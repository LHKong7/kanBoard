import { isForbiddenForAgent, requiresHumanApproval } from './guardrails.ts'
import type {
  Capability,
  Decision,
  DecisionContext,
  Grant,
  Policy,
  PolicyScope,
  ResourceRef,
  Role,
  SubjectProfile,
} from './types.ts'
import { isAgent } from './types.ts'

/** Role → Capability 的命名集合。Role 本身不是权限，只是便于管理的集合。 */
/**
 * 每个**干活的**角色都能评论。
 *
 * 给的是 `Comment.*` 而不是 `Comment.Create`：建一条评论要顺带建一条
 * `commentsOn` 关系，而建关系判的是 `${from.type}.Update`（见
 * `ResourceService.relate`）。只给 Create 的话，评论建得出来、挂不上去。
 *
 * 代价要说清楚：`Comment.*` 里也含 Update / Delete，而这套能力模型
 * **没有"只能改自己的"这一档**——于是同角色的人互相改得动评论。
 * 真正的修法是按实例判归属，那是权限模型的活，不该在这里用一个
 * 更窄的能力名假装解决（窄到 Create 的话，连自己发的都改不了）。
 */
const ROLE_CAPABILITIES: Record<Role, readonly string[]> = {
  PM: [
    'Requirement.*',
    'Story.*',
    'Sprint.*',
    'Project.Read',
    'Dashboard.Read',
    'Knowledge.Read',
    'Comment.*',
    // 企业级对象（docs/research/plane-enterprise-features.md）
    'Initiative.*',
    'Teamspace.*',
    'Template.*',
    'SavedView.*',
    'Baseline.*',
    'Worklog.Approve',
  ],
  RD: ['Task.*', 'Code.*', 'PR.Create', 'Requirement.Read', 'Story.Read', 'Knowledge.*', 'Comment.*', 'Worklog.*', 'SavedView.*'],
  QA: ['TestCase.*', 'Issue.*', 'Acceptance.Verify', 'Task.Read', 'Requirement.Read', 'Comment.*', 'Worklog.*', 'SavedView.*'],
  Leader: [
    '*.Read',
    'Approve.*',
    'Budget.Read',
    'Dashboard.Read',
    'Requirement.Approve',
    'Comment.*',
    'Initiative.*',
    'Teamspace.*',
    'Baseline.*',
    'Worklog.Approve',
  ],
  Admin: ['*'],
  // Guest 仍然只读：看得到讨论，插不上话。要放开是一个产品决定，不是默认值
  Guest: ['*.Read'],
  // AI Agent 角色是**空集合**，不是"给 Agent 全部权限"的快捷方式（PRD 07 §3）
  AIAgent: [],
}

function capabilityMatches(pattern: string, capability: Capability): boolean {
  if (pattern === '*') return true
  if (pattern === capability) return true
  // `Requirement.*` 匹配该 domain 下所有动作
  if (pattern.endsWith('.*')) {
    return capability.startsWith(pattern.slice(0, -1))
  }
  // `*.Read` 匹配所有 domain 的该动作
  if (pattern.startsWith('*.')) {
    const action = pattern.slice(2)
    const dot = capability.indexOf('.')
    return dot > 0 && capability.slice(dot + 1) === action
  }
  return false
}

function subjectHasCapability(profile: SubjectProfile, capability: Capability): boolean {
  if (profile.capabilities.some((c) => capabilityMatches(c, capability))) return true
  return profile.roles.some((role) =>
    (ROLE_CAPABILITIES[role] ?? []).some((c) => capabilityMatches(c, capability)),
  )
}

function scopeMatches(scope: PolicyScope, resource: ResourceRef): boolean {
  switch (scope.kind) {
    case 'any':
      return true
    case 'tenant':
      return scope.tenant === resource.tenant
    case 'workspace':
      return scope.workspace === resource.workspace
    case 'project':
      return scope.project === resource.project
    case 'resource':
      return scope.id === resource.id
    default: {
      const exhaustive: never = scope
      throw new Error(`unhandled scope: ${JSON.stringify(exhaustive)}`)
    }
  }
}

