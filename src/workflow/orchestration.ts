/**
 * 多步骤编排与失败补偿（FR-WF-010 / FR-WF-011）。
 *
 *   FR-WF-010  并行 / 分支 / 循环 / 人工节点 / 超时 —— 验收：Release 流程端到端跑通
 *   FR-WF-011  失败补偿 —— 验收：灰度失败自动回滚状态
 *
 * 这两条必须一起做。一个能并行、能循环、能等人的编排器，**在失败时
 * 制造的烂摊子比它省下的手工操作大得多**：三步里第二步炸了，
 * 第一步的副作用还在，而没有人知道系统现在处于哪个状态。
 * 补偿不是锦上添花，它是"允许自动化多步操作"的前提。
 *
 * 和自动化规则同一个 doctrine：**步骤是封闭联合，没有表达式语言。**
 * 分支条件只能引用流程自己产出的值，循环必须有上界，人工节点必须有超时。
 * 每放宽一条，这个编排器就更接近"一门没有类型检查、没有调试器的语言"。
 *
 * 执行是**纯函数**：`advance` 拿到当前状态和一批已完成的结果，
 * 算出下一步该做什么。真正的副作用由调用方执行。
 * 这样"编排逻辑对不对"可以逐条测，而不必先起一个流程引擎。
 */

/** 一步要做的事。刻意很窄——想做表达不了的事，写代码 */
export type StepAction =
  /** 迁移一个对象的状态 */
  | { kind: 'transition'; resourceRef: string; to: string }
  /** 调一个外部连接器（走网关，因此照样有授权/审计/限流） */
  | { kind: 'call'; connectorId: string; operation: string; target: string }
  /** 什么也不做，只是个汇合点 */
  | { kind: 'noop' }

export type Step =
  | { id: string; kind: 'action'; action: StepAction; compensate?: StepAction; timeoutMs?: number }
  /** 并行：全部子步骤都完成才继续 */
  | { id: string; kind: 'parallel'; branches: readonly Step[] }
  /** 分支：按前面某一步的产出选一条路 */
  | {
      id: string
      kind: 'branch'
      /** 看哪一步的结果 */
      on: string
      /** 结果等于 key 就走对应的那条。没有匹配走 `otherwise` */
      cases: Readonly<Record<string, readonly Step[]>>
      otherwise?: readonly Step[]
    }
  /**
   * 循环：重复直到某一步产出 `untilAnyOf` 里的任意一个，或到达 `maxIterations`。
   *
   * 出口是**一组**值而不是一个，是被现实逼出来的：灰度观察有三种结论——
   * 健康（走全量）、还在观察（再来一轮）、明确不健康（停下来中止）。
   * 只认一个出口值的话，"明确不健康"和"还在观察"就没法区分，
   * 于是流程只能一直重试到上界——而**上界到了走的是补偿，不是中止分支**。
   * 第一版就是这么写的，结果是那条中止分支永远执行不到（变异测试逮到的）。
   */
  | { id: string; kind: 'loop'; body: readonly Step[]; on: string; untilAnyOf: readonly string[]; maxIterations: number }
  /** 人工节点：停下来等人。**必须有超时** */
  | { id: string; kind: 'human'; prompt: string; timeoutMs: number; onTimeout: 'fail' | 'proceed' }

export type Process = {
  id: string
  steps: readonly Step[]
}

/** 一步跑完之后的结果 */
export type StepOutcome = {
  stepId: string
  status: 'ok' | 'failed' | 'timeout'
  /** 分支与循环读它 */
  value?: string
  error?: string
}

export type RunState = {
  processId: string
  /** 已经完成的步骤，按发生顺序 */
  completed: readonly StepOutcome[]
  /** 已经执行过、可以被补偿的动作，**按执行顺序** */
  performed: readonly { stepId: string; compensate: StepAction }[]
  startedAt: Date
}

export type Instruction =
  /** 去做这些（同一批里的可以并行） */
  | { kind: 'do'; steps: readonly { stepId: string; action: StepAction; timeoutMs?: number }[] }
  /** 停下来等人 */
  | { kind: 'await-human'; stepId: string; prompt: string; deadline: Date }
  /** 全部做完 */
  | { kind: 'done' }
  /**
   * 失败了，按**逆序**执行这些补偿。
   *
   * 逆序是关键：正序会先撤销那些后面几步还依赖着的东西。
   * 「先建 Release、再把 Task 挂上去」，撤的时候必须先摘 Task 再撤 Release。
   */
  | { kind: 'compensate'; reason: string; actions: readonly { stepId: string; action: StepAction }[] }

/**
 * 算出下一步。
 *
 * 纯函数、可重入：同样的状态永远给同样的指令，所以一个中断掉的流程
 * 重新加载状态就能接着跑——**不需要把"跑到哪儿了"记在内存里**。
 */
