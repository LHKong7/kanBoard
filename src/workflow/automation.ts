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
}

/**
 * 自动化动作。
 *
 * 刻意只有三种，且都很窄。自动化引擎的能力越强，
 * 它就越接近"一门没有类型检查、没有测试、没有调试器的编程语言"。
 */
export type AutomationAction =
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
