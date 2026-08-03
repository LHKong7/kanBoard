import { sql } from 'kysely'
import type { Db } from './db/client.ts'
import type { FieldChange } from './db/schema.ts'
import type {
  Page,
  PageResult,
  ResourceFilter,
  ResourceRepository,
} from '../domain/resource/ports.ts'
import type { HistoryEntry, Resource, Visibility } from '../domain/resource/resource.ts'
import type { Principal } from '../identity/types.ts'

type ResourceRow = {
  id: string
  tenant: string
  type: string
  ontology_version: string
  workspace: string
  project: string | null
  owner: string
  created_by: string
  created_at: Date
  updated_at: Date
  status: string
  lifecycle: string | null
  version: number
  labels: string[]
  attributes: Record<string, unknown>
  visibility: string
  deleted_at: Date | null
}

function toResource(row: ResourceRow): Resource {
  return {
    id: row.id,
    type: row.type,
    ontologyVersion: row.ontology_version,
    tenant: row.tenant,
    workspace: row.workspace,
    project: row.project,
    owner: row.owner,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    status: row.status,
    lifecycle: row.lifecycle,
    version: row.version,
    labels: row.labels,
    attributes: row.attributes,
    visibility: row.visibility as Visibility,
    deletedAt: row.deleted_at,
  }
}

/**
 * Resource 仓储的 Postgres 实现。
 *
 * 每个实例绑定一个已设置租户的事务（见 withTenant）。
 * 查询里仍然写 tenant 条件——RLS 是兜底，不是省事的借口，而且带上 tenant 才能命中索引前缀。
 */
export class PgResourceRepository implements ResourceRepository {
  readonly #db: Db
  readonly #tenant: string

  constructor(db: Db, tenant: string) {
    this.#db = db
    this.#tenant = tenant
  }

  async insert(resource: Resource): Promise<void> {
    await this.#db
      .insertInto('resources')
      .values({
        id: resource.id,
        tenant: resource.tenant,
        type: resource.type,
        ontology_version: resource.ontologyVersion,
        workspace: resource.workspace,
        project: resource.project,
        owner: resource.owner,
        created_by: resource.createdBy,
        created_at: resource.createdAt,
        updated_at: resource.updatedAt,
        status: resource.status,
        lifecycle: resource.lifecycle,
        version: resource.version,
        labels: resource.labels as string[],
        attributes: JSON.stringify(resource.attributes),
        visibility: resource.visibility,
        deleted_at: resource.deletedAt,
      })
      .execute()
  }

  async findById(id: string): Promise<Resource | null> {
    const row = await this.#db
      .selectFrom('resources')
      .selectAll()
      .where('tenant', '=', this.#tenant)
      .where('id', '=', id)
      .executeTakeFirst()
    return row === undefined ? null : toResource(row as unknown as ResourceRow)
  }

  /**
   * 乐观锁更新（FR-RES-003）。
   *
   * 版本条件写在 WHERE 里而不是先读再判断：先读后写之间存在竞态窗口，
   * 把条件交给数据库才是原子的。影响行数为 0 即冲突。
   */
  async update(resource: Resource, expectedVersion: number): Promise<boolean> {
    const result = await this.#db
      .updateTable('resources')
      .set({
        status: resource.status,
        labels: resource.labels as string[],
        attributes: JSON.stringify(resource.attributes),
        visibility: resource.visibility,
        owner: resource.owner,
        updated_at: resource.updatedAt,
        version: resource.version,
        deleted_at: resource.deletedAt,
      })
      .where('tenant', '=', this.#tenant)
      .where('id', '=', resource.id)
      .where('version', '=', expectedVersion)
      .executeTakeFirst()

    return (result.numUpdatedRows ?? 0n) > 0n
  }

  async query(filter: ResourceFilter, page: Page): Promise<PageResult<Resource>> {
    const size = Math.min(Math.max(page.size, 1), 200)

    let q = this.#db.selectFrom('resources').selectAll().where('tenant', '=', this.#tenant)

    if (filter.type !== undefined) q = q.where('type', '=', filter.type)
    if (filter.workspace !== undefined) q = q.where('workspace', '=', filter.workspace)
    if (filter.project !== undefined) q = q.where('project', '=', filter.project)
    if (filter.owner !== undefined) q = q.where('owner', '=', filter.owner)
    if (filter.status !== undefined && filter.status.length > 0) {
      q = q.where('status', 'in', filter.status as string[])
    }
    if (filter.labels !== undefined && filter.labels.length > 0) {
      q = q.where(sql<boolean>`labels @> ${sql.val(filter.labels as string[])}`)
    }
    if (filter.attributes !== undefined && Object.keys(filter.attributes).length > 0) {
      // @> 走 jsonb_path_ops GIN 索引
      q = q.where(sql<boolean>`attributes @> ${JSON.stringify(filter.attributes)}::jsonb`)
    }
    if (filter.includeDeleted !== true) {
      q = q.where('deleted_at', 'is', null)
    }
    if (page.cursor !== undefined) {
      // ULID 单调递增，倒序分页取严格小于游标的下一批
      q = q.where('id', '<', page.cursor)
    }

    // 多取一条用来判断是否还有下一页，避免额外的 count 查询
    const rows = await q.orderBy('id', 'desc').limit(size + 1).execute()
    const hasMore = rows.length > size
    const items = (hasMore ? rows.slice(0, size) : rows).map((r) => toResource(r as unknown as ResourceRow))

    return {
      items,
      nextCursor: hasMore ? (items[items.length - 1]?.id ?? null) : null,
    }
  }

  async appendHistory(entry: HistoryEntry): Promise<void> {
    await this.#db
      .insertInto('resource_history')
      .values({
        resource_id: entry.resourceId,
        tenant: this.#tenant,
        version: entry.version,
        changed_by: entry.changedBy,
        on_behalf_of: entry.onBehalfOf,
        changed_at: entry.changedAt,
        run_ref: entry.runRef,
        changes: JSON.stringify(entry.changes),
        reason: entry.reason,
        trace_id: entry.traceId,
      })
      .execute()
  }

  async history(resourceId: string, page: Page): Promise<PageResult<HistoryEntry>> {
    const size = Math.min(Math.max(page.size, 1), 200)
    let q = this.#db
      .selectFrom('resource_history')
      .selectAll()
      .where('tenant', '=', this.#tenant)
      .where('resource_id', '=', resourceId)

    if (page.cursor !== undefined) {
      q = q.where('version', '<', Number(page.cursor))
    }

    const rows = await q.orderBy('version', 'desc').limit(size + 1).execute()
    const hasMore = rows.length > size
    const slice = hasMore ? rows.slice(0, size) : rows

    const items: HistoryEntry[] = slice.map((row) => ({
      resourceId: row.resource_id,
      version: row.version,
      changedBy: row.changed_by as Principal,
      onBehalfOf: row.on_behalf_of,
      changedAt: row.changed_at,
      runRef: row.run_ref,
      changes: row.changes as unknown as readonly FieldChange[],
      reason: row.reason,
      traceId: row.trace_id,
    }))

    return {
      items,
      nextCursor: hasMore ? String(items[items.length - 1]?.version ?? '') : null,
    }
  }
}
