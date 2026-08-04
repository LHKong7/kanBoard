import { WorkflowRegistry } from './engine.ts'
import type { Lifecycle } from './types.ts'

/**
 * 默认生命周期（PRD 08 §1）。
 *
 * 这些是**默认值不是规定**：FR-WF-001 要求状态机可配置。
 * 但默认值要够真实——一套敷衍的默认状态机会逼所有人第一天就去改配置，
 * 那样"可配置"就成了"必须配置"。
 */

const DAY = 24 * 60 * 60 * 1000

export const TASK_LIFECYCLE: Lifecycle = {
  id: 'task-default',
  entityType: 'Task',
  initial: 'Todo',
  states: [
    { name: 'Todo' },
    {
      name: 'Doing',
      // 没有负责人的任务处于"进行中"是个谎言：它没有在进行
      requires: [{ kind: 'attributeSet', path: 'assignee' }],
      entryActions: [{ kind: 'stampNow', path: 'startedAt' }],
      sla: { maxDurationMs: 5 * DAY, onBreach: 'notify-owner' },
    },
    { name: 'Review' },
    { name: 'Testing' },
    {
      name: 'Blocked',
      // 不写明为什么阻塞的阻塞项，事后没有人能接手
      requires: [{ kind: 'attributeSet', path: 'blockReason' }],
      sla: { maxDurationMs: 2 * DAY, onBreach: 'escalate' },
    },
    {
      name: 'Done',
      entryActions: [
        { kind: 'stampNow', path: 'completedAt' },
        { kind: 'clearAttribute', path: 'blockReason' },
      ],
      terminal: true,
    },
    { name: 'Cancelled', terminal: true },
  ],
  transitions: [
    { from: ['Todo'], to: 'Doing', capability: 'Task.Execute' },
    { from: ['Doing'], to: 'Review' },
    { from: ['Review'], to: 'Doing', description: '评审打回' },
    { from: ['Review'], to: 'Testing' },
    { from: ['Testing'], to: 'Doing', description: '测试打回' },
    { from: ['Testing'], to: 'Done' },
    // 小改动允许直接完成，不强制走评审——强制会让人把它填成形式
    { from: ['Doing'], to: 'Done' },
    { from: ['Doing', 'Review', 'Testing'], to: 'Blocked' },
    { from: ['Blocked'], to: 'Doing' },
    { from: ['Todo', 'Doing', 'Review', 'Testing', 'Blocked'], to: 'Cancelled' },
    // 返工重开（ADR-0012）。任务天天被重开，在此之前系统无法表达这件事，
    // 于是自动化率里没有一次返工——不是因为没返工过
    { from: ['Done'], to: 'Doing', reopen: true, capability: 'Task.Execute', description: '返工重开' },
  ],
}

export const REQUIREMENT_LIFECYCLE: Lifecycle = {
  id: 'requirement-default',
  entityType: 'Requirement',
  initial: 'Draft',
  states: [
    { name: 'Draft' },
    {
      name: 'Review',
      requires: [{ kind: 'attributeSet', path: 'statement' }],
    },
    {
      name: 'Approved',
      entryActions: [{ kind: 'stampNow', path: 'approvedAt' }],
    },
    {
      name: 'Planning',
      // 进入规划意味着要拆 Story；没有拆解关系时推进是自欺欺人
      requires: [{ kind: 'hasRelation', type: 'implementedBy', direction: 'out' }],
    },
    { name: 'InProgress' },
    { name: 'Finished', terminal: true },
    { name: 'Rejected', terminal: true },
    { name: 'Superseded', terminal: true },
  ],
  transitions: [
    { from: ['Draft'], to: 'Review' },
    { from: ['Review'], to: 'Draft', description: '评审打回' },
    { from: ['Review'], to: 'Approved', capability: 'Requirement.Approve' },
    { from: ['Review'], to: 'Rejected', capability: 'Requirement.Approve' },
    { from: ['Approved'], to: 'Planning' },
    { from: ['Planning'], to: 'InProgress' },
    { from: ['InProgress'], to: 'Finished' },
    { from: ['Approved', 'Planning', 'InProgress'], to: 'Superseded' },
    // 谁有权批准，谁才有权推翻（ADR-0012）
    {
      from: ['Finished'],
      to: 'InProgress',
      reopen: true,
      capability: 'Requirement.Approve',
      description: '验收后返工',
    },
  ],
}

