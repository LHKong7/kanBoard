/**
 * 统一 Resource API 的客户端（ADR-0002）。
 *
 * 只有这一个出口。每加一类企业级对象就写一个 `fetchX` 的话，
 * 迟早有一个忘了带身份头、忘了处理 4xx——而那种错的表现是
 * "这个页面偶尔是空的"。
 */

export type Identity = { principal: string; roles: string }

const KEY = 'projectos.identity'

/** 与 vanilla 前端共用同一个 localStorage 键：换身份不该换一次界面就得重设 */
export function loadIdentity(): Identity {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw !== null) {
      const parsed = JSON.parse(raw) as Partial<Identity>
      if (typeof parsed.principal === 'string' && typeof parsed.roles === 'string') {
        return { principal: parsed.principal, roles: parsed.roles }
      }
    }
  } catch {
    // 存坏了退回默认身份，不值得为此让整页打不开
  }
  return { principal: 'user://alice', roles: 'Admin' }
}

export function saveIdentity(identity: Identity): void {
  localStorage.setItem(KEY, JSON.stringify({ ...identity, label: identity.principal }))
}

export type Resource = {
  id: string
  type: string
  status: string
  workspace: string
  project: string | null
  owner: string | null
  labels: string[]
  attributes: Record<string, unknown>
  version: number
  createdAt: string
  updatedAt: string
}

export type AttributeDef = {
  name: string
  kind: string
  required?: boolean
  derived?: boolean
  values?: string[]
  description?: string
  maxLength?: number
}

export type EntityTypeDef = {
  name: string
  version: string
  lifecycle?: string
  description?: string
  attributes: AttributeDef[]
}

/** 与 `GET /v1/resources/:id/transitions` 的返回一致（字段名照抄服务端，不另起） */
export type TransitionOption = {
  to: string
  ready: boolean
  /** 未就绪时差的是什么。列出来而不是把按钮藏掉——藏掉会让人以为"就这些了" */
  blockedBy?: string
  reopen?: boolean
}

export class ApiError extends Error {
  readonly code: string
  constructor(message: string, code: string) {
    super(message)
    this.code = code
  }
}

let identity = loadIdentity()
export const currentIdentity = (): Identity => identity
export function setIdentity(next: Identity): void {
  identity = next
  saveIdentity(next)
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const hasBody = init.body !== undefined
  const res = await fetch(path, {
    ...init,
    headers: {
      'x-principal': identity.principal,
      // v1 单租户（ADR-0005），界面上不出现租户概念
      'x-tenant': 'default',
      'x-roles': identity.roles,
      'x-capabilities': '',
      ...(hasBody ? { 'content-type': 'application/json' } : {}),
      ...(init.headers ?? {}),
    },
  })
  if (res.status === 204) return null as T
  const text = await res.text()
  const body: unknown = text === '' ? null : JSON.parse(text)
  if (!res.ok) {
    const detail = body as { message?: string; error?: string } | null
    throw new ApiError(detail?.message ?? `HTTP ${res.status}`, detail?.error ?? 'error')
  }
  return body as T
}

export const api = {
  entityTypes: () => request<{ items: EntityTypeDef[] }>('/v1/ontology/entity-types'),
  list: (type: string, params: Record<string, string> = {}) =>
    request<{ items: Resource[]; nextCursor: string | null }>(
      `/v1/resources?${new URLSearchParams({ type, size: '200', ...params })}`,
    ),
  byIds: (type: string, ids: string[]) =>
    ids.length === 0
      ? Promise.resolve({ items: [], nextCursor: null })
      : request<{ items: Resource[]; nextCursor: string | null }>(
          `/v1/resources?${new URLSearchParams({ type, ids: ids.join(','), size: '200' })}`,
        ),
  create: (body: Record<string, unknown>) =>
    request<Resource>('/v1/resources', { method: 'POST', body: JSON.stringify(body) }),
  transitions: (id: string) =>
    request<{ items: TransitionOption[] }>(`/v1/resources/${id}/transitions`),
  transition: (id: string, to: string, reason: string) =>
    request<Resource>(`/v1/resources/${id}/transitions`, {
      method: 'POST',
      body: JSON.stringify({ to, reason }),
    }),
  relations: (id: string, direction: 'in' | 'out' | 'both', type?: string) =>
    request<{ items: { id: string; type: string; fromId: string; toId: string }[] }>(
      `/v1/resources/${id}/relations?${new URLSearchParams({
        direction,
        ...(type === undefined ? {} : { type }),
      })}`,
    ),
  relate: (fromId: string, type: string, toId: string) =>
    request<unknown>(`/v1/resources/${fromId}/relations`, {
      method: 'POST',
      body: JSON.stringify({ type, toId }),
    }),
  relationTypes: () =>
    request<{ items: { name: string; inverse: string; domain: string[]; range: string[] }[] }>(
      '/v1/ontology/relation-types',
    ),

  /**
   * 可选的分析维度与指标。**从服务端取，前端不抄一份**——
   * 抄一份的话，加第 17 个维度那天下拉里不会有它，
   * 而没有任何报错说明为什么。
   */
  analyticsDimensions: () =>
    request<{
      xAxes: string[]
      yMetrics: string[]
      dateAxes: string[]
      dateGroupings: string[]
      durations: string[]
      stateGroups: string[]
    }>('/v1/analytics/dimensions'),

  analytics: (params: Record<string, string>) =>
    request<{
      spec: Record<string, string>
      keys: string[]
      groups: string[]
      rows: Array<Record<string, string | number>>
      total: number
    }>(`/v1/analytics?${new URLSearchParams(params)}`),

  burndown: (cycleId: string, unit: 'count' | 'points') =>
    request<{
      cycleId: string
      unit: string
      total: number
      completed: number
      cancelled: number
      truncated: boolean
      points: Array<{ day: string; ideal: number; remaining: number | null }>
    }>(`/v1/cycles/${cycleId}/burndown?unit=${unit}`),

  cycleProgress: (cycleId: string) =>
    request<{
      cycleId: string
      name: string
      total: number
      completed: number
      cancelled: number
      open: number
      byGroup: Record<string, number>
      points: { total: number; completed: number }
      completionRate: number
    }>(`/v1/cycles/${cycleId}/progress`),
}
