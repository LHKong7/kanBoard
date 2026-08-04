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
      // FR-DOM-004：没有拆出任务的 Story 不算就绪
      requires: [{ kind: 'hasRelation', type: 'decomposedInto', direction: 'out' }],
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
]

export function buildDefaultWorkflowRegistry(): WorkflowRegistry {
  const registry = new WorkflowRegistry()
  for (const lifecycle of DEFAULT_LIFECYCLES) registry.register(lifecycle)
  return registry
}