export const STORY_LIFECYCLE: Lifecycle = {
  id: 'story-default',
  entityType: 'Story',
  initial: 'Draft',
  states: [
    { name: 'Draft' },
    {
      name: 'Ready',
      requires: [
        // 没有拆出任务的 Story 不算就绪
        { kind: 'hasRelation', type: 'decomposedInto', direction: 'out' },
        // FR-DOM-004：没有验收标准就不能进入执行。
        //
        // 这一条以前**不存在**——那时 Ready 只查 decomposedInto，
        // 而代码注释却写着"FR-DOM-004"。引用了需求编号却做的是别的事，
        // 比不写注释更糟：它让人以为这条需求已经落地了。
        { kind: 'hasRelation', type: 'acceptedBy', direction: 'out' },
      ],
    },
    { name: 'InProgress', entryActions: [{ kind: 'stampNow', path: 'startedAt' }] },
    { name: 'Review' },
    { name: 'Done', entryActions: [{ kind: 'stampNow', path: 'completedAt' }], terminal: true },
    { name: 'Cancelled', terminal: true },
  ],
  transitions: [
    { from: ['Draft'], to: 'Ready' },
    { from: ['Ready'], to: 'Draft' },
    { from: ['Ready'], to: 'InProgress' },
    { from: ['InProgress'], to: 'Review' },
    { from: ['Review'], to: 'InProgress' },
    { from: ['Review'], to: 'Done' },
    { from: ['InProgress'], to: 'Done' },
    { from: ['Draft', 'Ready', 'InProgress', 'Review'], to: 'Cancelled' },
    { from: ['Done'], to: 'InProgress', reopen: true, description: '返工重开' },
  ],
}

export const DECISION_LIFECYCLE: Lifecycle = {
  id: 'decision-default',
  entityType: 'Decision',
  initial: 'Proposed',
  states: [
    { name: 'Proposed' },
    {
      name: 'Accepted',
      requires: [
        { kind: 'attributeSet', path: 'chosen' },
        { kind: 'attributeSet', path: 'rationale' },
      ],
      entryActions: [{ kind: 'stampNow', path: 'acceptedAt' }],
    },
    // 与 docs/adr/README.md 的规则一致：Accepted 的决策不改内容，只能被取代
    { name: 'Superseded', terminal: true },
    { name: 'Deprecated', terminal: true },
    { name: 'Rejected', terminal: true },
  ],
  transitions: [
    { from: ['Proposed'], to: 'Accepted', capability: 'Decision.Approve' },
    { from: ['Proposed'], to: 'Rejected' },
    { from: ['Accepted'], to: 'Superseded' },
    { from: ['Accepted'], to: 'Deprecated' },
  ],
}

export const KNOWLEDGE_LIFECYCLE: Lifecycle = {
  id: 'knowledge-default',
  entityType: 'Knowledge',
  initial: 'Draft',
  states: [
    { name: 'Draft' },
    {
      name: 'Published',
      // FR-DOM-008：无来源的知识不可信，不允许发布
      requires: [{ kind: 'hasRelation', type: 'derivedFrom', direction: 'out' }],
      entryActions: [{ kind: 'stampNow', path: 'publishedAt' }],
    },
    { name: 'NeedsReview', description: 'validUntil 到期后自动进入，避免知识腐化' },
    { name: 'Archived', terminal: true },
  ],
  transitions: [
    { from: ['Draft'], to: 'Published' },
    { from: ['Published'], to: 'NeedsReview' },
    { from: ['NeedsReview'], to: 'Published' },
    { from: ['Draft', 'Published', 'NeedsReview'], to: 'Archived' },
  ],
}

/**
 * 验收标准自己也有生命周期（FR-DOM-004）。
 *
 * 需要 `Agreed` 这一档，是因为"写下来了"和"双方认可"是两回事：
 * 只要求存在一条验收标准的话，一句随手写的空话也能满足门槛。
 */
/**
 * 发布（FR-DOM-007）。
 *
 * 关键的一条守卫在 `Released` 上：**这次发布装着的 Task 必须全部 Done**。
 * 这个不变量靠流程纪律是守不住的——赶发版的时候纪律是第一个被放弃的东西，
 * 而"上线了一个没做完的东西"的代价要到线上才知道。
 */
