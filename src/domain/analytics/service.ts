import type { Clock } from '../../platform/clock.ts'
import { NotFoundError, ValidationError } from '../../platform/errors.ts'
import { groupOf } from '../../workflow/engine.ts'
import type { WorkflowRegistry } from '../../workflow/engine.ts'
import { isClosedGroup } from '../../workflow/types.ts'
import type { StateGroup } from '../../workflow/types.ts'
import type { ResourceFilter } from '../resource/ports.ts'
import type { Resource } from '../resource/resource.ts'
import type { Caller, ResourceService } from '../resource/service.ts'
import { burndown } from './burndown.ts'
import type { Burndown } from './burndown.ts'
import type { AnalyticsRepository, StateGroupRow } from './ports.ts'
import {
  assertValidSpec,
  effectiveGrouping,
  PENDING_GROUPS,
  toSeries,
  windowOf,
} from './spec.ts'
import type { ChartSeries, ChartSpec } from './spec.ts'

/**
 * 分析服务。
 *
 * 三件事：自由组合的图（16 × 9）、周期燃尽、周期进度快照。
 * 它们共用同一份状态组映射——这是全部三者能对得上的原因。
 * 各自维护一份"哪些状态算完成"的话，燃尽图烧到零的那天，
 * 进度条可能还显示 93%，而两个数字都说不出自己错在哪。
 */

export type AnalyticsDeps = {
  resources: ResourceService
  analytics: AnalyticsRepository
  workflows: WorkflowRegistry
  clock: Clock
}

/** 一个周期里能装多少工作项还算合理。超过就截断并**明说**，不静默 */
const MAX_CYCLE_ITEMS = 500

export type CycleProgress = {
  cycleId: string
  name: string
  startAt: string
  endAt: string
  total: number
  completed: number
  cancelled: number
  /** 还在流转中的条数 */
  open: number
  /** 按状态组分的条数。进度条按它拼色块 */
  byGroup: Record<string, number>
  points: { total: number; completed: number }
  /** 完成率（0–1）。分母是总数减取消——取消掉的事不该拉低完成率 */
  completionRate: number
  capturedAt: string
}

export class AnalyticsService {
  readonly #deps: AnalyticsDeps

  constructor(deps: AnalyticsDeps) {
    this.#deps = deps
  }

