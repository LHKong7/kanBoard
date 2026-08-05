import { describe, expect, it } from 'vitest'
import { decide } from '../src/identity/pdp.ts'
import { defaultPolicies } from '../src/identity/default-policies.ts'
import type { Grant, Policy, SubjectProfile } from '../src/identity/types.ts'

const TENANT = 't_acme'
const policies = defaultPolicies(TENANT)

function user(principal: string, roles: SubjectProfile['roles'] = ['RD']): SubjectProfile {
  return { principal: principal as SubjectProfile['principal'], tenant: TENANT, roles, capabilities: [] }
}

function agent(principal: string, capabilities: string[] = []): SubjectProfile {
  return {
    principal: principal as SubjectProfile['principal'],
    tenant: TENANT,
    roles: ['AIAgent'],
    capabilities,
  }
}

const resource = { tenant: TENANT, workspace: 'ws1', project: 'prj_x', id: 'task_1', type: 'Task' }

describe('PDP · deny by default (FR-IAM-002)', () => {
  it('denies when no policy grants the capability', () => {
    const d = decide({ subject: user('user://nobody', ['Guest']), action: 'Task.Delete', resource }, [])
    expect(d.effect).toBe('Deny')
    expect(d.reason).toMatch(/deny by default|lacks capability/)
  })

  it('allows a role-derived capability', () => {
    const d = decide({ subject: user('user://rd'), action: 'Task.Update', resource }, policies)
    expect(d.effect).toBe('Allow')
  })
})

describe('PDP · Deny beats Allow (FR-IAM-003)', () => {
  it('denies even when an Allow policy also matches', () => {
    const conflicting: Policy[] = [
      ...policies,
      {
        id: 'pol-quarantine',
        effect: 'Deny',
        subject: '*',
        action: 'Task.Update',
        scope: { kind: 'resource', id: 'task_1' },
      },
    ]
    const d = decide({ subject: user('user://rd'), action: 'Task.Update', resource }, conflicting)
    expect(d.effect).toBe('Deny')
    expect(d.matchedPolicy).toBe('pol-quarantine')
  })
})

describe('PDP · tenant isolation (FR-IAM-015)', () => {
  it('denies cross-tenant access regardless of policy', () => {
    const admin: SubjectProfile = { ...user('user://admin', ['Admin']), tenant: 't_other' }
    const d = decide({ subject: admin, action: 'Task.Read', resource }, policies)
    expect(d.effect).toBe('Deny')
    expect(d.reason).toMatch(/cross-tenant/)
  })
})

describe('PDP · agents start at zero (FR-IAM-005)', () => {
  it('denies a freshly defined agent everything', () => {
    const d = decide({ subject: agent('agent://new@1.0.0'), action: 'Task.Read', resource }, policies)
    expect(d.effect).toBe('Deny')
    expect(d.reason).toMatch(/lacks capability/)
  })

  it('allows only what was explicitly granted', () => {
    const coding = agent('agent://coding@2.1.0', ['Task.Read'])
    expect(decide({ subject: coding, action: 'Task.Read', resource }, policies).effect).toBe('Allow')
    expect(decide({ subject: coding, action: 'Task.Update', resource }, policies).effect).toBe('Deny')
  })
})

describe('PDP · hard guardrails cannot be overridden (FR-IAM-008)', () => {
  const permissive: Policy[] = [
    {
      id: 'pol-oops-everything',
      effect: 'Allow',
      subject: '*',
      action: '*',
      scope: { kind: 'any' },
    },
  ]

  it('denies Permission.Grant to an agent even under an allow-everything policy', () => {
    const a = agent('agent://sneaky@1.0.0', ['*'])
    const d = decide({ subject: a, action: 'Permission.Grant', resource }, permissive)
    expect(d.effect).toBe('Deny')
    expect(d.reason).toMatch(/hard guardrail/)
  })

  it('denies Project.Delete to an agent even under an allow-everything policy', () => {
    const a = agent('agent://sneaky@1.0.0', ['*'])
    expect(decide({ subject: a, action: 'Project.Delete', resource }, permissive).effect).toBe('Deny')
  })

  it('still allows a human admin to do those things', () => {
    const d = decide({ subject: user('user://root', ['Admin']), action: 'Project.Delete', resource }, permissive)
    expect(d.effect).toBe('Allow')
  })
})

