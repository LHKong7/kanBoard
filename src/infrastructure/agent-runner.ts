import { createDb, withTenant } from './db/client.ts'
import type { Db } from './db/client.ts'
import { BufferedAuditSink, flushAudit, PgOutbox } from './outbox.pg.ts'
import { PgRelationRepository } from './relation-repository.pg.ts'
import { PgResourceRepository } from './resource-repository.pg.ts'
import { PgRunStepRepository } from './run-step-repository.pg.ts'
import { AgentRuntime } from '../domain/agent/runtime.ts'
import type { ConnectorInvoker } from '../domain/agent/runtime.ts'
import type { ModelClient, RunResult } from '../domain/agent/types.ts'
import { ResourceService } from '../domain/resource/service.ts'
import type { Caller } from '../domain/resource/service.ts'
import type { Resource } from '../domain/resource/resource.ts'
import type { OntologyRegistry } from '../ontology/registry.ts'
import type { WorkflowRegistry } from '../workflow/engine.ts'
import type { Capability, Policy } from '../identity/types.ts'
import { systemClock } from '../platform/clock.ts'
import type { Clock } from '../platform/clock.ts'
import { newTraceId } from '../platform/id.ts'
import type pg from 'pg'

/**
 * Agent Runner —— ADR-0008 里的第三种进程角色。
 *
 * 它做的事和 poller 同构：找到待办、执行、把结果写回。
 * 之所以不把执行塞进 HTTP 请求里：一次 Run 可能跑几十秒到几分钟，
 * 挂在请求上意味着超时、重试会重复执行、而且 API 进程的时延
 * 会被推理耗时污染。
 *
 * **启动一次 Run 不需要专用端点**：创建一个 `AgentRun` 资源即可
 * （走统一 API，ADR-0002）。Runner 认领 Queued 状态的 Run。
 * 于是"谁能发起 Agent 执行"这个问题的答案就是 `AgentRun.Create` 的权限，
 * 不需要另设一套。
 */

export type AgentRunnerDeps = {
  pool: pg.Pool
  tenants: readonly string[]
  registry: OntologyRegistry
  workflows: WorkflowRegistry
  policies: readonly Policy[]
  model: ModelClient
  /** 外部系统通道。不给就是这批 Run 不能调用任何外部工具 */
  connectors?: ConnectorInvoker
  clock?: Clock
  /** 单次 Run 的影响面上限（FR-IAM-012）。租户级策略，不由 Run 自己设定 */
  blastRadius?: number
  /** 每轮最多认领几个 Run */
  batchSize?: number
  onFinished?: (run: Resource, result: RunResult) => void
}

export type ClaimResult = {
  claimed: number
  results: Array<{ runId: string; result: RunResult }>
}

export class AgentRunner {
  readonly #deps: AgentRunnerDeps
  readonly #db: Db
  #stopped = false
  /**
   * 关停时用来打断在途的 Run（FR-ARCH-011）。
   *
   * 没有它的话，`stop()` 只是"不再认领新的"，进程会一直等到
   * 最后一次推理跑完——而那可能是几分钟。验收标准写的是 5 秒内停止。
   */
  #aborter = new AbortController()

  constructor(deps: AgentRunnerDeps) {
    this.#deps = deps
    this.#db = createDb(deps.pool)
  }

  /**
   * 认领并执行一批 Run。
   *
   * 认领与执行**分成两个事务**，这是刻意的：推理会跑很久，
   * 把它包在认领事务里等于长时间持锁。所以先用一个短事务把
   * Queued → Running 落定（状态机本身保证了不会有第二个 runner
   * 认领同一条），再在独立事务里执行。
   */
  async pollOnce(): Promise<ClaimResult> {
    const clock = this.#deps.clock ?? systemClock
    const results: ClaimResult['results'] = []
    let claimed = 0

    for (const tenant of this.#deps.tenants) {
      const queued = await this.#claim(tenant, clock)
      claimed += queued.length

      for (const run of queued) {
        const result = await this.#run(tenant, run, clock)
        results.push({ runId: run.id, result })
        this.#deps.onFinished?.(run, result)
      }
    }

    return { claimed, results }
  }

