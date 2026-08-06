import type { StateGroup } from '../../workflow/types.ts'
import type { ResourceFilter } from '../resource/ports.ts'
import type { ChartCell, ChartXAxis, ChartYMetric, DateGrouping, TimeWindow } from './spec.ts'

/**
 * 分析的取数端口。
 *
 * 单独一个端口而不是复用 `ResourceRepository.countGrouped`，是因为
 * 那个方法的 `GroupableField` 刻意只有四个值——注释里写着
 * "任意字段分组会变成一个没有边界的查询接口"，那句话仍然成立。
 * 这里要的正是一个**有边界但很宽**的分组能力：边界由 16 个具名维度定义，
 * 而不是由"任意字段"定义。两者不是一回事，所以不共用一个方法。
 *
 * 为什么必须下推到数据库：把行拉回内存里数，一个百万行的租户会把进程打死。
 * 这条约束在 `ResourceRepository.countGrouped` 的注释里立过，
 * 分析这条路径上只会更严重——它还带二次分组。
 */
export type StateGroupRow = {
  entityType: string
  status: string
  group: StateGroup
}

export type AnalyticsQuery = {
  /**
   * 过滤条件。**和列表接口共用同一个类型**——
   * 于是"图上这一格是哪些对象"点开之后，看到的一定是同一批。
   * 分成两套过滤器的话，指标算出 12 条、下钻看到 9 条，
   * 而这种不一致没人会当成 bug 报。
   */
  filter: ResourceFilter
  xAxis: ChartXAxis
  groupBy: ChartXAxis | null
  yMetric: ChartYMetric
  /** 时间类 X 轴的分桶粒度；非时间轴为 null */
  dateGrouping: DateGrouping | null
  /** 二次分组若也是时间轴，它的粒度 */
  groupDateGrouping: DateGrouping | null
  /**
   * (类型, 状态) → 状态组 的对照表，由工作流注册表装配后传进来。
   *
   * 必须带上类型：`Accepted` 在 Decision 上是 Completed，在 Risk 上是
   * Cancelled（"接受这个风险，不再缓解"）。只按状态名映射的话，
   * 这两者会被算成同一件事，而没有任何迹象。
   */
  stateGroups: readonly StateGroupRow[]
  /** 时间范围。作用在 created_at 上 */
  window: TimeWindow | null
  /** "今天到期""本周到期"这两个指标的基准时刻 */
  now: Date
}

export interface AnalyticsRepository {
  chart(query: AnalyticsQuery): Promise<ChartCell[]>
}
