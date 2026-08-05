import { DomainError } from '../../platform/errors.ts'
import type { Caller, ResourceService } from '../resource/service.ts'
import type { GroupCount, Page, PageResult } from '../resource/ports.ts'
import type { Resource } from '../resource/resource.ts'
import { DEFAULT_METRICS, findMetric } from './metrics.ts'
import type { MetricDef } from './metrics.ts'
import { grade, summarize } from './automation-rate.ts'
import type { AutomationSummary, Grade, GradeInput } from './automation-rate.ts'
import type { HistoryEntry } from '../resource/resource.ts'
import type { WorkflowRegistry } from '../../workflow/engine.ts'

/**
 * 从历史记录里还原「Agent 初版」与「采纳那一刻的终版」。
 *
 * 历史是**逐字段 diff** 的序列，所以两个版本都要从当前值反向回放得到：
 * 把每一次变更倒着撤销回去。这比另存一份快照可靠——
 * 快照会和历史不一致，而不一致时没人知道该信哪个。
 *
 * 返回 null 表示这个工作项从未进入过终态，因此不进分母（§2.2）。
 */
function reconstruct(
  item: { attributes: Record<string, unknown>; createdBy: string; status: string },
  history: readonly HistoryEntry[],
  terminalStates: ReadonlySet<string>,
): Omit<GradeInput, 'now'> | null {
  const ordered = [...history].sort((a, b) => a.version - b.version)

  // ── 先定位「采纳」与「推翻」两个时刻 ──
  //
  // 采纳 = **首次**进入终态。之后首次离开终态 = 被推翻。
  // 两个都取首次：口径管的是"采纳后 7 天内"，
  // 取最近一次会让每次推翻都刷新一遍窗口（见 GradeInput.acceptedAt）
  let acceptedAt: Date | null = null
  let acceptanceVersion = 0
  let overturnedAt: Date | null = null
  for (const entry of ordered) {
    const statusChange = entry.changes.find((c) => c.path === 'status')
    if (statusChange === undefined) continue
    const to = String(statusChange.to)
    if (acceptedAt === null) {
      if (terminalStates.has(to)) {
        acceptedAt = entry.changedAt
        acceptanceVersion = entry.version
      }
    } else if (overturnedAt === null && !terminalStates.has(to)) {
      overturnedAt = entry.changedAt
    }
  }

  if (acceptedAt === null) {
    // 创建时就落在终态的对象没有状态变更记录。它确实进过终态，
    // 只是没有"迁移"这一步——用创建时刻当采纳时刻
    const creation = ordered[0]
    if (!terminalStates.has(item.status) || creation === undefined) return null
    acceptedAt = creation.changedAt
    acceptanceVersion = creation.version
  }

  // ── 再还原两个版本 ──
  const cur: Record<string, unknown> = { ...item.attributes }
  let final: Record<string, unknown> | null = null

  for (const entry of [...ordered].reverse()) {
    // 撤到采纳那一步之后，当前快照就是"进入终态时的最终版本"（§2 编辑幅度定义）。
    // 用当前属性当终版是错的：采纳之后的编辑不是"采纳前的人工修改"，
    // 把它算进去会让一个原样接受、后来才被人补充的产出莫名其妙降级
    if (final === null && entry.version <= acceptanceVersion) final = { ...cur }
    for (const change of entry.changes) {
      if (!change.path.startsWith('attributes.')) continue
      const key = change.path.slice('attributes.'.length)
      if (change.from === null || change.from === undefined) delete cur[key]
      else cur[key] = change.from
    }
  }

  return {
    // 创建者是 agent:// 才算 Agent 产出（§2.1：无关联 AgentRun 即 L0）
    agent: item.createdBy.startsWith('agent://') ? item.createdBy : null,
    firstAttributes: cur,
    finalAttributes: final ?? { ...item.attributes },
    acceptedAt,
    overturnedAt,
  }
}

function titleOf(item: { attributes: Record<string, unknown>; id: string }): string {
  return String(item.attributes['title'] ?? item.attributes['question'] ?? item.id)
}

/**
 * 指标服务（FR-DASH-005/006/010/011）。
 *
 * 它薄得几乎不像一个服务，那是刻意的：所有的读都转交给 `ResourceService`，
 * 于是权限、租户隔离、软删除过滤全部沿用主路径的实现。
 * 指标层**不自己碰数据库**——一旦它开始直接查表，
 * 就必须自己重新实现一遍权限，而重新实现的那份迟早会漏。
 */

export type MetricScopeFilter = {
  project?: string | undefined
  workspace?: string | undefined
}

export type MetricValue = {
  id: string
  title: string
  definition: string
  direction: MetricDef['direction']
  /** 单值指标的总数；分组指标是各组之和 */
  total: number
  /** 分组指标的分布；单值指标为空数组 */
  groups: GroupCount[]
  /** 算这个数字的时刻。现算的，所以就是"现在" */
  computedAt: Date
}