function subjectMatches(policySubject: string, profile: SubjectProfile): boolean {
  if (policySubject === '*') return true
  if (policySubject === profile.principal) return true
  if (policySubject.startsWith('role:')) {
    return profile.roles.includes(policySubject.slice(5) as Role)
  }
  return false
}

/**
 * 求值策略条件。返回 null 表示条件**满足**，返回字符串表示不满足的原因。
 *
 * 条件描述的是"被许可的状态"，两种 effect 对它的用法是镜像的：
 *   - Allow / Ask：条件满足才生效（"是 owner 才让你删"）
 *   - Deny：      条件**不**满足才生效（"不是 owner 就拒绝"）
 *
 * 这个镜像关系是必要的。权限模型是"任一 Allow 即放行"，
 * 所以一条宽泛的 `Task.*` Allow 会静默冲掉任何想收紧的窄 Allow——
 * 收紧只有写成 Deny 才有约束力，而 Deny 需要条件才能表达"仅在某种情况下拒绝"。
 */
function conditionHolds(policy: Policy, profile: SubjectProfile, ctx: DecisionContext): string | null {
  const cond = policy.condition
  if (cond === undefined) return null

  if (cond.ownerOnly === true && ctx.resourceOwner !== profile.principal) {
    return `policy ${policy.id} is owner-only and ${profile.principal} is not the owner`
  }
  if (cond.notOwner === true && ctx.resourceOwner === profile.principal) {
    return `policy ${policy.id} forbids acting on your own resource`
  }
  if (cond.mfa === true && ctx.mfa !== true) {
    return `policy ${policy.id} requires MFA`
  }
  if (cond.classificationNotIn !== undefined && ctx.classification !== undefined) {
    if (cond.classificationNotIn.includes(ctx.classification)) {
      return `policy ${policy.id} forbids data classification "${ctx.classification}"`
    }
  }
  return null
}

export type PdpInput = {
  subject: SubjectProfile
  action: Capability
  resource: ResourceRef
  context?: DecisionContext
  /** 委派来源的画像。Agent 代表用户执行时，有效权限取交集。 */
  delegator?: SubjectProfile | undefined
  /** 本次调用可用的临时授权 */
  grants?: readonly Grant[]
}

/**
 * 策略决策点（PDP）。
 *
 * 决策顺序（PRD 07 §6，顺序本身就是安全属性，不可调整）：
 *   1. 租户不匹配         → Deny
 *   2. Agent 硬性护栏      → Deny
 *   3. 显式 Deny 策略      → Deny
 *   4. 主体不具备 capability → Deny
 *   5. 委派交集不满足       → Deny
 *   6. 临时授权已失效       → Deny
 *   7. Agent 敏感操作      → Ask
 *   8. 命中 Ask 策略        → Ask
 *   9. 命中 Allow 策略      → Allow
 *  10. 未命中任何 Allow     → Deny（默认拒绝）
 */
