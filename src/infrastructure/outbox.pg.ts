import type { Db } from './db/client.ts'
import type { AuditRecord, AuditSink, EventSink } from '../domain/resource/ports.ts'
import type { DomainEvent } from '../domain/events.ts'

/**
 * Outbox 事件汇（FR-RES-006）。
 *
 * 关键点是它接收的 `db` 就是业务写入所在的那个事务句柄——
 * 事件与业务数据要么一起提交，要么一起回滚。
 * "写完数据库再发消息"在进程崩溃时会丢事件，"先发消息再写"会产生幽灵事件。
 */
export class PgOutbox implements EventSink {
  readonly #db: Db

  constructor(db: Db) {
    this.#db = db
  }

  async emit(event: DomainEvent): Promise<void> {
    await this.#db
      .insertInto('outbox_events')
      .values({
        tenant: event.tenant,
        event_type: event.type,
        resource_id: event.resourceId,
        resource_type: event.resourceType,
        payload: JSON.stringify(event.payload),
        occurred_at: event.occurredAt,
        trace_id: event.traceId,
        published_at: null,
      })
      .execute()
  }
}

/**
 * 审计缓冲。
 *
 * 审计**不能**写在业务事务里。授权被拒时服务层会抛错，事务随之回滚——
 * 如果审计记录也在这个事务里，被拒绝的尝试就会一起消失。
 * 而被拒绝的尝试恰恰是最需要留痕的那一类（FR-IAM-013）。
 *
 * 所以这里只在内存中收集，由调用方在业务事务结束后（无论成功失败）
 * 用独立事务落盘。代价是业务回滚时可能留下一条"尝试过"的记录——
 * 这个方向的误差是可接受的：多记不该记的，好过丢掉该记的。
 */
export class BufferedAuditSink implements AuditSink {
  readonly #entries: AuditRecord[] = []

  async record(entry: AuditRecord): Promise<void> {
    this.#entries.push(entry)
  }

  drain(): AuditRecord[] {
    return this.#entries.splice(0, this.#entries.length)
  }
}

/** 用独立事务落盘审计记录 */
export async function flushAudit(db: Db, entries: readonly AuditRecord[]): Promise<void> {
  if (entries.length === 0) return
  await db
    .insertInto('audit_log')
    .values(
      entries.map((entry) => ({
        tenant: entry.tenant,
        subject: entry.subject,
        on_behalf_of: entry.onBehalfOf,
        action: entry.action,
        resource_id: entry.resourceId,
        resource_type: entry.resourceType,
        decision: entry.decision.effect,
        reason: entry.decision.reason,
        matched_policy: entry.decision.matchedPolicy ?? null,
        run_ref: entry.runRef,
        occurred_at: entry.occurredAt,
        trace_id: entry.traceId,
      })),
    )
    .execute()
}

export type OutboxRow = {
  seq: string
  tenant: string
  eventType: string
  resourceId: string
  resourceType: string
  payload: Record<string, unknown>
  occurredAt: Date
  traceId: string | null
}

/**
 * 取一批未发布事件。
 *
 * `FOR UPDATE SKIP LOCKED` 让多个 poller 实例可以并行消费而不互相阻塞，
 * 也不会重复取到同一批。
 */
export async function claimUnpublished(db: Db, limit: number): Promise<OutboxRow[]> {
  const rows = await db
    .selectFrom('outbox_events')
    .selectAll()
    .where('published_at', 'is', null)
    .orderBy('seq', 'asc')
    .limit(limit)
    .forUpdate()
    .skipLocked()
    .execute()

  return rows.map((r) => ({
    seq: String(r.seq),
    tenant: r.tenant,
    eventType: r.event_type,
    resourceId: r.resource_id,
    resourceType: r.resource_type,
    payload: r.payload as unknown as Record<string, unknown>,
    occurredAt: r.occurred_at,
    traceId: r.trace_id,
  }))
}

export async function markPublished(db: Db, seqs: readonly string[], at: Date): Promise<void> {
  if (seqs.length === 0) return
  await db
    .updateTable('outbox_events')
    .set({ published_at: at })
    .where('seq', 'in', seqs as string[])
    .execute()
}