/** §2.4：计入自动化率的对象类型 */
const COUNTED_TYPES = ['Requirement', 'Story', 'Task', 'Decision', 'Knowledge'] as const

const PAGE_SIZE = 200
const HISTORY_SIZE = 200

/**
 * 一次计算最多检查多少个工作项。
 *
 * 这条上界是真实存在的代价：每个工作项都要拉一次历史并做一次编辑距离，
 * 全租户扫描不是免费的。定成常量而不是"扫到底"，是因为一个会随数据量
 * 线性变慢、最终超时的指标接口，坏起来的样子是整个 Dashboard 打不开。
 * 命中上界时结果里的 `truncated` 会是 true——**慢和少算都可以接受，
 * 不声不响地少算不可以**。
 */
const MAX_SCANNED = 5_000

export type AutomationRateOptions = {
  types?: readonly string[]
  now?: Date
  /** 「同期」的定义：按**采纳时刻**落窗。不传即全部历史 */
  period?: Period | undefined
  maxItems?: number
}

export type Period = { from?: Date | undefined; to?: Date | undefined }

function inPeriod(at: Date, period: Period | undefined): boolean {
  if (period === undefined) return true
  if (period.from !== undefined && at < period.from) return false
  // 右端开区间：`to` 传当天零点时，"到 8 月 1 日"不该悄悄含进 8 月 1 日当天
  if (period.to !== undefined && at >= period.to) return false
  return true
}

export type GradedItem = Grade & { id: string; type: string; title: string; acceptedAt: Date }

export type AutomationRateResult = AutomationSummary & {
  items: GradedItem[]
  /** 扫描命中了上界，结果不完整 */
  truncated: boolean
  /** 实际检查过的工作项数量 */
  scanned: number
}

export class DashboardService {
  readonly #resources: ResourceService
  readonly #workflows: WorkflowRegistry | undefined

  constructor(resources: ResourceService, workflows?: WorkflowRegistry) {
    this.#resources = resources
    this.#workflows = workflows
  }

  catalogue(): readonly MetricDef[] {
    return DEFAULT_METRICS
  }

  /**
   * Automation Rate（FR-DASH-015，口径见 docs/prd/11-dashboard.md §2）。
   *
   * 它和别的指标不同：不是一次分组计数，而要逐个工作项去比对
   * 「Agent 的初版」与「进入终态时的终版」。所以单独一条方法，
   * 而不是硬塞进 MetricDef 的查询模型里——
   * 硬塞进去只会让那个模型变成一个什么都能表达、因而什么都说不清的东西。
   */
  async automationRate(
    caller: Caller,
    scope: MetricScopeFilter,
    options: AutomationRateOptions = {},
  ): Promise<AutomationRateResult> {
    const now = options.now ?? new Date()
    const types = options.types ?? COUNTED_TYPES
    const maxItems = options.maxItems ?? MAX_SCANNED
    const graded: GradedItem[] = []
    let scanned = 0
    let truncated = false

    for (const type of types) {
      const terminal = new Set(this.#terminalStates(type))
      if (terminal.size === 0) continue

      // 注意这里**不按当前状态过滤**。
      //
      // 分母是「同期**进入过**终态的全部工作项」（§2.2），
      // 而一个被推翻的工作项此刻正躺在非终态里。按 status 过滤的话，
      // 它会同时从分子和分母消失——自动化率照样下降，看起来"生效了"，
      // 但 Rework Rate 恒为 0，回溯修正（FR-DASH-016）根本无从发生。
      // 这是一次真实的返工：FR-DASH-015 那版就是这么写的
      let cursor: string | undefined = undefined
      for (;;) {
        const page: PageResult<Resource> = await this.#resources.query(
          caller,
          { ...definedOnly(scope), type },
          { size: PAGE_SIZE, cursor },
        )

        for (const item of page.items) {
          if (scanned >= maxItems) {
            truncated = true
            break
          }
          scanned++
          const history = await this.#resources.history(caller, item.id, { size: HISTORY_SIZE })
          const input = reconstruct(item, history.items, terminal)
          // 从未进入终态 → 不进分母
          if (input === null) continue
          // 「同期」：按采纳时刻落窗。没有窗口就是全部历史
          if (!inPeriod(input.acceptedAt, options.period)) continue
          graded.push({
            id: item.id,
            type: item.type,
            title: titleOf(item),
            acceptedAt: input.acceptedAt,
            ...grade({ ...input, now }),
          })
        }

        if (truncated || page.nextCursor === null) break
        cursor = page.nextCursor
      }
      if (truncated) break
    }

    return {
      ...summarize(graded),
      // 扫描被截断时**明说**，不要安静地少算。
      // 一个少算了的北极星指标看起来完全正常，而它正是最不该被默默相信的数字
      truncated,
      scanned,
      items: graded,
    }
  }

