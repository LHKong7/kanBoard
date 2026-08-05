import { sql } from 'kysely'
import type { Db } from './db/client.ts'
import type {
  InsertRelationResult,
  PathHit,
  RelationRepository,
  TraverseResult,
  TraverseSpec,
} from '../domain/resource/ports.ts'
import type { RelationInstance, RelationOrigin } from '../ontology/types.ts'

type RelationRow = {
  id: string
  tenant: string
  type: string
  from_id: string
  to_id: string
  created_by: string
  created_at: Date
  confidence: number | null
  confirmed: boolean | null
}

function toRelation(row: RelationRow): RelationInstance {
  return {
    id: row.id,
    tenant: row.tenant,
    type: row.type,
    fromId: row.from_id,
    toId: row.to_id,
    createdBy: row.created_by as RelationOrigin,
    createdAt: row.created_at,
    confidence: row.confidence,
    confirmed: row.confirmed,
  }
}

/**
 * 关系仓储与图遍历。
 *
 * v1 用 PG 递归 CTE（ADR-0005 配套决策 Q-A2）：关系规模到达阈值前，
 * 引入独立图库只是增加运维面。接口在这里收敛，将来换存储不影响领域层。
 */
export class PgRelationRepository implements RelationRepository {
  readonly #db: Db
  readonly #tenant: string

  constructor(db: Db, tenant: string) {
    this.#db = db
    this.#tenant = tenant
  }

