import { advance, flatten } from '../../workflow/orchestration.ts'
import type { Instruction, Process, RunState, StepAction, StepOutcome } from '../../workflow/orchestration.ts'

/**
 * 流程执行器（FR-WF-010 / FR-WF-011）。
 *
 * 验收标准：**Release 流程端到端跑通**、**灰度失败自动回滚状态**。
 *
 * `advance()` 是纯的：给它状态，它说下一步做什么。这一层负责把那个"做"
 * 真的做掉，并且**每做一步就把状态存回去**。
 *
 * 为什么每一步都存，而不是跑完再存：一个流程实例会跨天（人工节点等 24 小时、
 * 灰度观察好几轮）。进程重启、部署、崩溃都会发生在中间。
 * 状态只活在内存里的话，一次重启会让一个已经冻结了 Release、
 * 已经调过部署接口的流程**从记录上彻底消失**——而外面的世界已经变了。
 *
 * 与 `advance` 的分工是刻意的：
 *
 *   advance   决定做什么（纯函数、可重入、逐条可测）
 *   executor  把它做掉、把结果记下来（有副作用、要处理失败）
 *
 * 合成一个的话，"这个流程的下一步该是什么"就只能通过跑一遍副作用来验证。
 */

/** 流程实例。`refs` 把流程里的符号名映射到真实对象 */
export type ProcessRun = {
  id: string
  tenant: string
  processId: string
  /** `release` → `rel_01J…`。流程定义里写的是符号名，实例才知道是哪个对象 */
  refs: Readonly<Record<string, string>>
  state: RunState
  status: RunStatus
  /** 正在等谁点头。null = 没在等人 */
  awaiting: { stepId: string; prompt: string; deadline: Date } | null
}

export type RunStatus =
  | 'running'
  /** 停在人工节点上。**这不是"卡住了"，是流程的正常一环** */
  | 'awaiting-human'
  | 'completed'
  /** 补偿跑完了。和 completed 分开：外面的世界被撤销过，这件事要看得见 */
  | 'compensated'
  /**
   * 补偿**没跑完**。
   *
   * 单独一个状态，因为它是唯一一种需要人立刻去看的结局：
   * 一部分副作用已经撤销、一部分没有，系统正处在一个没人描述过的状态。
   * 把它和 compensated 混在一起，是这套东西能犯的最坏的错。
   */
  | 'compensation-failed'

/** 执行一个动作。真实现走 ResourceService 与连接器网关 */
export interface ActionRunner {
  /**
   * @param action 要做的事
   * @param refs 符号名 → 对象 id
   * @returns `value` 供分支与循环判断（如灰度观察的 healthy / degraded）
   */
  perform(
    action: StepAction,
    refs: Readonly<Record<string, string>>,
  ): Promise<{ status: 'ok' | 'failed'; value?: string; error?: string }>
}

export interface ProcessRunStore {
  save(run: ProcessRun): Promise<void>
}

export type ExecutorDeps = {
  runner: ActionRunner
  store: ProcessRunStore
  now: () => Date
  /**
   * 一次驱动最多推进多少步。
   *
   * 有上界不是为了性能：一个写错的流程（比如循环上界写成 100 万）
   * 会让一次 HTTP 请求永远不返回。到达上界时**流程还是 running**，
   * 下一次驱动接着走——所以这是个分片上界，不是失败条件。
   */
  maxSteps?: number
}

const DEFAULT_MAX_STEPS = 200

/** 剥掉循环给步骤 id 打的轮次标签，拿回定义里的那个 id */
function bareId(stepId: string): string {
  const hash = stepId.indexOf('#')
  return hash < 0 ? stepId : stepId.slice(0, hash)
}

/**
 * 把一个流程实例往前推，直到它需要人、做完了、或者用光了这次的步数。
 *
 * 返回推进后的实例。**调用方不需要循环调它**——它自己会一直走到
 * 走不动为止。
 */