export function advance(process: Process, state: RunState, now: Date): Instruction {
  const failed = state.completed.find((c) => c.status === 'failed' || c.status === 'timeout')
  if (failed !== undefined) {
    return {
      kind: 'compensate',
      reason: `step "${failed.stepId}" ${failed.status}${failed.error === undefined ? '' : `: ${failed.error}`}`,
      // 逆序
      actions: [...state.performed].reverse().map((p) => ({ stepId: p.stepId, action: p.compensate })),
    }
  }

  const done = new Set(state.completed.map((c) => c.stepId))
  const outcome = new Map(state.completed.map((c) => [c.stepId, c]))
  const next = nextIn(process.steps, done, outcome, now, state)
  return next ?? { kind: 'done' }
}

function nextIn(
  steps: readonly Step[],
  done: ReadonlySet<string>,
  outcome: ReadonlyMap<string, StepOutcome>,
  now: Date,
  state: RunState,
): Instruction | null {
  for (const step of steps) {
    switch (step.kind) {
      case 'action': {
        if (done.has(step.id)) continue
        return {
          kind: 'do',
          steps: [
            {
              stepId: step.id,
              action: step.action,
              ...(step.timeoutMs === undefined ? {} : { timeoutMs: step.timeoutMs }),
            },
          ],
        }
      }

      case 'parallel': {
        const pending = flatten(step.branches).filter((s) => !done.has(s.id))
        if (pending.length === 0) continue
        // 只把**这一批里立刻能做的**交出去。分支内部还有顺序，
        // 一次性全部抛出来的话，一个分支的第二步会在第一步之前被执行
        const ready = step.branches
          .map((b) => nextIn([b], done, outcome, now, state))
          .filter((i): i is Instruction => i !== null)
        const actions = ready.flatMap((i) => (i.kind === 'do' ? i.steps : []))
        // 并行里出现人工节点时，先把人等出来——它挡着这一批
        const human = ready.find((i) => i.kind === 'await-human')
        if (human !== undefined) return human
        if (actions.length > 0) return { kind: 'do', steps: actions }
        continue
      }

      case 'branch': {
        // 分支引用的是**逻辑**步骤 id，而循环体里的步骤带了轮次后缀。
        // 只按原名去查的话，一个读循环结果的分支永远查不到——
        // 而 Release 流程正是这么写的（灰度的结论决定全量还是回滚）。
        // 取**最后一轮**的结果：分支要问的是"最后一次观察怎么说"
        const decided = outcome.get(step.on) ?? lastRoundOf(step.on, state)
        if (decided === undefined) {
          // 依赖的那一步还没跑。**这不是错误**，是顺序问题——
          // 它排在前面，上面的循环会先把它做掉
          continue
        }
        const chosen = step.cases[decided.value ?? ''] ?? step.otherwise ?? []
        const inner = nextIn(chosen, done, outcome, now, state)
        if (inner !== null) return inner
        continue
      }

      case 'loop': {
        // 轮次标记的 id 形如 `<子步骤>#<循环>#<轮次>`。
        // 按 `<循环>#` 前缀去数是数不到的——第一版就是这么写的，
        // 结果是循环永远停在第一轮，而用例把它抓了出来
        const suffix = `#${step.id}#`
        const bodyIds = flatten(step.body).map((s) => s.id)
        const roundOf = (id: string): number | null => {
          const at = id.lastIndexOf(suffix)
          if (at < 0) return null
          const n = Number(id.slice(at + suffix.length))
          return Number.isNaN(n) ? null : n
        }
        // 一轮"跑完"是**这一轮的每个子步骤都完成了**，不是完成的条数够了：
        // 按条数算的话，一个分支型循环体（这一轮少跑了一步）会把轮次算错
        const completedRounds = new Set<number>()
        for (let r = 0; ; r++) {
          const all = bodyIds.every((b) => done.has(`${b}${suffix}${r}`))
          if (!all) break
          completedRounds.add(r)
        }
        const rounds = completedRounds.size

        const last = [...state.completed]
          .filter((c) => c.stepId.startsWith(`${step.on}${suffix}`))
          .sort((a, b) => (roundOf(a.stepId) ?? 0) - (roundOf(b.stepId) ?? 0))
          .at(-1)
        if (last?.value !== undefined && step.untilAnyOf.includes(last.value)) continue
        if (rounds >= step.maxIterations) {
          // **上界到了就是失败，不是悄悄退出。** 悄悄退出的话，
          // 一个永远等不到条件的循环会表现为"流程跑完了"
          return {
            kind: 'compensate',
            reason: `loop "${step.id}" hit maxIterations=${step.maxIterations} without reaching any of ${JSON.stringify(step.untilAnyOf)}`,
            actions: [...state.performed].reverse().map((p) => ({ stepId: p.stepId, action: p.compensate })),
          }
        }
        // 每一轮的步骤 id 带上轮次，否则第二轮会被当成"已经做过了"
        const round = rounds
        const inner = nextIn(
          step.body.map((s) => withRound(s, step.id, round)),
          done,
          outcome,
          now,
          state,
        )
        if (inner !== null) return inner
        continue
      }

      case 'human': {
        if (done.has(step.id)) continue
        const deadline = new Date(state.startedAt.getTime() + step.timeoutMs)
        if (now.getTime() > deadline.getTime()) {
          if (step.onTimeout === 'proceed') continue
          return {
            kind: 'compensate',
            reason: `human step "${step.id}" timed out`,
            actions: [...state.performed].reverse().map((p) => ({ stepId: p.stepId, action: p.compensate })),
          }
        }
        return { kind: 'await-human', stepId: step.id, prompt: step.prompt, deadline }
      }
    }
  }
  return null
}

