import { sql } from 'kysely'
import type { Db } from './db/client.ts'
import type { FieldChange } from './db/schema.ts'
import type {
  GroupCount,
  GroupableField,
  Page,
  PageResult,
  ResourceFilter,
  ResourceRepository,
} from '../domain/resource/ports.ts'
import type { HistoryEntry, Resource, Visibility } from '../domain/resource/resource.ts'
import type { Principal } from '../identity/types.ts'

/** 与 api/schemas.ts 的 resourceIdSchema 同源：`req_01J…` 这种形状 */
const RESOURCE_ID = /^[a-z][a-z0-9]*_[0-9A-HJKMNP-TV-Z]{26}$/

/**
 * 短于三个字符的查询串走另一条路。
 *
 * pg_trgm 三字符一组，抽不出三元组时索引**不是"用不上"，而是更糟**：
 * 规划器照样可能选它，而索引扫描会把整表当候选返回，再由 recheck 逐行过滤。
 * 100 万行实测 `状态`（4 组，Execution Time）：
 *
 *                          带 type 过滤    不带
 *   ILIKE（可命中 trigram）    14.0 ms    1259 ms   ← 索引返回 1,010,420 候选行
 *   strpos（挡开 trigram）      0.4 ms     734 ms
 *
 * 两处收益不同，别混为一谈：
 *
 * - **不带 type**：1259 → 734 ms。都很糟，strpos 只是没那么糟。
 *   这条路径会打一条 warn 日志，见下方 query()。
 * - **带 type**（界面上的实际路径，看板永远有一个当前类型）：14.0 → 0.4 ms。
 *   差别不在于躲开了 trigram，而在于躲开之后规划器改选了
 *   (tenant, type, id DESC)——它本来就按 id 排好序，凑够一页就能停；
 *   而 ILIKE 那条选的是 (tenant, type)，得读完一万行再 top-N 排序。
 *
 * 中文两字词（需求 / 状态 / 权限）太常见，拒绝这类查询等于让搜索框
 * 对中文用户不可用，所以是换路径而不是拒绝。
 */
const TRIGRAM_MIN = 3

/**
 * 转义 LIKE 的通配符。
 *
 * 不转的话，用户搜一个 `%` 就等于「匹配一切」，搜 `_` 等于「匹配任意单字」——
 * 前者把全表拉回来，后者给出莫名其妙的结果，两种都不是用户要的。
 * 反斜杠自己必须先转，否则 `\%` 会被当成"转义过的 %"而漏掉。
 */
function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (ch) => `\\${ch}`)
}

/**
 * 显式列出要取的列，不用 `selectAll()`。
 *
 * `search_text` 是生成列（002_search.sql），内容是全部属性值的拼接——
 * 也就是说 `selectAll()` 会把每一行的属性**取两遍**。
 * 它只用于 WHERE，从不回传给调用方，没有理由让它占着网络和内存。
 */
const RESOURCE_COLUMNS = [
  'id',
  'tenant',
  'type',
  'ontology_version',
  'workspace',
  'project',
  'owner',
  'created_by',
  'created_at',
  'updated_at',
  'status',
  'lifecycle',
  'version',
  'labels',
  'attributes',
  'visibility',
  'deleted_at',
] as const

