import type { StateGroup } from '../../workflow/types.ts'
import { ValidationError } from '../../platform/errors.ts'

/**
 * 自定义分析的**规格**（对照 docs/0806planeFeatures 的 16 × 9 组合空间）。
 *
 * 这一层是纯的：只定义维度、指标和它们的合法组合，不碰数据库。
 * 求值需要的一切（过滤条件、状态组映射、当前时刻）由调用方装配后传进来，
 * 和工作流引擎是同一个套路——于是 16 × 9 = 144 种组合可以被单独测试，
 * 而不需要先造出一个租户的数据。
 *
 * 为什么值得做成一个可组合的空间，而不是把常用的几张图写死：
 * 写死的话，每一个新问题都要改一次代码、发一次版。而分析的用处
 * 恰恰在于**问出没预料到的问题**——"谁手上并行任务过多"这种问题，
 * 提出来的时候通常已经晚了，等不起一个版本。
 */

/**
 * X 轴：**按什么分**。16 种。
 *
 * 分成五类不是为了好看，是因为它们的取数路径完全不同：
 * 状态类要查状态机，属性类读 attributes，人员类要考虑 assignee 与 owner
 * 的差别，归属类要走关系表，时间类要先分桶。
 */
export const CHART_X_AXES = [
  // 状态类
  'STATES',
  'STATE_GROUPS',
  // 属性类
  'PRIORITY',
  'LABELS',
  'ESTIMATE_POINTS',
  'WORK_ITEM_TYPES',
  // 人员类
  'ASSIGNEES',
  'CREATED_BY',
  // 归属类
  'CYCLES',
  'MODULES',
  'PROJECTS',
  'EPICS',
  // 时间类
  'START_DATE',
  'TARGET_DATE',
  'CREATED_AT',
  'COMPLETED_AT',
] as const

export type ChartXAxis = (typeof CHART_X_AXES)[number]

/** 时间类维度。它们额外接受一档聚合粒度，其余维度不接受 */
export const DATE_X_AXES: readonly ChartXAxis[] = [
  'START_DATE',
  'TARGET_DATE',
  'CREATED_AT',
  'COMPLETED_AT',
]

export function isDateAxis(axis: ChartXAxis): boolean {
  return DATE_X_AXES.includes(axis)
}

/**
 * Y 轴：**数什么**。9 种。
 *
 * 六个是带条件的计数，一个是求和，两个是按类型筛的计数。
 * 全都落在同一条 SQL 上（`COUNT(*) FILTER (WHERE …)`），
 * 于是同一张图里换 Y 轴不会换一条取数路径——换路径就意味着
 * 两个指标可能对不上，而对不上的两个数字没有人能判断哪个是对的。
 */
export const CHART_Y_METRICS = [
  'WORK_ITEM_COUNT',
  'ESTIMATE_POINT_COUNT',
  'PENDING_WORK_ITEM_COUNT',
  'IN_PROGRESS_WORK_ITEM_COUNT',
  'COMPLETED_WORK_ITEM_COUNT',
  'WORK_ITEM_DUE_TODAY_COUNT',
  'WORK_ITEM_DUE_THIS_WEEK_COUNT',
  'BLOCKED_WORK_ITEM_COUNT',
  'EPIC_WORK_ITEM_COUNT',
] as const

export type ChartYMetric = (typeof CHART_Y_METRICS)[number]

export const DATE_GROUPINGS = ['DAY', 'WEEK', 'MONTH', 'YEAR'] as const
export type DateGrouping = (typeof DATE_GROUPINGS)[number]

/** 时间范围。对照 Plane 的 ANALYTICS_DURATION_FILTER_OPTIONS */
export const DURATIONS = ['YESTERDAY', 'LAST_7_DAYS', 'LAST_30_DAYS', 'LAST_3_MONTHS'] as const
export type Duration = (typeof DURATIONS)[number]

/**
 * "待办"包含哪几个状态组。
 *
 * `Triage` 也算：一条还没分诊的东西**是待办的**，只是还没人决定它要不要做。
 * 把它排除掉的话，一个积压了两百条待分诊意见的团队，
 * 在待办数上看起来和一个队列清空的团队一模一样。
 */
export const PENDING_GROUPS: readonly StateGroup[] = ['Triage', 'Backlog', 'Unstarted']

export type ChartSpec = {
  xAxis: ChartXAxis
  yMetric: ChartYMetric
  /** 二次分组，取值同样来自 16 种 X 轴维度。给了就产出堆叠 / 分组图 */
  groupBy?: ChartXAxis | undefined
  /** 时间类 X 轴的聚合粒度。非时间轴上给了会被拒绝，而不是被忽略 */
  dateGrouping?: DateGrouping | undefined
  duration?: Duration | undefined
}

/**
 * 校验一份规格。
 *
 * 三条规则，每条都对应一种"图能画出来但没有意义"的情形。
 * 全部在**求值之前**判掉：一张画错的图不会报错，它只会被相信。
 */
