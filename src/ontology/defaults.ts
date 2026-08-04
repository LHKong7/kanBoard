import { OntologyRegistry } from './registry.ts'
import type { EntityTypeDef, RelationTypeDef } from './types.ts'

/**
 * 默认本体包。
 *
 * 存在的理由是风险 R1（本体建模成本高，团队难以上手）：
 * 开箱即用的一套类型，让团队可以先用起来，再按需扩展。
 *
 * 注意：这里没有 `status` 属性——生命周期状态在 Resource 头部字段中，
 * 由 Workflow Engine 管理（M1）。在 attributes 里再放一个 status 会造成双写。
 */

export const DEFAULT_ENTITY_TYPES: readonly EntityTypeDef[] = [
  {
    name: 'Project',
    version: '1.2.0',
    context: 'Project',
    lifecycle: 'project-default',
    description: '项目：目标、里程碑、预算与风险的聚合根',
    attributes: [
      { name: 'key', kind: 'string', required: true, description: '同 Workspace 下唯一' },
      { name: 'name', kind: 'string', required: true },
      { name: 'vision', kind: 'text' },
      { name: 'ownerTeam', kind: 'string' },
      // 以下由状态机的 entry action 写入（04-ontology：新增可选属性 = minor 版本）
      { name: 'startedAt', kind: 'datetime', derived: true },
      { name: 'completedAt', kind: 'datetime', derived: true },
    ],
  },
  {
    name: 'Requirement',
    version: '1.2.0',
    context: 'Requirement',
    lifecycle: 'requirement-default',
    description: '需求：Epic / Feature / Story 三级',
    attributes: [
      { name: 'title', kind: 'string', required: true },
      { name: 'level', kind: 'enum', values: ['Epic', 'Feature', 'Story'], required: true },
      { name: 'statement', kind: 'richtext', required: true },
      {
        name: 'source',
        kind: 'enum',
        values: ['customer', 'internal', 'incident', 'ai-proposed'],
      },
      { name: 'priority', kind: 'enum', values: ['Must', 'Should', 'Could', 'Wont'] },
      { name: 'approvedAt', kind: 'datetime', derived: true, description: '由状态机进入 Approved 时写入' },
    ],
  },
  {
    name: 'Story',
    version: '1.2.0',
    context: 'Requirement',
    lifecycle: 'story-default',
    description: '可独立交付的最小需求单元',
    attributes: [
      { name: 'title', kind: 'string', required: true },
      { name: 'role', kind: 'string', description: '作为 <角色>' },
      { name: 'capability', kind: 'text', description: '我希望 <能力>' },
      { name: 'value', kind: 'text', description: '以便 <价值>' },
      { name: 'storyPoint', kind: 'int' },
      { name: 'estimateRationale', kind: 'text', description: '估点依据，AI 估点时必填' },
      { name: 'startedAt', kind: 'datetime', derived: true },
      { name: 'completedAt', kind: 'datetime', derived: true },
    ],
  },
  {
    name: 'Task',
    version: '1.2.0',
    context: 'Execution',
    lifecycle: 'task-default',
    description: '执行单元。assignee 可以是 User 也可以是 Agent',
    attributes: [
      { name: 'title', kind: 'string', required: true },
      { name: 'description', kind: 'text' },
      { name: 'assignee', kind: 'string', description: 'user://… 或 agent://…' },
      { name: 'estimate', kind: 'float' },
      { name: 'blockReason', kind: 'text', description: '进入 Blocked 状态时必填' },
      { name: 'startedAt', kind: 'datetime', derived: true },
      { name: 'completedAt', kind: 'datetime', derived: true },
    ],
  },
  {
    name: 'Decision',
    version: '1.2.0',
    context: 'Knowledge',
    lifecycle: 'decision-default',
    description: '决策 / ADR：解释"为什么这样做"',
    attributes: [
      { name: 'question', kind: 'string', required: true },
      { name: 'chosen', kind: 'text', required: true },
      { name: 'rationale', kind: 'text', required: true },
      { name: 'consequences', kind: 'text' },
      { name: 'acceptedAt', kind: 'datetime', derived: true },
    ],
  },
  {
    name: 'Knowledge',
    version: '1.2.0',
    context: 'Knowledge',
    lifecycle: 'knowledge-default',
    description: '知识：必须有来源（derivedFrom），否则不可信',
    attributes: [
      { name: 'title', kind: 'string', required: true },
      { name: 'body', kind: 'richtext', required: true },
      { name: 'confidence', kind: 'percent' },
      { name: 'validUntil', kind: 'datetime', description: '到期后进入待复核，避免知识腐化' },
      { name: 'publishedAt', kind: 'datetime', derived: true },
    ],
  },
  {
    name: 'AgentRun',
    version: '1.0.0',
    context: 'AI',
    lifecycle: 'agentrun-default',
    description:
      '一次 Agent 执行（FR-AGT-007）。它是**领域对象**而不是后台任务记录：' +
      '既然要能被授权、被审计、被回放，就该和别的对象走同一条 API 与同一套权限。',
    attributes: [
      { name: 'goal', kind: 'text', required: true, description: '这次要达成什么' },
      {
        name: 'agent',
        kind: 'ref',
        target: 'Agent',
        required: true,
        description: '哪个 Agent 执行；它的 principal 决定这次 Run 的身份',
      },
      {
        name: 'subject',
        kind: 'ref',
        description: '这次 Run 围绕哪个对象展开，Context 从它开始沿图装配（FR-AGT-004）',
      },
      {
        name: 'mode',
        kind: 'enum',
        values: ['Suggest', 'Draft', 'ExecuteWithReview', 'Autonomous'],
        required: true,
        description: '人机协作模式（FR-AGT-009）。不可逆操作无论哪种模式都要人工确认',
      },
      { name: 'trigger', kind: 'enum', values: ['human', 'event', 'schedule', 'agent'], required: true },
      // 预算是**输入**不是统计：写在 Run 上，执行时按它熔断（FR-AGT-012）
      { name: 'maxTokens', kind: 'int', description: '本次 Run 的 token 上限；缺省用 Agent 定义里的值' },
      { name: 'maxSteps', kind: 'int', description: '本次 Run 的步数上限，防止推理循环' },
      { name: 'tokensUsed', kind: 'int', derived: true },
      { name: 'costUsd', kind: 'float', derived: true },
      { name: 'stepCount', kind: 'int', derived: true },
      { name: 'outcome', kind: 'text', derived: true, description: '终止原因：完成、超预算、被拒、出错' },
      { name: 'startedAt', kind: 'datetime', derived: true },
      { name: 'finishedAt', kind: 'datetime', derived: true },
      // 时长在结算时算好存下来（FR-DASH-003 的 Latency）。
      // 让指标层去减两个时间戳的话，那一层就得会解析日期、
      // 处理缺失值、定义"还没结束算多久"——而它只该会做查询
      { name: 'durationMs', kind: 'int', derived: true, description: '本次 Run 的耗时' },
    ],
  },
  {
    name: 'Agent',
    version: '1.2.0',
    context: 'AI',
    lifecycle: 'agent-default',
    description:
      'Agent 是一等身份主体，同样是领域对象（ADR-0003）。' +
      '它的行为由**声明**决定而不是由代码分支决定（FR-AGT-001/002）：' +
      '运行时读下面这些属性，并不知道自己在跑哪个 Agent。',
    attributes: [
      { name: 'name', kind: 'string', required: true },
      { name: 'principal', kind: 'string', required: true, description: 'agent://<name>@<version>' },
      { name: 'ownerTeam', kind: 'string' },
      { name: 'capabilities', kind: 'json', description: '显式授予的 Capability 列表；默认为空' },
      { name: 'system', kind: 'text', description: '角色设定与规则，送给模型的 system 段' },
      {
        name: 'tier',
        kind: 'enum',
        values: ['tier-low', 'tier-mid', 'tier-high'],
        description: '模型档位（FR-AGT-013）。换供应商只改这里，领域层不认识具体厂商',
      },
      {
        name: 'mode',
        kind: 'enum',
        values: ['Suggest', 'Draft', 'ExecuteWithReview', 'Autonomous'],
        description: '默认协作模式；单次 Run 可以覆盖它（FR-AGT-009）',
      },
      {
        name: 'contextRelations',
        kind: 'json',
        description: 'Context 从 subject 出发沿哪些关系装配（FR-AGT-004）',
      },
      {
        name: 'mayPropose',
        kind: 'json',
        description:
          '允许提议写回的类型清单。**空表示只能给建议**——' +
          '能写什么由声明决定，不由模型的输出决定',
      },
      { name: 'maxTokensPerRun', kind: 'int', description: '单次 Run 的 token 上限（FR-AGT-012）' },
    ],
  },
  {
    name: 'Notification',
    version: '1.0.0',
    // 归到 Execution：通知在这个系统里全部由工作发生的事情引发
    // （自动化、SLA 超时）。它不完美——通知本质上是跨上下文的平台关注点——
    // 但 PRD 的 7 个 BC 是固定的，硬加第 8 个比放错一个更糟
    context: 'Execution',
    lifecycle: 'notification-default',
    description:
      '一条站内通知（FR-WF-005 的 notify 动作）。' +
      '做成领域对象而不是一张旁路表：这样它天然受租户隔离与资源级权限约束，' +
      '能被查询、被下钻、被审计——而不是变成一条发出去就无人知晓的消息。' +
      'IM 与邮件属于 Connector 层，这里只负责站内这一路。',
    attributes: [
      { name: 'title', kind: 'string', required: true },
      { name: 'body', kind: 'text' },
      { name: 'recipient', kind: 'string', required: true, description: 'user:// 或 agent:// 主体' },
      { name: 'about', kind: 'ref', description: '这条通知在说哪个对象' },
      {
        name: 'severity',
        kind: 'enum',
        values: ['info', 'warning', 'critical'],
        description: '决定它在收件箱里排在哪儿；不影响送达',
      },
      { name: 'readAt', kind: 'datetime', derived: true },
    ],
  },
  {
    name: 'Release',
    version: '1.0.0',
    context: 'Execution',
    lifecycle: 'release-default',
    description:
      '一次发布（FR-DOM-007）。它装的是 Task——"这次发了什么"必须是可枚举的对象，' +
      '不是一段发布说明里的文字。',
    attributes: [
      { name: 'name', kind: 'string', required: true },
      { name: 'version', kind: 'string', required: true },
      { name: 'notes', kind: 'richtext' },
      { name: 'releasedAt', kind: 'datetime', derived: true },
    ],
  },
  {
    name: 'Sprint',
    version: '1.0.0',
    context: 'Execution',
    lifecycle: 'sprint-default',
    description: '一次迭代（PRD 03 §5）。Velocity 的分母就是它',
    attributes: [
      { name: 'name', kind: 'string', required: true },
      { name: 'goal', kind: 'text' },
      { name: 'startAt', kind: 'datetime', required: true },
      { name: 'endAt', kind: 'datetime', required: true },
      { name: 'capacity', kind: 'float', description: '可用点数 / 工时' },
      { name: 'completedPoints', kind: 'float', derived: true, description: '本迭代完成的点数' },
    ],
  },
  {
    name: 'Milestone',
    version: '1.0.0',
    context: 'Project',
    lifecycle: 'milestone-default',
    description: '里程碑（PRD 03 §2）',
    attributes: [
      { name: 'name', kind: 'string', required: true },
      { name: 'dueDate', kind: 'datetime', required: true },
      { name: 'forecastDate', kind: 'datetime', description: '按当前进度预测的达成日' },
    ],
  },
  {
    name: 'Risk',
    version: '1.0.0',
    context: 'Project',
    lifecycle: 'risk-default',
    description:
      '风险登记册的一条（PRD 03 §2）。不变量：**高风险必须有 owner 与 mitigation**——' +
      '一条没人负责、没有对策的高风险，登记下来只是让人安心，不改变任何事。',
    attributes: [
      { name: 'description', kind: 'text', required: true },
      {
        name: 'probability',
        kind: 'enum',
        values: ['low', 'medium', 'high'],
        required: true,
      },
      { name: 'impact', kind: 'enum', values: ['low', 'medium', 'high'], required: true },
      { name: 'mitigation', kind: 'text', description: '缓解措施。高风险进入 Mitigating 时必填' },
      { name: 'dueDate', kind: 'datetime', description: '缓解期限；过期未处理会被指标点名' },
    ],
  },
  {
    name: 'Budget',
    version: '1.0.0',
    context: 'Project',
    lifecycle: 'budget-default',
    description: '预算（PRD 03 §2）。人力 / Token / 云成本各记一条',
    attributes: [
      {
        name: 'type',
        kind: 'enum',
        values: ['headcount', 'token', 'cloud'],
        required: true,
      },
      { name: 'planned', kind: 'float', required: true },
      { name: 'consumed', kind: 'float', description: '已消耗。超过 hardLimit 触发策略' },
      { name: 'hardLimit', kind: 'float' },
    ],
  },
  {
    name: 'Approval',
    version: '1.0.0',
    context: 'Identity',
    lifecycle: 'approval-default',
    description:
      '一次人工确认（FR-IAM-009）。策略判定为 Ask 时挂起在这里，' +
      '等人批准或拒绝，**超时自动拒绝**。' +
      '做成领域对象而不是内存里的一张挂起表：进程重启不该让待批的操作凭空消失，' +
      '而"谁批准了什么"本来就该是可查、可审计的。',
    attributes: [
      { name: 'action', kind: 'string', required: true, description: '被挂起的 Capability' },
      { name: 'requestedBy', kind: 'string', required: true },
      { name: 'targetId', kind: 'string', description: '作用于哪个对象' },
      { name: 'matchedPolicy', kind: 'string', description: '哪条 Ask 策略把它挡下来的' },
      {
        name: 'expiresAt',
        kind: 'datetime',
        required: true,
        description: '过了这个时刻自动拒绝。**没有它，一次挂起就是永久待批**',
      },
      { name: 'decidedBy', kind: 'string', derived: true },
      { name: 'decidedAt', kind: 'datetime', derived: true },
    ],
  },
  {
    name: 'Acceptance',
    version: '1.0.0',
    context: 'Requirement',
    lifecycle: 'acceptance-default',
    description:
      '验收标准（FR-DOM-004）。**是一个对象，不是 Story 上的一段文本**——' +
      '因为它要能被单独确认、被测试用例引用、被查询"哪些验收还没过"。' +
      '塞进 Story 的一个 richtext 字段里，这三件事一件也做不到。',
    attributes: [
      // given / when / then 分成三个字段而不是一段自由文本：
      // 一条读起来像验收标准、其实没有可判定条件的描述，
      // 是需求评审里最常见也最贵的一种含糊
      { name: 'given', kind: 'text', required: true, description: '前置条件' },
      { name: 'when', kind: 'text', required: true, description: '触发动作' },
      { name: 'then', kind: 'text', required: true, description: '可观察的结果' },
      { name: 'verifiedBy', kind: 'string', description: '由哪个测试用例 / 谁验证' },
      { name: 'verifiedAt', kind: 'datetime', derived: true },
    ],
  },
]

