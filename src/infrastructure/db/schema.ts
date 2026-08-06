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
  /** 进入当前状态的时刻（007_sla.sql）。不是 updated_at——改标题不该重置计时 */
  status_since: Date
  lifecycle: string | null
  version: number
  labels: string[]
  attributes: JSONColumnType<Record<string, unknown>, string, string>
  visibility: string
  deleted_at: Date | null
  /**
   * 归档时刻（013_archive.sql）。**与 status 正交**：
   * 一个归档掉的 Done 任务仍然是 Done，指标照常算它，
   * 只是日常列表默认不显示。
   */
  archived_at: Date | null
  archived_by: string | null
  /**
   * 生成列（002_search.sql）：标签 + 属性值拼成的可检索文本。
   * `never` 表示插入与更新都不接受它——写它是错误，由数据库负责维护。
   */
  search_text: ColumnType<string, never, never>
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

export type AgentRunStepsTable = {
  seq_id: Generated<number>
  tenant: string
  run_id: string
  seq: number
  kind: string
  summary: string
  detail: JSONColumnType<Record<string, unknown>, string, string>
  tokens_used: number
  /** NUMERIC 经 pg 驱动回来是字符串，读出后再转数字；直接当 number 会得到 "0.000100" */
  cost_usd: ColumnType<string, string | number, string | number>
  occurred_at: Date
}

export type ConnectorCallsTable = {
  seq_id: Generated<number>
  tenant: string
  connector_id: string
  operation: string
  idempotency_key: string
  subject: string
  result: JSONColumnType<Record<string, unknown> | null, string, string>
  occurred_at: Date
}

export type LifecyclesTable = {
  tenant: string
  id: string
  entity_type: string
  definition: JSONColumnType<Record<string, unknown>, string, string>
  revision: Generated<number>
  updated_by: string
  updated_at: Date
}

export type RelationRulesTable = {
  tenant: string
  id: string
  subject_type: string
  definition: JSONColumnType<Record<string, unknown>, string, string>
  enabled: Generated<boolean>
  updated_by: string
  updated_at: Date
}

export type OntologyExtensionsTable = {
  tenant: string
  entity_type: string
  attributes: JSONColumnType<Record<string, unknown>[], string, string>
  updated_by: string
  updated_at: Date
}

export type ProcessRunsTable = {
  tenant: string
  id: string
  process_id: string
  refs: JSONColumnType<Record<string, string>, string, string>
  state: JSONColumnType<Record<string, unknown>, string, string>
  status: string
  awaiting_step: string | null
  awaiting_deadline: Date | null
  started_at: Date
  updated_at: Date
}

export type SlaBreachesTable = {
  tenant: string
  resource_id: string
  status: string
  status_since: Date
  action: string
  breached_at: Date
  detected_at: Date
  notification_id: string | null
}

export type AgentMemoriesTable = {
  id: string
  tenant: string
  agent: string
  project: string | null
  /** 只可能是 'episodic'——表上有 CHECK 约束（009_agent_memory.sql） */
  kind: string
  key: string
  value: JSONColumnType<Record<string, unknown>, string, string>
  run_ref: string | null
  created_at: Date
  expires_at: Date
}

export type Database = {
  resources: ResourcesTable
  agent_memories: AgentMemoriesTable
  sla_breaches: SlaBreachesTable
  lifecycles: LifecyclesTable
  relation_rules: RelationRulesTable
  ontology_extensions: OntologyExtensionsTable
  process_runs: ProcessRunsTable
  agent_run_steps: AgentRunStepsTable
  connector_calls: ConnectorCallsTable
  relations: RelationsTable
  resource_history: ResourceHistoryTable
  outbox_events: OutboxEventsTable
  audit_log: AuditLogTable
  grants: GrantsTable
}