  /**
   * 自定义分析图。
   *
   * 授权先做，且用的是**列表那条路径的同一次判定**：分析不该成为
   * 一条绕过权限的旁路——看不到某个项目的人，不能从它的图上把信息推出来。
   */
  async chart(caller: Caller, filter: ResourceFilter, spec: ChartSpec): Promise<ChartSeries> {
    assertValidSpec(spec)
    await this.#deps.resources.authorizeQuery(caller, filter)

    const now = this.#deps.clock.now()
    const grouping = effectiveGrouping(spec)
    const cells = await this.#deps.analytics.chart({
      filter,
      xAxis: spec.xAxis,
      groupBy: spec.groupBy ?? null,
      yMetric: spec.yMetric,
      dateGrouping: grouping,
      // 二次分组若也是时间轴，跟随同一档粒度。给它单独一档的话，
      // 一张按天分组、按月堆叠的图在语义上说不清是什么
      groupDateGrouping: spec.groupBy === undefined ? null : grouping,
      stateGroups: this.stateGroupRows(),
      window: spec.duration === undefined ? null : windowOf(spec.duration, now),
      now,
    })

    return toSeries(cells, spec)
  }

  /**
   * (类型, 状态) → 状态组 的对照表。
   *
   * 从工作流注册表现读，不缓存：状态机是可以热改的（FR-WF-001），
   * 缓存一份就意味着改完流程之后，图上还按旧的分组算——
   * 而那种错误看不出来，它只是让某一类工作项悄悄换了一个桶。
   */
  stateGroupRows(): StateGroupRow[] {
    const rows: StateGroupRow[] = []
    for (const lifecycle of this.#deps.workflows.all()) {
      for (const state of lifecycle.states) {
        rows.push({ entityType: lifecycle.entityType, status: state.name, group: state.group })
      }
    }
    return rows
  }

  /**
   * 一个周期的燃尽图。
   *
   * 数据源是周期里那批工作项的 `completedAt`，不是每天存一份快照。
   * 理由是**快照会漏**：漏掉的那天在图上是一段直线，看起来像那天没人干活。
   * 从完成时刻反推则是幂等的——同一批数据算多少次都一样。
   *
   * 代价是它算的是"按当前归属"的燃尽：一个中途被移出周期的工作项，
   * 会连它之前的贡献一起消失。这正是指南里"迭代中途别随意增删"
   * 那条纪律的技术理由，所以这里不去补救它——补救等于把纪律的
   * 后果藏起来，而藏起来的后果不会消失。
   */
  async burndownOf(
    caller: Caller,
    cycleId: string,
    unit: 'count' | 'points' = 'count',
  ): Promise<Burndown & { cycleId: string; truncated: boolean }> {
    const { cycle, items, truncated } = await this.#cycleItems(caller, cycleId)

    const start = this.#requireDate(cycle, 'startAt')
    const end = this.#requireDate(cycle, 'endAt')

    const result = burndown({
      start,
      end,
      now: this.#deps.clock.now(),
      unit,
      items: items.map((item) => ({
        completedAt: readDate(item.attributes['completedAt']),
        points: pointsOf(item),
        cancelled: this.#groupOf(item) === 'Cancelled',
      })),
    })

    return { ...result, cycleId, truncated }
  }

  /**
   * 周期进度。关闭周期时把它冻进 `progressSnapshot`。
   *
   * 冻结的理由在本体那边写过：周期关掉之后工作项还会继续被改，
   * 现算出来的"上个迭代完成率"会一直变，于是回顾会上的数字
   * 和一周后再看时对不上。
   */
  async progressOf(caller: Caller, cycleId: string): Promise<CycleProgress> {
    const { cycle, items } = await this.#cycleItems(caller, cycleId)

    const byGroup: Record<string, number> = {}
    let completed = 0
    let cancelled = 0
    let open = 0
    let totalPoints = 0
    let completedPoints = 0

    for (const item of items) {
      const group = this.#groupOf(item) ?? 'Unstarted'
      byGroup[group] = (byGroup[group] ?? 0) + 1
      const points = pointsOf(item)
      totalPoints += points
      if (group === 'Completed') {
        completed += 1
        completedPoints += points
      } else if (group === 'Cancelled') {
        cancelled += 1
      } else {
        open += 1
      }
    }

    // 分母减去取消掉的：一个砍了一半范围的迭代，剩下的那一半全做完了
    // 就该是 100%。把取消的留在分母里，完成率会永远上不去，
    // 而团队会学会不去取消任何东西——那比数字难看糟得多
    const denominator = items.length - cancelled

    return {
      cycleId,
      name: String(cycle.attributes['name'] ?? cycle.id),
      startAt: String(cycle.attributes['startAt'] ?? ''),
      endAt: String(cycle.attributes['endAt'] ?? ''),
      total: items.length,
      completed,
      cancelled,
      open,
      byGroup,
      points: { total: round(totalPoints), completed: round(completedPoints) },
      completionRate: denominator === 0 ? 0 : Math.round((completed / denominator) * 10_000) / 10_000,
      capturedAt: this.#deps.clock.now().toISOString(),
    }
  }

  /** 周期里的工作项。两个存储方向都认，和分析取数那边同一个道理 */
  async #cycleItems(
    caller: Caller,
    cycleId: string,
  ): Promise<{ cycle: Resource; items: Resource[]; truncated: boolean }> {
    const cycle = await this.#deps.resources.get(caller, cycleId)
    if (cycle.type !== 'Sprint') {
      throw new ValidationError(`"${cycleId}" is a ${cycle.type}, not a cycle`, {
        expected: 'Sprint',
        actual: cycle.type,
      })
    }

    const edges = await this.#deps.resources.relationsOf(caller, cycleId, 'out', 'plans')
    const ids = [...new Set(edges.map((e) => e.toId))]
    const truncated = ids.length > MAX_CYCLE_ITEMS

    if (ids.length === 0) return { cycle, items: [], truncated: false }

    const page = await this.#deps.resources.query(
      caller,
      { ids: ids.slice(0, MAX_CYCLE_ITEMS) },
      { size: MAX_CYCLE_ITEMS },
    )
    return { cycle, items: page.items, truncated }
  }

  #groupOf(item: Resource): StateGroup | null {
    const lifecycle = this.#deps.workflows.forEntityType(item.type)
    if (lifecycle === null) return null
    return groupOf(lifecycle, item.status)
  }

  #requireDate(cycle: Resource, key: string): Date {
    const value = readDate(cycle.attributes[key])
    if (value === null) {
      throw new NotFoundError(`cycle ${cycle.id} has no valid ${key}; a burn-down needs both ends`)
    }
    return value
  }
}

/** 待办 = 三个未完成的状态组之和。导出给指标那边共用，口径只有一份 */
export function isPendingGroup(group: StateGroup): boolean {
  return PENDING_GROUPS.includes(group)
}

export function isClosed(group: StateGroup): boolean {
  return isClosedGroup(group)
}

function pointsOf(item: Resource): number {
  const raw = item.attributes['storyPoint'] ?? item.attributes['estimate']
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : 0
}

/**
 * 从属性里读一个时间。
 *
 * 读不出来返回 null 而不是抛错：一条 `completedAt` 写坏了的工作项
 * 不该让整张燃尽图打不开。它会被当成"还没完成"，
 * 而那是两种错误里危害较小的一种——它让线烧得慢，不让线消失。
 */
function readDate(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value
  if (typeof value !== 'string' || value === '') return null
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

function round(value: number): number {
  return Math.round(value * 100) / 100
}
