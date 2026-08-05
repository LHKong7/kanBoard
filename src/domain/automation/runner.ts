import { DomainError } from '../../platform/errors.ts'
import { mentionsExcluding } from '../collaboration/mentions.ts'
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

/**
 * 自动化以系统身份执行。它的权限是显式且很窄的，见 default-policies.ts。
 *
 * 这里是**能力闸门**，策略闸门在 default-policies.ts，两道都要放行。
 * 逐个类型地列而不是写 `*.Create`：自动化引擎是个高权限执行路径，
 * 它不面对人类的判断力，一条写错的规则会以机器的速度把错误铺开。
 * 将来要让某条规则创建新类型，就在这里补一行——**补这一行时人会想一想**，
 * 而一个通配符不会给任何人这个机会。
 */
export const SYSTEM_SUBJECT: SubjectProfile = {
  principal: 'system://internal',
  tenant: '',
  roles: [],
  capabilities: [
    '*.Transition',
    '*.Read',
    'Task.Execute',
    // createEntity / notify / invokeAgent 能创建的全部类型
    'Task.Create',
    'Notification.Create',
    'AgentRun.Create',
    // assign 只针对工作项。需求归谁是人的判断，不该由规则改写
    'Task.Update',
    'Story.Update',
  ],
}

export function systemCaller(tenant: string, traceId: string | null, depth = 0): Caller {
  return {
    subject: { ...SYSTEM_SUBJECT, tenant },
    traceId: traceId ?? undefined,
    // 本次自动化发出的事件会带上 depth+1，下一跳据此判断是否超限
    automationDepth: depth + 1,
  }
}

/**
 * 一条规则**找到了目标却没能推动它**。
 *
 * 区分两种，因为要给的答案不一样：
 * - `rejected`：守卫挡回或调用出错。系统层面的异常，要告警。
 * - `declined`：规则自己的条件不满足（目标状态不对、还有未完成的兄弟对象）。
 *   不是异常，但**是一次停滞**——对象就停在那儿了，得有人能问出"为什么没动"。
 *
 * 关键在于"找到了目标"。压根没有这条关系（任务不属于任何 Story）不算停滞，
 * 那是常态，记下来只会把有用的信号淹掉。
 *
 * 这个类型来自自用第一天（docs/dogfooding-log.md #2）：
 * Story 忘了标 Ready，子任务全部做完，两条规则都算出了准确的原因——
 * `story_… is "Draft", not in ["Ready"]`——然后把它扔了。
 */
export type AutomationDecline = {
  targetId: string
  reason: string
  kind: 'rejected' | 'declined'
}

