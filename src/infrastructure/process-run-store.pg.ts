import type { Db } from './db/client.ts'
import type { ProcessRun, RunStatus } from '../domain/orchestration/executor.ts'
import type { RunState, StepOutcome } from '../workflow/orchestration.ts'

/**
 * 流程实例的存储（FR-WF-010）。
 *
 * `state` 整条存 JSONB：它是 `advance()` 的输入，而 advance 是纯函数，
 * 所以"跑到哪儿了"完全由这一坨数据决定。拆成 steps 表的话，
 * 重入时要先把它拼回来，而拼错了没人会发现——流程会从一个
 * 看起来合理、其实错了的位置继续跑。
 */
export class PgProcessRunStore {
  readonly #db: Db
  readonly #tenant: string

  constructor(db: Db, tenant: string) {
    this.#db = db
    this.#tenant = tenant
  }

  async save(run: ProcessRun): Promise<void> {
    const now = new Date(run.state.startedAt)
    await this.#db
      .insertInto('process_runs')
      .values({
        tenant: this.#tenant,
        id: run.id,
        process_id: run.processId,
        refs: JSON.stringify(run.refs),
        state: JSON.stringify(run.state),
        status: run.status,
        awaiting_step: run.awaiting?.stepId ?? null,
        awaiting_deadline: run.awaiting?.deadline ?? null,
        started_at: now,
        updated_at: new Date(),
      })
      .onConflict((oc) =>
        oc.columns(['tenant', 'id']).doUpdateSet({
          state: JSON.stringify(run.state),
          status: run.status,
          awaiting_step: run.awaiting?.stepId ?? null,
          awaiting_deadline: run.awaiting?.deadline ?? null,
          updated_at: new Date(),
        }),
      )
      .execute()
  }

  async load(id: string): Promise<ProcessRun | null> {
    const row = await this.#db
      .selectFrom('process_runs')
      .selectAll()
      .where('tenant', '=', this.#tenant)
      .where('id', '=', id)
      .executeTakeFirst()
    return row === undefined ? null : toRun(row as unknown as Row)
  }

  async list(status?: RunStatus): Promise<ProcessRun[]> {
    let q = this.#db
      .selectFrom('process_runs')
      .selectAll()
      .where('tenant', '=', this.#tenant)
      .orderBy('id', 'desc')
    if (status !== undefined) q = q.where('status', '=', status)
    const rows = await q.limit(200).execute()
    return rows.map((r) => toRun(r as unknown as Row))
  }

  /**
   * 等人等过头了的实例。
   *
   * 定时任务扫它。**不设上界的话，一个等人的实例会永远挂着**，
   * 而它攥着一个已冻结的 Release——没有任何报错，只是那个发布再也不动了。
   */
  async overdue(now: Date): Promise<ProcessRun[]> {
    const rows = await this.#db
      .selectFrom('process_runs')
      .selectAll()
      .where('tenant', '=', this.#tenant)
      .where('status', '=', 'awaiting-human')
      .where('awaiting_deadline', '<=', now)
      .limit(100)
      .execute()
    return rows.map((r) => toRun(r as unknown as Row))
  }
}

type Row = {
  tenant: string
  id: string
  process_id: string
  refs: Record<string, string>
  state: Record<string, unknown>
  status: string
  awaiting_step: string | null
  awaiting_deadline: Date | null
  started_at: Date
}

function toRun(row: Row): ProcessRun {
  const raw = row.state as unknown as RunState
  return {
    id: row.id,
    tenant: row.tenant,
    processId: row.process_id,
    refs: row.refs,
    status: row.status as RunStatus,
    // JSON 里的时间是字符串。`advance` 拿它算超时，
    // 不还原成 Date 的话，`now - startedAt` 会是 NaN——
    // 而 NaN 的比较全是 false，于是**所有超时都不会触发**
    state: {
      processId: raw.processId,
      completed: raw.completed as readonly StepOutcome[],
      performed: raw.performed,
      startedAt: new Date(raw.startedAt),
    },
    awaiting:
      row.awaiting_step === null || row.awaiting_deadline === null
        ? null
        : {
            stepId: row.awaiting_step,
            prompt: '',
            deadline: new Date(row.awaiting_deadline),
          },
  }
}
