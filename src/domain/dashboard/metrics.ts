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
]

export function findMetric(id: string): MetricDef | undefined {
  return DEFAULT_METRICS.find((m) => m.id === id)
}
