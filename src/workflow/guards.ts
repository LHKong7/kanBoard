import type { Guard, GuardContext, GuardResult } from './types.ts'

/**
 * 守卫求值。
 *
 * 失败时返回的是**具体缺了什么**，不是 false。
 * "迁移被拒绝"对使用者毫无帮助；"进入 Review 需要先关联一个 PR"才有。
 */
export function evaluateGuard(guard: Guard, ctx: GuardContext): GuardResult {
  switch (guard.kind) {
    case 'attributeSet': {
      const value = ctx.attributes[guard.path]
      const missing = value === undefined || value === null || value === ''
      return missing ? fail(`attribute "${guard.path}" must be set`) : OK
    }

    case 'attributeEquals': {
      const value = ctx.attributes[guard.path]
      return value === guard.value
        ? OK
        : fail(`attribute "${guard.path}" must equal ${JSON.stringify(guard.value)}, found ${JSON.stringify(value ?? null)}`)
    }

    case 'attributeIn': {
      const value = ctx.attributes[guard.path]
      return guard.values.includes(value as string | number)
        ? OK
        : fail(
            `attribute "${guard.path}" must be one of ${JSON.stringify(guard.values)}, found ${JSON.stringify(value ?? null)}`,
          )
    }

    case 'hasRelation': {
      const set = guard.direction === 'out' ? ctx.outgoingRelationTypes : ctx.incomingRelationTypes
      return set.has(guard.type)
        ? OK
        : fail(`a "${guard.type}" relation (${guard.direction}going) is required`)
    }

    case 'ownerAssigned':
      return ctx.owner !== null && ctx.owner !== '' ? OK : fail('an owner must be assigned')

    case 'all': {
      for (const inner of guard.of) {
        const result = evaluateGuard(inner, ctx)
        if (!result.ok) return result
      }
      return OK
    }

    case 'any': {
      const reasons: string[] = []
      for (const inner of guard.of) {
        const result = evaluateGuard(inner, ctx)
        if (result.ok) return OK
        reasons.push(result.reason)
      }
      return fail(`none of the alternatives held: ${reasons.join(' | ')}`)
    }

    case 'not': {
      const result = evaluateGuard(guard.of, ctx)
      return result.ok ? fail(`condition must not hold: ${describe(guard.of)}`) : OK
    }

    default: {
      const exhaustive: never = guard
      throw new Error(`unhandled guard kind: ${JSON.stringify(exhaustive)}`)
    }
  }
}

const OK: GuardResult = { ok: true }

function fail(reason: string): GuardResult {
  return { ok: false, reason }
}

/** 用于 `not` 的错误信息，以及 UI 展示"这条迁移需要什么" */
export function describe(guard: Guard): string {
  switch (guard.kind) {
    case 'attributeSet':
      return `${guard.path} is set`
    case 'attributeEquals':
      return `${guard.path} == ${JSON.stringify(guard.value)}`
    case 'attributeIn':
      return `${guard.path} in ${JSON.stringify(guard.values)}`
    case 'hasRelation':
      return `has ${guard.direction}going "${guard.type}" relation`
    case 'ownerAssigned':
      return 'owner is assigned'
    case 'all':
      return guard.of.map(describe).join(' and ')
    case 'any':
      return guard.of.map(describe).join(' or ')
    case 'not':
      return `not (${describe(guard.of)})`
    default: {
      const exhaustive: never = guard
      throw new Error(`unhandled guard kind: ${JSON.stringify(exhaustive)}`)
    }
  }
}
