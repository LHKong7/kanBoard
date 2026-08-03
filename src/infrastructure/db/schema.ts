import type { ColumnType, Generated, JSONColumnType } from 'kysely'

/**
 * Kysely 的库表类型。手写而非生成，因为表结构由本体派生、变动受控（ADR-0001 P1.2），
 * 而且这样能显式表达 Generated / 只读列的语义。
 */

export type ResourcesTable = {
  id: string
  tenant: string
  type: string
  ontology_version: string
  workspace: string
  project: string | null
  owner: string
  created_by: string
  created_at: ColumnType<Date, Date, never>
  updated_at: Date
  status: string
  lifecycle: string | null
  version: number
  labels: string[]
  attributes: JSONColumnType<Record<string, unknown>, string, string>
  visibility: string
  deleted_at: Date | null
}

export type RelationsTable = {
  id: string
  tenant: string
  type: string
  from_id: string
  to_id: string
  created_by: string
  created_at: ColumnType<Date, Date, never>
  confidence: number | null
  confirmed: boolean | null
}

export type ResourceHistoryTable = {
  seq: Generated<string>
  resource_id: string
  tenant: string
  version: number
  changed_by: string
  on_behalf_of: string | null
  changed_at: Date
  run_ref: string | null
  changes: JSONColumnType<readonly FieldChange[], string, string>
  reason: string | null
  trace_id: string | null
}

export type FieldChange = {
  path: string
  from: unknown
  to: unknown
}

export type OutboxEventsTable = {
  seq: Generated<string>
  tenant: string
  event_type: string
  resource_id: string
  resource_type: string
  payload: JSONColumnType<Record<string, unknown>, string, string>
  occurred_at: Date
  trace_id: string | null
  published_at: Date | null
}

export type AuditLogTable = {
  seq: Generated<string>
  tenant: string
  subject: string
  on_behalf_of: string | null
  action: string
  resource_id: string | null
  resource_type: string | null
  decision: string
  reason: string
  matched_policy: string | null
  run_ref: string | null
  occurred_at: Date
  trace_id: string | null
}

export type GrantsTable = {
  id: string
  tenant: string
  subject: string
  on_behalf_of: string | null
  capabilities: string[]
  scope_kind: string
  scope_value: string | null
  issued_at: Date
  expires_at: Date
  max_calls: number
  used_calls: number
  bound_to_run: string | null
  revoked_at: Date | null
}

export type Database = {
  resources: ResourcesTable
  relations: RelationsTable
  resource_history: ResourceHistoryTable
  outbox_events: OutboxEventsTable
  audit_log: AuditLogTable
  grants: GrantsTable
}