const GROUP_COLUMNS: Record<GroupableField, 'status' | 'type' | 'owner' | 'project'> = {
  status: 'status',
  type: 'type',
  owner: 'owner',
  project: 'project',
}

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
        status_since: resource.createdAt,
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
      .select(RESOURCE_COLUMNS)
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
        // 只在状态真的变了时重置计时，而且**在 SQL 里判**。
        //
        // 交给调用方去判断"这次改了状态吗"，迟早会有一条写路径忘记，
        // 而症状是某些对象的 SLA 永远不触发——一个没人会去查的静默失败。
        // 放在这里，它对所有写路径一视同仁。
        status_since: sql<Date>`CASE WHEN resources.status <> ${resource.status}
          THEN ${resource.updatedAt}::timestamptz ELSE resources.status_since END`,
      })
      .where('tenant', '=', this.#tenant)
      .where('id', '=', resource.id)
      .where('version', '=', expectedVersion)
      .executeTakeFirst()

    return (result.numUpdatedRows ?? 0n) > 0n
  }

  /**
   * 过滤条件的**唯一**构造处。
   *
   * `query`（列表 / 下钻）与 `countGrouped`（指标）都走它。
   * 分成两份写的话，指标算出 12 条、点开明细看到 9 条——
   * 而这种不一致没人会当成 bug 报，只会让人默默不再相信这个数字。
   */
  #applyFilter<Q extends { where: (...args: never[]) => Q }>(q: Q, filter: ResourceFilter): Q {
    // 用 any 桥接 Kysely 的 builder 泛型：这里只加 WHERE，不改变 select 的形状
    /* eslint-disable @typescript-eslint/no-explicit-any */
    let b = q as any
    b = b.where('tenant', '=', this.#tenant)
    if (filter.type !== undefined) b = b.where('type', '=', filter.type)
    if (filter.workspace !== undefined) b = b.where('workspace', '=', filter.workspace)
    if (filter.project !== undefined) b = b.where('project', '=', filter.project)
    if (filter.owner !== undefined) b = b.where('owner', '=', filter.owner)
    if (filter.status !== undefined && filter.status.length > 0) {
      b = b.where('status', 'in', filter.status as string[])
    }
    if (filter.labels !== undefined && filter.labels.length > 0) {
      b = b.where(sql<boolean>`labels @> ${sql.val(filter.labels as string[])}`)
    }
    if (filter.attributes !== undefined && Object.keys(filter.attributes).length > 0) {
      // @> 走 jsonb_path_ops GIN 索引
      b = b.where(sql<boolean>`attributes @> ${JSON.stringify(filter.attributes)}::jsonb`)
    }
    const term = filter.text?.trim()
    if (term !== undefined && term !== '') {
      if (RESOURCE_ID.test(term)) {
        b = b.where('id', '=', term)
      } else if (term.length >= TRIGRAM_MIN) {
        b = b.where(sql<boolean>`search_text ILIKE ${'%' + escapeLike(term) + '%'}`)
      } else {
        b = b.where(sql<boolean>`strpos(lower(search_text), lower(${term})) > 0`)
      }
    }
    if (filter.ids !== undefined) {
      // 空数组要生成一个恒假条件，而不是被当成"没有这个过滤条件"。
      // Kysely 的 `in []` 会生成 `in ()`，PG 直接语法错误
      b = filter.ids.length === 0 ? b.where(sql<boolean>`false`) : b.where('id', 'in', filter.ids)
    }
    if (filter.includeDeleted !== true) {
      b = b.where('deleted_at', 'is', null)
    }
    return b as Q
    /* eslint-enable @typescript-eslint/no-explicit-any */
  }

  async query(filter: ResourceFilter, page: Page): Promise<PageResult<Resource>> {
    const size = Math.min(Math.max(page.size, 1), 200)

    let q = this.#applyFilter(
      this.#db.selectFrom('resources').select(RESOURCE_COLUMNS),
      filter,
    )
    const term = filter.text?.trim()

    if (page.cursor !== undefined) {
      // ULID 单调递增，倒序分页取严格小于游标的下一批
      q = q.where('id', '<', page.cursor)
    }

    // 排序始终按 id 倒序（最新的在前），检索时也不换成相关度排序：
    // 游标分页依赖 id 的全序，换成相关度就得换一套游标方案，
    // 而"翻页会漏条目/重复条目"是比"排序不够聪明"严重得多的缺陷。
    //
    // 多取一条用来判断是否还有下一页，避免额外的 count 查询
    const startedAt = Date.now()
    const rows = await q.orderBy('id', 'desc').limit(size + 1).execute()

    // 短查询没有别的条件收窄时是真的慢，得让运维知道。带 type/project 的不必吵——
    // 那条路径实测 0.5ms，属于正常流量
    if (
      term !== undefined &&
      term.length > 0 &&
      term.length < TRIGRAM_MIN &&
      !RESOURCE_ID.test(term) &&
      filter.type === undefined &&
      filter.project === undefined
    ) {
      const elapsed = Date.now() - startedAt
      console.warn(
        `[search] term "${term}" is shorter than ${TRIGRAM_MIN} chars and has no type/project ` +
          `filter to narrow it; this scanned the whole tenant (${elapsed}ms)`,
      )
    }
    const hasMore = rows.length > size
    const items = (hasMore ? rows.slice(0, size) : rows).map((r) => toResource(r as unknown as ResourceRow))

    return {
      items,
      nextCursor: hasMore ? (items[items.length - 1]?.id ?? null) : null,
    }
  }

  /**
   * 分组计数。复用 `query` 的过滤条件构造，指标与下钻明细因此天然一致。
   *
   * 把 WHERE 的构造抽出来是必须的：如果指标一套条件、下钻另一套，
   * 用户点开明细会发现条数对不上——而那种不一致没人会当成 bug 报，
   * 只会让人默默不再相信这个数字。
   */
  async countGrouped(filter: ResourceFilter, groupBy: GroupableField): Promise<GroupCount[]> {
    const column = GROUP_COLUMNS[groupBy]
    const rows = await this.#applyFilter(
      this.#db.selectFrom('resources').select((eb) => [
        eb.ref(column).as('key'),
        eb.fn.countAll<string>().as('count'),
      ]),
      filter,
    )
      .groupBy(column)
      .orderBy('count', 'desc')
      .execute()

    return rows.map((r) => ({ key: r.key ?? '(none)', count: Number(r.count) }))
  }

  /**
   * 对某个属性求和 / 求平均（FR-DASH-001/002/003）。
   *
   * 用 `jsonb_typeof(...) = 'number'` 先筛：非数值的属性被**排除**，
   * 而不是当成 0。当成 0 的话，一个把 costUsd 写成 "1.50" 字符串的
   * bug 会表现为"成本突然降下来了"——一个看起来像好消息的坏消息。
   * `counted` 报出真正参与计算的条数，好让人对得上。
   */
  async aggregate(
    filter: ResourceFilter,
    fn: 'sum' | 'avg',
    attribute: string,
  ): Promise<{ value: number; counted: number }> {
    const path = sql`attributes -> ${sql.lit(attribute)}`
    const numeric = sql<number>`(${path})::numeric`
    const row = await this.#applyFilter(
      this.#db.selectFrom('resources').select(() => [
        (fn === 'sum'
          ? sql<string | null>`sum(${numeric})`
          : sql<string | null>`avg(${numeric})`
        ).as('value'),
        sql<string>`count(${numeric})`.as('counted'),
      ]),
      filter,
    )
      .where(sql<boolean>`jsonb_typeof(${path}) = 'number'`)
      .executeTakeFirst()

    return {
      // 一条都没有时是 0 而不是 NaN/null：界面上"还没有数据"该显示成 0
      value: row?.value == null ? 0 : Number(row.value),
      counted: Number(row?.counted ?? 0),
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