  async insert(relation: RelationInstance): Promise<InsertRelationResult> {
    const inserted = await this.#db
      .insertInto('relations')
      .values({
        id: relation.id,
        tenant: relation.tenant,
        type: relation.type,
        from_id: relation.fromId,
        to_id: relation.toId,
        created_by: relation.createdBy,
        created_at: relation.createdAt,
        confidence: relation.confidence,
        confirmed: relation.confirmed,
      })
      // 同一条边重复建立是幂等的：自动关系建立规则会反复触发，报错没有意义
      .onConflict((oc) => oc.columns(['tenant', 'from_id', 'type', 'to_id']).doNothing())
      .returningAll()
      .executeTakeFirst()

    if (inserted !== undefined) {
      return { relation: toRelation(inserted as unknown as RelationRow), created: true }
    }

    // 冲突了。**必须**把已存在的那条查回来还给调用方——
    // 早先这里直接把传进来的对象原样返回，于是接口回 201 并附上一个
    // 数据库里根本不存在的 id：拿它去删会 404，事件里也带着这个不存在的 id。
    // 幂等的意思是"再来一次结果相同"，不是"假装刚刚创建了一条"。
    const existing = await this.#db
      .selectFrom('relations')
      .selectAll()
      .where('tenant', '=', this.#tenant)
      .where('from_id', '=', relation.fromId)
      .where('type', '=', relation.type)
      .where('to_id', '=', relation.toId)
      .executeTakeFirst()

    if (existing === undefined) {
      // 冲突了却查不到：只可能是 RLS 挡住了另一个租户的同名边，
      // 或者唯一索引与这里的查询条件不一致。两种都是要立刻知道的问题
      throw new Error(
        `relation insert conflicted but the existing edge could not be read back ` +
          `(${relation.fromId} -${relation.type}-> ${relation.toId})`,
      )
    }
    return { relation: toRelation(existing as unknown as RelationRow), created: false }
  }

  async remove(relationId: string): Promise<boolean> {
    const result = await this.#db
      .deleteFrom('relations')
      .where('tenant', '=', this.#tenant)
      .where('id', '=', relationId)
      .executeTakeFirst()
    return (result.numDeletedRows ?? 0n) > 0n
  }

  async findById(relationId: string): Promise<RelationInstance | null> {
    const row = await this.#db
      .selectFrom('relations')
      .selectAll()
      .where('tenant', '=', this.#tenant)
      .where('id', '=', relationId)
      .executeTakeFirst()
    return row === undefined ? null : toRelation(row as unknown as RelationRow)
  }

  async listFor(
    resourceId: string,
    direction: 'out' | 'in' | 'both',
    type?: string,
  ): Promise<RelationInstance[]> {
    let q = this.#db.selectFrom('relations').selectAll().where('tenant', '=', this.#tenant)

    if (direction === 'out') q = q.where('from_id', '=', resourceId)
    else if (direction === 'in') q = q.where('to_id', '=', resourceId)
    else q = q.where((eb) => eb.or([eb('from_id', '=', resourceId), eb('to_id', '=', resourceId)]))

    if (type !== undefined) q = q.where('type', '=', type)

    const rows = await q.orderBy('created_at', 'desc').execute()
    return rows.map((r) => toRelation(r as unknown as RelationRow))
  }

  /**
   * 诱导子图：两端都落在 `ids` 里的边。
   *
   * **被否决的边（`confirmed = false`）也返回**，和 `traverse` 不同，
   * 而这个不同是有意的：遍历里的边是**通路**，否决过的不该让人走过去；
   * 这里的边是**说明**，两端本来就已经在图上了，画出来（虚线）
   * 说的是"有人看过这条关系并且否掉了它"。把它藏起来的后果是
   * 同一个人下周再推断一次同样的边，而图上没有任何痕迹说明这事发生过。
   *
   * 关键在于两端都必须在 `ids` 里——否则会画出一条一端悬空的线。
   */
  async edgesAmong(ids: readonly string[]): Promise<RelationInstance[]> {
    // 空集合天然没有内部边。交给 SQL 也对，但 `= ANY('{}')` 白跑一次往返
    if (ids.length === 0) return []

    const rows = await this.#db
      .selectFrom('relations')
      .selectAll()
      .where('tenant', '=', this.#tenant)
      .where('from_id', 'in', [...ids])
      .where('to_id', 'in', [...ids])
      .orderBy('created_at', 'desc')
      .execute()
    return rows.map((r) => toRelation(r as unknown as RelationRow))
  }

  async scanAll(after: string | null, limit: number): Promise<RelationInstance[]> {
    let q = this.#db
      .selectFrom('relations')
      .selectAll()
      .where('tenant', '=', this.#tenant)
      .orderBy('id', 'asc')
      .limit(limit)
    if (after !== null) q = q.where('id', '>', after)
    const rows = await q.execute()
    return rows.map((r) => toRelation(r as unknown as RelationRow))
  }

  async setConfirmed(relationId: string, confirmed: boolean): Promise<boolean> {
    const result = await this.#db
      .updateTable('relations')
      .set({ confirmed })
      .where('tenant', '=', this.#tenant)
      .where('id', '=', relationId)
      .executeTakeFirst()
    return (result.numUpdatedRows ?? 0n) > 0n
  }

  /**
   * 广度优先遍历（FR-ONT-004）。
   *
   * `visited` 数组防止环导致的无限递归——需求图里成环是常态
   * （blockedBy 会绕回来），不能假设它是 DAG。
   */
  async traverse(spec: TraverseSpec): Promise<TraverseResult> {
    // 空列表天然匹配不到任何边，因此不再需要 outward/inward 布尔开关
    const outTypes = spec.followOut as string[]
    const inTypes = spec.followIn as string[]

    const rows = await sql<{
      id: string
      type: string
      depth: number
      path: string[]
    }>`
      WITH RECURSIVE walk AS (
        SELECT
          r.id            AS id,
          r.type          AS type,
          0               AS depth,
          ARRAY[]::text[] AS path,
          ARRAY[r.id]     AS visited
        FROM resources r
        WHERE r.tenant = ${this.#tenant} AND r.id = ${spec.start}

        UNION ALL

        SELECT
          nxt.id,
          nxt.type,
          w.depth + 1,
          w.path || nxt.rel_type,
          w.visited || nxt.id
        FROM walk w
        JOIN LATERAL (
          SELECT rel.to_id AS id, tgt.type AS type, rel.type AS rel_type
          FROM relations rel
          JOIN resources tgt ON tgt.id = rel.to_id AND tgt.tenant = ${this.#tenant}
          WHERE rel.tenant = ${this.#tenant}
            AND rel.from_id = w.id
            AND rel.type = ANY(${outTypes})
            AND tgt.deleted_at IS NULL
            AND rel.confirmed IS DISTINCT FROM false

          UNION ALL

          SELECT rel.from_id AS id, src.type AS type, rel.type AS rel_type
          FROM relations rel
          JOIN resources src ON src.id = rel.from_id AND src.tenant = ${this.#tenant}
          WHERE rel.tenant = ${this.#tenant}
            AND rel.to_id = w.id
            AND rel.type = ANY(${inTypes})
            AND src.deleted_at IS NULL
            AND rel.confirmed IS DISTINCT FROM false
        ) nxt ON true
        WHERE w.depth < ${spec.maxDepth}
          AND NOT (nxt.id = ANY(w.visited))
      )
      SELECT id, type, depth, path FROM (
        SELECT DISTINCT ON (id) id, type, depth, path
        FROM walk
        WHERE depth > 0
        ORDER BY id, depth ASC
      ) deduped
      -- 排序放到 SQL 里：10k 行在 JS 侧排序会占住事件循环，
      -- 而这台机器上那正是 P95 的主要来源
      ORDER BY depth ASC, id ASC
      -- 多取一条用来判断是否被截断，不需要额外的 count 查询
      LIMIT ${sql.lit(spec.limit + 1)}
    `.execute(this.#db)

    const truncated = rows.rows.length > spec.limit
    const hits = (truncated ? rows.rows.slice(0, spec.limit) : rows.rows).map((r) => ({
      id: r.id,
      type: r.type,
      depth: r.depth,
      path: r.path,
    }))
    return { hits, truncated }
  }

  /**
   * 最短路径（FR-ONT-005）。
   *
   * 方向上取无向：回答"这个故障和那个需求是怎么连上的"时，
   * 关心的是连通性，不是箭头朝哪边。
   */
  async shortestPath(from: string, to: string, maxDepth: number): Promise<PathHit | null> {
    const rows = await sql<{ nodes: string[]; rels: string[] }>`
      WITH RECURSIVE walk AS (
        SELECT
          ${from}::text     AS node,
          ARRAY[${from}]::text[] AS nodes,
          ARRAY[]::text[]   AS rels,
          0                 AS depth

        UNION ALL

        SELECT
          nxt.id,
          w.nodes || nxt.id,
          w.rels || nxt.rel_type,
          w.depth + 1
        FROM walk w
        JOIN LATERAL (
          SELECT rel.to_id AS id, rel.type AS rel_type
          FROM relations rel
          WHERE rel.tenant = ${this.#tenant} AND rel.from_id = w.node
            AND rel.confirmed IS DISTINCT FROM false
          UNION ALL
          SELECT rel.from_id AS id, rel.type AS rel_type
          FROM relations rel
          WHERE rel.tenant = ${this.#tenant} AND rel.to_id = w.node
            AND rel.confirmed IS DISTINCT FROM false
        ) nxt ON true
        WHERE w.depth < ${maxDepth}
          AND NOT (nxt.id = ANY(w.nodes))
      )
      SELECT nodes, rels FROM walk
      WHERE node = ${to}
      ORDER BY depth ASC
      LIMIT 1
    `.execute(this.#db)

    const hit = rows.rows[0]
    return hit === undefined ? null : { nodes: hit.nodes, relations: hit.rels }
  }
}
