import { ulid } from 'ulid'

/**
 * 全局唯一 ID：`<类型前缀>_<ULID>`。
 *
 * 前缀让 ID 自解释（看到 `req_01J8...` 就知道是 Requirement），
 * ULID 保证时间有序，游标分页（FR-RES-012）可以直接按 id 排序而不需要额外的序列列。
 */
export type ResourceId = string

const PREFIX_BY_TYPE: Record<string, string> = {
  Project: 'prj',
  Requirement: 'req',
  Story: 'story',
  Task: 'task',
  Issue: 'issue',
  Decision: 'dec',
  Knowledge: 'kn',
  Agent: 'agent',
  Sprint: 'sprint',
  Release: 'rel',
}

export function prefixFor(entityType: string): string {
  const known = PREFIX_BY_TYPE[entityType]
  if (known !== undefined) return known
  // 未登记的类型（含租户扩展类型）退化为小写全名，仍然自解释
  return entityType.toLowerCase()
}

export function newResourceId(entityType: string): ResourceId {
  return `${prefixFor(entityType)}_${ulid()}`
}

export function newRelationId(): string {
  return `relation_${ulid()}`
}

export function newRunId(): string {
  return `run_${ulid()}`
}

/** Episodic Memory 的 id（FR-AGT-005） */
export function newMemoryId(): string {
  return `mem_${ulid()}`
}

export function newTraceId(): string {
  return `tr_${ulid()}`
}