export type AutomationOutcome = {
  ruleId: string
  action: string
  status: 'applied' | 'skipped' | 'failed'
  detail: string
  /** 找到了目标但没推动它的记录。空数组与缺省同义：没有停滞。 */
  declines?: readonly AutomationDecline[]
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

      case 'transition': {
        const subject = await this.#deps.service.get(caller, event.resourceId)
        if (
          action.onlyIfCurrentIn !== undefined &&
          !action.onlyIfCurrentIn.includes(subject.status)
        ) {
          const reason = `${subject.id} is "${subject.status}", not in ${JSON.stringify(action.onlyIfCurrentIn)}`
          return {
            ruleId: rule.id,
            action: action.kind,
            status: 'skipped',
            detail: reason,
            // 找到了目标却没推动它，就是一次停滞。记下来（dogfooding #2）
            declines: [{ targetId: subject.id, reason, kind: 'declined' }],
          }
        }
        await this.#deps.service.transition(caller, subject.id, action.to, {
          reason: `automation: ${rule.id}`,
        })
        return {
          ruleId: rule.id,
          action: action.kind,
          status: 'applied',
          detail: `${subject.id} → ${action.to}`,
        }
      }

      case 'assign': {
        const subject = await this.#deps.service.get(caller, event.resourceId)
        if (subject.owner === action.to) {
          // 已经是这个人了就别写一次历史：一条什么都没改的 history 条目
          // 会让"这个对象被改过几次"变得不可信
          return {
            ruleId: rule.id,
            action: action.kind,
            status: 'skipped',
            detail: `${subject.id} already owned by ${action.to}`,
          }
        }
        await this.#deps.service.update(caller, subject.id, {
          expectedVersion: subject.version,
          owner: action.to,
          reason: `automation: ${rule.id}`,
        })
        return {
          ruleId: rule.id,
          action: action.kind,
          status: 'applied',
          detail: `${subject.id} → ${action.to}`,
        }
      }

      case 'createEntity': {
        const subject = await this.#deps.service.get(caller, event.resourceId)
        const attributes: Record<string, unknown> = { ...action.attributes }
        if (action.titleFromSubject !== undefined) {
          attributes['title'] = String(subject.attributes[action.titleFromSubject] ?? subject.id)
        }
        const created = await this.#deps.service.create(caller, {
          type: action.resourceType,
          workspace: subject.workspace,
          project: subject.project,
          attributes,
        })
        if (action.relateBack !== undefined) {
          await this.#deps.service.relate(caller, {
            type: action.relateBack,
            fromId: created.id,
            toId: subject.id,
            origin: 'system',
          })
        }
        return {
          ruleId: rule.id,
          action: action.kind,
          status: 'applied',
          detail: `created ${action.resourceType} ${created.id}`,
        }
      }

      case 'invokeAgent': {
        const subject = await this.#deps.service.get(caller, event.resourceId)
        // 就是创建一个 AgentRun。AgentRunner 会取走 Queued 的那些，
        // 于是自动化发起的 Run 和人发起的 Run 走同一条路径
        const run = await this.#deps.service.create(caller, {
          type: 'AgentRun',
          workspace: subject.workspace,
          project: subject.project,
          attributes: {
            goal: action.goal,
            agent: action.agentId,
            subject: subject.id,
            mode: action.mode,
            trigger: 'event',
          },
        })
        return {
          ruleId: rule.id,
          action: action.kind,
          status: 'applied',
          detail: `queued AgentRun ${run.id} for ${action.agentId}`,
        }
      }

      case 'notify': {
        const subject = await this.#deps.service.get(caller, event.resourceId)

        // ── `mentions`：一条规则发多封 ──────────────────────
        //
        // 收件人从**正文当场解析**，不读任何存下来的清单，
        // 也不接受客户端自报（见 collaboration/mentions.ts）。
        if (action.recipient === 'mentions') {
          const targets = mentionsExcluding(subject.attributes['body'], subject.owner)
          if (targets.length === 0) {
            // 没 @ 任何人是**正常**的——大多数评论都不 @ 人。
            // 记成 failed 会让自动化面板被一片红淹掉，真正的失败就看不见了
            return {
              ruleId: rule.id,
              action: action.kind,
              status: 'skipped',
              detail: 'no one was mentioned',
            }
          }
          for (const recipient of targets) {
            await this.#deps.service.create(caller, {
              type: 'Notification',
              workspace: subject.workspace,
              project: subject.project,
              attributes: {
                title: action.title,
                recipient,
                about: subject.id,
                severity: action.severity ?? 'info',
              },
            })
          }
          return {
            ruleId: rule.id,
            action: action.kind,
            status: 'applied',
            detail: `notified ${targets.length} mentioned: ${targets.join(', ')}`,
          }
        }

        const recipient = action.recipient === 'owner' ? subject.owner : action.recipient
        if (recipient === null || recipient === '') {
          // 没有收件人的通知不该被安静地丢掉——它意味着一条规则
          // 认为有人该被告知，而系统答不出是谁
          return {
            ruleId: rule.id,
            action: action.kind,
            status: 'failed',
            detail: `no recipient: ${subject.id} has no owner`,
          }
        }
        const created = await this.#deps.service.create(caller, {
          type: 'Notification',
          workspace: subject.workspace,
          project: subject.project,
          attributes: {
            title: action.title,
            recipient,
            about: subject.id,
            severity: action.severity ?? 'info',
          },
        })
        return {
          ruleId: rule.id,
          action: action.kind,
          status: 'applied',
          detail: `notified ${recipient} (${created.id})`,
        }
      }

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
        const declines: AutomationDecline[] = []
        for (const relation of related) {
          const targetId = action.direction === 'out' ? relation.toId : relation.fromId
          const target = await this.#deps.service.get(caller, targetId)
          if (target.type !== action.targetType) continue

          if (
            action.onlyIfCurrentIn !== undefined &&
            !action.onlyIfCurrentIn.includes(target.status)
          ) {
            const reason = `${targetId} is "${target.status}", not in ${JSON.stringify(action.onlyIfCurrentIn)}`
            details.push(reason)
            declines.push({ targetId, reason, kind: 'declined' })
            continue
          }

          if (action.requireAllSiblings !== undefined) {
            const pending = await this.#pendingSiblings(caller, targetId, action)
            if (pending.length > 0) {
              const reason = `${targetId} still has ${pending.length} unfinished sibling(s)`
              details.push(reason)
              declines.push({ targetId, reason, kind: 'declined' })
              continue
            }
          }

          // 每个目标单独兜住：一个目标被守卫拒绝，不该让同一动作的其余目标也不执行。
          // 之前是整个动作抛出去由外层捕获，于是列表里排在后面的对象白白被牵连。
          try {
            await this.#deps.service.transition(caller, targetId, action.to, {
              reason: `automation: ${rule.id}`,
            })
            details.push(`${targetId} → ${action.to}`)
          } catch (error) {
            const reason = error instanceof DomainError ? error.message : String(error)
            declines.push({ targetId, reason, kind: 'rejected' })
            details.push(`${targetId} ✗ ${reason}`)
          }
        }

        const applied = details.some((d) => d.includes('→'))
        const rejected = declines.some((d) => d.kind === 'rejected')
        return {
          ruleId: rule.id,
          action: action.kind,
          // 有 rejected 就是 failed，哪怕另一些目标成功了——部分成功不能报告成成功
          status: rejected ? 'failed' : applied ? 'applied' : 'skipped',
          detail: details.join('; ') || 'no matching target',
          ...(declines.length > 0 ? { declines } : {}),
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
  // 外部事件（FR-WF-006）。来源与事件名都在 payload 里——
  // 领域层因此不需要认识 GitHub 是谁
  if (rule.when.externalSource !== undefined && event.payload['source'] !== rule.when.externalSource) {
    return false
  }
  if (rule.when.externalEvent !== undefined && event.payload['event'] !== rule.when.externalEvent) {
    return false
  }
  return true
}
