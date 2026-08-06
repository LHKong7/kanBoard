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
    { name: 'Todo', group: 'Unstarted' },
    {
      name: 'Doing',
      group: 'Started',
      // 没有负责人的任务处于"进行中"是个谎言：它没有在进行
      requires: [{ kind: 'attributeSet', path: 'assignee' }],
      entryActions: [{ kind: 'stampNow', path: 'startedAt' }],
      sla: { maxDurationMs: 5 * DAY, onBreach: 'notify-owner' },
    },
    { name: 'Review', group: 'Started' },
    { name: 'Testing', group: 'Started' },
    {
      name: 'Blocked',
      // 阻塞了也还在 Started 组：它没做完，也没被放弃。
      // 单独给它一个"不算进行中"的分组会让 WIP 数字凭空变好看，
      // 而阻塞恰恰是最该被算进 WIP 的那一类
      group: 'Started',
      // 不写明为什么阻塞的阻塞项，事后没有人能接手
      requires: [{ kind: 'attributeSet', path: 'blockReason' }],
      sla: { maxDurationMs: 2 * DAY, onBreach: 'escalate' },
    },
    {
      name: 'Done',
      group: 'Completed',
      entryActions: [
        { kind: 'stampNow', path: 'completedAt' },
        { kind: 'clearAttribute', path: 'blockReason' },
      ],
      terminal: true,
    },
    { name: 'Cancelled', group: 'Cancelled', terminal: true },
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
    { name: 'Draft', group: 'Backlog' },
    {
      // 评审在决定"这条需求要不要做"——这正是分诊
      name: 'Review',
      group: 'Triage',
      requires: [{ kind: 'attributeSet', path: 'statement' }],
    },
    {
      name: 'Approved',
      group: 'Unstarted',
      entryActions: [{ kind: 'stampNow', path: 'approvedAt' }],
    },
    {
      name: 'Planning',
      group: 'Unstarted',
      // 进入规划意味着要拆 Story；没有拆解关系时推进是自欺欺人
      requires: [{ kind: 'hasRelation', type: 'implementedBy', direction: 'out' }],
    },
    { name: 'InProgress', group: 'Started' },
    { name: 'Finished', group: 'Completed', terminal: true },
    { name: 'Rejected', group: 'Cancelled', terminal: true },
    { name: 'Superseded', group: 'Cancelled', terminal: true },
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
    { name: 'Draft', group: 'Backlog' },
    {
      name: 'Ready',
      group: 'Unstarted',
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
    { name: 'InProgress', group: 'Started', entryActions: [{ kind: 'stampNow', path: 'startedAt' }] },
    { name: 'Review', group: 'Started' },
    {
      name: 'Done',
      group: 'Completed',
      entryActions: [{ kind: 'stampNow', path: 'completedAt' }],
      terminal: true,
    },
    { name: 'Cancelled', group: 'Cancelled', terminal: true },
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
    { name: 'Proposed', group: 'Triage' },
    {
      name: 'Accepted',
      // Completed 但**不是终态**——决策做完了，可它还可能被后来的决策取代。
      // 这正是"终态必须归 Completed / Cancelled"只做单向检查的理由：
      // 反过来要求"Completed 组必须是终态"会把这类建模判成错的
      group: 'Completed',
      requires: [
        { kind: 'attributeSet', path: 'chosen' },
        { kind: 'attributeSet', path: 'rationale' },
      ],
      entryActions: [{ kind: 'stampNow', path: 'acceptedAt' }],
    },
    // 与 docs/adr/README.md 的规则一致：Accepted 的决策不改内容，只能被取代
    { name: 'Superseded', group: 'Cancelled', terminal: true },
    { name: 'Deprecated', group: 'Cancelled', terminal: true },
    { name: 'Rejected', group: 'Cancelled', terminal: true },
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
    { name: 'Draft', group: 'Backlog' },
    {
      name: 'Published',
      group: 'Completed',
      // FR-DOM-008：无来源的知识不可信，不允许发布
      requires: [{ kind: 'hasRelation', type: 'derivedFrom', direction: 'out' }],
      entryActions: [{ kind: 'stampNow', path: 'publishedAt' }],
    },
    {
      name: 'NeedsReview',
      // 回到 Unstarted：知识过期意味着又有活要干了。
      // 留在 Completed 组会让"有多少知识需要复核"从进度里消失
      group: 'Unstarted',
      description: 'validUntil 到期后自动进入，避免知识腐化',
    },
    { name: 'Archived', group: 'Cancelled', terminal: true },
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
    { name: 'Planned', group: 'Unstarted' },
    {
      name: 'Frozen',
      group: 'Started',
      // 封版意味着范围定了。至少得装着点什么，否则这一步没有意义
      requires: [{ kind: 'hasRelation', type: 'ships', direction: 'out' }],
      description: '范围冻结，不再加内容',
    },
    {
      name: 'Released',
      group: 'Completed',
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
    { name: 'Abandoned', group: 'Cancelled', terminal: true },
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

export const SPRINT_LIFECYCLE: Lifecycle = {
  id: 'sprint-default',
  entityType: 'Sprint',
  initial: 'Planned',
  states: [
    { name: 'Planned', group: 'Unstarted' },
    { name: 'Active', group: 'Started' },
    { name: 'Closed', group: 'Completed', terminal: true },
  ],
  transitions: [
    { from: ['Planned'], to: 'Active' },
    { from: ['Active'], to: 'Closed' },
    { from: ['Planned'], to: 'Closed', description: '取消这次迭代' },
  ],
}

/**
 * 模块 —— **范围**维度的状态机（对照 Plane 的 Module）。
 *
 * 它和周期的差别在这台状态机上看得最清楚：周期的状态**由日期推导**
 * （到点就开始、到点就结束），模块的状态**由人显式声明**。
 * 因为"这两周开始了没有"是个事实问题，而"这个功能算不算在做了"
 * 是个判断问题——日历回答不了后者。
 *
 * `Paused` 单列一档而不是复用 Backlog：暂停的模块**已经投入过**，
 * 把它退回 Backlog 会让"这个季度启动了几个模块"这个数字凭空变小。
 */
export const MODULE_LIFECYCLE: Lifecycle = {
  id: 'module-default',
  entityType: 'Module',
  initial: 'Backlog',
  states: [
    { name: 'Backlog', group: 'Backlog', description: '确认要做，还没排期' },
    { name: 'Planned', group: 'Unstarted', description: '排了期，还没开工' },
    { name: 'InProgress', group: 'Started', entryActions: [{ kind: 'stampNow', path: 'startedAt' }] },
    { name: 'Paused', group: 'Started', description: '暂停。投入过，所以不退回 Backlog' },
    {
      name: 'Completed',
      group: 'Completed',
      // 装着的工作项还没做完就宣布模块完成，是"这个功能做完了吗"
      // 这个问题失去可信度的唯一方式。和 Release 用的是同一条守卫
      requires: [
        {
          kind: 'allRelatedIn',
          type: 'moduleIncludes',
          direction: 'out',
          states: ['Done', 'Cancelled'],
          targetType: 'Task',
        },
      ],
      entryActions: [{ kind: 'stampNow', path: 'completedAt' }],
      terminal: true,
    },
    { name: 'Cancelled', group: 'Cancelled', terminal: true },
  ],
  transitions: [
    { from: ['Backlog'], to: 'Planned' },
    { from: ['Planned'], to: 'Backlog', description: '排期取消，退回待排' },
    { from: ['Planned'], to: 'InProgress' },
    { from: ['InProgress'], to: 'Paused' },
    { from: ['Paused'], to: 'InProgress' },
    { from: ['InProgress'], to: 'Completed' },
    { from: ['Backlog', 'Planned', 'InProgress', 'Paused'], to: 'Cancelled' },
    // 交付之后发现还有事没做完。和 Task 一样，返工要显式（ADR-0012）
    { from: ['Completed'], to: 'InProgress', reopen: true, description: '交付后返工' },
  ],
}

/**
 * 意见收集的分诊队列（对照 Plane 的 Intake）。
 *
 * 五个状态直接对应指南里那四个分诊动作，外加一个入口。两条守卫
 * 是这台状态机的全部价值所在：
 *
 * 1. **Accepted 必须产生一个工作项**（`acceptedInto` 关系）。
 *    没有这条，"接受"就是一个把队列清空的按钮——队列确实空了，
 *    而提需求的人等来的仍然是没有下文。
 * 2. **Snoozed 必须写明延到哪天**。无限期延后是分诊队列里
 *    最常见的自欺：它看起来像做了决定，实际上只是把决定推走了。
 *
 * `Duplicate` 与 `Rejected` 分开，是因为要采取的动作不同：
 * 重复的那条要去看原件，被拒的那条要给个理由。合成一个
 * "关闭"之后，提交人收到的是同一句话。
 */
export const INTAKE_LIFECYCLE: Lifecycle = {
  id: 'intake-default',
  entityType: 'Intake',
  initial: 'Pending',
  states: [
    {
      name: 'Pending',
      group: 'Triage',
      // 一条待分诊的意见超过两天没人碰就该有人被提醒。
      // 指南把"每天清空 Intake 队列"列为纪律，SLA 是这条纪律
      // 唯一能被系统看见的形式
      sla: { maxDurationMs: 2 * DAY, onBreach: 'notify-owner' },
    },
    {
      name: 'Snoozed',
      // 仍在 Triage：延后不是决定，只是把决定挪到了以后。
      // 归进 Cancelled 会让它从待办里消失，而它到期后还会回来
      group: 'Triage',
      requires: [{ kind: 'attributeSet', path: 'snoozedUntil' }],
      description: '延后到 snoozedUntil。到期回到 Pending',
    },
    {
      name: 'Accepted',
      group: 'Completed',
      requires: [{ kind: 'hasRelation', type: 'acceptedInto', direction: 'out' }],
      terminal: true,
      description: '接受了，并且真的建出了工作项',
    },
    { name: 'Rejected', group: 'Cancelled', terminal: true },
    {
      name: 'Duplicate',
      group: 'Cancelled',
      requires: [{ kind: 'hasRelation', type: 'duplicates', direction: 'out' }],
      terminal: true,
      description: '重复。必须指出重复的是哪一条，否则提交人无从查起',
    },
  ],
  transitions: [
    { from: ['Pending'], to: 'Accepted', capability: 'Intake.Triage' },
    { from: ['Pending'], to: 'Rejected', capability: 'Intake.Triage' },
    { from: ['Pending'], to: 'Snoozed', capability: 'Intake.Triage' },
    { from: ['Pending'], to: 'Duplicate', capability: 'Intake.Triage' },
    // 延后到期后回到队列。由 poller 推，也可以人工提前捞回来
    { from: ['Snoozed'], to: 'Pending' },
    { from: ['Snoozed'], to: 'Rejected', capability: 'Intake.Triage' },
  ],
}

export const MILESTONE_LIFECYCLE: Lifecycle = {
  id: 'milestone-default',
  entityType: 'Milestone',
  initial: 'Planned',
  states: [
    { name: 'Planned', group: 'Unstarted' },
    { name: 'AtRisk', group: 'Started', description: '预测达成日已晚于 dueDate' },
    { name: 'Reached', group: 'Completed', terminal: true },
    // 错过的里程碑归 Cancelled 而不是 Completed：六个组里没有"失败"这一档，
    // 而把它算进 Completed 会让"按期率"把错过的也算成达成了
    { name: 'Missed', group: 'Cancelled', terminal: true },
  ],
  transitions: [
    { from: ['Planned'], to: 'AtRisk' },
    { from: ['AtRisk'], to: 'Planned', description: '追回来了' },
    { from: ['Planned', 'AtRisk'], to: 'Reached' },
    { from: ['Planned', 'AtRisk'], to: 'Missed' },
  ],
}

/**
 * 风险（PRD 03 §2 的不变量：高风险必须有 owner 与 mitigation）。
 *
 * 守卫放在 `Mitigating` 上而不是创建时：**登记一条风险不该有门槛**，
 * 门槛越高越没人记。但声称"正在缓解"就必须说出缓解措施是什么——
 * 没有对策的"正在处理"是这类登记册最常见的自欺。
 */
export const RISK_LIFECYCLE: Lifecycle = {
  id: 'risk-default',
  entityType: 'Risk',
  initial: 'Identified',
  states: [
    { name: 'Identified', group: 'Backlog' },
    {
      name: 'Mitigating',
      group: 'Started',
      requires: [
        { kind: 'attributeSet', path: 'mitigation' },
        { kind: 'ownerAssigned' },
        // 风险要指得出触发它的实体（FR-AI-006）。
        //
        // 用**关系**而不是属性，因为验收标准的原文是"可点击"——
        // 一个字符串数组点不动，而关系正是 UI 能渲染成链接的东西。
        // 和 Knowledge 的来源守卫（FR-DOM-008）用的是同一套机制。
        //
        // 闸设在 Mitigating 而不是 Identified：**刚发现时说不清出处是正常的**，
        // 设在入口会让人不敢登记风险，而漏登记比登记得潦草糟得多。
        // 但要动手缓解、要占用人和时间，就得说清楚是什么让你这么判断的。
        { kind: 'hasRelation', type: 'evidencedBy', direction: 'out' },
      ],
    },
    { name: 'Closed', group: 'Completed', terminal: true },
    { name: 'Accepted', group: 'Cancelled', description: '接受这个风险，不再缓解', terminal: true },
  ],
  transitions: [
    { from: ['Identified'], to: 'Mitigating' },
    { from: ['Identified', 'Mitigating'], to: 'Accepted' },
    { from: ['Mitigating'], to: 'Closed' },
    { from: ['Identified'], to: 'Closed', description: '不再成立' },
  ],
}

/**
 * 一次推荐的一生（FR-AI-009）。
 *
 * 三个状态，两个终态。**`Dismissed` 必须存在**：没有它，
 * 点击率的分母就只能是"推过的总数"，而那个数字混着还没来得及看的那些，
 * 于是刚上线时点击率永远很低，看数的人会以为推荐做得很差。
 */
export const RECOMMENDATION_LIFECYCLE: Lifecycle = {
  id: 'recommendation-default',
  entityType: 'Recommendation',
  initial: 'Shown',
  states: [
    // 没有 entryActions：初始状态是创建时直接落的，不走迁移，
    // 写在这里的动作永远不会执行。展示时刻用资源自带的 createdAt
    { name: 'Shown', group: 'Unstarted' },
    {
      name: 'Clicked',
      group: 'Completed',
      entryActions: [{ kind: 'stampNow', path: 'respondedAt' }],
      terminal: true,
    },
    {
      name: 'Dismissed',
      group: 'Cancelled',
      entryActions: [{ kind: 'stampNow', path: 'respondedAt' }],
      terminal: true,
    },
  ],
  transitions: [
    { from: ['Shown'], to: 'Clicked' },
    { from: ['Shown'], to: 'Dismissed' },
  ],
}

/**
 * 举措的生命周期（企业级，对照 Plane pro 档的 Initiative）。
 *
 * 有 `Abandoned` 这个终态而不是只有"完成"：一个跨项目的举措被放弃
 * 是常事，而把它硬推到 Achieved 或者永远挂在 Active 上，
 * 都会让"我们今年到底做成了几件事"这个数字失真。
 */
export const INITIATIVE_LIFECYCLE: Lifecycle = {
  id: 'initiative-default',
  entityType: 'Initiative',
  initial: 'Planned',
  states: [
    { name: 'Planned', group: 'Unstarted' },
    { name: 'Active', group: 'Started' },
    { name: 'Achieved', group: 'Completed', terminal: true },
    { name: 'Abandoned', group: 'Cancelled', terminal: true },
  ],
  transitions: [
    { from: ['Planned'], to: 'Active' },
    { from: ['Active'], to: 'Achieved' },
    { from: ['Planned', 'Active'], to: 'Abandoned' },
  ],
}

/**
 * 工时的生命周期（对照 Plane business 档的"工时单 + 审批"）。
 *
 * 报工时**默认是草稿**，提交之后才等审批。三档而不是两档的理由：
 * 少了 Draft 的话，手滑报错一条 8 小时就直接进了别人的待审队列，
 * 而撤回一条已提交的记录比改一条草稿麻烦得多。
 *
 * 审批人不能是自己——那条不在状态机里，在 default-policies 的
 * Deny 策略里（和"Agent 不能批准自己的产出"是同一条思路）。
 */
export const WORKLOG_LIFECYCLE: Lifecycle = {
  id: 'worklog-default',
  entityType: 'Worklog',
  initial: 'Draft',
  states: [
    { name: 'Draft', group: 'Backlog' },
    { name: 'Submitted', group: 'Started', description: '等审批。等着也是在流转中' },
    {
      name: 'Approved',
      group: 'Completed',
      entryActions: [{ kind: 'stampNow', path: 'approvedAt' }],
      terminal: true,
    },
    { name: 'Rejected', group: 'Cancelled', terminal: true },
  ],
  transitions: [
    { from: ['Draft'], to: 'Submitted' },
    // 审批走**单独的 capability**，不是通用的 Worklog.Transition。
    // 有了它，"不能批自己报的工时"才写得出来——否则那条 Deny 会
    // 连"提交"一起挡掉，而提交本来就该由本人做
    { from: ['Submitted'], to: 'Approved', capability: 'Worklog.Approve' },
    { from: ['Submitted'], to: 'Rejected', capability: 'Worklog.Approve' },
    // 打回来的可以撤回改，所以这条边留着
    { from: ['Submitted'], to: 'Draft' },
  ],
}

export const BUDGET_LIFECYCLE: Lifecycle = {
  id: 'budget-default',
  entityType: 'Budget',
  initial: 'Active',
  states: [
    { name: 'Active', group: 'Started' },
    { name: 'Exceeded', group: 'Started', description: 'consumed 超过 hardLimit' },
    { name: 'Closed', group: 'Completed', terminal: true },
  ],
  transitions: [
    { from: ['Active'], to: 'Exceeded' },
    { from: ['Exceeded'], to: 'Active', description: '追加了预算' },
    { from: ['Active', 'Exceeded'], to: 'Closed' },
  ],
}

/**
 * 一条提议的生命周期（FR-AI-001）。
 *
 * 三个状态就够了。关键在于它是**每个节点各有一条**：
 * 一棵生成出来的 WBS 有二十个节点，人要能留下十七个、扔掉三个，
 * 而不是对着整棵树只能全要或全不要——后者的实际结果是全都不要。
 */
export const PROPOSAL_LIFECYCLE: Lifecycle = {
  id: 'proposal-default',
  entityType: 'Proposal',
  initial: 'Pending',
  states: [
    { name: 'Pending', group: 'Triage' },
    {
      name: 'Accepted',
      group: 'Completed',
      entryActions: [{ kind: 'stampNow', path: 'decidedAt' }],
      terminal: true,
    },
    {
      name: 'Rejected',
      group: 'Cancelled',
      entryActions: [{ kind: 'stampNow', path: 'decidedAt' }],
      terminal: true,
    },
  ],
  transitions: [
    // 接受要一个人才有的能力。Agent 自己批自己的产出，
    // 整套人机协作模式就只是个摆设（同 AgentRun.Approve）
    { from: ['Pending'], to: 'Accepted', capability: 'Proposal.Decide' },
    { from: ['Pending'], to: 'Rejected', capability: 'Proposal.Decide' },
  ],
}

export const APPROVAL_LIFECYCLE: Lifecycle = {
  id: 'approval-default',
  entityType: 'Approval',
  initial: 'Pending',
  states: [
    {
      name: 'Pending',
      group: 'Triage',
      // 挂起超过一天没人管，SLA 巡检会告警。真正的过期判定在使用时做——
      // 靠巡检把状态刷成 Expired 的话，巡检停掉的那几天里
      // 过期的批准照样能用（见 approvalProblem）
      sla: { maxDurationMs: DAY, onBreach: 'escalate' },
    },
    {
      name: 'Approved',
      group: 'Completed',
      entryActions: [{ kind: 'stampNow', path: 'decidedAt' }],
      terminal: true,
    },
    {
      name: 'Rejected',
      group: 'Cancelled',
      entryActions: [{ kind: 'stampNow', path: 'decidedAt' }],
      terminal: true,
    },
    {
      name: 'Expired',
      group: 'Cancelled',
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
    { name: 'Draft', group: 'Backlog' },
    {
      name: 'Agreed',
      group: 'Unstarted',
      description: '双方认可这条标准；此后 Story 才可以进入执行',
    },
    {
      name: 'Verified',
      group: 'Completed',
      entryActions: [{ kind: 'stampNow', path: 'verifiedAt' }],
      terminal: true,
    },
    { name: 'Withdrawn', group: 'Cancelled', terminal: true },
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
    { name: 'Unread', group: 'Unstarted' },
    {
      name: 'Read',
      group: 'Completed',
      entryActions: [{ kind: 'stampNow', path: 'readAt' }],
      terminal: true,
    },
  ],
  transitions: [{ from: ['Unread'], to: 'Read' }],
}

export const PROJECT_LIFECYCLE: Lifecycle = {
  id: 'project-default',
  entityType: 'Project',
  initial: 'Planning',
  states: [
    { name: 'Planning', group: 'Unstarted' },
    { name: 'Active', group: 'Started', entryActions: [{ kind: 'stampNow', path: 'startedAt' }] },
    // 挂起的项目仍在 Started：它开工过，而且随时可能回来。
    // 退回 Unstarted 会让"进行中的项目有几个"少算一个正在出问题的项目
    { name: 'OnHold', group: 'Started' },
    {
      name: 'Completed',
      group: 'Completed',
      entryActions: [{ kind: 'stampNow', path: 'completedAt' }],
      terminal: true,
    },
    { name: 'Cancelled', group: 'Cancelled', terminal: true },
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
    { name: 'Draft', group: 'Backlog' },
    {
      name: 'Active',
      group: 'Started',
      // ADR-0003：Agent 必须有明确的 principal 才能被授权与审计
      requires: [{ kind: 'attributeSet', path: 'principal' }],
    },
    { name: 'Suspended', group: 'Started', description: '出问题时的紧急关停' },
    { name: 'Retired', group: 'Cancelled', terminal: true },
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
    { name: 'Queued', group: 'Unstarted' },
    { name: 'Running', group: 'Started', entryActions: [{ kind: 'stampNow', path: 'startedAt' }] },
    // 等人看也是"还没做完"。归到 Completed 的话，
    // "有多少产出正在等人"会从待办数里消失，而那正是要盯的数字
    { name: 'AwaitingReview', group: 'Started' },
    {
      name: 'Succeeded',
      group: 'Completed',
      entryActions: [{ kind: 'stampNow', path: 'finishedAt' }],
      terminal: true,
    },
    // 失败归 Cancelled：六个组里没有"失败"这一档，而 Completed
    // 会让 Run 成功率的分子把失败的也算进去
    {
      name: 'Failed',
      group: 'Cancelled',
      entryActions: [{ kind: 'stampNow', path: 'finishedAt' }],
      terminal: true,
    },
    {
      name: 'Cancelled',
      group: 'Cancelled',
      entryActions: [{ kind: 'stampNow', path: 'finishedAt' }],
      terminal: true,
    },
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
  PROPOSAL_LIFECYCLE,
  SPRINT_LIFECYCLE,
  MILESTONE_LIFECYCLE,
  RISK_LIFECYCLE,
  RECOMMENDATION_LIFECYCLE,
  BUDGET_LIFECYCLE,
  INITIATIVE_LIFECYCLE,
  WORKLOG_LIFECYCLE,
  MODULE_LIFECYCLE,
  INTAKE_LIFECYCLE,
]

export function buildDefaultWorkflowRegistry(): WorkflowRegistry {
  const registry = new WorkflowRegistry()
  for (const lifecycle of DEFAULT_LIFECYCLES) registry.register(lifecycle)
  return registry
}