export function decide(input: PdpInput, policies: readonly Policy[]): Decision {
  const { subject, action, resource } = input
  const ctx = input.context ?? {}
  const now = ctx.now ?? new Date()

  // ① 租户边界。跨租户一律拒绝，且不区分"不存在"与"无权限"。
  if (subject.tenant !== resource.tenant) {
    return {
      effect: 'Deny',
      reason: `cross-tenant access denied: subject tenant "${subject.tenant}" != resource tenant "${resource.tenant}"`,
    }
  }

  const agent = isAgent(subject.principal)

  // ② 硬性护栏：先于一切策略，且不可被覆盖
  if (agent && isForbiddenForAgent(action)) {
    return {
      effect: 'Deny',
      reason: `capability "${action}" is permanently forbidden for agents (hard guardrail, ADR-0003)`,
    }
  }

  const applicable = policies.filter(
    (p) => subjectMatches(p.subject, subject) && capabilityMatches(p.action, action) && scopeMatches(p.scope, resource),
  )

  // ③ 显式 Deny 始终优先于 Allow。
  //    无条件 Deny 直接生效；带条件的 Deny 在条件不满足时生效（见 conditionHolds 注释）。
  for (const policy of applicable) {
    if (policy.effect !== 'Deny') continue
    const unmet = conditionHolds(policy, subject, ctx)
    if (policy.condition === undefined) {
      return { effect: 'Deny', reason: `denied by policy ${policy.id}`, matchedPolicy: policy.id }
    }
    if (unmet !== null) {
      return { effect: 'Deny', reason: unmet, matchedPolicy: policy.id }
    }
  }

  // ④ 主体是否具备该 capability（Role 展开 + 直接授予 + 临时授权）
  const fromGrants = (input.grants ?? []).some((g) =>
    g.capabilities.some((c) => capabilityMatches(c, action)),
  )
  if (!subjectHasCapability(subject, action) && !fromGrants) {
    return {
      effect: 'Deny',
      reason: `subject ${subject.principal} lacks capability "${action}"`,
    }
  }

  // ⑤ 受限委派：有效权限 = user ∩ agent，且不超过 agent 自身上限
  if (input.delegator !== undefined) {
    if (!subjectHasCapability(input.delegator, action)) {
      return {
        effect: 'Deny',
        reason:
          `delegation denied: delegator ${input.delegator.principal} lacks capability "${action}", ` +
          `so ${subject.principal} cannot exercise it on their behalf`,
      }
    }
  }

  // ⑥ 临时授权的三个失效条件（ADR-0003 §7.2）
  if (fromGrants && !subjectHasCapability(subject, action)) {
    const usable = (input.grants ?? []).filter((g) =>
      g.capabilities.some((c) => capabilityMatches(c, action)),
    )
    const live = usable.find((g) => grantIsLive(g, resource, now, ctx.runId))
    if (live === undefined) {
      return {
        effect: 'Deny',
        reason: `capability "${action}" is only available via a grant, and no live grant applies (expired, exhausted, or unbound run)`,
      }
    }
  }

  // ⑦ Agent 的不可逆操作强制人工确认——即使策略写了 Allow
  if (agent && requiresHumanApproval(action)) {
    return {
      effect: 'Ask',
      reason: `capability "${action}" requires human approval for agents (ADR-0003 guardrail)`,
    }
  }

  // ⑧/⑨ 条件求值后取 Ask 优先于 Allow：条件更严的那条应当胜出
  const ask = applicable.find((p) => p.effect === 'Ask')
  if (ask !== undefined && conditionHolds(ask, subject, ctx) === null) {
    return { effect: 'Ask', reason: `policy ${ask.id} requires approval`, matchedPolicy: ask.id }
  }

  for (const policy of applicable.filter((p) => p.effect === 'Allow')) {
    const failure = conditionHolds(policy, subject, ctx)
    if (failure === null) {
      return { effect: 'Allow', reason: `allowed by policy ${policy.id}`, matchedPolicy: policy.id }
    }
  }

  // ⑩ 默认拒绝
  const conditionFailures = applicable
    .filter((p) => p.effect === 'Allow')
    .map((p) => conditionHolds(p, subject, ctx))
    .filter((r): r is string => r !== null)

  return {
    effect: 'Deny',
    reason:
      conditionFailures.length > 0
        ? `no policy allows "${action}": ${conditionFailures.join('; ')}`
        : `no policy allows ${subject.principal} to perform "${action}" on the requested resource (deny by default)`,
  }
}

function grantIsLive(grant: Grant, resource: ResourceRef, now: Date, runId?: string): boolean {
  if (grant.revokedAt != null) return false
  if (grant.expiresAt.getTime() <= now.getTime()) return false
  if (grant.usedCalls >= grant.maxCalls) return false
  // 绑定到 Run 的授权，只在该 Run 内有效；Run 结束或换了 Run 都视为失效
  if (grant.boundToRun !== undefined && grant.boundToRun !== runId) return false
  if (!scopeMatches(grant.scope, resource)) return false
  return true
}

export { ROLE_CAPABILITIES }