export const DEFAULT_RELATION_TYPES: readonly RelationTypeDef[] = [
  {
    // Release ──ships──▶ Task
    name: 'ships',
    inverse: 'shippedIn',
    acyclic: true,
    domain: ['Release'],
    range: ['Task'],
  },
  {
    name: 'shippedIn',
    inverse: 'ships',
    acyclic: true,
    domain: ['Task'],
    range: ['Release'],
  },
  {
    // Story ──acceptedBy──▶ Acceptance
    name: 'acceptedBy',
    inverse: 'acceptanceFor',
    domain: ['Requirement', 'Story'],
    range: ['Acceptance'],
  },
  {
    name: 'acceptanceFor',
    inverse: 'acceptedBy',
    domain: ['Acceptance'],
    range: ['Requirement', 'Story'],
  },
  {
    name: 'contains',
    inverse: 'containedIn',
    transitive: true,
    // 一个项目装着自己，会让传递闭包查询直接转不出来
    acyclic: true,
    domain: ['Project'],
    range: ['Requirement', 'Story', 'Task', 'Decision', 'Knowledge', 'Acceptance'],
  },
  {
    name: 'containedIn',
    inverse: 'contains',
    transitive: true,
    acyclic: true,
    domain: ['Requirement', 'Story', 'Task', 'Decision', 'Knowledge', 'Acceptance'],
    range: ['Project'],
  },
  {
    name: 'implementedBy',
    inverse: 'implements',
    domain: ['Requirement'],
    range: ['Story'],
  },
  {
    name: 'implements',
    inverse: 'implementedBy',
    domain: ['Story'],
    range: ['Requirement'],
  },
  {
    name: 'decomposedInto',
    acyclic: true,
    inverse: 'partOf',
    domain: ['Story'],
    range: ['Task'],
  },
  {
    name: 'partOf',
    acyclic: true,
    inverse: 'decomposedInto',
    domain: ['Task'],
    range: ['Story'],
  },
  {
    // 依赖成环意味着这几件事互相等对方先做完，谁也开不了工。
    // 这是能在写入时判掉的错，而在排期会上才发现的话，代价大得多
    name: 'blockedBy',
    acyclic: true,
    inverse: 'blocks',
    domain: ['Task'],
    range: ['Task'],
  },
  {
    name: 'blocks',
    acyclic: true,
    inverse: 'blockedBy',
    domain: ['Task'],
    range: ['Task'],
  },
  {
    name: 'explains',
    inverse: 'explainedBy',
    domain: ['Decision'],
    range: ['Requirement'],
  },
  {
    name: 'explainedBy',
    inverse: 'explains',
    domain: ['Requirement'],
    range: ['Decision'],
  },
  {
    name: 'owns',
    inverse: 'ownedBy',
    domain: ['Agent'],
    range: ['Task'],
  },
  {
    name: 'ownedBy',
    inverse: 'owns',
    domain: ['Task'],
    range: ['Agent'],
  },
  {
    name: 'derivedFrom',
    inverse: 'distills',
    domain: ['Knowledge'],
    range: ['Task', 'Decision'],
  },
  {
    name: 'distills',
    inverse: 'derivedFrom',
    domain: ['Task', 'Decision'],
    range: ['Knowledge'],
  },
]

export function buildDefaultRegistry(): OntologyRegistry {
  const registry = new OntologyRegistry()
  for (const def of DEFAULT_ENTITY_TYPES) registry.registerEntity(def)
  for (const def of DEFAULT_RELATION_TYPES) registry.registerRelation(def)
  registry.seal()
  return registry
}
