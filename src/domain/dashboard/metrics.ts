import type { GroupableField, ResourceFilter } from '../resource/ports.ts'

/**
 * 指标目录（FR-DASH-001/002/003/005/006）。
 *
 * 核心设计：**一个指标就是一次查询**，不是一张被人填出来的表。
 *
 * 由此三件事同时成立，而且不是靠纪律，是靠结构：
 *
 * 1. **不存在人工填报入口**（FR-DASH-005）。指标没有写路径——
 *    没有"指标"这张表，也就没有任何东西可以被填。
 * 2. **下钻必然与指标一致**（FR-DASH-006）。明细就是同一个 filter
 *    不做聚合跑一遍。两套条件才会出现"指标显示 12、点开看到 9"，
 *    而那种不一致没人会报 bug，只会让人默默不再信这个数字。
 * 3. **权限自动生效**（FR-DASH-010）。查询走 `service.query`，
 *    也就是走 PDP。指标不需要自己实现一套权限——
 *    重新实现一遍必然和主路径漂移，而漂移的方向通常是漏。
 *
 * 新鲜度（FR-DASH-011 要求 ≤ 1 分钟）：现算的延迟是 0。
 * 规模再大一个量级时需要物化，那时这份定义就是物化任务的输入。
 */

export type MetricScope = 'project' | 'team' | 'agent' | 'knowledge'

export type MetricDef = {
  id: string
  title: string
  scope: MetricScope
  /** 一句话说清这个数字**怎么算的**。口径不写下来，两个人会读出两个意思 */
  definition: string
  /** 指标与其下钻明细共用的过滤条件 */
  filter: ResourceFilter
  /**
   * 有 groupBy 就是一组分布值（如按状态分布），没有就是一个总数。
   * 刻意不支持任意表达式：指标要能被读懂、被复算、被质疑。
   */
  groupBy?: GroupableField
  /**
   * 对某个**具名属性**求和 / 求平均，而不是数条数。
   *
   * "花了多少钱"和"有几次 Run"是两个问题，前者数条数答不了。
   * 仍然只接受属性名，不接受表达式——`sum(cost * 1.2 + fee)` 这种东西
   * 一旦允许，指标就不再是"能被读懂、被复算、被质疑"的了。
   */
  aggregate?: { fn: 'sum' | 'avg'; attribute: string }
  /**
   * 比率：分子是这个更窄的条件，分母是本指标自己的 filter。
   *
   * 分子分母**共用一个 filter 基底**，所以不可能出现
   * "分子统计了 8 月、分母统计了全年"这种对不上的比率——
   * 而那种错算出来的数字看起来完全正常。
   */
  ratio?: { numerator: ResourceFilter }
  /** 数值越大越好还是越小越好。异常检测与趋势展示需要知道方向 */
  direction: 'higher-is-better' | 'lower-is-better' | 'neutral'
}

/**
 * 内置指标。
 *
 * 刻意长得慢：每加一个指标都是在说"这个数字值得被盯着"。
 * 一屏二十个数字的看板，等于没有看板。
 */
