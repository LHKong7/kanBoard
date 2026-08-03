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

export type TraverseSpec = {
  start: string
  follow: readonly string[]
  maxDepth: number
  direction: 'out' | 'in' | 'both'
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

export interface RelationRepository {
  insert(relation: RelationInstance): Promise<void>
  remove(relationId: string): Promise<boolean>
  findById(relationId: string): Promise<RelationInstance | null>
  /** direction=out 查 from_id，in 查 to_id；both 合并 */
  listFor(resourceId: string, direction: 'out' | 'in' | 'both', type?: string): Promise<RelationInstance[]>
  traverse(spec: TraverseSpec): Promise<TraverseHit[]>
  shortestPath(from: string, to: string, maxDepth: number): Promise<PathHit | null>
  setConfirmed(relationId: string, confirmed: boolean): Promise<boolean>
}

export interface EventSink {
  emit(event: DomainEvent): Promise<void>
}

export type AuditRecord = {
  tenant: string
  subject: string
  onBehalfOf: string | null
  action: string
  resourceId: string | null
  resourceType: string | null
  decision: Decision
  runRef: string | null
  occurredAt: Date
  traceId: string | null
}

export interface AuditSink {
  record(entry: AuditRecord): Promise<void>
}
