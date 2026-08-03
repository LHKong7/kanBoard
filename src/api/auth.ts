import { z } from 'zod'
import type { Principal, Role, SubjectProfile } from '../identity/types.ts'
import { DomainError } from '../platform/errors.ts'

/**
 * 认证：把请求头解析成主体画像。
 *
 * M0 用请求头承载身份（`x-principal` / `x-tenant` / `x-roles`），
 * 真实的 OIDC / Agent Credential 在 M1 接入。
 *
 * 之所以现在就把它抽成独立模块：认证方式会变，但下游拿到的
 * `SubjectProfile` 不该跟着变——尤其是 Agent 与 User 必须走同一个出口，
 * 否则很容易在后面长出一条"Agent 专用"的旁路（ADR-0002 明确禁止）。
 */

const headerSchema = z.object({
  principal: z
    .string()
    .regex(/^(user|agent):\/\/[\w@.:-]{1,128}$/, 'principal must be user://… or agent://…'),
  tenant: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
  roles: z.array(z.enum(['PM', 'RD', 'QA', 'Leader', 'Admin', 'Guest', 'AIAgent'])),
  capabilities: z.array(z.string().max(128)).max(200),
})

export type AuthHeaders = Record<string, string | string[] | undefined>

export function parseSubject(headers: AuthHeaders): SubjectProfile {
  const raw = {
    principal: first(headers['x-principal']),
    tenant: first(headers['x-tenant']),
    roles: splitList(first(headers['x-roles'])),
    capabilities: splitList(first(headers['x-capabilities'])),
  }

  const result = headerSchema.safeParse(raw)
  if (!result.success) {
    throw new DomainError('unauthenticated', 'missing or malformed identity headers', 401, {
      fields: result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    })
  }

  return {
    principal: result.data.principal as Principal,
    tenant: result.data.tenant,
    roles: result.data.roles as Role[],
    capabilities: result.data.capabilities,
  }
}

/**
 * 受限委派：Agent 代表用户执行。
 *
 * 只解析出委派来源，交集计算在 PDP 里做——权限判定必须集中在一处。
 */
export function parseDelegator(headers: AuthHeaders, tenant: string): SubjectProfile | undefined {
  const principal = first(headers['x-on-behalf-of'])
  if (principal === undefined || principal === '') return undefined

  const result = headerSchema.safeParse({
    principal,
    tenant,
    roles: splitList(first(headers['x-on-behalf-of-roles'])),
    capabilities: splitList(first(headers['x-on-behalf-of-capabilities'])),
  })
  if (!result.success) {
    throw new DomainError('unauthenticated', 'malformed delegation headers', 401)
  }

  return {
    principal: result.data.principal as Principal,
    tenant,
    roles: result.data.roles as Role[],
    capabilities: result.data.capabilities,
  }
}

function first(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0]
  return value
}

function splitList(value: string | undefined): string[] {
  if (value === undefined || value.trim() === '') return []
  return value.split(',').map((s) => s.trim()).filter((s) => s !== '')
}
