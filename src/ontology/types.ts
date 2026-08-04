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
  /**
   * 由系统写入，不该出现在人填的表单里（如状态机 entry action 写的时间戳）。
   *
   * 这条信息属于本体而不是前端：ADR-0001 要求 UI 是本体的渲染视图，
   * 前端不得自己判断"哪些字段该显示"——那等于把语义搬到了 UI 层。
   */
  derived?: boolean
  /**
   * 该属性允许的最大长度（字符数；`json` 按序列化后的长度算）。
   *
   * 不填则按 `kind` 取默认值，见 `MAX_LENGTH_BY_KIND`。
   * 注册时会被填成具体数字，所以 `GET /v1/ontology/entity-types`
   * 拿到的一定是可直接使用的值，客户端不必自己再推一遍默认规则。
   *
   * 为什么这条必须长在本体上（docs/dogfooding-log.md #7）：
   * 长度上限本来就存在——只是藏在服务端的校验器里。
   * 客户端无从知道多长会被拒，只能各自猜一个数去截断，
   * 猜得不一样，同一份内容在不同客户端就以不同的方式被截断。
   * 约束是语义的一部分，属于本体，不属于某一层的实现细节。
   */
  maxLength?: number
  description?: string
}

/**
 * 按 `kind` 的默认长度上限。
 *
 * `kind` 本来就承载着"这是个短标签 / 一段话 / 一篇文档"的语义，
 * 上限跟着它走，绝大多数属性就不必逐个声明。
 *
 * 数值是照真实语料定的，不是拍的（截至 2026-08-04 的自用库）：
 *
 *   richtext  实测最长 7,468（Knowledge.body）  → 200,000，约 26 倍余量
 *   text      实测最长 1,465（Decision.chosen） →  20,000，约 13 倍余量
 *   string    实测最长    79（Requirement.title）→  1,024，沿用原值
 *
 * `text` 与 `richtext` 此前共用 1,000,000：一个「阻塞原因」能写一兆字节
 * 不是用法，是缺陷。`json` 此前完全没有上限，唯一的边界是 4MB 请求体。
 */
export const MAX_LENGTH_BY_KIND: Partial<Record<AttributeKind, number>> = {
  string: 1_024,
  text: 20_000,
  richtext: 200_000,
  json: 100_000,
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
