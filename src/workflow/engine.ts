import { TransitionError, ValidationError } from '../platform/errors.ts'
import { describe, evaluateGuard } from './guards.ts'
import { isClosedGroup, STATE_GROUPS } from './types.ts'
import type {
  GuardContext,
  Lifecycle,
  StateDef,
  StateGroup,
  TransitionAction,
  TransitionDef,
} from './types.ts'

/**
 * 工作流引擎。
 *
 * 职责边界：**只回答"这个迁移合不合法、需要什么权限、会产生什么副作用"**。
 * 实际的持久化、授权、事件发布都在领域服务里。
 * 这样引擎可以被纯粹地单元测试，也能在 UI 上被用来渲染"当前能做什么"。
 */
export class WorkflowRegistry {
  readonly #byId = new Map<string, Lifecycle>()
  readonly #byEntityType = new Map<string, Lifecycle>()

  register(lifecycle: Lifecycle): void {
    if (this.#byId.has(lifecycle.id)) {
      throw new Error(`lifecycle already registered: ${lifecycle.id}`)
    }
    validateLifecycle(lifecycle)
    this.#byId.set(lifecycle.id, lifecycle)
    this.#byEntityType.set(lifecycle.entityType, lifecycle)
  }

  byId(id: string): Lifecycle | null {
    return this.#byId.get(id) ?? null
  }

  forEntityType(entityType: string): Lifecycle | null {
    return this.#byEntityType.get(entityType) ?? null
  }