  /** 某个类型的终态集合。取自状态机定义，不在这里另写一份清单 */
  #terminalStates(type: string): string[] {
    const lifecycle = this.#workflows?.forEntityType(type)
    if (lifecycle == null) return []
    return lifecycle.states.filter((s) => s.terminal === true).map((s) => s.name)
  }

  async value(caller: Caller, metricId: string, scope: MetricScopeFilter): Promise<MetricValue> {
    const metric = this.#require(metricId)
    const filter = { ...metric.filter, ...definedOnly(scope) }

    // 求和 / 求平均：数条数答不了"花了多少钱"
    if (metric.aggregate !== undefined) {
      const { value, counted } = await this.#resources.aggregate(
        caller,
        filter,
        metric.aggregate.fn,
        metric.aggregate.attribute,
      )
      return {
        id: metric.id,
        title: metric.title,
        definition: metric.definition,
        direction: metric.direction,
        total: value,
        // 参与计算的条数一起给：平均值背后是 3 条还是 300 条，
        // 决定了它值不值得当回事
        groups: [{ key: 'counted', count: counted }],
        computedAt: new Date(),
      }
    }

    // 比率：分子分母共用同一个 filter 基底，因此不可能对不上
    if (metric.ratio !== undefined) {
      const denominator = await this.#countOf(caller, filter)
      const numerator = await this.#countOf(caller, { ...filter, ...metric.ratio.numerator })
      return {
        id: metric.id,
        title: metric.title,
        definition: metric.definition,
        direction: metric.direction,
        // 分母为 0 时是 0 而不是 NaN——界面上 NaN 是一片吓人的空白
        total: denominator === 0 ? 0 : Math.round((numerator / denominator) * 10_000) / 10_000,
        groups: [
          { key: 'numerator', count: numerator },
          { key: 'denominator', count: denominator },
        ],
        computedAt: new Date(),
      }
    }

    // 分组与不分组都走同一条 countGrouped：不分组时按 type 分组再求和。
    // 少一条代码路径，就少一个"两处算得不一样"的可能
    const groups = await this.#resources.countGrouped(caller, filter, metric.groupBy ?? 'type')
    const total = groups.reduce((sum, g) => sum + g.count, 0)

    return {
      id: metric.id,
      title: metric.title,
      definition: metric.definition,
      direction: metric.direction,
      total,
      groups: metric.groupBy === undefined ? [] : groups,
      computedAt: new Date(),
    }
  }

  /**
   * 下钻（FR-DASH-006）。
   *
   * 用**同一个 filter** 跑一次普通查询。指标和明细因此不可能对不上——
   * 它们本来就是一次查询的两种投影。
   */
  async breakdown(
    caller: Caller,
    metricId: string,
    scope: MetricScopeFilter,
    page: Page,
    group?: string,
  ): Promise<PageResult<Resource>> {
    const metric = this.#require(metricId)
    const filter = { ...metric.filter, ...definedOnly(scope) }

    // 点的是分布里的某一格，就再按那一格收窄
    if (group !== undefined && metric.groupBy !== undefined) {
      Object.assign(filter, groupFilter(metric.groupBy, group))
    }
    return this.#resources.query(caller, filter, page)
  }

  async #countOf(caller: Caller, filter: Record<string, unknown>): Promise<number> {
    const groups = await this.#resources.countGrouped(caller, filter, 'type')
    return groups.reduce((sum, g) => sum + g.count, 0)
  }

  #require(metricId: string): MetricDef {
    const metric = findMetric(metricId)
    if (metric === undefined) {
      // 404 并把已知指标列出来：拼错一个指标 id 时，
      // 光说"没找到"要人去翻源码才知道正确的写法
      throw new DomainError('not_found', `unknown metric: ${metricId}`, 404, {
        known: DEFAULT_METRICS.map((m) => m.id),
      })
    }
    return metric
  }
}

/** 把 groupBy 的某一格转成过滤条件 */
function groupFilter(groupBy: string, key: string): Record<string, unknown> {
  switch (groupBy) {
    case 'status':
      return { status: [key] }
    case 'type':
      return { type: key }
    case 'owner':
      return { owner: key }
    case 'project':
      return { project: key }
    default:
      return {}
  }
}

/**
 * 只保留真的传了的字段。
 *
 * `{...metric.filter, ...scope}` 里如果 scope 带着 `project: undefined`，
 * 会把 metric.filter 自己的 project 覆盖成 undefined——
 * "某个项目的指标"于是悄悄变成"全租户的指标"，数字更大，而且看不出错。
 *
 * **老实说：目前没有一个内置指标在自己的 filter 里写 project，
 * 所以这个函数现在是防御性的，删掉它当前所有用例照样绿**（试过）。
 * 留着是因为第一个自带 project 条件的指标出现时，这个坑会当场生效，
 * 而它的表现是"数字偏大"——不会报错，只会让人做错决定。
 */
function definedOnly(scope: MetricScopeFilter): Record<string, string> {
  const out: Record<string, string> = {}
  if (scope.project !== undefined) out['project'] = scope.project
  if (scope.workspace !== undefined) out['workspace'] = scope.workspace
  return out
}
