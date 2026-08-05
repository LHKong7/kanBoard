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
  /**
   * 不允许成环（FR-DOM-005）。
   *
   * 写在本体里而不是写死在服务层，理由和别的约束一样：
   * "哪些关系不能成环"是**建模决定**，不是实现细节。
   * 写死的话，新增一种依赖关系时没人知道还要去改一处 if。
   *
   * 只对同一种关系类型内部判环。跨类型的环（A blocks B，B contains A）
   * 不在此列——那需要定义"哪几种关系算同一张图"，
   * 而目前没有一个说得清的答案，硬判会拦下大量合法的建模。
   */
  acyclic?: boolean
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
/**
 * 一条边是谁建的。
 *
 * `rule:<ruleId>` 和 `agent:<name>` 归成一类：**两者建的都是建议，不是事实**
 * （FR-ONT-008 / FR-ONT-006）。图上的边是会被守卫读的——Release 只装 Done 的
 * Task、Story 要有验收标准——所以一条没人看过的边可以让一批对象的状态机
 * 行为整个变掉。它们因此都默认"待确认"，都必须带置信度。
 *
 * 分成两个前缀而不是共用一个，是因为出了问题要追得到源头：
 * 一条边是哪条规则建的，和是哪个 Agent 推的，处理方式完全不同。
 */
export type RelationOrigin = 'human' | 'system' | `agent:${string}` | `rule:${string}`

/** 建议性的来源：默认待确认、必须带置信度 */
export function isProposal(origin: RelationOrigin): boolean {
  return origin.startsWith('agent:') || origin.startsWith('rule:')
}

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
