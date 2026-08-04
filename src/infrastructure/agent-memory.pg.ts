import type { Db } from './db/client.ts'
import type { EpisodicRecord, EpisodicStore } from '../domain/agent/memory.ts'

/**
 * Episodic Memory 的 Postgres 实现（FR-AGT-005）。
 *
 * 四级里只有这一级需要一张表。Working 在内存里，
 * Semantic 落 Knowledge BC，Procedural 就是 Agent 声明本身。
 */
export class PgEpisodicStore implements EpisodicStore {
  readonly #db: Db
  readonly #tenant: string

  constructor(db: Db, tenant: string) {
    this.#db = db
    this.#tenant = tenant
  }

  async put(record: EpisodicRecord): Promise<void> {
    await this.#db
      .insertInto('agent_memories')
      .values({
        id: record.id,
        tenant: this.#tenant,
        agent: record.agent,
        project: record.project,
        // 写死 'episodic'：这张表的 CHECK 约束只接受它。
        // 让调用方传 kind 的话，那条约束就变成一个可以被撞上的运行期错误，
        // 而不是一个说明"这里只放经历"的结构事实
        kind: 'episodic',
        key: record.key,
        value: JSON.stringify(record.value),
        run_ref: record.runRef,
        created_at: record.createdAt,
        expires_at: record.expiresAt,
      })
      .onConflict((oc) =>
        // 记忆是被更新的，不是被累积的。同一个 key 反复写会把
        // 同一段经历攒成几十条，召回时全是重复内容
        oc.columns(['tenant', 'agent', 'project', 'key']).doUpdateSet({
          value: JSON.stringify(record.value),
          run_ref: record.runRef,
          created_at: record.createdAt,
          expires_at: record.expiresAt,
        }),
      )
      .execute()
  }

  async recall(
    agent: string,
    project: string | null,
    now: Date,
    limit: number,
  ): Promise<EpisodicRecord[]> {
    let q = this.#db
      .selectFrom('agent_memories')
      .selectAll()
      .where('tenant', '=', this.#tenant)
      .where('agent', '=', agent)
      // 过期的当作不存在，**不等清理任务跑过**。
      // 靠清理任务保证正确性的话，任务停掉的那几天里
      // Agent 会读到早该忘掉的东西，而没有任何迹象
      .where('expires_at', '>', now)

    q = project === null ? q.where('project', 'is', null) : q.where('project', '=', project)

    const rows = await q.orderBy('created_at', 'desc').limit(limit).execute()
    return rows.map((r) => ({
      id: r.id,
      tenant: r.tenant,
      agent: r.agent,
      project: r.project,
      key: r.key,
      value: r.value as unknown,
      runRef: r.run_ref,
      createdAt: r.created_at,
      expiresAt: r.expires_at,
    }))
  }

  async purgeExpired(now: Date): Promise<number> {
    const result = await this.#db
      .deleteFrom('agent_memories')
      .where('tenant', '=', this.#tenant)
      .where('expires_at', '<=', now)
      .executeTakeFirst()
    return Number(result.numDeletedRows ?? 0n)
  }
}