export async function drive(
  process: Process,
  run: ProcessRun,
  deps: ExecutorDeps,
): Promise<ProcessRun> {
  const maxSteps = deps.maxSteps ?? DEFAULT_MAX_STEPS
  // 补偿表从流程定义现算，**不放在模块级变量里**：
  // 一个服务进程会同时驱动好几个实例，共享一张可变的表就是一次竞态，
  // 而它的表现是"某个实例撤销了另一个实例的动作"
  const compensations = new Map<string, StepAction>()
  for (const step of flatten(process.steps)) {
    if (step.kind === 'action' && step.compensate !== undefined) {
      compensations.set(step.id, step.compensate)
    }
  }

  let current = run
  let steps = 0

  while (steps < maxSteps) {
    if (current.status !== 'running') return current
    const instruction = advance(process, current.state, deps.now())

    if (instruction.kind === 'done') {
      current = { ...current, status: 'completed', awaiting: null }
      await deps.store.save(current)
      return current
    }

    if (instruction.kind === 'await-human') {
      current = {
        ...current,
        status: 'awaiting-human',
        awaiting: {
          stepId: instruction.stepId,
          prompt: instruction.prompt,
          deadline: instruction.deadline,
        },
      }
      await deps.store.save(current)
      return current
    }

    if (instruction.kind === 'compensate') {
      current = await compensate(instruction, current, deps)
      await deps.store.save(current)
      return current
    }

    current = await performBatch(instruction, current, deps, compensations)
    // 每一步都存。跨天的流程一定会撞上重启，而状态只在内存里的话，
    // 一个已经冻结了 Release 的流程会从记录上消失——外面的世界却已经变了
    await deps.store.save(current)
    steps += instruction.steps.length
  }

  return current
}

async function performBatch(
  instruction: Extract<Instruction, { kind: 'do' }>,
  run: ProcessRun,
  deps: ExecutorDeps,
  compensations: ReadonlyMap<string, StepAction>,
): Promise<ProcessRun> {
  // 同一批里的可以并行——这正是 parallel 的意义所在。串行做只是白等
  const results = await Promise.all(
    instruction.steps.map(async (step) => ({
      step,
      result: await deps.runner.perform(step.action, run.refs),
    })),
  )

  const completed: StepOutcome[] = [...run.state.completed]
  const performed = [...run.state.performed]

  for (const { step, result } of results) {
    completed.push({
      stepId: step.stepId,
      status: result.status,
      ...(result.value === undefined ? {} : { value: result.value }),
      ...(result.error === undefined ? {} : { error: result.error }),
    })
    // **只有真的成功了的动作才进补偿清单。**
    // 失败的动作没有产生副作用（或者产生了一半，而那时撤销一个
    // 没发生过的操作只会把状态搞得更乱）
    if (result.status !== 'ok') continue
    // 轮次标签：循环体里的步骤 id 形如 `<childId>#<loopId>#<round>`，
    // 补偿表按定义里的裸 id 建，所以要剥掉标签再查
    const compensate = compensations.get(bareId(step.stepId))
    if (compensate !== undefined) performed.push({ stepId: step.stepId, compensate })
  }

  return { ...run, state: { ...run.state, completed, performed } }
}

async function compensate(
  instruction: Extract<Instruction, { kind: 'compensate' }>,
  run: ProcessRun,
  deps: ExecutorDeps,
): Promise<ProcessRun> {
  // **逆序，而且串行。** 逆序是因为后面的步骤依赖前面的产物；
  // 串行是因为撤销之间同样有依赖——并行撤销会撞上同一个"先撤谁"的问题
  const failures: string[] = []
  for (const action of instruction.actions) {
    const result = await deps.runner.perform(action.action, run.refs)
    if (result.status !== 'ok') failures.push(`${action.stepId}: ${result.error ?? 'failed'}`)
  }

  return {
    ...run,
    awaiting: null,
    // 补偿没跑完是唯一一种需要人立刻去看的结局：
    // 一部分副作用撤销了、一部分没有，系统在一个没人描述过的状态里
    status: failures.length === 0 ? 'compensated' : 'compensation-failed',
    state: {
      ...run.state,
      completed: [
        ...run.state.completed,
        {
          stepId: '(compensation)',
          status: failures.length === 0 ? 'ok' : 'failed',
          value: instruction.reason,
          ...(failures.length === 0 ? {} : { error: failures.join('; ') }),
        },
      ],
    },
  }
}

/**
 * 人点了头（或者拒了）之后接着跑。
 *
 * 拒绝**不是**"什么都不做"：它要变成一个失败的步骤结果，
 * 于是 `advance` 会走到补偿。默默把实例留在 awaiting 上的话，
 * 那个已经冻结的 Release 会一直冻结着。
 */
export function resolveHuman(run: ProcessRun, approved: boolean, by: string): ProcessRun {
  if (run.awaiting === null) return run
  return {
    ...run,
    status: 'running',
    awaiting: null,
    state: {
      ...run.state,
      completed: [
        ...run.state.completed,
        {
          stepId: run.awaiting.stepId,
          status: approved ? 'ok' : 'failed',
          value: approved ? 'approved' : 'rejected',
          ...(approved ? {} : { error: `rejected by ${by}` }),
        },
      ],
    },
  }
}
