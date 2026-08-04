/**
 * 工作流引擎的类型定义（PRD 08）。
 *
 * 这一层是纯的：不碰数据库、不发 HTTP。求值需要的数据（资源快照、关系计数）
 * 由调用方装配后传进来。这样状态机可以被单独测试，也可以在将来
 * 由数据库中的配置驱动而不是写死在代码里（FR-WF-001 要求改定义即时生效）。
 */

/** 守卫表达式。刻意做成数据而非函数——配置化的前提是它可被序列化。 */
export type Guard =
  | { kind: 'attributeSet'; path: string }
  | { kind: 'attributeEquals'; path: string; value: string | number | boolean }
  | { kind: 'attributeIn'; path: string; values: readonly (string | number)[] }
  | { kind: 'hasRelation'; type: string; direction: 'out' | 'in' }
  | { kind: 'ownerAssigned' }
  | { kind: 'all'; of: readonly Guard[] }
  | { kind: 'any'; of: readonly Guard[] }
  | { kind: 'not'; of: Guard }

/** 状态迁移的副作用。同样是数据，不是回调。 */
export type TransitionAction =
  | { kind: 'setAttribute'; path: string; value: string | number | boolean | null }
  | { kind: 'stampNow'; path: string }
  | { kind: 'clearAttribute'; path: string }

export type StateDef = {
  name: string
  /** 进入该状态必须满足的条件；不满足则迁移被拒并说明缺什么 */
  requires?: readonly Guard[]
  /** 进入时执行的赋值 */
  entryActions?: readonly TransitionAction[]
  /** 状态停留时限。M1 只记录，超时动作在 poller 中实现 */
  sla?: { maxDurationMs: number; onBreach: 'notify-owner' | 'escalate' }
  /**
   * 终态：这个状态算"完成"。指标据此计入分母，SLA 停止计时。
   *
   * 终态默认没有出边，唯一的例外是显式标了 `reopen` 的迁移（ADR-0012）。
   * **终态不等于封闭**——依赖"进了就不会再变"的代码会出错。
   */
  terminal?: boolean
  description?: string
}

export type TransitionDef = {
  from: readonly string[]
  to: string
  guard?: Guard
  /** 迁移所需 Capability；缺省为 `<Type>.Transition` */
  capability?: string
  actions?: readonly TransitionAction[]
  /**
   * 从终态重开（ADR-0012）。
   *
   * 这是终态唯一允许的出边，也是 FR-DASH-016 判定「被推翻」的依据。
   * 做成显式标记而不是"从终态出发就算重开"，是为了让它在状态机定义里
   * 一眼可见——重开是一件该被看见的事。
   */
  reopen?: boolean
  description?: string
}

export type Lifecycle = {
  id: string
  entityType: string
  initial: string
  states: readonly StateDef[]
  transitions: readonly TransitionDef[]
}

/** 守卫求值所需的上下文。由调用方装配，保持本层纯净。 */
export type GuardContext = {
  attributes: Record<string, unknown>
  owner: string | null
  /** 出边的关系类型集合 */
  outgoingRelationTypes: ReadonlySet<string>
  /** 入边的关系类型集合 */
  incomingRelationTypes: ReadonlySet<string>
}

/** 守卫求值结果。失败时必须说清楚缺什么——FR-WF-003 要求可读原因。 */
export type GuardResult = { ok: true } | { ok: false; reason: string }