describe('PDP · sensitive agent actions require approval (FR-IAM-009)', () => {
  it('returns Ask for PR.Merge even when the policy says Allow', () => {
    const a = agent('agent://coding@2.1.0', ['PR.Merge'])
    const d = decide({ subject: a, action: 'PR.Merge', resource }, [
      { id: 'pol-merge', effect: 'Allow', subject: '*', action: 'PR.Merge', scope: { kind: 'any' } },
    ])
    expect(d.effect).toBe('Ask')
  })

  it('does not ask a human for the same action', () => {
    const d = decide({ subject: user('user://alice', ['Admin']), action: 'PR.Merge', resource }, [
      { id: 'pol-merge', effect: 'Allow', subject: '*', action: 'PR.Merge', scope: { kind: 'any' } },
    ])
    expect(d.effect).toBe('Allow')
  })
})

describe('PDP · constrained delegation takes the intersection (FR-IAM-007)', () => {
  it('denies when the delegating user lacks the capability, even if the agent has it', () => {
    const a = agent('agent://pm@1.0.0', ['Requirement.Approve'])
    const delegator = user('user://intern', ['Guest'])
    const d = decide(
      { subject: a, action: 'Requirement.Approve', resource, delegator },
      [{ id: 'pol-approve', effect: 'Allow', subject: '*', action: 'Requirement.Approve', scope: { kind: 'any' } }],
    )
    expect(d.effect).toBe('Deny')
    expect(d.reason).toMatch(/delegation denied/)
  })

  it('allows when both sides have it', () => {
    const a = agent('agent://pm@1.0.0', ['Requirement.Read'])
    const delegator = user('user://lead', ['Leader'])
    const d = decide({ subject: a, action: 'Requirement.Read', resource, delegator }, policies)
    expect(d.effect).toBe('Allow')
  })
})

describe('PDP · just-in-time grants expire three ways (FR-IAM-006)', () => {
  const base: Omit<Grant, 'expiresAt' | 'usedCalls' | 'maxCalls' | 'boundToRun'> = {
    id: 'grant_1',
    tenant: TENANT,
    subject: 'agent://coding@2.1.0',
    capabilities: ['Code.Write'],
    scope: { kind: 'any' },
  }
  const a = agent('agent://coding@2.1.0')
  const now = new Date('2026-08-03T10:00:00Z')

  function decideWith(grant: Grant, runId?: string) {
    return decide(
      {
        subject: a,
        action: 'Code.Write',
        resource,
        grants: [grant],
        context: { now, runId },
      },
      [{ id: 'pol-code', effect: 'Allow', subject: '*', action: 'Code.Write', scope: { kind: 'any' } }],
    )
  }

  it('allows while the grant is live', () => {
    const grant: Grant = {
      ...base,
      expiresAt: new Date('2026-08-03T10:30:00Z'),
      maxCalls: 200,
      usedCalls: 0,
      boundToRun: 'run_8891',
    }
    expect(decideWith(grant, 'run_8891').effect).toBe('Allow')
  })

  it('denies after the TTL elapses', () => {
    const grant: Grant = {
      ...base,
      expiresAt: new Date('2026-08-03T09:59:00Z'),
      maxCalls: 200,
      usedCalls: 0,
      boundToRun: 'run_8891',
    }
    const d = decideWith(grant, 'run_8891')
    expect(d.effect).toBe('Deny')
    expect(d.reason).toMatch(/no live grant/)
  })

  it('denies once the call budget is exhausted', () => {
    const grant: Grant = {
      ...base,
      expiresAt: new Date('2026-08-03T10:30:00Z'),
      maxCalls: 200,
      usedCalls: 200,
      boundToRun: 'run_8891',
    }
    expect(decideWith(grant, 'run_8891').effect).toBe('Deny')
  })

  it('denies outside the run it was bound to', () => {
    const grant: Grant = {
      ...base,
      expiresAt: new Date('2026-08-03T10:30:00Z'),
      maxCalls: 200,
      usedCalls: 0,
      boundToRun: 'run_8891',
    }
    // 同一个 Agent、同一个能力，但换了一个 Run——授权不跟着走
    expect(decideWith(grant, 'run_9999').effect).toBe('Deny')
  })

  it('denies a revoked grant', () => {
    const grant: Grant = {
      ...base,
      expiresAt: new Date('2026-08-03T10:30:00Z'),
      maxCalls: 200,
      usedCalls: 0,
      boundToRun: 'run_8891',
      revokedAt: new Date('2026-08-03T09:30:00Z'),
    }
    expect(decideWith(grant, 'run_8891').effect).toBe('Deny')
  })
})

