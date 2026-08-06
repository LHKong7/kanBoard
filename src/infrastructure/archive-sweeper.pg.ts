import { sql } from 'kysely'
import { createDb, withTenant } from './db/client.ts'
import type { Db } from './db/client.ts'
import { systemClock } from '../platform/clock.ts'
import type { Clock } from '../platform/clock.ts'
import { groupOf } from '../workflow/engine.ts'
import type { WorkflowRegistry } from '../workflow/engine.ts'
import { isClosedGroup } from '../workflow/types.ts'
import type pg from 'pg'

/**
 * 自动归档 / 自动关闭巡检（project-management-guide §2.6）。
 *
 * 两条规则，都由**项目上的属性**开关，不填就不开：
 *
 *   `archiveInMonths`  已完成的工作项，N 个月没更新 → 归档
 *   `closeInMonths`    未完成的工作项，N 个月没活动 → 取消（关闭）
 *
 * 不开的后果不是"少了个功能"，是指南反模式表里的那一条：
 * Backlog 无限增长，半年后变成垃圾场，然后没人愿意打开它。
 *
 * ## 两条规则的危险程度完全不同
 *
 * 归档是**可逆且无损**的：对象还在、状态没变、指标照算，只是不在日常视图里。
 * 关闭是**改状态**：它会走状态机、发事件、进历史，而且会让完成率变化。
 *
 * 所以关闭这条：
 *
 * - 走和人完全相同的 `transition()`，守卫、权限、审计一个不少；
 * - 目标状态从状态机里**查**出来（找 Cancelled 组里的终态），不写死
 *   `'Cancelled'`——一个把取消状态改名成 `WontDo` 的租户，
 *   写死的话会静默地什么都不做；
 * - 走不通就跳过并记下来，不硬推。
 *
 * ## 为什么是拉取式巡检
 *
 * 和 SLA 巡检同一个理由：定时器的状态在进程里，重启就丢，
 * 补回来又需要一次全量扫描——也就是这里做的事，只是多了一条会坏的路径。
 * 代价是检测有延迟，上界等于巡检间隔；那是一个说得清的上界。
 */

export type ArchiveOutcome = {
  tenant: string
  projectId: string
  /** 归档掉的对象 id */
  archived: string[]
  /** 关闭掉的对象 id */
  closed: string[]
  /** 想关但没关成的，附原因。停滞要看得见 */
  skipped: Array<{ id: string; reason: string }>
}

export type ArchiveSweeperDeps = {
  pool: pg.Pool
  tenants: readonly string[]
  workflows: WorkflowRegistry
  clock?: Clock
  /** 一轮每个项目最多处理多少条。留上界，免得第一次开启时一轮跑到超时 */
  batchSize?: number
  /**
   * 真正执行归档 / 关闭的回调。
   *
   * 做成回调而不是让巡检自己写库：这两个动作必须走
   * `ResourceService`（要授权、要审计、要发事件），
   * 而那需要一整套服务装配。让基础设施层去装配领域服务
   * 会把依赖方向倒过来，dependency-cruiser 也不允许。
   */
  archive: (tenant: string, id: string) => Promise<void>
  close: (tenant: string, id: string, to: string) => Promise<void>
}

/** 月份换成毫秒。按 30 天算——"3 个月无活动"不需要日历级的精确 */
const MONTH_MS = 30 * 24 * 60 * 60 * 1000

type Candidate = { id: string; type: string; status: string }

export class ArchiveSweeper {
  readonly #deps: ArchiveSweeperDeps

  constructor(deps: ArchiveSweeperDeps) {
    this.#deps = deps
  }

