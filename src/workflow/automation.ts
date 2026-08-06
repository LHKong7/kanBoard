import type { BoundedContext } from '../ontology/types.ts'
import type { DomainEventType } from '../domain/events.ts'

/**
 * 自动化规则的**定义**（PRD 08 §3）。纯数据，无副作用。
 * 执行在 `src/domain/automation/runner.ts`。
 *
 * ⚠️ 这个文件是分层的一个例外：它 import 了 domain 的事件类型。
 * 见文件末尾的说明。
 */

export type AutomationTrigger = {
  event: DomainEventType
  /** 只对该类型的资源触发 */
  resourceType?: string
  /** 状态变更事件专用：只在迁移到该状态时触发 */
  toStatus?: string
  fromStatus?: string
  /** 外部事件专用（FR-WF-006）：来源系统，如 'github' */
  externalSource?: string
  /** 外部事件专用：事件名，如 'pull_request.closed' */
  externalEvent?: string
}

/**
 * 自动化动作（FR-WF-005 要求 8 类全部可用）。
 *
 * 每一种都刻意很窄，而且是**封闭联合**——没有表达式、没有脚本、
 * 没有"任意字段赋值"。自动化引擎的能力越强，它就越接近
 * "一门没有类型检查、没有测试、没有调试器的编程语言"。
 *
 * 所以这里增加的是**动作的种类**，不是每种动作的自由度：
 * 想做规则表达不了的事，写代码，不要把规则语言撑大。
 */
export type AutomationAction =
  /** 直接迁移触发事件的那个对象 */
  | { kind: 'transition'; to: string; onlyIfCurrentIn?: readonly string[] }
  /** 把对象指派给某个主体（user:// 或 agent://） */
  | { kind: 'assign'; to: string }
  /**
   * 创建一个领域对象。
   *
   * `attributes` 是**字面量**：没有插值、没有引用求值。
   * 一旦允许 `'RCA for ' + issue.key`，就等于在规则里嵌了一门表达式语言，
   * 而它会立刻长出运算符优先级、空值语义和一个没人写得出的错误信息。
   * 需要引用事件里的值的，用 `titleFrom` 这类**具名**字段。
   */
  | {
      kind: 'createEntity'
      resourceType: string
      attributes: Record<string, string | number | boolean>
      /** 用触发对象的这个属性当标题；缺省则用 attributes.title */
      titleFromSubject?: string
      /** 与触发对象建立这条关系 */
      relateBack?: string
    }
  /**
   * 触发一次 Agent 执行（FR-WF-007）。
   *
   * 实现就是创建一个 `AgentRun`——这不是取巧：
   * AgentRunner 本来就靠"有没有 Queued 的 AgentRun"驱动，
   * 于是自动化发起的 Run 与人发起的 Run 走完全同一条路径，
   * 包括权限、预算、留痕。**另开一条专用通道才是取巧。**
   */
  | {
      kind: 'invokeAgent'
      /** Agent 资源的 id */
      agentId: string
      goal: string
      mode: 'Suggest' | 'Draft' | 'ExecuteWithReview' | 'Autonomous'
    }
  /**
   * 把周期当前的进度**冻**进 `progressSnapshot`。
   *
   * 只有一个参数都没有，因为它没有可配的地方：冻的就是"此刻的进度"。
   *
   * 为什么必须是一个动作而不是读的时候现算：周期关掉之后，
   * 里面的工作项还会继续被改——被挪走、被重开、被取消。
   * 现算出来的"上个迭代完成率"会随着这些改动一直变，
   * 于是回顾会上拿出来的数字和一周后再看时对不上，
   * 而没有人说得清哪一个是对的。
   */
  | { kind: 'snapshotCycleProgress' }
  /** 发一条站内通知。IM / 邮件属于 Connector 层 */
  | {
      kind: 'notify'
      /**
       * 收件人。两个**具名**取值，其余按字面主体处理：
       *
       * - `owner`：触发对象的 owner
       * - `mentions`：触发对象正文里 @ 到的每一个主体（**一条规则发多封**）
       *
       * 具名而不是写成 `${subject.mentions}` 之类的插值，理由见本文件顶部：
       * 一旦允许表达式，就得连带长出空值语义和一个没人写得出的错误信息。
       */
      recipient: string
      title: string
      severity?: 'info' | 'warning' | 'critical'
    }
  /** 沿关系找到相关对象，尝试把它迁移到某状态 */
  | {
      kind: 'transitionRelated'
      relation: string
      direction: 'out' | 'in'
      targetType: string
      to: string
      /** 仅当所有同级对象都处于这些状态时才执行 */
      requireAllSiblings?: readonly string[]
      /** 目标当前状态不在此列则跳过（避免把已完成的对象拉回去） */
      onlyIfCurrentIn?: readonly string[]
    }
  /** 在两个对象之间建立关系 */
  | { kind: 'relate'; relation: string; toRelation: string; direction: 'out' | 'in' }
  /** 记录一条日志。M1 的 notify 占位，真正的通知在 M2 接 Connector */
  | { kind: 'log'; message: string }

