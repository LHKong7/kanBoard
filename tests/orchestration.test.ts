import { describe, expect, it } from 'vitest'
import { advance, flatten, validateProcess } from '../src/workflow/orchestration.ts'
import { RELEASE_PROCESS } from '../src/workflow/release-process.ts'
import type { Instruction, Process, RunState, StepOutcome } from '../src/workflow/orchestration.ts'

/**
 * 多步骤编排与失败补偿（FR-WF-010 / FR-WF-011）。
 *
 *   FR-WF-010 验收：**Release 流程端到端跑通**（并行/分支/循环/人工/超时）
 *   FR-WF-011 验收：**灰度失败自动回滚状态**
 *
 * 主题：**一个能自动做多步操作的东西，失败时制造的烂摊子比它省下的
 * 手工操作大得多。** 补偿不是锦上添花，它是允许这种自动化存在的前提。
 */

const T0 = new Date('2026-08-01T00:00:00Z')
const later = (ms: number) => new Date(T0.getTime() + ms)

/** 一个把流程真的跑到底的小驱动器。副作用记在数组里 */
function drive(
  process: Process,
  handler: (stepId: string) => StepOutcome,
  options: { now?: () => Date; humanSays?: (stepId: string) => StepOutcome | null } = {},
): { performed: string[]; compensated: string[]; instruction: Instruction; rounds: number } {
  let state: RunState = { processId: process.id, completed: [], performed: [], startedAt: T0 }
  const performed: string[] = []
  const compensated: string[] = []
  const now = options.now ?? (() => T0)

  for (let round = 0; round < 200; round++) {
    const instruction = advance(process, state, now())

    if (instruction.kind === 'done') return { performed, compensated, instruction, rounds: round }

    if (instruction.kind === 'compensate') {
      for (const a of instruction.actions) compensated.push(a.stepId)
      return { performed, compensated, instruction, rounds: round }
    }

    if (instruction.kind === 'await-human') {
      const said = options.humanSays?.(instruction.stepId) ?? null
      if (said === null) return { performed, compensated, instruction, rounds: round }
      state = { ...state, completed: [...state.completed, said] }
      continue
    }

    const results: StepOutcome[] = []
    const newlyPerformed = [...state.performed]
    for (const s of instruction.steps) {
      performed.push(s.stepId)
      const outcome = handler(s.stepId)
      results.push(outcome)
      // 只有成功执行过的才需要补偿
      if (outcome.status === 'ok') {
        const def = flatten(process.steps).find((d) => s.stepId.startsWith(d.id))
        if (def?.kind === 'action' && def.compensate !== undefined) {
          newlyPerformed.push({ stepId: s.stepId, compensate: def.compensate })
        }
      }
    }
    state = { ...state, completed: [...state.completed, ...results], performed: newlyPerformed }
  }
  throw new Error('driver did not converge')
}

const ok = (stepId: string, value?: string): StepOutcome => ({
  stepId,
  status: 'ok',
  ...(value === undefined ? {} : { value }),
})

