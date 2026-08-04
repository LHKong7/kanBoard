import { serviceIn } from './service-factory.ts'
import { createDb, withTenant } from './db/client.ts'
import type { Db } from './db/client.ts'
import { claimUnpublished, markPublished, BufferedAuditSink, flushAudit, PgOutbox } from './outbox.pg.ts'
import { PgRelationRepository } from './relation-repository.pg.ts'
import { PgResourceRepository } from './resource-repository.pg.ts'
import { AutomationRunner, SYSTEM_SUBJECT } from '../domain/automation/runner.ts'
import type { AutomationOutcome } from '../domain/automation/runner.ts'
import { ResourceService } from '../domain/resource/service.ts'
import type { DomainEvent, DomainEventType } from '../domain/events.ts'
import type { OntologyRegistry } from '../ontology/registry.ts'
import type { WorkflowRegistry } from '../workflow/engine.ts'
import type { AutomationRule } from '../workflow/automation.ts'
import type { Policy } from '../identity/types.ts'
import { systemClock } from '../platform/clock.ts'
import type { Clock } from '../platform/clock.ts'
import type pg from 'pg'

/**
 * Outbox poller —— ADR-0008 里的第二种进程角色。
 *
 * 它把"事件已落库"变成"事件已被处理"。在此之前 outbox 只是个只写的表：
 * M0 把事件写进去了，但没有任何东西读它。
 */

export type PollerDeps = {
  pool: pg.Pool
  /**
   * 要消费的租户列表。
   *
   * poller 必须**逐个租户**消费，因为 outbox 同样受 RLS 约束。
   * 给后台任务开 BYPASSRLS 是最省事的做法，也是 ADR-0005 的保证被悄悄侵蚀的典型方式：
   * 隔离一旦有一条例外通道，"数据库层兜底"就不再成立。
   *
   * v1 单租户运行（ADR-0005），这里就是 `['default']`。
   * 将来做 SaaS 时改为从租户注册表读取——那张表本身不是租户级数据。
   */
  tenants: readonly string[]
  registry: OntologyRegistry
  workflows: WorkflowRegistry
  rules: readonly AutomationRule[]
  policies: readonly Policy[]
  clock?: Clock
  batchSize?: number
  /** 观测钩子，测试与日志都用它 */
  onOutcome?: (event: DomainEvent, outcomes: AutomationOutcome[]) => void
}

export type PollResult = {
  claimed: number
  outcomes: AutomationOutcome[]
}

export class OutboxPoller {
  readonly #deps: PollerDeps
  readonly #db: Db
  #stopped = false

  constructor(deps: PollerDeps) {
    this.#deps = deps
    this.#db = createDb(deps.pool)
  }

  /**
   * 消费一批事件。
   *
   * 每批一个事务：claim（FOR UPDATE SKIP LOCKED）→ 跑自动化 → 标记已发布。
   * SKIP LOCKED 让多个 poller 实例可以并行而不重复消费。
   *
   * 自动化产生的新事件会落进 outbox，下一轮再被取到——
   * 因此触发链是异步展开的，深度上限由 AutomationRunner 把守。
   */
  async pollOnce(): Promise<PollResult> {
    const batchSize = this.#deps.batchSize ?? 50
    const clock = this.#deps.clock ?? systemClock
    const outcomes: AutomationOutcome[] = []
    let claimed = 0

    for (const tenant of this.#deps.tenants) {
      // claim 与标记放在同一个租户事务里：处理失败则整批回滚，事件保持未发布，
      // 下次重新取到。代价是可能重复执行，所以自动化动作必须幂等——
      // transition 天然幂等（目标状态已达成时守卫会拒绝），relate 也是（唯一索引 + doNothing）。
      await withTenant(this.#db, tenant, async (trx: Db) => {
        const rows = await claimUnpublished(trx, batchSize)
        if (rows.length === 0) return
        claimed += rows.length

        for (const row of rows) {
          const event: DomainEvent = {
            type: row.eventType as DomainEventType,
            tenant: row.tenant,
            resourceId: row.resourceId,
            resourceType: row.resourceType,
            payload: row.payload,
            occurredAt: row.occurredAt,
            traceId: row.traceId,
          }

          const produced = await this.#handle(event, clock)
          outcomes.push(...produced)
          this.#deps.onOutcome?.(event, produced)
        }

        await markPublished(
          trx,
          rows.map((r) => r.seq),
          clock.now(),
        )
      })
    }

