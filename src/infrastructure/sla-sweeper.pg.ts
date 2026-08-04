import { createDb, withTenant } from './db/client.ts'
import type { Db } from './db/client.ts'
import { systemClock } from '../platform/clock.ts'
import type { Clock } from '../platform/clock.ts'
import type { WorkflowRegistry } from '../workflow/engine.ts'
import type { StateDef } from '../workflow/types.ts'
import type pg from 'pg'

/**
 * SLA 超时巡检（FR-WF-002 的 sla 要素）。
 *
 * 在此之前 `sla` 只是状态机定义里的一个字段。Task 的 `Doing` 上写着
 * 「5 天，超时通知 owner」，Blocked 上写着「2 天，升级」——
 * 而**没有任何代码读它**。配置好了、什么也不做的字段比没有更糟：
 * 有人会以为超时会有人管。
 *
 * 巡检是**拉取**而不是定时器：
 *
 * 定时器要在进程里为每个对象排一个到期任务，重启就全丢；
 * 补回来又需要一次全量扫描——也就是这里做的事，只是多了一条会坏的路径。
 * 拉取的状态全在数据库里，进程可以随时重启、随时多开。
 *
 * 代价是**检测有延迟**，上界等于巡检间隔。这是一个说得清的上界，
 * 而定时器丢任务是一个说不清的漏报。
 */

export type SlaBreach = {
  resourceId: string
  type: string
  status: string
  owner: string
  /** 进入这个状态的时刻 */
  since: Date
  /** 按定义应当在此刻告警 */
  breachedAt: Date
  action: 'notify-owner' | 'escalate'
  /** 超时了多久 */
  overdueMs: number
}

export type SweeperDeps = {
  pool: pg.Pool
  tenants: readonly string[]
  workflows: WorkflowRegistry
  clock?: Clock
  /** 一轮最多处理多少条。留一个上界，免得积压时一轮跑到超时 */
  batchSize?: number
  /** 通知怎么发出去。缺省只写 sla_breaches，不发通知 */
  onBreach?: (tenant: string, breach: SlaBreach) => Promise<string | null>
}

export type SweepResult = {
  /** 本轮新发现的超时。已经报过的不在其中 */
  breaches: SlaBreach[]
  /** 检查过的（类型, 状态）组合数量 */
  scanned: number
}

export class SlaSweeper {
  readonly #deps: SweeperDeps
  readonly #db: Db

  constructor(deps: SweeperDeps) {
    this.#deps = deps
    this.#db = createDb(deps.pool)
  }

  async sweepOnce(): Promise<SweepResult> {
    const clock = this.#deps.clock ?? systemClock
    const now = clock.now()
    const limit = this.#deps.batchSize ?? 200
    const breaches: SlaBreach[] = []
    let scanned = 0

    for (const tenant of this.#deps.tenants) {
      for (const { entityType, state } of statesWithSla(this.#deps.workflows)) {
        scanned++
        const sla = state.sla
        if (sla === undefined) continue
        const cutoff = new Date(now.getTime() - sla.maxDurationMs)

        // 一条 SQL 就把"超时了"和"还没报过"一起问掉。
        // 分两步查会在两次查询之间留一个窗口，多开几个巡检进程时
        // 同一次超时会被报很多遍
        const rows = await withTenant(this.#db, tenant, async (trx) =>
          trx
            .selectFrom('resources')
            .select(['id', 'type', 'status', 'owner', 'status_since'])
            .where('tenant', '=', tenant)
            .where('type', '=', entityType)
            .where('status', '=', state.name)
            .where('status_since', '<', cutoff)
            .where('deleted_at', 'is', null)
            .where(({ not, exists, selectFrom }) =>
              not(
                exists(
                  selectFrom('sla_breaches')
                    .select('sla_breaches.resource_id')
                    .whereRef('sla_breaches.resource_id', '=', 'resources.id')
                    .whereRef('sla_breaches.status', '=', 'resources.status')
                    // 带上 status_since：重新进入这个状态算一次新的计时，
                    // 因此也应当能重新报警
                    .whereRef('sla_breaches.status_since', '=', 'resources.status_since'),
                ),
              ),
            )
            .orderBy('status_since')
            .limit(limit)
            .execute(),
        )

        for (const row of rows) {
          const breach: SlaBreach = {
            resourceId: row.id,
            type: row.type,
            status: row.status,
            owner: row.owner,
            since: row.status_since,
            breachedAt: new Date(row.status_since.getTime() + sla.maxDurationMs),
            action: sla.onBreach,
            overdueMs: now.getTime() - row.status_since.getTime() - sla.maxDurationMs,
          }

          // 先把动作做掉再记账。反过来的话，记账成功而动作失败时
          // 这次超时就**永远不会再被报**——一次静默的漏报，
          // 而且看起来一切正常
          let notificationId: string | null = null
          try {
            notificationId = (await this.#deps.onBreach?.(tenant, breach)) ?? null
          } catch (error) {
            // 动作失败不记账，下一轮会重试。但要大声说出来
            console.error(
              `[sla] breach action failed for ${row.id} (${row.type} in ${row.status}):`,
              error,
            )
            continue
          }

          await withTenant(this.#db, tenant, async (trx) => {
            await trx
              .insertInto('sla_breaches')
              .values({
                tenant,
                resource_id: row.id,
                status: row.status,
                status_since: row.status_since,
                action: sla.onBreach,
                breached_at: breach.breachedAt,
                detected_at: now,
                notification_id: notificationId,
              })
              // 多个巡检进程同时发现同一条时，第二个静默跳过。
              // 代价是可能重复发一条通知，比漏报好
              .onConflict((oc) => oc.doNothing())
              .execute()
          })

          breaches.push(breach)
        }
      }
    }

    return { breaches, scanned }
  }
}

/** 所有声明了 sla 的（类型, 状态）。清单从状态机定义来，不另写一份 */
function statesWithSla(
  workflows: WorkflowRegistry,
): { entityType: string; state: StateDef }[] {
  const out: { entityType: string; state: StateDef }[] = []
  for (const lifecycle of workflows.all()) {
    for (const state of lifecycle.states) {
      if (state.sla !== undefined) out.push({ entityType: lifecycle.entityType, state })
    }
  }
  return out
}