  /** 短事务：把 Queued 的 Run 推进到 Running，认领成功的返回 */
  async #claim(tenant: string, clock: Clock): Promise<Resource[]> {
    const audit = new BufferedAuditSink()
    try {
      return await withTenant(this.#db, tenant, async (trx: Db) => {
        const service = this.#service(trx, tenant, audit, clock)
        const caller = this.#systemCaller(tenant)
        const page = await service.query(
          caller,
          { type: 'AgentRun', status: ['Queued'] },
          { size: this.#deps.batchSize ?? 5 },
        )

        const taken: Resource[] = []
        for (const run of page.items) {
          try {
            taken.push(await service.transition(caller, run.id, 'Running', { reason: 'agent runner 认领' }))
          } catch {
            // 认领失败通常意味着别的 runner 抢先了。不是错误，跳过即可
          }
        }
        return taken
      })
    } finally {
      await this.#flush(tenant, audit)
    }
  }

  /** 独立事务：以 **Agent 的身份** 执行，并把结果写回 Run */
  async #run(tenant: string, run: Resource, clock: Clock): Promise<RunResult> {
    const audit = new BufferedAuditSink()
    try {
      return await withTenant(this.#db, tenant, async (trx: Db) => {
        const service = this.#service(trx, tenant, audit, clock)
        const systemCaller = this.#systemCaller(tenant)

        // Agent 的 principal 决定这次 Run 的身份（FR-AGT-003）。
        // 用发起人的身份执行会让审计变成谎话——日志里看到的是人，
        // 实际动手的是 Agent
        // 从解析身份到执行完，整段都兜住。
        //
        // 一条 Run 出问题不该掀掉整批：runner 是常驻进程，
        // 一个畸形的 Agent 定义会让它每一轮都在同一条上崩掉，
        // 而队列里其余的 Run 永远轮不到。失败要落到**那一条 Run 上**，
        // 记成 Failed 并写明原因，然后继续下一条。
        let result: RunResult
        try {
          const agent = await service.get(systemCaller, String(run.attributes['agent'] ?? ''))
          const principal = String(agent.attributes['principal'] ?? '')
          if (!principal.startsWith('agent://')) {
            // 拿不到 Agent 身份就**不执行**。退回到 system 或发起人的身份跑，
            // 审计里会记成别人干的——那比不执行糟糕得多
            throw new Error(
              `agent ${agent.id} has principal "${principal}", which is not an agent:// identity; ` +
                'refusing to run under a borrowed identity',
            )
          }

          const agentCaller: Caller = {
            subject: {
              principal: principal as `agent://${string}`,
              tenant,
              roles: ['AIAgent'],
              // 能力全部来自 Agent 自己的声明（FR-AGT-001）。
              //
              // `ROLE_CAPABILITIES.AIAgent` 是空集，所以这里不写就是什么都不能做——
              // 这正是 ADR-0003 想要的默认值：Agent 的权限是**配出来的**，
              // 不是"因为它是个 Agent"就有的。
              // 配得再宽也越不过 default-policies.ts 里那两条 Deny。
              capabilities: declaredCapabilities(agent.attributes['capabilities']),
            },
            // Run 绑定：临时授权按它失效（ADR-0003 §7.2）
            runId: run.id,
            traceId: newTraceId(),
          }

          const runtime = new AgentRuntime({
            service,
            model: this.#deps.model,
            steps: new PgRunStepRepository(trx, tenant),
            clock,
            ...(this.#deps.connectors === undefined ? {} : { connectors: this.#deps.connectors }),
            ...(this.#deps.blastRadius === undefined ? {} : { blastRadius: this.#deps.blastRadius }),
            signal: this.#aborter.signal,
          })
          result = await runtime.execute(agentCaller, run)
        } catch (error) {
          result = {
            outcome: { kind: 'failed', reason: error instanceof Error ? error.message : String(error) },
            steps: 0,
            tokensUsed: 0,
            costUsd: 0,
            proposals: [],
          }
        }

        // 结算与终态。用 system 身份写回：这是运行时的记账，不是 Agent 的动作，
        // 而且 Agent 被显式禁止批准自己的产出
        await this.#settle(service, systemCaller, run, result)
        return result
      })
    } finally {
      await this.#flush(tenant, audit)
    }
  }

  /**
   * 把用量与终态写回 Run。
   *
   * 终态由 outcome 决定，而不是由"有没有异常"决定：
   * 超预算被掐掉的 Run 也是**跑完了**，只是没达成目标——
   * 把它记成 Failed 会让"多少 Run 是被预算限制的"这个数字消失在错误堆里。
   */
  async #settle(
    service: ResourceService,
    caller: Caller,
    run: Resource,
    result: RunResult,
  ): Promise<void> {
    const current = await service.get(caller, run.id)
    const updated = await service.update(caller, run.id, {
      expectedVersion: current.version,
      attributes: {
        ...current.attributes,
        tokensUsed: result.tokensUsed,
        costUsd: result.costUsd,
        stepCount: result.steps,
        outcome: describe(result),
      },
      reason: 'agent runner 结算',
    })

    const next =
      result.outcome.kind === 'completed'
        ? 'Succeeded'
        : result.outcome.kind === 'awaiting-review'
          ? 'AwaitingReview'
          // 被取消的 Run 落在 Cancelled 而不是 Failed（FR-ARCH-011）。
          // 都记成失败的话，"这批 Run 为什么这么多失败"就永远问不清楚
          : result.outcome.kind === 'cancelled'
            ? 'Cancelled'
            : 'Failed'

    // 已经在目标状态就不再迁移。
    //
    // 外部取消会走到这里：有人把 Run 迁到了 Cancelled，运行时读到之后停下来，
    // 结算再迁一次就会撞上"不能从 Cancelled 迁到 Cancelled"，
    // 于是整个结算失败——用量与终止原因都写不回去。
    // 结算必须是幂等的
    if (updated.status !== next) {
      await service.transition(caller, run.id, next, {
        expectedVersion: updated.version,
        reason: describe(result),
      })
    }
  }

  #service(trx: Db, tenant: string, audit: BufferedAuditSink, clock: Clock): ResourceService {
    return new ResourceService({
      registry: this.#deps.registry,
      workflows: this.#deps.workflows,
      resources: new PgResourceRepository(trx, tenant),
      relations: new PgRelationRepository(trx, tenant),
      events: new PgOutbox(trx),
      audit,
      policies: this.#deps.policies,
      clock,
    })
  }

  #systemCaller(tenant: string): Caller {
    return {
      subject: {
        principal: 'system://internal',
        tenant,
        roles: [],
        capabilities: ['*.Transition', '*.Read', '*.Update'],
      },
      traceId: newTraceId(),
    }
  }

  async #flush(tenant: string, audit: BufferedAuditSink): Promise<void> {
    const entries = audit.drain()
    if (entries.length === 0) return
    try {
      await withTenant(this.#db, tenant, (trx: Db) => flushAudit(trx, entries))
    } catch (error) {
      // 与 API / poller 同样的取舍：审计写入失败不掩盖业务结果，但要吵
      console.error('[agent-runner] failed to flush audit records:', error)
    }
  }

  /** 循环消费。空闲时退避 */
  async run(intervalMs = 2000): Promise<void> {
    this.#stopped = false
    while (!this.#stopped) {
      let result: ClaimResult = { claimed: 0, results: [] }
      try {
        result = await this.pollOnce()
      } catch (error) {
        console.error('[agent-runner] batch failed:', error)
      }
      if (result.claimed === 0 && !this.#stopped) {
        await new Promise((resolve) => setTimeout(resolve, intervalMs))
      }
    }
  }

  stop(): void {
    this.#stopped = true
    // 在途的 Run 也要停。只置一个"别再认领"的标志，
    // 关停就要等最后一次推理自然结束
    this.#aborter.abort()
  }
}

function describe(result: RunResult): string {
  const o = result.outcome
  switch (o.kind) {
    case 'completed':
      return `完成：${o.summary}`
    case 'awaiting-review':
      return `待人工审阅：${o.proposals} 项产出`
    case 'budget-exceeded':
      return `预算触顶（${o.limit}=${o.used}）后终止`
    case 'blast-radius-exceeded':
      return `影响面触顶（已改动 ${o.touched} 个对象，上限 ${o.limit}）后熔断`
    case 'cancelled':
      return `被取消（已执行 ${o.afterSteps} 步）`
    case 'failed':
      return `失败：${o.reason}`
  }
}

/**
 * 读 Agent 声明里的能力清单。
 *
 * 格式不对就当成空——**不是**当成"没限制"。
 * 一个写坏了的声明应该让 Agent 什么都做不了，而不是什么都能做。
 */
function declaredCapabilities(raw: unknown): Capability[] {
  if (!Array.isArray(raw)) return []
  return raw.filter((c): c is Capability => typeof c === 'string' && c.includes('.'))
}