/**
 * 某个逻辑步骤最后一轮的结果。
 *
 * 循环体里的步骤 id 带着 `#<循环>#<轮次>` 后缀，而引用它的分支写的是原名。
 * 按轮次取最大的那个——分支要问的是"**最后一次**观察怎么说"，
 * 取第一轮的话，一个后来恢复健康的灰度会被按最初那次失败处理。
 */
function lastRoundOf(logicalId: string, state: RunState): StepOutcome | undefined {
  return [...state.completed]
    .filter((c) => c.stepId.startsWith(`${logicalId}#`))
    .sort((a, b) => roundSuffix(a.stepId) - roundSuffix(b.stepId))
    .at(-1)
}

function roundSuffix(id: string): number {
  const n = Number(id.slice(id.lastIndexOf('#') + 1))
  return Number.isNaN(n) ? -1 : n
}

/** 给循环体里的步骤打上轮次后缀 */
function withRound(step: Step, loopId: string, round: number): Step {
  const id = `${step.id}#${loopId}#${round}`
  if (step.kind === 'action') return { ...step, id }
  if (step.kind === 'human') return { ...step, id }
  if (step.kind === 'parallel') {
    return { ...step, id, branches: step.branches.map((b) => withRound(b, loopId, round)) }
  }
  if (step.kind === 'loop') {
    return { ...step, id, body: step.body.map((b) => withRound(b, loopId, round)) }
  }
  return {
    ...step,
    id,
    cases: Object.fromEntries(
      Object.entries(step.cases).map(([k, v]) => [k, v.map((s) => withRound(s, loopId, round))]),
    ),
    ...(step.otherwise === undefined ? {} : { otherwise: step.otherwise.map((s) => withRound(s, loopId, round)) }),
  }
}

/** 展平出所有叶子步骤 */
export function flatten(steps: readonly Step[]): Step[] {
  const out: Step[] = []
  for (const step of steps) {
    if (step.kind === 'parallel') out.push(...flatten(step.branches))
    else if (step.kind === 'loop') out.push(...flatten(step.body))
    else if (step.kind === 'branch') {
      out.push(...flatten(Object.values(step.cases).flat()))
      out.push(...flatten(step.otherwise ?? []))
    } else out.push(step)
  }
  return out
}

/**
 * 校验一份流程定义——**在保存时**。
 *
 * 一个跑到一半才发现"这个分支引用了一个不存在的步骤"的编排器，
 * 会把系统留在中间状态，而那正是补偿要处理的最难的情况。
 * 能在保存时挡掉的，绝不留到运行时。
 */
export function validateProcess(process: Process): string[] {
  const problems: string[] = []
  const ids = new Set<string>()
  for (const step of flatten(process.steps)) {
    if (ids.has(step.id)) problems.push(`duplicate step id "${step.id}"`)
    ids.add(step.id)
  }

  const check = (steps: readonly Step[]): void => {
    for (const step of steps) {
      if (step.kind === 'branch') {
        if (!ids.has(step.on)) problems.push(`branch "${step.id}" reads unknown step "${step.on}"`)
        if (Object.keys(step.cases).length === 0 && step.otherwise === undefined) {
          problems.push(`branch "${step.id}" has no cases at all`)
        }
        for (const branch of Object.values(step.cases)) check(branch)
        check(step.otherwise ?? [])
      }
      if (step.kind === 'loop') {
        if (step.maxIterations < 1) problems.push(`loop "${step.id}" must allow at least one iteration`)
        if (step.untilAnyOf.length === 0) problems.push(`loop "${step.id}" has no exit value at all`)
        if (!ids.has(step.on)) problems.push(`loop "${step.id}" reads unknown step "${step.on}"`)
        if (step.body.length === 0) problems.push(`loop "${step.id}" has an empty body`)
        check(step.body)
      }
      if (step.kind === 'human' && step.timeoutMs <= 0) {
        // 无限等的人工节点会让流程实例永远挂着，而没有人会去清理它们
        problems.push(`human step "${step.id}" must have a timeout`)
      }
      if (step.kind === 'parallel') {
        if (step.branches.length < 2) problems.push(`parallel "${step.id}" needs at least two branches`)
        check(step.branches)
      }
    }
  }
  check(process.steps)
  return problems
}
