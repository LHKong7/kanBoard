import { DomainError } from '../../platform/errors.ts'
import type { AutomationAction, AutomationRule } from '../../workflow/automation.ts'
import type { DomainEvent } from '../events.ts'
import type { Caller, ResourceService } from '../resource/service.ts'
import type { SubjectProfile } from '../../identity/types.ts'

/**
 * 自动化执行器。
 *
 * 三条约束决定了它的形状：
 *
 * 1. **自动化不能绕过守卫**（W2）。它调用的是和人完全一样的 `transition()`，
 *    因此守卫、权限、审计、事件一个都不少。
 * 2. **失败不能中断链路**。一条规则失败不该让其余规则和事件消费停摆，
 *    但也不能静默——每次失败都记录下来。
 * 3. **触发链有深度上限**（W3）。自动化触发的迁移会再发事件，
 *    事件又可能触发自动化。没有上限的话，一条环形规则就能打满数据库。
 */

/** 自动化以系统身份执行。它的权限是显式且很窄的，见 default-policies.ts */
export const SYSTEM_SUBJECT: SubjectProfile = {
  principal: 'system://internal',
  tenant: '',
  roles: [],
  capabilities: ['*.Transition', '*.Read', 'Task.Execute'],
}

export function systemCaller(tenant: string, traceId: string | null, depth = 0): Caller {
  return {
    subject: { ...SYSTEM_SUBJECT, tenant },
    traceId: traceId ?? undefined,
    // 本次自动化发出的事件会带上 depth+1，下一跳据此判断是否超限
    automationDepth: depth + 1,
  }
}

export type AutomationOutcome = {
  ruleId: string
  action: string
  status: 'applied' | 'skipped' | 'failed'
  detail: string
}

export type RunnerDeps = {
  service: ResourceService
  rules: readonly AutomationRule[]
  /** 触发链深度上限（W3）。默认 10。 */
  maxChainDepth?: number
}

export class AutomationRunner {
  readonly #deps: RunnerDeps

  constructor(deps: RunnerDeps) {
    this.#deps = deps
  }

  /**
   * 处理一个领域事件。
   *
   * `depth` 由调用方从事件负载中读出并递增——自动化产生的事件带着它上一跳的深度。
   */
  async handle(event: DomainEvent, depth = 0): Promise<AutomationOutcome[]> {
    const limit = this.#deps.maxChainDepth ?? 10
    if (depth >= limit) {
      return [
        {
          ruleId: '(chain-guard)',
          action: 'abort',
          status: 'failed',
          detail: `automation chain depth ${depth} reached the limit of ${limit}; likely a rule cycle`,
        },
      ]
    }

    const caller = systemCaller(event.tenant, event.traceId, depth)
    const outcomes: AutomationOutcome[] = []

    for (const rule of this.#deps.rules) {
      if (rule.enabled === false) continue
      if (!matches(rule, event)) continue

      for (const action of rule.then) {
        try {
          outcomes.push(await this.#apply(rule, action, event, caller))
        } catch (error) {
          // 一条规则失败不影响其余规则。但失败必须留痕——
          // 静默失败的自动化比没有自动化更糟：用户以为系统做了，其实没有。
          outcomes.push({
            ruleId: rule.id,
            action: action.kind,
            status: 'failed',
            detail: error instanceof DomainError ? error.message : String(error),
          })
        }
      }
    }

    return outcomes
  }

  async #apply(
    rule: AutomationRule,
    action: AutomationAction,
    event: DomainEvent,
    caller: Caller,
  ): Promise<AutomationOutcome> {
    switch (action.kind) {
      case 'log':
        return { ruleId: rule.id, action: 'log', status: 'applied', detail: action.message }

      case 'relate': {
        await this.#deps.service.relate(caller, {
          type: action.relation,
          fromId: event.resourceId,
          toId: String(event.payload['toId'] ?? ''),
          origin: 'system',
        })
        return { ruleId: rule.id, action: 'relate', status: 'applied', detail: action.relation }
      }

      case 'transitionRelated': {
        const related = await this.#deps.service.relationsOf(
          caller,
          event.resourceId,
          action.direction,
          action.relation,
        )
        if (related.length === 0) {
          return {
            ruleId: rule.id,
            action: action.kind,
            status: 'skipped',
            detail: `no "${action.relation}" relation from ${event.resourceId}`,
          }
        }

        const details: string[] = []
        for (const relation of related) {
          const targetId = action.direction === 'out' ? relation.toId : relation.fromId
          const target = await this.#deps.service.get(caller, targetId)
          if (target.type !== action.targetType) continue

          if (
            action.onlyIfCurrentIn !== undefined &&
            !action.onlyIfCurrentIn.includes(target.status)
          ) {
            details.push(`${targetId} is "${target.status}", not in ${JSON.stringify(action.onlyIfCurrentIn)}`)
            continue
          }

          if (action.requireAllSiblings !== undefined) {
            const pending = await this.#pendingSiblings(caller, targetId, action)
            if (pending.length > 0) {
              details.push(`${targetId} still has ${pending.length} unfinished sibling(s)`)
              continue
            }
          }

          await this.#deps.service.transition(caller, targetId, action.to, {
            reason: `automation: ${rule.id}`,
          })
          details.push(`${targetId} → ${action.to}`)
        }

        const applied = details.some((d) => d.includes('→'))
        return {
          ruleId: rule.id,
          action: action.kind,
          status: applied ? 'applied' : 'skipped',
          detail: details.join('; ') || 'no matching target',
        }
      }

      default: {
        const exhaustive: never = action
        throw new Error(`unhandled automation action: ${JSON.stringify(exhaustive)}`)
      }
    }
  }

  /**
   * 找出目标对象下还没到终态的同级对象。
   *
   * "所有子任务都完成了吗"必须真的去查，不能靠事件里的信息推断——
   * 事件只知道刚刚这一个任务完成了。
   */
  async #pendingSiblings(
    caller: Caller,
    targetId: string,
    action: Extract<AutomationAction, { kind: 'transitionRelated' }>,
  ): Promise<string[]> {
    const inverseDirection = action.direction === 'out' ? 'in' : 'out'
    const siblings = await this.#deps.service.relationsOf(
      caller,
      targetId,
      inverseDirection,
      action.relation,
    )

    const pending: string[] = []
    for (const relation of siblings) {
      const siblingId = inverseDirection === 'out' ? relation.toId : relation.fromId
      const sibling = await this.#deps.service.get(caller, siblingId)
      if (!(action.requireAllSiblings ?? []).includes(sibling.status)) {
        pending.push(siblingId)
      }
    }
    return pending
  }
}

function matches(rule: AutomationRule, event: DomainEvent): boolean {
  if (rule.when.event !== event.type) return false
  if (rule.when.resourceType !== undefined && rule.when.resourceType !== event.resourceType) {
    return false
  }
  if (rule.when.toStatus !== undefined && event.payload['to'] !== rule.when.toStatus) return false
  if (rule.when.fromStatus !== undefined && event.payload['from'] !== rule.when.fromStatus) {
    return false
  }
  return true
}
