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
    version: '1.1.0',
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
    version: '1.1.0',
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
    version: '1.1.0',
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
    version: '1.1.0',
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
    version: '1.1.0',
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
    version: '1.1.0',
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
    name: 'Agent',
    version: '1.0.0',
    context: 'AI',
    lifecycle: 'agent-default',
    description: 'Agent 是一等身份主体，同样是领域对象（ADR-0003）',
    attributes: [
      { name: 'name', kind: 'string', required: true },
      { name: 'principal', kind: 'string', required: true, description: 'agent://<name>@<version>' },
      { name: 'ownerTeam', kind: 'string' },
      { name: 'capabilities', kind: 'json', description: '显式授予的 Capability 列表；默认为空' },
    ],
  },
]

export const DEFAULT_RELATION_TYPES: readonly RelationTypeDef[] = [
  {
    name: 'contains',
    inverse: 'containedIn',
    transitive: true,
    domain: ['Project'],
    range: ['Requirement', 'Story', 'Task', 'Decision', 'Knowledge'],
  },
  {
    name: 'containedIn',
    inverse: 'contains',
    transitive: true,
    domain: ['Requirement', 'Story', 'Task', 'Decision', 'Knowledge'],
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
    inverse: 'partOf',
    domain: ['Story'],
    range: ['Task'],
  },
  {
    name: 'partOf',
    inverse: 'decomposedInto',
    domain: ['Task'],
    range: ['Story'],
  },
  {
    name: 'blockedBy',
    inverse: 'blocks',
    domain: ['Task'],
    range: ['Task'],
  },
  {
    name: 'blocks',
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
