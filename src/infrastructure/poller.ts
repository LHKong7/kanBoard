import { createDb, withTenant } from './db/client.ts'
import type { Db } from './db/client.ts'
import { claimUnpublished, markPublished, BufferedAuditSink, flushAudit, PgOutbox } from './outbox.pg.ts'
import { PgRelationRepository } from './relation-repository.pg.ts'
import { PgResourceRepository } from './resource-repository.pg.ts'
import { AutomationRunner, systemCaller } from '../domain/automation/runner.ts'
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
      return await withTenant(this.#db, event.tenant, async (trx: Db) => {
        const service = new ResourceService({
          registry: this.#deps.registry,
          workflows: this.#deps.workflows,
          resources: new PgResourceRepository(trx, event.tenant),
          relations: new PgRelationRepository(trx, event.tenant),
          events: new PgOutbox(trx),
          audit,
          policies: this.#deps.policies,
          clock,
        })
        const runner = new AutomationRunner({ service, rules: this.#deps.rules })
        return runner.handle(event, depth)
      })
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