describe('the Release process runs end to end (FR-WF-010)', () => {
  it('is a valid definition', () => {
    expect(validateProcess(RELEASE_PROCESS)).toEqual([])
  })

  it('reaches Released when the canary comes back healthy', () => {
    const result = drive(
      RELEASE_PROCESS,
      (id) => (id.startsWith('observe') ? ok(id, 'healthy') : ok(id)),
      { humanSays: (id) => ok(id) },
    )
    expect(result.instruction.kind).toBe('done')
    expect(result.performed).toContain('freeze')
    expect(result.performed).toContain('promote')
    expect(result.performed).toContain('mark-released')
    expect(result.compensated).toEqual([])
  })

  it('runs build and notes in parallel — they do not wait on each other', () => {
    let state: RunState = { processId: 'x', completed: [ok('freeze')], performed: [], startedAt: T0 }
    const instruction = advance(RELEASE_PROCESS, state, T0)
    expect(instruction.kind).toBe('do')
    if (instruction.kind !== 'do') throw new Error('expected do')
    expect(instruction.steps.map((s) => s.stepId).sort()).toEqual(['build', 'notes'])
  })

  it('stops for a human before touching production', () => {
    // PRD §4：不可逆操作永远需要人工确认
    const result = drive(RELEASE_PROCESS, (id) => ok(id), { humanSays: () => null })
    expect(result.instruction.kind).toBe('await-human')
    if (result.instruction.kind !== 'await-human') throw new Error('expected await-human')
    expect(result.instruction.stepId).toBe('approve')
    // **还没碰灰度**
    expect(result.performed).not.toContain('widen')
  })

  it('loops the canary until it reports healthy', () => {
    let seen = 0
    const result = drive(
      RELEASE_PROCESS,
      (id) => {
        if (!id.startsWith('observe')) return ok(id)
        seen++
        return ok(id, seen < 3 ? 'degraded' : 'healthy')
      },
      { humanSays: (id) => ok(id) },
    )
    expect(seen).toBe(3)
    expect(result.performed.filter((p) => p.startsWith('widen'))).toHaveLength(3)
    expect(result.instruction.kind).toBe('done')
    // **分支必须看最后一轮**：取第一轮的话它读到 'degraded'，
    // 于是走中止而不是全量——而流程照样"跑完了"，只是结果反了
    expect(result.performed).toContain('promote')
    expect(result.performed).not.toContain('abort')
  })

  it('takes the abort branch when the canary comes back definitively unhealthy', () => {
    // 灰度不健康是常态，不是异常——所以 otherwise 是主路径之一。
    // `unhealthy` 是循环的出口值之一，于是循环退出、分支拿到它、走中止
    const result = drive(
      RELEASE_PROCESS,
      (id) => (id.startsWith('observe') ? ok(id, 'unhealthy') : ok(id)),
      { humanSays: (id) => ok(id) },
    )
    expect(result.instruction.kind).toBe('done')
    expect(result.performed).toContain('abort')
    expect(result.performed).not.toContain('promote')
    // 中止是**正常结束**，不是失败——不该触发补偿
    expect(result.compensated).toEqual([])
  })

  it('gives up through compensation when the canary never settles either way', () => {
    // 一直 degraded：既不健康也没明确坏。五轮上界到了 → 补偿
    const result = drive(
      RELEASE_PROCESS,
      (id) => (id.startsWith('observe') ? ok(id, 'degraded') : ok(id)),
      { humanSays: (id) => ok(id) },
    )
    expect(result.instruction.kind).toBe('compensate')
    if (result.instruction.kind !== 'compensate') throw new Error('expected compensate')
    expect(result.instruction.reason).toMatch(/maxIterations=5/)
  })
})