export const RELEASE_LIFECYCLE: Lifecycle = {
  id: 'release-default',
  entityType: 'Release',
  initial: 'Planned',
  states: [
    { name: 'Planned' },
    {
      name: 'Frozen',
      // 封版意味着范围定了。至少得装着点什么，否则这一步没有意义
      requires: [{ kind: 'hasRelation', type: 'ships', direction: 'out' }],
      description: '范围冻结，不再加内容',
    },
    {
      name: 'Released',
      requires: [
        {
          kind: 'allRelatedIn',
          type: 'ships',
          direction: 'out',
          targetType: 'Task',
          // Cancelled 也放行：取消掉的任务不会被发出去，
          // 卡着它不让发版，只会逼人把关系删掉——那样发布记录就不准了
          states: ['Done', 'Cancelled'],
        },
      ],
      entryActions: [{ kind: 'stampNow', path: 'releasedAt' }],
      terminal: true,
    },
    { name: 'Abandoned', terminal: true },
  ],
  transitions: [
    { from: ['Planned'], to: 'Frozen' },
    { from: ['Frozen'], to: 'Planned', description: '解冻，继续加内容' },
    { from: ['Frozen'], to: 'Released', capability: 'Release.Promote' },
    { from: ['Planned', 'Frozen'], to: 'Abandoned' },
  ],
}

/**
 * 人工确认（FR-IAM-009）。
 *
 * 三个终态刻意分开：Approved / Rejected / Expired。
 * 把超时并进 Rejected 的话，"有多少确认是被人拒的、多少是没人管"
 * 就再也分不出来——而这两件事要采取的行动完全不同。
 */
export const APPROVAL_LIFECYCLE: Lifecycle = {
  id: 'approval-default',
  entityType: 'Approval',
  initial: 'Pending',
  states: [
    {
      name: 'Pending',
      // 挂起超过一天没人管，SLA 巡检会告警。真正的过期判定在使用时做——
      // 靠巡检把状态刷成 Expired 的话，巡检停掉的那几天里
      // 过期的批准照样能用（见 approvalProblem）
      sla: { maxDurationMs: DAY, onBreach: 'escalate' },
    },
    {
      name: 'Approved',
      entryActions: [{ kind: 'stampNow', path: 'decidedAt' }],
      terminal: true,
    },
    { name: 'Rejected', entryActions: [{ kind: 'stampNow', path: 'decidedAt' }], terminal: true },
    {
      name: 'Expired',
      description: '超时没人处理。默认拒绝——沉默不是同意',
      entryActions: [{ kind: 'stampNow', path: 'decidedAt' }],
      terminal: true,
    },
  ],
  transitions: [
    // 批准需要一个人才有的能力。少了这条，被 Ask 挡下的主体
    // 可以自己批准自己，整条确认流程就是个摆设
    { from: ['Pending'], to: 'Approved', capability: 'Approval.Decide' },
    { from: ['Pending'], to: 'Rejected', capability: 'Approval.Decide' },
    { from: ['Pending'], to: 'Expired' },
  ],
}

export const ACCEPTANCE_LIFECYCLE: Lifecycle = {
  id: 'acceptance-default',
  entityType: 'Acceptance',
  initial: 'Draft',
  states: [
    { name: 'Draft' },
    { name: 'Agreed', description: '双方认可这条标准；此后 Story 才可以进入执行' },
    { name: 'Verified', entryActions: [{ kind: 'stampNow', path: 'verifiedAt' }], terminal: true },
    { name: 'Withdrawn', terminal: true },
  ],
  transitions: [
    { from: ['Draft'], to: 'Agreed' },
    { from: ['Agreed'], to: 'Draft', description: '标准本身要改' },
    { from: ['Agreed'], to: 'Verified' },
    { from: ['Draft', 'Agreed'], to: 'Withdrawn' },
  ],
}

/**
 * 通知只有两个状态。
 *
 * 刻意不做"已归档""已忽略"：一个状态机的状态越多，
 * 它就越需要有人去维护那些状态的含义，而通知不值得这个成本。
 */
export const NOTIFICATION_LIFECYCLE: Lifecycle = {
  id: 'notification-default',
  entityType: 'Notification',
  initial: 'Unread',
  states: [
    { name: 'Unread' },
    { name: 'Read', entryActions: [{ kind: 'stampNow', path: 'readAt' }], terminal: true },
  ],
  transitions: [{ from: ['Unread'], to: 'Read' }],
}