export function assertValidSpec(spec: ChartSpec): void {
  if (!CHART_X_AXES.includes(spec.xAxis)) {
    throw new ValidationError(`unknown x axis: ${spec.xAxis}`, { allowed: [...CHART_X_AXES] })
  }
  if (!CHART_Y_METRICS.includes(spec.yMetric)) {
    throw new ValidationError(`unknown y metric: ${spec.yMetric}`, { allowed: [...CHART_Y_METRICS] })
  }
  if (spec.groupBy !== undefined && !CHART_X_AXES.includes(spec.groupBy)) {
    throw new ValidationError(`unknown group_by dimension: ${spec.groupBy}`, {
      allowed: [...CHART_X_AXES],
    })
  }
  // 按同一个维度分两次，产出的每一组都只有一个柱子。
  // 静默接受的话，使用者会以为"这个组合就是长这样"
  if (spec.groupBy !== undefined && spec.groupBy === spec.xAxis) {
    throw new ValidationError('group_by must differ from the x axis', { xAxis: spec.xAxis })
  }
  if (spec.dateGrouping !== undefined && !isDateAxis(spec.xAxis)) {
    throw new ValidationError(
      `date grouping only applies to a date x axis, and "${spec.xAxis}" is not one`,
      { dateAxes: [...DATE_X_AXES] },
    )
  }
  if (spec.dateGrouping !== undefined && !DATE_GROUPINGS.includes(spec.dateGrouping)) {
    throw new ValidationError(`unknown date grouping: ${spec.dateGrouping}`, {
      allowed: [...DATE_GROUPINGS],
    })
  }
  if (spec.duration !== undefined && !DURATIONS.includes(spec.duration)) {
    throw new ValidationError(`unknown duration: ${spec.duration}`, { allowed: [...DURATIONS] })
  }
}

/** 时间轴的默认粒度。不给粒度时按天分桶 */
export function effectiveGrouping(spec: ChartSpec): DateGrouping | null {
  if (!isDateAxis(spec.xAxis)) return null
  return spec.dateGrouping ?? 'DAY'
}

export type TimeWindow = { from: Date; to: Date }

/**
 * 把时间范围选项换算成一个具体区间。
 *
 * 区间是**左闭右开**的，且以调用方传进来的 `now` 为基准而不是读时钟：
 * 一份报表在不同的机器上、跨过午夜跑出来，结果必须一样。
 * 昨天就是昨天，不能因为任务跑到了 00:01 就变成前天。
 */
export function windowOf(duration: Duration, now: Date): TimeWindow {
  const startOfToday = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  )
  const day = 24 * 60 * 60 * 1000

  switch (duration) {
    case 'YESTERDAY':
      // 只有昨天一整天，不含今天：今天还没过完，把它和整日放在一起比会显得低
      return { from: new Date(startOfToday.getTime() - day), to: startOfToday }
    case 'LAST_7_DAYS':
      return { from: new Date(startOfToday.getTime() - 7 * day), to: new Date(now.getTime() + 1) }
    case 'LAST_30_DAYS':
      return { from: new Date(startOfToday.getTime() - 30 * day), to: new Date(now.getTime() + 1) }
    case 'LAST_3_MONTHS': {
      const from = new Date(startOfToday)
      from.setUTCMonth(from.getUTCMonth() - 3)
      return { from, to: new Date(now.getTime() + 1) }
    }
    default: {
      const exhaustive: never = duration
      throw new Error(`unhandled duration: ${String(exhaustive)}`)
    }
  }
}

/**
 * 一个分组格子。`group` 为 null 表示没有二次分组。
 *
 * `x` 一律是字符串：日期已经分好桶（`2026-08-06` / `2026-W32` / `2026-08`），
 * 数值也转成了字符串。让调用方拿到混合类型的话，排序和相等判断
 * 在每个消费端都要重写一遍，而它们不会写得一样。
 */
export type ChartCell = {
  x: string
  group: string | null
  value: number
}

/**
 * 组装成前端直接可画的形状。
 *
 * 出参刻意不是稀疏的：每一个 x 上，**每一个出现过的分组都有一个数**，
 * 缺的补 0。稀疏数据交给图表库的结果是堆叠图的层会错位——
 * 某个 x 少了一层，上面的层就会下移，而图看起来完全正常。
 */
export type ChartSeries = {
  /** X 轴刻度，已排序 */
  keys: string[]
  /** 分组名。没有二次分组时是 `['value']` 一项 */
  groups: string[]
  /** rows[i] 对应 keys[i]，键为分组名 */
  rows: Array<Record<string, string | number>>
  total: number
}

export const NO_GROUP = 'value'
/** 空值的统一显示名。散着写 '(none)' / '未指定' / '' 的话，同一批空值会分成三桶 */
export const NONE_KEY = '(none)'

export function toSeries(cells: readonly ChartCell[], spec: ChartSpec): ChartSeries {
  const grouped = spec.groupBy !== undefined
  const keys: string[] = []
  const groups: string[] = []
  const byKey = new Map<string, Map<string, number>>()

  for (const cell of cells) {
    const group = grouped ? (cell.group ?? NONE_KEY) : NO_GROUP
    if (!byKey.has(cell.x)) {
      byKey.set(cell.x, new Map())
      keys.push(cell.x)
    }
    if (!groups.includes(group)) groups.push(group)
    const bucket = byKey.get(cell.x) as Map<string, number>
    bucket.set(group, (bucket.get(group) ?? 0) + cell.value)
  }

  // 时间轴按字典序即时间序（分桶格式是有意选的，见 bucket 格式说明）；
  // 其余维度按总量降序——读图的人第一眼要看的是最大的那个
  if (isDateAxis(spec.xAxis)) {
    keys.sort()
  } else {
    keys.sort((a, b) => sumOf(byKey.get(b)) - sumOf(byKey.get(a)) || a.localeCompare(b))
  }
  if (groups.length === 0) groups.push(grouped ? NONE_KEY : NO_GROUP)
  groups.sort()

  let total = 0
  const rows = keys.map((key) => {
    const bucket = byKey.get(key) ?? new Map<string, number>()
    const row: Record<string, string | number> = { key }
    for (const group of groups) {
      const value = bucket.get(group) ?? 0
      row[group] = value
      total += value
    }
    return row
  })

  return { keys, groups, rows, total }
}

function sumOf(bucket: Map<string, number> | undefined): number {
  if (bucket === undefined) return 0
  let sum = 0
  for (const value of bucket.values()) sum += value
  return sum
}
