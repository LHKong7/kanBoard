/**
 * 本体元模型（ADR-0001 · Ontology First）。
 *
 * 这里定义的是"类型的类型"：先有 EntityType，才有表、API、UI。
 * 任何未在此注册的业务对象都无法写入系统。
 */

export type AttributeKind =
  | 'string'
  | 'text'
  | 'richtext'
  | 'int'
  | 'float'
  | 'percent'
  | 'bool'
  | 'datetime'
  | 'enum'
  | 'ref'
  | 'json'

export type AttributeType = {
  name: string
  kind: AttributeKind
  required?: boolean
  /** kind === 'enum' 时的取值集合 */
  values?: readonly string[]
  /** kind === 'ref' 时指向的 EntityType */
  target?: string
  /** 数据分级，决定能否进入 Agent 上下文与能否出境（ADR-0006） */
  classification?: DataClassification
  description?: string
}

/** 数据分级（NFR-COMP-001）。`secret` 永不进入模型上下文，`pii` 出境前必须脱敏。 */
export type DataClassification = 'public' | 'internal' | 'confidential' | 'pii' | 'secret'

export type Cardinality = '0..1' | '1..1' | '0..n' | '1..n'

export type RelationTypeDef = {
  name: string
  /** 逆关系名。FR-ONT-003 要求正反向查询等价，因此这是必填。 */
  inverse: string
  /** 传递闭包关系（如 contains）可做深度遍历（FR-ONT-004） */
  transitive?: boolean
  domain: readonly string[]
  range: readonly string[]
  cardinality?: Cardinality
  description?: string
}

export type EntityTypeDef = {
  name: string
  /** SemVer。实例写入时记录 ontologyVersion，读取旧实例时按兼容视图投影。 */
  version: string
  /** 所属限界上下文（原则 P2.1：一个对象只能属于一个上下文） */
  context: BoundedContext
  attributes: readonly AttributeType[]
  /** 绑定的生命周期状态机 id（Workflow Engine，M1 实现） */
  lifecycle?: string
  description?: string
}

export type BoundedContext =
  | 'Project'
  | 'Requirement'
  | 'Architecture'
  | 'Execution'
  | 'Knowledge'
  | 'AI'
  | 'Identity'

export const BOUNDED_CONTEXTS: readonly BoundedContext[] = [
  'Project',
  'Requirement',
  'Architecture',
  'Execution',
  'Knowledge',
  'AI',
  'Identity',
]

/** 关系实例。`confidence` 与 `createdBy` 支撑 FR-ONT-006：Agent 推断的关系可被人工否决。 */
export type RelationOrigin = 'human' | 'system' | `agent:${string}`

export type RelationInstance = {
  id: string
  tenant: string
  type: string
  fromId: string
  toId: string
  createdBy: RelationOrigin
  createdAt: Date
  /** Agent 推断关系必填（FR-ONT-006） */
  confidence: number | null
  /** null = 待确认；true = 人工确认；false = 人工否决 */
  confirmed: boolean | null
}
