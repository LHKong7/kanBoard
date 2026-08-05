import type { Db } from './db/client.ts'
import type { RunStep, RunStepKind, RunStepRepository } from '../domain/agent/types.ts'

/**
 * Run 轨迹的 Postgres 实现（FR-AGT-007）。
 *
 * 和其余仓储一样绑定一个已设置租户的事务；查询里仍然写 tenant 条件，
 * RLS 是兜底不是省事的理由。
 */
export class PgRunStepRepository implements RunStepRepository {
  readonly #db: Db
  readonly #tenant: string

  constructor(db: Db, tenant: string) {
    this.#db = db
    this.#tenant = tenant
  }

  async append(step: RunStep): Promise<void> {
    await this.#db
      .insertInto('agent_run_steps')
      .values({
        tenant: this.#tenant,
        run_id: step.runId,
        seq: step.seq,
        kind: step.kind,
        summary: step.summary,
        detail: JSON.stringify(step.detail),
        tokens_used: step.tokensUsed,
        cost_usd: step.costUsd,
        occurred_at: step.occurredAt,
      })
      .execute()
  }

  async listFor(runId: string): Promise<RunStep[]> {
    const rows = await this.#db
      .selectFrom('agent_run_steps')
      .selectAll()
      .where('tenant', '=', this.#tenant)
      .where('run_id', '=', runId)
      // 回放靠这个顺序。用 seq 而不是 seq_id：后者跨 Run 不连续
      .orderBy('seq', 'asc')
      .execute()

    return rows.map((row) => ({
      runId: row.run_id,
      seq: row.seq,
      kind: row.kind as RunStepKind,
      summary: row.summary,
      detail: row.detail as unknown as Record<string, unknown>,
      tokensUsed: row.tokens_used,
      // NUMERIC 从驱动回来是字符串
      costUsd: Number(row.cost_usd),
      occurredAt: row.occurred_at,
    }))
  }
}
