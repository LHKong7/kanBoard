import type { Capability } from './types.ts'

/**
 * 硬性护栏（ADR-0003 §7.3）。
 *
 * 这些规则**不可被任何策略覆盖**——它们不参与 Allow/Deny 的优先级比较，
 * 而是在策略求值之前就短路。理由很直接：如果一条"禁止 Agent 自我提权"的规则
 * 可以被另一条策略覆盖，那它就不是护栏，只是一个默认值。
 */

/** 对所有 Agent 永久禁止的 Capability */
const AGENT_FORBIDDEN: readonly string[] = [
  'Project.Delete',
  'Permission.Grant',
  'Permission.Revoke',
  'Agent.Define',
  'Tenant.*',
]

/** 强制走 Ask（人工确认）的 Capability——即使策略写了 Allow */
const AGENT_REQUIRE_APPROVAL: readonly string[] = [
  'PR.Merge',
  'Release.Promote:prod',
  'Data.Delete',
  'Browser.Action:payment',
]

function matches(pattern: string, capability: Capability): boolean {
  if (pattern === capability) return true
  if (pattern.endsWith('.*')) {
    return capability.startsWith(pattern.slice(0, -1))
  }
  return false
}

export function isForbiddenForAgent(capability: Capability): boolean {
  return AGENT_FORBIDDEN.some((p) => matches(p, capability))
}

export function requiresHumanApproval(capability: Capability): boolean {
  return AGENT_REQUIRE_APPROVAL.some((p) => matches(p, capability))
}

export const AGENT_FORBIDDEN_CAPABILITIES = AGENT_FORBIDDEN
export const AGENT_APPROVAL_CAPABILITIES = AGENT_REQUIRE_APPROVAL
