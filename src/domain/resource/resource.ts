import type { Principal } from '../../identity/types.ts'

/**
 * 统一 Resource（ADR-0002）。
 *
 * 所有领域对象都是这个形状。新增一种 EntityType 不需要新增表、端点或权限规则——
 * 这是本模型存在的全部理由。
 */
export type Resource = {
  id: string
  type: string
  ontologyVersion: string
  tenant: string
  workspace: string
  project: string | null
  owner: string
  createdBy: string
  createdAt: Date
  updatedAt: Date
  status: string
  lifecycle: string | null
  version: number
  labels: readonly string[]
  attributes: Record<string, unknown>
  visibility: Visibility
  deletedAt: Date | null
}

export type Visibility = 'private' | 'project' | 'workspace' | 'tenant'

export const VISIBILITIES: readonly Visibility[] = ['private', 'project', 'workspace', 'tenant']

export type CreateResourceInput = {
  type: string
  workspace: string
  project?: string | null
  owner?: string | undefined
  status?: string | undefined
  labels?: readonly string[] | undefined
  attributes?: Record<string, unknown> | undefined
  visibility?: Visibility | undefined
}

export type UpdateResourceInput = {
  /** 乐观锁：必须携带读到的版本号（FR-RES-003） */
  expectedVersion: number
  status?: string | undefined
  labels?: readonly string[] | undefined
  attributes?: Record<string, unknown> | undefined
  visibility?: Visibility | undefined
  owner?: string | undefined
  reason?: string | undefined
}

/** 变更历史条目（FR-RES-005） */
export type FieldChange = {
  path: string
  from: unknown
  to: unknown
}

export type HistoryEntry = {
  resourceId: string
  version: number
  changedBy: Principal
  onBehalfOf: string | null
  changedAt: Date
  runRef: string | null
  changes: readonly FieldChange[]
  reason: string | null
  traceId: string | null
}

/**
 * 计算字段级 diff。
 *
 * 只记录真正变化的字段：把整个对象前后快照都存下来看似省事，
 * 但那样"谁把优先级从 Should 改成了 Must"就要靠人肉比对了。
 */
export function diffResource(
  before: Pick<Resource, 'status' | 'labels' | 'attributes' | 'visibility' | 'owner'>,
  after: Pick<Resource, 'status' | 'labels' | 'attributes' | 'visibility' | 'owner'>,
): FieldChange[] {
  const changes: FieldChange[] = []

  if (before.status !== after.status) {
    changes.push({ path: 'status', from: before.status, to: after.status })
  }
  if (before.owner !== after.owner) {
    changes.push({ path: 'owner', from: before.owner, to: after.owner })
  }
  if (before.visibility !== after.visibility) {
    changes.push({ path: 'visibility', from: before.visibility, to: after.visibility })
  }
  if (!sameStringArray(before.labels, after.labels)) {
    changes.push({ path: 'labels', from: [...before.labels], to: [...after.labels] })
  }

  const keys = new Set([...Object.keys(before.attributes), ...Object.keys(after.attributes)])
  for (const key of [...keys].sort()) {
    const from = before.attributes[key]
    const to = after.attributes[key]
    if (!deepEqual(from, to)) {
      changes.push({ path: `attributes.${key}`, from: from ?? null, to: to ?? null })
    }
  }

  return changes
}

function sameStringArray(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i])
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a === null || b === null || a === undefined || b === undefined) return false
  if (typeof a !== 'object' || typeof b !== 'object') return false
  // attributes 的值来自 JSONB，结构简单且无环，序列化比较足够且可预测
  return JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b))
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([x], [y]) =>
      x < y ? -1 : x > y ? 1 : 0,
    )
    return Object.fromEntries(entries.map(([k, v]) => [k, sortKeys(v)]))
  }
  return value
}