  all(): Lifecycle[] {
    return [...this.#byId.values()]
  }
}

export type ResolvedTransition = {
  to: string
  capability: string
  actions: readonly TransitionAction[]
  targetState: StateDef
}

export type AvailableTransition = {
  to: string
  capability: string
  /** 守卫是否已满足。不满足也返回——UI 需要展示"为什么还不能推进" */
  ready: boolean
  blockedBy: string | null
  requires: string | null
  /**
   * 这是一条从终态出发的重开边（ADR-0012）。
   *
   * 单独标出来给 UI 用：把"重开一个已完成的任务"渲染成一个
   * 和别的迁移长得一样的按钮，等于把 ADR-0012 想让人看见的那件事
   * 又藏了回去。
   */
  reopen: boolean
}

/**
 * 解析一次迁移请求。
 *
 * 三种失败各自区分开，因为使用者要采取的行动完全不同：
 *   - 目标状态不存在        → 拼写错了
 *   - 从当前状态到不了目标   → 流程理解错了，应看可用迁移列表
 *   - 守卫不满足            → 流程对，但前置条件没做完
 */
export function resolveTransition(
  lifecycle: Lifecycle,
  entityType: string,
  currentStatus: string,
  targetStatus: string,
  ctx: GuardContext,
): ResolvedTransition {
  const targetState = lifecycle.states.find((s) => s.name === targetStatus)
  if (targetState === undefined) {
    throw new TransitionError(
      `"${targetStatus}" is not a state of lifecycle "${lifecycle.id}"`,
      { states: lifecycle.states.map((s) => s.name) },
    )
  }

  const candidates = lifecycle.transitions.filter(
    (t) => t.from.includes(currentStatus) && t.to === targetStatus,
  )
  if (candidates.length === 0) {
    const reachable = lifecycle.transitions
      .filter((t) => t.from.includes(currentStatus))
      .map((t) => t.to)
    throw new TransitionError(
      `cannot move ${entityType} from "${currentStatus}" to "${targetStatus}"`,
      { from: currentStatus, allowed: [...new Set(reachable)] },
    )
  }

  // 同一对 (from, to) 可以有多条定义（不同守卫代表不同路径）。
  // 取第一条守卫满足的；全都不满足时报最后一条的原因。
  let lastFailure: string | null = null
  for (const transition of candidates) {
    const failure = checkTransition(transition, targetState, ctx)
    if (failure === null) {
      return {
        to: targetStatus,
        capability: transition.capability ?? `${entityType}.Transition`,
        actions: [...(transition.actions ?? []), ...(targetState.entryActions ?? [])],
        targetState,
      }
    }
    lastFailure = failure
  }

  throw new TransitionError(
    `${entityType} cannot enter "${targetStatus}": ${lastFailure ?? 'guard not satisfied'}`,
    { from: currentStatus, to: targetStatus, reason: lastFailure },
  )
}

/** 返回 null 表示通过，否则是失败原因 */
function checkTransition(
  transition: TransitionDef,
  targetState: StateDef,
  ctx: GuardContext,
): string | null {
  if (transition.guard !== undefined) {
    const result = evaluateGuard(transition.guard, ctx)
    if (!result.ok) return result.reason
  }
  for (const requirement of targetState.requires ?? []) {
    const result = evaluateGuard(requirement, ctx)
    if (!result.ok) return result.reason
  }
  return null
}

/**
 * 列出从当前状态出发的所有迁移，含未就绪的。
 *
 * 只返回就绪的会让 UI 变成猜谜游戏：用户看不到"下一步是什么、还差什么"。
 * 权限过滤在服务层做（FR-RES-008），这里只管流程本身。
 */
export function availableTransitions(
  lifecycle: Lifecycle,
  entityType: string,
  currentStatus: string,
  ctx: GuardContext,
): AvailableTransition[] {
  const out: AvailableTransition[] = []

  for (const transition of lifecycle.transitions) {
    if (!transition.from.includes(currentStatus)) continue
    const targetState = lifecycle.states.find((s) => s.name === transition.to)
    if (targetState === undefined) continue

    const failure = checkTransition(transition, targetState, ctx)
    const requirements = [
      ...(transition.guard === undefined ? [] : [describe(transition.guard)]),
      ...(targetState.requires ?? []).map(describe),
    ]

    out.push({
      to: transition.to,
      capability: transition.capability ?? `${entityType}.Transition`,
      ready: failure === null,
      blockedBy: failure,
      requires: requirements.length > 0 ? requirements.join(' and ') : null,
      reopen: transition.reopen === true,
    })
  }

  // 同一目标可能有多条路径，合并为一条：只要有一条就绪就算就绪
  const merged = new Map<string, AvailableTransition>()
  for (const item of out) {
    const existing = merged.get(item.to)
    if (existing === undefined || (!existing.ready && item.ready)) {
      merged.set(item.to, item)
    }
  }
  return [...merged.values()]
}

/** 应用迁移副作用，返回新的 attributes（不改原对象） */
export function applyActions(
  attributes: Record<string, unknown>,
  actions: readonly TransitionAction[],
  now: Date,
): Record<string, unknown> {
  const next = { ...attributes }
  for (const action of actions) {
    switch (action.kind) {
      case 'setAttribute':
        next[action.path] = action.value
        break
      case 'stampNow':
        next[action.path] = now.toISOString()
        break
      case 'clearAttribute':
        delete next[action.path]
        break
      default: {
        const exhaustive: never = action
        throw new Error(`unhandled action kind: ${JSON.stringify(exhaustive)}`)
      }
    }
  }
  return next
}

/**
 * 一个状态属于哪个组。
 *
 * 状态不存在时返回 null 而不是抛错：调用方多半是指标或 UI，
 * 它们手上的状态名可能来自一条**改过状态机之后**的旧数据。
 * 为一条历史遗留的状态名让整张报表打不开，不划算。
 */
export function groupOf(lifecycle: Lifecycle, status: string): StateGroup | null {
  return lifecycle.states.find((s) => s.name === status)?.group ?? null
}

/** 某个组下的全部状态名。看板分列、按组筛选都用它 */
export function statesInGroup(lifecycle: Lifecycle, group: StateGroup): string[] {
  return lifecycle.states.filter((s) => s.group === group).map((s) => s.name)
}

function validateLifecycle(lifecycle: Lifecycle): void {
  const names = new Set(lifecycle.states.map((s) => s.name))
  if (names.size !== lifecycle.states.length) {
    throw new Error(`lifecycle "${lifecycle.id}" declares duplicate states`)
  }
  if (!names.has(lifecycle.initial)) {
    throw new Error(`lifecycle "${lifecycle.id}" initial state "${lifecycle.initial}" is not declared`)
  }

  for (const state of lifecycle.states) {
    if (!STATE_GROUPS.includes(state.group)) {
      throw new Error(
        `lifecycle "${lifecycle.id}": state "${state.name}" has no valid group (got ${JSON.stringify(state.group)}); one of ${STATE_GROUPS.join(' / ')} is required`,
      )
    }
    // 终态必须落在 Completed 或 Cancelled。
    //
    // 这条是分组机制唯一能机械检查出来的错误，也正是危害最大的那个：
    // 一个终态被归进 Started 组，燃尽图就永远烧不到零，
    // 而图本身看不出任何异常——它只是显示"还有 7 件事没做完"。
    // 反过来（非终态归进 Completed）在 Decision.Accepted 这类
    // "做完了但还可能被取代"的建模里是合法的，所以只单向检查
    if (state.terminal === true && !isClosedGroup(state.group)) {
      throw new Error(
        `lifecycle "${lifecycle.id}": state "${state.name}" is terminal but grouped as "${state.group}"; terminal states must be grouped Completed or Cancelled or every burn-down built on this lifecycle will never reach zero`,
      )
    }
  }

  const initialState = lifecycle.states.find((s) => s.name === lifecycle.initial)
  if (initialState !== undefined && isClosedGroup(initialState.group)) {
    // 一出生就"已完成"的对象会让完成率永远好看
    throw new Error(
      `lifecycle "${lifecycle.id}": initial state "${lifecycle.initial}" is grouped "${initialState.group}"; objects cannot begin life closed`,
    )
  }
  for (const transition of lifecycle.transitions) {
    for (const from of transition.from) {
      if (!names.has(from)) {
        throw new Error(`lifecycle "${lifecycle.id}" has a transition from unknown state "${from}"`)
      }
    }
    if (!names.has(transition.to)) {
      throw new Error(`lifecycle "${lifecycle.id}" has a transition to unknown state "${transition.to}"`)
    }
    // 终态的出边必须是显式的重开（ADR-0012）。
    //
    // 原规则是"终态一律不许有出边"，理由是把 Done 悄悄连回去的状态机
    // 说明 Done 根本不是终态。那个理由仍然成立，所以不标 reopen 照样报错；
    // 放开的只是**标了名字的那一条**——因为 FR-DASH-016 要求
    // 系统能表达"采纳后被推翻"，而在此之前它根本无法表达
    const target = lifecycle.states.find((s) => s.name === transition.to)
    for (const from of transition.from) {
      const source = lifecycle.states.find((s) => s.name === from)
      if (source?.terminal === true && transition.reopen !== true) {
        throw new Error(
          `lifecycle "${lifecycle.id}": state "${from}" is marked terminal but has an outgoing transition to "${target?.name}"; mark it reopen: true if this is a deliberate reopen (ADR-0012)`,
        )
      }
      if (transition.reopen === true && source?.terminal !== true) {
        // 不从终态出发的"重开"是个假标记。放任它，
        // FR-DASH-016 的 Rework Rate 就会开始统计一些不是返工的东西
        throw new Error(
          `lifecycle "${lifecycle.id}": transition "${from}" → "${target?.name}" is marked reopen but "${from}" is not terminal`,
        )
      }
    }
    if (transition.reopen === true && target?.terminal === true) {
      // 终态之间横跳不是重开，是分类错误
      throw new Error(
        `lifecycle "${lifecycle.id}": reopen transition must land on a non-terminal state, but "${target.name}" is terminal`,
      )
    }
  }
}

/** 校验实体的初始状态是否合法（创建时用） */
export function assertValidInitialStatus(lifecycle: Lifecycle, status: string): void {
  if (!lifecycle.states.some((s) => s.name === status)) {
    throw new ValidationError(
      `"${status}" is not a valid initial status for lifecycle "${lifecycle.id}"`,
      { allowed: lifecycle.states.map((s) => s.name), initial: lifecycle.initial },
    )
  }
}
