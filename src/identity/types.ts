/**
 * 五层权限模型的类型定义（PRD 07 / ADR-0003）。
 *
 *   ① Identity   谁
 *   ② Role       什么身份
 *   ③ Capability 能做什么
 *   ④ Resource   对什么
 *   ⑤ Policy     在什么条件下
 */

/** 主体。Agent 与 User 同级——这是 ADR-0003 的核心：Agent 是一等身份主体。 */
export type Principal = `user://${string}` | `agent://${string}` | 'system://internal'

export function isAgent(principal: string): boolean {
  return principal.startsWith('agent://')
}

export type Role = 'PM' | 'RD' | 'QA' | 'Leader' | 'Admin' | 'Guest' | 'AIAgent'

/** Capability 命名：`<Domain>.<Action>[:<Qualifier>]` */
export type Capability = string

/** 资源引用。层级从粗到细，上层授权向下继承。 */
export type ResourceRef = {
  tenant: string
  workspace?: string | undefined
  project?: string | undefined
  /** 具体资源 id，如 `req_01J8…`。缺省表示作用于整个层级。 */
  id?: string | undefined
  type?: string | undefined
}

export type Effect = 'Allow' | 'Deny' | 'Ask'

export type PolicyScope =
  | { kind: 'any' }
  | { kind: 'tenant'; tenant: string }
  | { kind: 'workspace'; workspace: string }
  | { kind: 'project'; project: string }
  | { kind: 'resource'; id: string }

export type PolicyCondition = {
  /** 仅资源 owner 可操作 */
  ownerOnly?: boolean
  /** 要求已完成 MFA */
  mfa?: boolean
  /** 允许的数据分级（不在其中即拒绝） */
  classificationNotIn?: readonly string[]
}

export type Policy = {
  id: string
  effect: Effect
  /** 匹配的主体：principal 精确匹配，或 role:<Role>，或 `*` */
  subject: string
  /** 匹配的 capability，支持尾部通配 `Requirement.*` 与全通配 `*` */
  action: string
  scope: PolicyScope
  condition?: PolicyCondition
  description?: string
}

/** 授权请求的上下文 */
export type DecisionContext = {
  /** 资源 owner，配合 ownerOnly 使用 */
  resourceOwner?: string | undefined
  mfa?: boolean | undefined
  /** 本次操作涉及的最高数据分级 */
  classification?: string | undefined
  /** 受限委派：Agent 代表某个 User 执行时的委派来源 */
  onBehalfOf?: string | undefined
  /** 绑定的 AgentRun，用于临时授权的失效判定 */
  runId?: string | undefined
  now?: Date | undefined
}

export type Decision = {
  effect: Effect
  /** 人类可读的原因。拒绝时必须能说清缺了什么——否则配置者无从下手。 */
  reason: string
  /** 命中的策略 id，用于审计与调试 */
  matchedPolicy?: string | undefined
}

/**
 * 临时授权（JIT Grant，ADR-0003 §7.2）。
 * 三个失效条件任一触发即回收：TTL 到期 / 调用次数耗尽 / Run 结束。
 */
export type Grant = {
  id: string
  tenant: string
  subject: Principal
  onBehalfOf?: Principal | undefined
  capabilities: readonly Capability[]
  scope: PolicyScope
  expiresAt: Date
  maxCalls: number
  usedCalls: number
  /** 绑定的 AgentRun；该 Run 结束后授权立即失效 */
  boundToRun?: string | undefined
  revokedAt?: Date | null | undefined
}

export type SubjectProfile = {
  principal: Principal
  tenant: string
  roles: readonly Role[]
  /** 直接授予的 Capability（不经 Role） */
  capabilities: readonly Capability[]
}
