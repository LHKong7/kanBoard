import type { RelationInstance } from '../../ontology/types.ts'
import type { Decision } from '../../identity/types.ts'
import type { DomainEvent } from '../events.ts'
import type { HistoryEntry, Resource } from './resource.ts'

/**
 * 端口（Ports）。领域层只认这些接口，不认 Kysely、pg 或 Fastify。
 * dependency-cruiser 在 CI 中强制这一点（FR-ARCH-001）。
 */

export type ResourceFilter = {
  type?: string | undefined
  project?: string | undefined
  workspace?: string | undefined
  status?: readonly string[] | undefined
  labels?: readonly string[] | undefined
  owner?: string | undefined
  /** attributes 的精确匹配，键为属性名 */
  attributes?: Record<string, unknown> | undefined
  includeDeleted?: boolean | undefined
  /**
   * 全文检索词（FR-RES-016）。
   *
   * 匹配范围是标签与属性的**值**，不含键名——否则搜 "title" 会命中全表。
   * 词形如资源 id 时走主键精确匹配，方便"粘贴一个 id 过来找对象"。
   * 与其余条件是 AND：`{type:'Requirement', text:'状态机'}` 表示两者都要满足。
   */
  text?: string | undefined
}

export type Page = {
  size: number
  /** 游标即上一页最后一条的 id。ULID 有序，因此 id 就是稳定游标（FR-RES-012）。 */
  cursor?: string | undefined
}

export type PageResult<T> = {
  items: T[]
  nextCursor: string | null
}

/**
 * 遍历规格。
 *
 * 方向被折进两个类型列表，而不是单独的 direction 字段：
 * 逆关系的解析需要本体知识（服务层有，仓储层没有），
 * 折算完再传下来，基础设施层就只需要照着走图。
 */
export type TraverseSpec = {
  start: string
  /** 沿出边走时匹配的关系类型 */
  followOut: readonly string[]
  /** 沿入边走时匹配的关系类型 */
  followIn: readonly string[]
  maxDepth: number
  /**
   * 返回节点数上限。
   *
   * 没有上限的遍历不是"偶尔慢"，是**没有上界**：项目越大返回越多，
   * 一个 Project 的全后代在基准里是 10,100 个节点 / 1.12MB。
   * 上限之外的部分由 `truncated` 显式告知——静默截断比慢更糟，
   * 调用方会以为自己拿到了全部。
   */
  limit: number
}

export type TraverseResult = {
  hits: TraverseHit[]
  /** 命中数超过 limit，返回的是前 limit 个（按深度、id 排序） */
  truncated: boolean
}

export type TraverseHit = {
  id: string
  type: string
  depth: number
  /** 从 start 到该节点经过的关系类型序列 */
  path: readonly string[]
}

export type PathHit = {
  nodes: readonly string[]
  relations: readonly string[]
}

export interface ResourceRepository {
  insert(resource: Resource): Promise<void>
  findById(id: string): Promise<Resource | null>
  /** 带乐观锁的更新；版本不符返回 false，由服务层抛 ConflictError */
  update(resource: Resource, expectedVersion: number): Promise<boolean>
  query(filter: ResourceFilter, page: Page): Promise<PageResult<Resource>>
  appendHistory(entry: HistoryEntry): Promise<void>
  history(resourceId: string, page: Page): Promise<PageResult<HistoryEntry>>
}

/**
 * 插入关系的结果。
 *
 * `created: false` 表示这条边本来就在，返回的是**库里那一条**而不是刚构造的对象。
 * 重复建边是幂等的（自动化规则会反复触发），但幂等不等于可以谎报：
 * 早先这里回的是传进来的对象，接口于是返回 201 并附上一个数据库里
 * 不存在的 id——拿它去删会 404（docs/dogfooding-log.md #8）。
 */
export type InsertRelationResult = {
  relation: RelationInstance
  created: boolean
}

export interface RelationRepository {
  insert(relation: RelationInstance): Promise<InsertRelationResult>
  remove(relationId: string): Promise<boolean>
  findById(relationId: string): Promise<RelationInstance | null>
  /** direction=out 查 from_id，in 查 to_id；both 合并 */
  listFor(resourceId: string, direction: 'out' | 'in' | 'both', type?: string): Promise<RelationInstance[]>
  traverse(spec: TraverseSpec): Promise<TraverseResult>
  shortestPath(from: string, to: string, maxDepth: number): Promise<PathHit | null>
  setConfirmed(relationId: string, confirmed: boolean): Promise<boolean>
}

export interface EventSink {
  emit(event: DomainEvent): Promise<void>
}

/**
 * 审计里记录的判定。
 *
 * PDP 只输出 Allow / Deny，但审计要回答的问题比"权限够不够"更宽：
 * **一次被拒绝的尝试**都得留痕（见 docs/development.md §7）。
 * 被工作流守卫挡回去的自动化正属于此类——权限是够的（PDP 判了 Allow），
 * 是状态机不让走。用独立的 `Rejected` 而不是复用 `Deny`：
 * Deny 意味着权限不足，是要去查权限配置的信号，两者混在一起
 * 会让"有多少次越权尝试"这个数字失真。
 */
export type AuditEffect = Decision['effect'] | 'Rejected'

export type AuditOutcome = {
  effect: AuditEffect
  reason: string
  matchedPolicy?: string | undefined
}

export type AuditRecord = {
  tenant: string
  subject: string
  onBehalfOf: string | null
  action: string
  resourceId: string | null
  resourceType: string | null
  decision: AuditOutcome
  runRef: string | null
  occurredAt: Date
  traceId: string | null
}

export interface AuditSink {
  record(entry: AuditRecord): Promise<void>
}