export const DEFAULT_METRICS: readonly MetricDef[] = [
  // ── Project 视角 ──────────────────────────────────────
  {
    id: 'project.requirements.by-status',
    title: '需求状态分布',
    scope: 'project',
    definition: '项目下所有未删除 Requirement，按当前状态分组计数',
    filter: { type: 'Requirement' },
    groupBy: 'status',
    direction: 'neutral',
  },
  {
    id: 'project.stories.in-progress',
    title: '进行中的 Story',
    scope: 'project',
    definition: '状态为 InProgress 的 Story 数量',
    filter: { type: 'Story', status: ['InProgress'] },
    direction: 'neutral',
  },
  {
    id: 'project.tasks.blocked',
    title: '被阻塞的任务',
    scope: 'project',
    definition: '状态为 Blocked 的 Task 数量。持续大于零意味着流动出了问题',
    filter: { type: 'Task', status: ['Blocked'] },
    direction: 'lower-is-better',
  },
  {
    id: 'project.tasks.by-status',
    title: '任务状态分布',
    scope: 'project',
    definition: '项目下所有未删除 Task，按当前状态分组计数',
    filter: { type: 'Task' },
    groupBy: 'status',
    direction: 'neutral',
  },
  {
    id: 'project.decisions.accepted',
    title: '已生效的决策',
    scope: 'project',
    definition: '状态为 Accepted 的 Decision 数量（不含 Superseded）',
    filter: { type: 'Decision', status: ['Accepted'] },
    direction: 'neutral',
  },

  // ── Team 视角 ─────────────────────────────────────────
  {
    id: 'team.tasks.by-owner',
    title: '任务负载分布',
    scope: 'team',
    definition: '未完成的 Task 按负责人分组计数。看的是分布是否失衡，不是产量',
    filter: { type: 'Task', status: ['Todo', 'Doing', 'Review', 'Testing', 'Blocked'] },
    groupBy: 'owner',
    direction: 'neutral',
  },

  // ── Agent 视角（FR-DASH-003） ─────────────────────────
  {
    id: 'agent.runs.by-status',
    title: 'Agent Run 状态分布',
    scope: 'agent',
    definition: '所有 AgentRun 按状态分组计数',
    filter: { type: 'AgentRun' },
    groupBy: 'status',
    direction: 'neutral',
  },
  {
    id: 'agent.runs.awaiting-review',
    title: '等待人工审阅的产出',
    scope: 'agent',
    definition:
      '停在 AwaitingReview 的 AgentRun 数量。' +
      '它是人机协作真实成本的度量——这个数字一直涨，说明 Agent 在制造审阅负担而不是减轻它',
    filter: { type: 'AgentRun', status: ['AwaitingReview'] },
    direction: 'lower-is-better',
  },
  {
    id: 'agent.drafts.pending',
    title: 'Agent 产出的待处理草稿',
    scope: 'agent',
    definition: '带 agent-generated 标签且仍在 Draft 状态的对象',
    filter: { labels: ['agent-generated'], status: ['Draft'] },
    direction: 'lower-is-better',
  },

  // ── Knowledge 视角 ────────────────────────────────────
  {
    id: 'knowledge.by-status',
    title: '知识状态分布',
    scope: 'knowledge',
    definition: '所有 Knowledge 按状态分组计数。NeedsReview 堆积意味着知识在腐化',
    filter: { type: 'Knowledge' },
    groupBy: 'status',
    direction: 'neutral',
  },

  // ── Project 视角（FR-DASH-001：8 项） ──────────────────
  {
    id: 'project.burndown.remaining',
    title: 'Burn Down · 剩余工作量',
    scope: 'project',
    definition: '未进入终态的 Story 的 storyPoint 之和',
    filter: { type: 'Story', status: ['Draft', 'Ready', 'InProgress', 'Review'] },
    aggregate: { fn: 'sum', attribute: 'storyPoint' },
    direction: 'lower-is-better',
  },
  {
    id: 'project.velocity.completed-points',
    title: 'Velocity · 已完成点数',
    scope: 'project',
    definition: '已关闭 Sprint 的 completedPoints 之和',
    filter: { type: 'Sprint', status: ['Closed'] },
    aggregate: { fn: 'sum', attribute: 'completedPoints' },
    direction: 'higher-is-better',
  },
  {
    id: 'project.milestones.on-track',
    title: 'Milestone · 按期率',
    scope: 'project',
    // AtRisk 也算进分母：把有风险的里程碑排除掉，
    // 这个数字会在最需要示警的时候反而变好看
    definition: 'Reached / 全部已判定的 Milestone（Reached + Missed + AtRisk）',
    filter: { type: 'Milestone', status: ['Reached', 'Missed', 'AtRisk'] },
    ratio: { numerator: { status: ['Reached'] } },
    direction: 'higher-is-better',
  },
  {
    id: 'project.risks.open',
    title: 'Risk · 未关闭的风险',
    scope: 'project',
    definition: '尚未 Closed / Accepted 的 Risk 数量，按当前状态分组',
    filter: { type: 'Risk', status: ['Identified', 'Mitigating'] },
    groupBy: 'status',
    direction: 'lower-is-better',
  },
  {
    id: 'project.budget.consumed',
    title: 'Budget · 已消耗',
    scope: 'project',
    definition: '未关闭 Budget 的 consumed 之和',
    filter: { type: 'Budget', status: ['Active', 'Exceeded'] },
    aggregate: { fn: 'sum', attribute: 'consumed' },
    direction: 'lower-is-better',
  },
  {
    id: 'project.scope-change.superseded',
    title: 'Scope Change · 被取代的需求',
    scope: 'project',
    // 需求被 supersede 就是一次范围变更。数它比去翻历史便宜，
    // 而且口径不含糊
    definition: '状态为 Superseded 的 Requirement 数量',
    filter: { type: 'Requirement', status: ['Superseded'] },
    direction: 'lower-is-better',
  },
  {
    id: 'project.cycle-time.done-stories',
    title: 'Cycle Time · 已完成 Story',
    scope: 'project',
    definition: '已 Done 的 Story 数量。时长分布需要按 status_since 展开，见下方说明',
    filter: { type: 'Story', status: ['Done'] },
    direction: 'neutral',
  },
  {
    id: 'project.lead-time.finished-requirements',
    title: 'Lead Time · 已交付需求',
    scope: 'project',
    definition: '状态为 Finished 的 Requirement 数量',
    filter: { type: 'Requirement', status: ['Finished'] },
    direction: 'neutral',
  },

  // ── Team 视角（FR-DASH-002：6 项） ─────────────────────
  {
    id: 'team.capacity.planned',
    title: 'Capacity · 计划容量',
    scope: 'team',
    definition: '进行中 Sprint 的 capacity 之和',
    filter: { type: 'Sprint', status: ['Active'] },
    aggregate: { fn: 'sum', attribute: 'capacity' },
    direction: 'neutral',
  },
  {
    id: 'team.review.waiting',
    title: 'Review Time · 等待评审',
    scope: 'team',
    definition: '停在 Review 状态的 Task 数量',
    filter: { type: 'Task', status: ['Review'] },
    direction: 'lower-is-better',
  },
  {
    id: 'team.wip.in-progress',
    title: 'WIP · 在制品',
    scope: 'team',
    definition: '处于 Doing / Review / Testing 的 Task 数量',
    filter: { type: 'Task', status: ['Doing', 'Review', 'Testing'] },
    direction: 'lower-is-better',
  },
  {
    id: 'team.blocked.count',
    title: 'Blocked · 被阻塞的任务',
    scope: 'team',
    definition: '状态为 Blocked 的 Task 数量',
    filter: { type: 'Task', status: ['Blocked'] },
    direction: 'lower-is-better',
  },
  {
    id: 'team.human-vs-agent',
    title: 'Human vs Agent · 产出占比',
    scope: 'team',
    // 这个数字和 Automation Rate 不是一回事：它数的是**谁创建的**，
    // 不判断人后来改了多少。两个都要，因为"Agent 起了多少稿"
    // 和"多少稿被原样接受"是两个问题
    definition: 'Agent 创建的 Story / 全部 Story（按创建者标签）',
    filter: { type: 'Story' },
    ratio: { numerator: { labels: ['agent-generated'] } },
    direction: 'neutral',
  },

  // ── Agent 视角（FR-DASH-003：8 项） ────────────────────
  //
  // Automation Rate 是第 8 项，也是北极星。它不在这张表里——
  // 它的形状不一样（分级分布、口径版本、临时计数），
  // 硬塞进通用模型只会让这个模型变成什么都能装的容器。
  // 走 `GET /v1/metrics:automation-rate`，Rework Rate 一并在那里返回。
  {
    id: 'agent.cost.total',
    title: 'Agent 成本',
    scope: 'agent',
    definition: '全部 AgentRun 的 costUsd 之和（美元）',
    filter: { type: 'AgentRun' },
    aggregate: { fn: 'sum', attribute: 'costUsd' },
    direction: 'lower-is-better',
  },
  {
    id: 'agent.tokens.total',
    title: 'Token 消耗',
    scope: 'agent',
    definition: '全部 AgentRun 的 tokensUsed 之和',
    filter: { type: 'AgentRun' },
    aggregate: { fn: 'sum', attribute: 'tokensUsed' },
    direction: 'lower-is-better',
  },
  {
    id: 'agent.success-rate',
    title: 'Run 成功率',
    scope: 'agent',
    // 分母是**已经跑完的** Run。把 Queued / Running 算进分母，
    // 成功率会随着排队长度上下跳，而那和成功不成功毫无关系
    definition: 'Succeeded / 已进入终态的 AgentRun（Succeeded + Failed + Cancelled）',
    filter: { type: 'AgentRun', status: ['Succeeded', 'Failed', 'Cancelled'] },
    ratio: { numerator: { status: ['Succeeded'] } },
    direction: 'higher-is-better',
  },
  {
    id: 'agent.acceptance-rate',
    title: '产出采纳率',
    scope: 'agent',
    // 只看走到过人工审阅的那些：Autonomous 模式直接 Succeeded，
    // 把它们算进分母等于把"没人看过"算成"被采纳了"
    definition: 'Succeeded / 曾进入 AwaitingReview 的 Run（Succeeded + Failed）',
    filter: { type: 'AgentRun', status: ['AwaitingReview', 'Succeeded', 'Failed'] },
    ratio: { numerator: { status: ['Succeeded'] } },
    direction: 'higher-is-better',
  },
  {
    id: 'agent.latency.avg',
    title: 'Run 平均时延',
    scope: 'agent',
    definition: '已结算 Run 的 durationMs 平均值（毫秒）',
    filter: { type: 'AgentRun' },
    aggregate: { fn: 'avg', attribute: 'durationMs' },
    direction: 'lower-is-better',
  },
  {
    id: 'agent.ask-rate',
    title: '人工确认触发率',
    scope: 'agent',
    // 过高说明权限或护栏设的太紧，人被叫醒得太频繁；
    // 恒为零则说明护栏可能根本没生效
    definition: '待确认 / 全部人工确认单（Pending / 全部 Approval）',
    filter: { type: 'Approval' },
    ratio: { numerator: { status: ['Pending'] } },
    direction: 'lower-is-better',
  },
]

/**
 * 指标 id 必须唯一。
 *
 * 重复的 id 不会报错，只会让 `findMetric` 永远返回第一条、
 * 目录里出现两个同名条目——而"我明明改了这个指标的口径却不生效"
 * 是一个极难查的现象。加指标时撞了 id 在这里当场炸掉。
 * （这条是被自己撞出来的：新增 Agent 指标时重复定义了 agent.runs.by-status。）
 */
const duplicateIds = DEFAULT_METRICS.map((m) => m.id).filter(
  (id, i, all) => all.indexOf(id) !== i,
)
if (duplicateIds.length > 0) {
  throw new Error(`duplicate metric ids: ${[...new Set(duplicateIds)].join(', ')}`)
}

export function findMetric(id: string): MetricDef | undefined {
  return DEFAULT_METRICS.find((m) => m.id === id)
}