describe('PDP · conditions (FR-IAM-011)', () => {
  it('applies ownerOnly', () => {
    const alice = user('user://alice', ['RD'])
    const allow = decide(
      { subject: alice, action: 'Task.Delete', resource, context: { resourceOwner: 'user://alice' } },
      policies,
    )
    expect(allow.effect).toBe('Allow')

    const deny = decide(
      { subject: alice, action: 'Task.Delete', resource, context: { resourceOwner: 'user://bob' } },
      policies,
    )
    expect(deny.effect).toBe('Deny')
    expect(deny.reason).toMatch(/owner/)
  })

  it('does not let a broad Allow reopen what a conditional Deny closed', () => {
    // 回归测试：`pol-rd-task` 授予 `Task.*`（含 Delete）。
    // 如果 owner-only 限制写成 Allow，这条宽策略会静默把它冲掉。
    const alice = user('user://alice', ['RD'])
    const d = decide(
      { subject: alice, action: 'Task.Delete', resource, context: { resourceOwner: 'user://bob' } },
      policies,
    )
    expect(d.effect).toBe('Deny')
    expect(d.matchedPolicy).toBe('pol-delete-owner-only-rd')
  })

  it('still lets an admin delete resources they do not own', () => {
    // owner-only 的 Deny 按角色列出正是为了保留这条兜底路径
    const d = decide(
      {
        subject: user('user://root', ['Admin']),
        action: 'Task.Delete',
        resource,
        context: { resourceOwner: 'user://bob' },
      },
      policies,
    )
    expect(d.effect).toBe('Allow')
  })

  it('applies an MFA requirement', () => {
    const p: Policy[] = [
      {
        id: 'pol-mfa',
        effect: 'Allow',
        subject: '*',
        action: 'Task.Update',
        scope: { kind: 'any' },
        condition: { mfa: true },
      },
    ]
    expect(decide({ subject: user('user://rd'), action: 'Task.Update', resource, context: { mfa: false } }, p).effect).toBe('Deny')
    expect(decide({ subject: user('user://rd'), action: 'Task.Update', resource, context: { mfa: true } }, p).effect).toBe('Allow')
  })
})

describe('PDP · scope narrowing (FR-IAM-010)', () => {
  it('lets a resource-level Deny override a tenant-level Allow', () => {
    const p: Policy[] = [
      { id: 'pol-tenant-allow', effect: 'Allow', subject: '*', action: 'Task.Update', scope: { kind: 'tenant', tenant: TENANT } },
      { id: 'pol-resource-deny', effect: 'Deny', subject: '*', action: 'Task.Update', scope: { kind: 'resource', id: 'task_1' } },
    ]
    expect(decide({ subject: user('user://rd'), action: 'Task.Update', resource }, p).effect).toBe('Deny')
    // 另一个资源不受影响
    const other = { ...resource, id: 'task_2' }
    expect(decide({ subject: user('user://rd'), action: 'Task.Update', resource: other }, p).effect).toBe('Allow')
  })
})

describe('PDP · the AIAgent role is an empty set, not a shortcut', () => {
  it('grants nothing by virtue of the role alone', () => {
    const d = decide({ subject: agent('agent://x@1.0.0'), action: 'Task.Read', resource }, [
      { id: 'pol-role', effect: 'Allow', subject: 'role:AIAgent', action: '*', scope: { kind: 'any' } },
    ])
    // 策略匹配上了，但主体本身不具备任何 capability
    expect(d.effect).toBe('Deny')
    expect(d.reason).toMatch(/lacks capability/)
  })
})