describe('a failure rolls the state back (FR-WF-011)', () => {
  it('compensates when the canary deploy fails', () => {
    // **这就是验收标准那句话：灰度失败自动回滚状态**
    const result = drive(
      RELEASE_PROCESS,
      (id) =>
        id.startsWith('widen')
          ? { stepId: id, status: 'failed', error: '5xx 突增' }
          : ok(id, id.startsWith('observe') ? 'healthy' : undefined),
      { humanSays: (id) => ok(id) },
    )
    expect(result.instruction.kind).toBe('compensate')
    if (result.instruction.kind !== 'compensate') throw new Error('expected compensate')
    expect(result.instruction.reason).toMatch(/5xx 突增/)
    // 冻结要被撤销，构建产物要被丢掉
    expect(result.compensated).toContain('freeze')
    expect(result.compensated).toContain('build')
  })

  it('compensates in reverse order', () => {
    // 正序会先撤销那些后面几步还依赖着的东西
    const result = drive(
      RELEASE_PROCESS,
      (id) => (id.startsWith('widen') ? { stepId: id, status: 'failed' } : ok(id)),
      { humanSays: (id) => ok(id) },
    )
    // freeze 是第一个做的，所以它必须是**最后**一个被撤销的
    expect(result.compensated.at(-1)).toBe('freeze')
  })

  it('only compensates what actually succeeded', () => {
    // 撤销一件没做成的事，本身就是一次没人预料到的副作用
    const process: Process = {
      id: 'p',
      steps: [
        {
          id: 'a',
          kind: 'action',
          action: { kind: 'noop' },
          compensate: { kind: 'transition', resourceRef: 'r', to: 'Undone' },
        },
        {
          id: 'b',
          kind: 'action',
          action: { kind: 'noop' },
          compensate: { kind: 'transition', resourceRef: 'r', to: 'AlsoUndone' },
        },
      ],
    }
    const result = drive(process, (id) => (id === 'b' ? { stepId: id, status: 'failed' } : ok(id)))
    expect(result.compensated).toEqual(['a'])
  })

  it('says what went wrong, not just that something did', () => {
    const result = drive(
      RELEASE_PROCESS,
      (id) => (id === 'build' ? { stepId: id, status: 'failed', error: '编译失败' } : ok(id)),
      { humanSays: (id) => ok(id) },
    )
    if (result.instruction.kind !== 'compensate') throw new Error('expected compensate')
    expect(result.instruction.reason).toMatch(/build/)
    expect(result.instruction.reason).toMatch(/编译失败/)
  })

  it('treats a timeout as a failure worth rolling back', () => {
    // 用 `build`（不在循环里）。用 observe 的话，循环会一直重试到上界、
    // 也走到 compensate——于是"超时算不算失败"这条根本没被测到
    const result = drive(
      RELEASE_PROCESS,
      (id) => (id === 'build' ? { stepId: id, status: 'timeout' } : ok(id)),
      { humanSays: (id) => ok(id) },
    )
    expect(result.instruction.kind).toBe('compensate')
    if (result.instruction.kind !== 'compensate') throw new Error('expected compensate')
    expect(result.instruction.reason).toMatch(/timeout/)
  })
})

describe('the human node cannot hang forever (FR-WF-010)', () => {
  it('gives the human a deadline', () => {
    const result = drive(RELEASE_PROCESS, (id) => ok(id), { humanSays: () => null })
    if (result.instruction.kind !== 'await-human') throw new Error('expected await-human')
    expect(result.instruction.deadline.getTime()).toBeGreaterThan(T0.getTime())
  })

  it('rolls back when nobody answers in time', () => {
    // 不设上界的话，这个实例会永远挂着——而挂着的实例攥着一个已冻结的 Release
    const result = drive(RELEASE_PROCESS, (id) => ok(id), {
      humanSays: () => null,
      now: () => later(48 * 60 * 60 * 1000),
    })
    expect(result.instruction.kind).toBe('compensate')
    if (result.instruction.kind !== 'compensate') throw new Error('expected compensate')
    expect(result.instruction.reason).toMatch(/timed out/)
  })

  it('can be told to proceed instead of fail on timeout', () => {
    const process: Process = {
      id: 'p',
      steps: [
        { id: 'h', kind: 'human', prompt: '要不要？', timeoutMs: 1000, onTimeout: 'proceed' },
        { id: 'after', kind: 'action', action: { kind: 'noop' } },
      ],
    }
    const result = drive(process, (id) => ok(id), { humanSays: () => null, now: () => later(5000) })
    expect(result.performed).toEqual(['after'])
    expect(result.instruction.kind).toBe('done')
  })
})