export type AutomationRule = {
  id: string
  /**
   * 拥有这条规则的限界上下文。
   *
   * 这不是装饰性字段。原则 P2.1 禁止一个对象跨上下文维护状态：
   * "Task 完成后推进 Story" 这条规则属于 **Requirement BC**（它拥有 Story），
   * 而不是 Execution BC（它只是发出了事件）。
   *
   * ADR-0008 要求 M1 按 BC 重组模块时，规则要跟着搬到它的归属上下文里。
   * 现在先把归属记下来，免得到时候无从判断。
   */
  owningContext: BoundedContext
  when: AutomationTrigger
  then: readonly AutomationAction[]
  description?: string
  enabled?: boolean
}

/**
 * 内置规则。
 *
 * 只有两条，都是我们自己每天会用到的（ADR-0011 先内部自用）。
 * 规则集应当长得很慢：每条自动化都是一次"系统替我做了决定"，
 * 多到看不懂时，用户就不再信任系统的任何自动行为了。
 */
export const DEFAULT_AUTOMATION_RULES: readonly AutomationRule[] = [
  {
    id: 'freeze-cycle-progress-on-close',
    owningContext: 'Execution',
    description: '周期关闭时把进度冻进 progressSnapshot，供回顾使用',
    // 绑的是内置状态机里那个终态的名字。改过状态机的租户要自己把这条改掉——
    // 让它去猜"哪个状态算关闭"的话，猜错时表现是快照没生成，
    // 而那要到几周后有人翻回顾数据时才会被发现
    when: { event: 'ResourceStatusChanged', resourceType: 'Sprint', toStatus: 'Closed' },
    then: [{ kind: 'snapshotCycleProgress' }],
  },
  {
    id: 'notify-mentioned-on-comment',
    owningContext: 'Execution',
    description: '有人在评论里被 @ 到时，给他发一条站内通知',
    when: { event: 'ResourceCreated', resourceType: 'Comment' },
    then: [
      {
        kind: 'notify',
        recipient: 'mentions',
        title: '有人在评论里提到了你',
      },
    ],
  },
  {
    id: 'story-starts-when-first-task-starts',
    owningContext: 'Requirement',
    description: '第一个子任务进入 Doing 时，把 Story 推进到 InProgress',
    when: { event: 'ResourceStatusChanged', resourceType: 'Task', toStatus: 'Doing' },
    then: [
      {
        kind: 'transitionRelated',
        relation: 'partOf',
        direction: 'out',
        targetType: 'Story',
        to: 'InProgress',
        // 已经在进行或已完成的 Story 不该被重复推进
        onlyIfCurrentIn: ['Ready'],
      },
    ],
  },
  {
    id: 'story-done-when-all-tasks-done',
    owningContext: 'Requirement',
    description: '所有子任务完成后，把 Story 推进到 Done',
    when: { event: 'ResourceStatusChanged', resourceType: 'Task', toStatus: 'Done' },
    then: [
      {
        kind: 'transitionRelated',
        relation: 'partOf',
        direction: 'out',
        targetType: 'Story',
        to: 'Done',
        // 只有全部子任务都到终态才推进。少了这条，第一个任务完成就会把 Story 标记完成
        requireAllSiblings: ['Done', 'Cancelled'],
        onlyIfCurrentIn: ['InProgress', 'Review'],
      },
    ],
  },
]

/**
 * 分层例外说明
 * ────────────
 * `src/workflow/` 本应不依赖 `src/domain/`。这里 import 了 `DomainEventType`，
 * 是一个受控的例外：只引入**类型**，不引入运行时代码，
 * 且方向上是"规则声明它响应哪个事件"，不构成对领域逻辑的依赖。
 *
 * 更干净的做法是把事件类型下沉到 platform 层。M1 按 BC 重组时一并处理。
 * 在此之前，dependency-cruiser 中为本文件保留了一条显式豁免——
 * 豁免是显式的、有名字的、写了理由的，而不是把整条规则放松掉。
 */