    return { claimed, outcomes }
  }

  async #handle(event: DomainEvent, clock: Clock): Promise<AutomationOutcome[]> {
    const audit = new BufferedAuditSink()
    const depth = Number(event.payload['automationDepth'] ?? 0)

    try {
      const outcomes = await withTenant(this.#db, event.tenant, async (trx: Db) => {
        const service = serviceIn(trx, event.tenant, {
          registry: this.#deps.registry,
          workflows: this.#deps.workflows,
          policies: this.#deps.policies,
          audit,
          clock,
        })
        const runner = new AutomationRunner({ service, rules: this.#deps.rules })
        return runner.handle(event, depth)
      })
      await this.#reportDeclines(event, outcomes, audit, clock)
      return outcomes
    } finally {
      // 自动化的授权决策同样要审计：一条规则以 system 身份改了什么，必须查得到
      const entries = audit.drain()
      if (entries.length > 0) {
        try {
          await withTenant(this.#db, event.tenant, (trx: Db) => flushAudit(trx, entries))
        } catch {
          // 与 API 层同样的取舍：不让审计写入失败掩盖业务结果。
          // TODO(M1)：持久缓冲
        }
      }
    }
  }

  /**
   * 让没推动的自动化留下痕迹。
   *
   * 这件事**不能**交给 `onOutcome` 钩子：钩子是可选的，main.ts 一开始就没接，
   * 于是规则算出了准确的原因之后原地丢掉。自用第一天的实测
   * （docs/dogfooding-log.md #2）：Story 忘了标 Ready，子任务全做完了，
   * 两条规则都给出了 `story_… is "Draft", not in ["Ready"]`——
   * 日志、历史、审计三处一个字都没有，看起来就像"自动化根本没配"。
   * 可选的可观测性等于没有可观测性。
   *
   * 两个去处，各答一个问题：
   * - stderr：只发 `rejected`。守卫挡回或调用出错是异常，该触发告警；
   *   条件不满足是正常业务分支，刷进日志只会让真正的异常被淹掉。
   * - audit_log：两种都写。使用者的问题是"我这条为什么没动"，
   *   按 resource_id 一查就有答案，不必区分是被拒还是被跳过。
   */
  async #reportDeclines(
    event: DomainEvent,
    outcomes: readonly AutomationOutcome[],
    audit: BufferedAuditSink,
    clock: Clock,
  ): Promise<void> {
    for (const outcome of outcomes) {
      // 动作整体抛出（或链深超限）时没有逐目标信息，挂到触发事件的源对象上——
      // 定位差一点，但绝不能因此不记
      const declines =
        outcome.declines ??
        (outcome.status === 'failed'
          ? ([{ targetId: event.resourceId, reason: outcome.detail, kind: 'rejected' }] as const)
          : [])

      for (const decline of declines) {
        if (decline.kind === 'rejected') {
          console.error(
            `[poller] automation rejected: rule=${outcome.ruleId} action=${outcome.action} ` +
              `target=${decline.targetId} event=${event.type} reason=${decline.reason}`,
          )
        }
        await audit.record({
          tenant: event.tenant,
          subject: SYSTEM_SUBJECT.principal,
          onBehalfOf: null,
          action: `automation:${outcome.ruleId}`,
          resourceId: decline.targetId,
          resourceType: null,
          decision: { effect: 'Rejected', reason: decline.reason },
          runRef: null,
          occurredAt: clock.now(),
          traceId: event.traceId,
        })
      }
    }
  }

  /** 循环消费。空闲时退避，避免空转打满数据库。 */
  async run(intervalMs = 1000): Promise<void> {
    this.#stopped = false
    while (!this.#stopped) {
      let result: PollResult = { claimed: 0, outcomes: [] }
      try {
        result = await this.pollOnce()
      } catch (error) {
        console.error('[poller] batch failed:', error)
      }
      // 有事件就立刻取下一批，没有才等——积压时不该被固定间隔拖慢
      if (result.claimed === 0 && !this.#stopped) {
        await sleep(intervalMs)
      }
    }
  }

  stop(): void {
    this.#stopped = true
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
