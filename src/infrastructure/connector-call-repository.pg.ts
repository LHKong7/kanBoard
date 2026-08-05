import type { Db } from './db/client.ts'
import type { CallLogRepository, CallRecord } from '../domain/connector/types.ts'

/** 幂等记录的 Postgres 实现（FR-CON-004） */
export class PgCallLogRepository implements CallLogRepository {
  readonly #db: Db
  readonly #tenant: string

  constructor(db: Db, tenant: string) {
    this.#db = db
    this.#tenant = tenant
  }

  async find(
    connectorId: string,
    operation: string,
    idempotencyKey: string,
  ): Promise<CallRecord | null> {
    const row = await this.#db
      .selectFrom('connector_calls')
      .selectAll()
      .where('tenant', '=', this.#tenant)
      .where('connector_id', '=', connectorId)
      .where('operation', '=', operation)
      .where('idempotency_key', '=', idempotencyKey)
      .executeTakeFirst()

    if (row === undefined) return null
    return {
      tenant: row.tenant,
      connectorId: row.connector_id,
      operation: row.operation,
      idempotencyKey: row.idempotency_key,
      subject: row.subject,
      result: row.result as unknown,
      occurredAt: row.occurred_at,
    }
  }

  async save(record: CallRecord): Promise<void> {
    await this.#db
      .insertInto('connector_calls')
      .values({
        tenant: this.#tenant,
        connector_id: record.connectorId,
        operation: record.operation,
        idempotency_key: record.idempotencyKey,
        subject: record.subject,
        result: JSON.stringify(record.result ?? null),
        occurred_at: record.occurredAt,
      })
      // 并发下两个请求可能同时没查到、同时写入。
      // 冲突时不报错：先到的那条就是权威结果，这正是幂等要的语义
      .onConflict((oc) =>
        oc.columns(['tenant', 'connector_id', 'operation', 'idempotency_key']).doNothing(),
      )
      .execute()
  }
}