export const PROJECT_LIFECYCLE: Lifecycle = {
  id: 'project-default',
  entityType: 'Project',
  initial: 'Planning',
  states: [
    { name: 'Planning' },
    { name: 'Active', entryActions: [{ kind: 'stampNow', path: 'startedAt' }] },
    { name: 'OnHold' },
    { name: 'Completed', entryActions: [{ kind: 'stampNow', path: 'completedAt' }], terminal: true },
    { name: 'Cancelled', terminal: true },
  ],
  transitions: [
    { from: ['Planning'], to: 'Active' },
    { from: ['Active'], to: 'OnHold' },
    { from: ['OnHold'], to: 'Active' },
    { from: ['Active'], to: 'Completed' },
    { from: ['Planning', 'Active', 'OnHold'], to: 'Cancelled' },
  ],
}

export const AGENT_LIFECYCLE: Lifecycle = {
  id: 'agent-default',
  entityType: 'Agent',
  initial: 'Draft',
  states: [
    { name: 'Draft' },
    {
      name: 'Active',
      // ADR-0003：Agent 必须有明确的 principal 才能被授权与审计
      requires: [{ kind: 'attributeSet', path: 'principal' }],
    },
    { name: 'Suspended', description: '出问题时的紧急关停' },
    { name: 'Retired', terminal: true },
  ],
  transitions: [
    { from: ['Draft'], to: 'Active', capability: 'Agent.Define' },
    { from: ['Active'], to: 'Suspended', capability: 'Agent.Define' },
    { from: ['Suspended'], to: 'Active', capability: 'Agent.Define' },
    { from: ['Draft', 'Active', 'Suspended'], to: 'Retired', capability: 'Agent.Define' },
  ],
}

/**
 * 一次 Agent 执行的生命周期（FR-AGT-007 / FR-AGT-009）。
 *
 * `AwaitingReview` 是这台状态机存在的理由。人机协作的四种模式里，
 * 只有 Autonomous 允许直接落到 Succeeded；其余三种必须先停在这一站等人。
 * 把"等人"做成一个**状态**而不是一个布尔字段，好处是它自动获得了
 * 看板上的一列、可用迁移列表、以及完整的历史记录——
 * 也就是说"有多少产出正在等人看"这个问题不需要额外做报表。
 */
export const AGENT_RUN_LIFECYCLE: Lifecycle = {
  id: 'agentrun-default',
  entityType: 'AgentRun',
  initial: 'Queued',
  states: [
    { name: 'Queued' },
    { name: 'Running', entryActions: [{ kind: 'stampNow', path: 'startedAt' }] },
    { name: 'AwaitingReview' },
    { name: 'Succeeded', entryActions: [{ kind: 'stampNow', path: 'finishedAt' }], terminal: true },
    { name: 'Failed', entryActions: [{ kind: 'stampNow', path: 'finishedAt' }], terminal: true },
    { name: 'Cancelled', entryActions: [{ kind: 'stampNow', path: 'finishedAt' }], terminal: true },
  ],
  transitions: [
    { from: ['Queued'], to: 'Running' },
    // 直接完成：Autonomous 模式，以及无需产出评审的 Run
    { from: ['Running'], to: 'Succeeded' },
    { from: ['Running'], to: 'AwaitingReview' },
    // 采纳产出。人的动作，因此要一个人才有的能力——
    // 让 Agent 自己批准自己的产出，人机协作模式就只是个摆设
    { from: ['AwaitingReview'], to: 'Succeeded', capability: 'AgentRun.Approve' },
    { from: ['AwaitingReview'], to: 'Failed', capability: 'AgentRun.Approve' },
    { from: ['Running'], to: 'Failed' },
    { from: ['Queued', 'Running', 'AwaitingReview'], to: 'Cancelled' },
  ],
}

export const DEFAULT_LIFECYCLES: readonly Lifecycle[] = [
  TASK_LIFECYCLE,
  REQUIREMENT_LIFECYCLE,
  STORY_LIFECYCLE,
  DECISION_LIFECYCLE,
  KNOWLEDGE_LIFECYCLE,
  PROJECT_LIFECYCLE,
  AGENT_LIFECYCLE,
  AGENT_RUN_LIFECYCLE,
  NOTIFICATION_LIFECYCLE,
  ACCEPTANCE_LIFECYCLE,
  RELEASE_LIFECYCLE,
  APPROVAL_LIFECYCLE,
]

export function buildDefaultWorkflowRegistry(): WorkflowRegistry {
  const registry = new WorkflowRegistry()
  for (const lifecycle of DEFAULT_LIFECYCLES) registry.register(lifecycle)
  return registry
}