/**
 * 条件与 Ask 的求值细节。
 *
 * 这几条分支决定了"策略写了条件，条件到底有没有被求值"。
 * 没被覆盖的话，一条写了 mfa/分级限制的策略可能根本不生效，
 * 而它在策略列表里看着完全正常。
 */
describe('PDP · policy conditions are actually evaluated', () => {
  it('refuses when MFA is required and absent, and says so', () => {
    const p: Policy[] = [
      {
        id: 'pol-mfa',
        effect: 'Allow',
        subject: '*',
        action: 'Task.Delete',
        scope: { kind: 'tenant', tenant: TENANT },
        condition: { mfa: true },
      },
    ]
    const d = decide({ subject: user('user://rd'), action: 'Task.Delete', resource }, p)
    expect(d.effect).toBe('Deny')
    expect(d.reason).toMatch(/requires MFA/)
  })

  it('allows once MFA is present', () => {
    const p: Policy[] = [
      {
        id: 'pol-mfa',
        effect: 'Allow',
        subject: '*',
        action: 'Task.Delete',
        scope: { kind: 'tenant', tenant: TENANT },
        condition: { mfa: true },
      },
    ]
    const d = decide(
      { subject: user('user://rd'), action: 'Task.Delete', resource, context: { mfa: true } },
      p,
    )
    expect(d.effect).toBe('Allow')
  })

  it('refuses a forbidden data classification', () => {
    const p: Policy[] = [
      {
        id: 'pol-class',
        effect: 'Allow',
        subject: '*',
        action: 'Task.Read',
        scope: { kind: 'tenant', tenant: TENANT },
        condition: { classificationNotIn: ['secret'] },
      },
    ]
    const denied = decide(
      { subject: user('user://rd'), action: 'Task.Read', resource, context: { classification: 'secret' } },
      p,
    )
    expect(denied.effect).toBe('Deny')
    expect(denied.reason).toMatch(/classification/)

    // 没有分级信息时这条限制不适用——不该把未标注的数据一律当成机密
    const allowed = decide({ subject: user('user://rd'), action: 'Task.Read', resource }, p)
    expect(allowed.effect).toBe('Allow')
  })

  it('prefers Ask over Allow when both apply', () => {
    // 条件更严的那条应当胜出。反过来的话，加一条 Ask 策略等于没加
    const p: Policy[] = [
      {
        id: 'pol-allow',
        effect: 'Allow',
        subject: '*',
        action: 'Task.Update',
        scope: { kind: 'tenant', tenant: TENANT },
      },
      {
        id: 'pol-ask',
        effect: 'Ask',
        subject: '*',
        action: 'Task.Update',
        scope: { kind: 'tenant', tenant: TENANT },
      },
    ]
    const d = decide({ subject: user('user://rd'), action: 'Task.Update', resource }, p)
    expect(d.effect).toBe('Ask')
    expect(d.matchedPolicy).toBe('pol-ask')
  })

  it('falls through to Allow when the Ask policy’s own condition fails', () => {
    // Ask 自己的条件不满足时它不该生效，否则一条永远不适用的 Ask
    // 会把操作永久卡住
    const p: Policy[] = [
      {
        id: 'pol-allow',
        effect: 'Allow',
        subject: '*',
        action: 'Task.Update',
        scope: { kind: 'tenant', tenant: TENANT },
      },
      {
        id: 'pol-ask-owner-only',
        effect: 'Ask',
        subject: '*',
        action: 'Task.Update',
        scope: { kind: 'tenant', tenant: TENANT },
        condition: { ownerOnly: true },
      },
    ]
    const d = decide(
      {
        subject: user('user://rd'),
        action: 'Task.Update',
        resource,
        context: { resourceOwner: 'user://someone-else' },
      },
      p,
    )
    expect(d.effect).toBe('Allow')
  })
})
