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
  /**
   * 沿某条关系走到的对象**全部**处于给定状态之一（FR-DOM-007）。
   *
   * 与 `hasRelation` 的区别是它看的是对面的状态，不只是边的存在。
   * "Release 只能包含 Done 的 Task"这类不变量必须由状态机守住，
   * 靠流程纪律守不住——赶发版的时候纪律是第一个被放弃的东西。
   *
   * 一条边都没有时**通过**：空集合上的全称命题为真。
   * 需要"至少有一条"就再加一条 `hasRelation`——把两件事合成一个守卫，
   * 失败信息就说不清到底是哪一件不满足了。
   */
  | {
      kind: 'allRelatedIn'
      type: string
      direction: 'out' | 'in'
      states: readonly string[]
      /** 只看这个类型的对象；不传则看全部 */
      targetType?: string
    }
  | { kind: 'ownerAssigned' }
  | { kind: 'all'; of: readonly Guard[] }
  | { kind: 'any'; of: readonly Guard[] }
  | { kind: 'not'; of: Guard }

/** 状态迁移的副作用。同样是数据，不是回调。 */
export type TransitionAction =
  | { kind: 'setAttribute'; path: string; value: string | number | boolean | null }
  | { kind: 'stampNow'; path: string }
  | { kind: 'clearAttribute'; path: string }

/**
 * 状态组：状态在生命周期上的**位置**，与它叫什么名字无关。
 *
 * 六个组的存在理由是：燃尽图、进度条、完成率、"还剩多少没做"——
 * 这些统计都需要回答"这个状态算不算做完了"，而状态名回答不了这个问题。
 * 每台状态机的状态名都不一样（Task 叫 Doing，Story 叫 InProgress，
 * Release 叫 Frozen），把它们逐个枚举进指标代码里，等于让**每加一个状态
 * 就得去改一遍所有指标**——而漏掉的那一处不会报错，只会让某类对象
 * 从统计里静静消失。
 *
 * 分组是**建模决定**，所以它写在状态机定义里，不写在指标那一侧：
 * 定义状态的人知道这个状态意味着什么，读指标的人不知道。
 *
 * | 组 | 语义 |
 * | --- | --- |
 * | `Triage` | 待分诊：还没确认要不要做 |
 * | `Backlog` | 已确认要做，未排期 |
 * | `Unstarted` | 已排期，未开工 |
 * | `Started` | 进行中（含阻塞、评审、等人——**它们都还没做完**） |
 * | `Completed` | 做完了 |
 * | `Cancelled` | 不做了（含被取代、被拒、失败） |
 */
export type StateGroup = 'Triage' | 'Backlog' | 'Unstarted' | 'Started' | 'Completed' | 'Cancelled'

export const STATE_GROUPS: readonly StateGroup[] = [
  'Triage',
  'Backlog',
  'Unstarted',
  'Started',
  'Completed',
  'Cancelled',
]

/**
 * 算"已经不在流转中"的两个组。
 *
 * 燃尽图的分子、完成率的分母、WIP 的排除项都用它，
 * 因此这个判断只写一处——散成 `g === 'Completed' || g === 'Cancelled'`
 * 的话，总有一处只写了前一半，表现是取消掉的工作项永远烧不掉。
 */
export const CLOSED_STATE_GROUPS: readonly StateGroup[] = ['Completed', 'Cancelled']

export function isClosedGroup(group: StateGroup): boolean {
  return CLOSED_STATE_GROUPS.includes(group)
}

export type StateDef = {
  name: string
  /**
   * 这个状态归哪个组。**必填**。
   *
   * 做成必填而不是"不填就猜一个"，是因为猜错不会报错——
   * 它只会让燃尽图少烧掉一批工作项，而看图的人不会知道图是错的。
   * 让定义状态的人当场回答一次，比让读指标的人事后怀疑一辈子便宜。
   */
  group: StateGroup
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
  /**
   * 相关对象及其状态，键为 `${关系类型}:${方向}`。
   *
   * **只为 `allRelatedIn` 真正引用到的关系装配**——否则每次展开抽屉
   * 都要把邻居全查一遍。没有这类守卫的状态机，这里是空的。
   */
  related?: ReadonlyMap<string, readonly RelatedRef[]>
}

export type RelatedRef = { id: string; type: string; status: string }

/** 守卫求值结果。失败时必须说清楚缺什么——FR-WF-003 要求可读原因。 */
export type GuardResult = { ok: true } | { ok: false; reason: string }