  async sweepOnce(): Promise<ArchiveOutcome[]> {
    const clock = this.#deps.clock ?? systemClock
    const now = clock.now()
    const limit = this.#deps.batchSize ?? 200
    const db = createDb(this.#deps.pool)
    const outcomes: ArchiveOutcome[] = []

    for (const tenant of this.#deps.tenants) {
      const projects = await withTenant(db, tenant, async (trx: Db) =>
        trx
          .selectFrom('resources')
          .select(['id', 'attributes'])
          .where('tenant', '=', tenant)
          .where('type', '=', 'Project')
          .where('deleted_at', 'is', null)
          .execute(),
      )

      for (const project of projects) {
        const attributes = project.attributes as unknown as Record<string, unknown>
        const archiveMonths = monthsOf(attributes['archiveInMonths'])
        const closeMonths = monthsOf(attributes['closeInMonths'])
        if (archiveMonths === null && closeMonths === null) continue

        const outcome: ArchiveOutcome = {
          tenant,
          projectId: project.id,
          archived: [],
          closed: [],
          skipped: [],
        }

        if (archiveMonths !== null) {
          const cutoff = new Date(now.getTime() - archiveMonths * MONTH_MS)
          const candidates = await this.#stale(db, tenant, project.id, cutoff, limit)
          for (const candidate of candidates) {
            // 归档只挑**已经结束**的：把一个还在做的任务归档掉，
            // 等于让它从所有人的视线里消失而事情还没做完
            if (!this.#isClosed(candidate)) continue
            try {
              await this.#deps.archive(tenant, candidate.id)
              outcome.archived.push(candidate.id)
            } catch (error) {
              outcome.skipped.push({ id: candidate.id, reason: reasonOf(error) })
            }
          }
        }

        if (closeMonths !== null) {
          const cutoff = new Date(now.getTime() - closeMonths * MONTH_MS)
          const candidates = await this.#stale(db, tenant, project.id, cutoff, limit)
          for (const candidate of candidates) {
            if (this.#isClosed(candidate)) continue
            const target = this.#cancelStateFor(candidate.type)
            if (target === null) {
              // 这个类型没有可去的取消状态。记下来而不是安静跳过——
              // 否则"我开了自动关闭但什么都没发生"永远查不出原因
              outcome.skipped.push({
                id: candidate.id,
                reason: `lifecycle for ${candidate.type} has no reachable Cancelled state`,
              })
              continue
            }
            try {
              await this.#deps.close(tenant, candidate.id, target)
              outcome.closed.push(candidate.id)
            } catch (error) {
              outcome.skipped.push({ id: candidate.id, reason: reasonOf(error) })
            }
          }
        }

        if (outcome.archived.length + outcome.closed.length + outcome.skipped.length > 0) {
          outcomes.push(outcome)
        }
      }
    }

    return outcomes
  }

  /** 项目下 `updated_at` 早于 cutoff、且尚未归档的对象 */
  async #stale(
    db: Db,
    tenant: string,
    projectId: string,
    cutoff: Date,
    limit: number,
  ): Promise<Candidate[]> {
    return withTenant(db, tenant, async (trx: Db) =>
      trx
        .selectFrom('resources')
        .select(['id', 'type', 'status'])
        .where('tenant', '=', tenant)
        .where('project', '=', projectId)
        .where('deleted_at', 'is', null)
        .where('archived_at', 'is', null)
        .where('updated_at', '<', cutoff)
        // 项目自己不参与：一个三个月没动的项目不该把自己归档掉
        .where('type', '!=', 'Project')
        .where(sql<boolean>`lifecycle IS NOT NULL`)
        .orderBy('updated_at')
        .limit(limit)
        .execute(),
    )
  }

  #isClosed(candidate: Candidate): boolean {
    const lifecycle = this.#deps.workflows.forEntityType(candidate.type)
    if (lifecycle === null) return false
    const group = groupOf(lifecycle, candidate.status)
    return group !== null && isClosedGroup(group)
  }

  /**
   * 这个类型该往哪个状态关。
   *
   * 从状态机里**查**：找 Cancelled 组里的终态。写死 `'Cancelled'` 的话，
   * 一个把它改名成 `WontDo` 的租户会得到一个什么都不做的自动关闭，
   * 而且不报错。
   *
   * 有多个就取第一个——两个 Cancelled 组终态的状态机很少见，
   * 真出现时选哪个都是猜，所以不如取一个确定的。
   */
  #cancelStateFor(type: string): string | null {
    const lifecycle = this.#deps.workflows.forEntityType(type)
    if (lifecycle === null) return null
    return lifecycle.states.find((s) => s.group === 'Cancelled' && s.terminal === true)?.name ?? null
  }
}

/** 月数：1–12 的整数才算数。别的值当成没配 */
function monthsOf(raw: unknown): number | null {
  if (typeof raw !== 'number' || !Number.isInteger(raw)) return null
  if (raw < 1 || raw > 12) return null
  return raw
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