describe('a loop must terminate (FR-WF-010)', () => {
  it('fails loudly at the iteration ceiling instead of quietly finishing', () => {
    // 悄悄退出的话，一个永远等不到条件的循环会表现为"流程跑完了"
    const process: Process = {
      id: 'p',
      steps: [
        {
          id: 'l',
          kind: 'loop',
          on: 'check',
          untilAnyOf: ['yes'],
          maxIterations: 3,
          body: [{ id: 'check', kind: 'action', action: { kind: 'noop' } }],
        },
      ],
    }
    const result = drive(process, (id) => ok(id, 'no'))
    expect(result.instruction.kind).toBe('compensate')
    if (result.instruction.kind !== 'compensate') throw new Error('expected compensate')
    expect(result.instruction.reason).toMatch(/maxIterations=3/)
  })

  it('does not mistake round two for "already done"', () => {
    const process: Process = {
      id: 'p',
      steps: [
        {
          id: 'l',
          kind: 'loop',
          on: 'check',
          untilAnyOf: ['yes'],
          maxIterations: 5,
          body: [{ id: 'check', kind: 'action', action: { kind: 'noop' } }],
        },
      ],
    }
    let n = 0
    const result = drive(process, (id) => {
      n++
      return ok(id, n < 3 ? 'no' : 'yes')
    })
    expect(n).toBe(3)
    expect(result.instruction.kind).toBe('done')
  })
})

describe('a bad definition is refused when it is written (FR-WF-010)', () => {
  const bad = (steps: Process['steps']): string[] => validateProcess({ id: 'p', steps })

  it('rejects a human node with no timeout', () => {
    expect(bad([{ id: 'h', kind: 'human', prompt: 'x', timeoutMs: 0, onTimeout: 'fail' }])).toContain(
      'human step "h" must have a timeout',
    )
  })

  it('rejects a loop that can never run', () => {
    expect(
      bad([
        { id: 'l', kind: 'loop', on: 'c', untilAnyOf: ['y'], maxIterations: 0, body: [{ id: 'c', kind: 'action', action: { kind: 'noop' } }] },
      ]),
    ).toContain('loop "l" must allow at least one iteration')
  })

  it('rejects a branch reading a step that does not exist', () => {
    // 跑到一半才发现引用了不存在的步骤，会把系统留在中间状态
    expect(bad([{ id: 'b', kind: 'branch', on: 'ghost', cases: { a: [] } }])).toContain(
      'branch "b" reads unknown step "ghost"',
    )
  })

  it('rejects a parallel with only one branch', () => {
    expect(
      bad([{ id: 'p1', kind: 'parallel', branches: [{ id: 'x', kind: 'action', action: { kind: 'noop' } }] }]),
    ).toContain('parallel "p1" needs at least two branches')
  })

  it('rejects duplicate step ids', () => {
    expect(
      bad([
        { id: 'same', kind: 'action', action: { kind: 'noop' } },
        { id: 'same', kind: 'action', action: { kind: 'noop' } },
      ]),
    ).toContain('duplicate step id "same"')
  })

  it('rejects a loop with no exit value', () => {
    // 出口值为空 = 只能靠上界退出，而上界走的是补偿。
    // 也就是说这个循环**永远不会正常结束**
    expect(
      bad([
        {
          id: 'l',
          kind: 'loop',
          on: 'c',
          untilAnyOf: [],
          maxIterations: 2,
          body: [{ id: 'c', kind: 'action', action: { kind: 'noop' } }],
        },
      ]),
    ).toContain('loop "l" has no exit value at all')
  })

  it('rejects an empty loop body', () => {
    expect(bad([{ id: 'l', kind: 'loop', on: 'l', untilAnyOf: ['y'], maxIterations: 2, body: [] }])).toContain(
      'loop "l" has an empty body',
    )
  })
})

describe('the same state always gives the same instruction (FR-WF-010)', () => {
  it('is re-entrant, so an interrupted process can resume from storage', () => {
    // 不需要把"跑到哪儿了"记在内存里——中断的流程重新加载状态就能接着跑
    const state: RunState = {
      processId: RELEASE_PROCESS.id,
      completed: [ok('freeze'), ok('build')],
      performed: [],
      startedAt: T0,
    }
    const a = advance(RELEASE_PROCESS, state, T0)
    const b = advance(RELEASE_PROCESS, state, T0)
    expect(a).toEqual(b)
  })
})
