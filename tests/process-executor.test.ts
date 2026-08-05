import { describe, expect, it } from 'vitest'
import { drive, resolveHuman } from '../src/domain/orchestration/executor.ts'
import type { ActionRunner, ProcessRun } from '../src/domain/orchestration/executor.ts'
import type { Process, StepAction } from '../src/workflow/orchestration.ts'
import { RELEASE_PROCESS } from '../src/workflow/release-process.ts'

/**
 * 执行器本身（FR-WF-010 / FR-WF-011），不连数据库。
 *
 * 端到端那一组（tests/integration/process-run.test.ts）证明的是"它真的跑起来"。
 * 这里证明的是三件**跑起来之后看不见**的事：
 *
 *   每做一步就落库   只有崩在中间时才看得出来，而崩溃没法在集成测试里制造
 *   逆序 + 只补真做过的  失败的动作不进补偿清单
 *   轮次标签         循环体里的步骤 id 带 `#loop#round`，补偿表按裸 id 建
 */

const NOW = new Date('2026-01-01T00:00:00Z')

/** 记下每一次 save，而不只是最后一次 */
function recordingStore(): { saves: ProcessRun[]; save: (run: ProcessRun) => Promise<void> } {
  const saves: ProcessRun[] = []
  return {
    saves,
    async save(run) {
      saves.push(structuredClone(run))
    },
  }
}

function runnerThat(reply: (action: StepAction) => { status: 'ok' | 'failed'; value?: string }): ActionRunner & {
  performed: StepAction[]
} {
  const performed: StepAction[] = []
  return {
    performed,
    async perform(action) {
      performed.push(action)
      return reply(action)
    },
  }
}

function freshRun(process: Process): ProcessRun {
  return {
    id: 'run_1',
    tenant: 't',
    processId: process.id,
    refs: { release: 'rel_1' },
    status: 'running',
    awaiting: null,
    state: { processId: process.id, completed: [], performed: [], startedAt: NOW },
  }
}

const TWO_STEPS: Process = {
  id: 'two-steps',
  steps: [
    { id: 'a', kind: 'action', action: { kind: 'noop' }, compensate: { kind: 'noop' } },
    { id: 'b', kind: 'action', action: { kind: 'noop' } },
  ],
}

describe('process executor', () => {
  it('saves after every step, not only at the end', async () => {
    // 一个流程实例会跨天。进程重启、部署、崩溃都会发生在中间——
    // 只在结束时落库的话，一次崩溃会让一个已经调过部署接口的流程
    // **从记录上彻底消失**，而外面的世界已经变了。
    //
    // 用 maxSteps 把驱动切开来看：这是崩溃在测试里唯一能被模拟的样子
    const store = recordingStore()
    const runner = runnerThat(() => ({ status: 'ok' }))
    const partial = await drive(TWO_STEPS, freshRun(TWO_STEPS), {
      runner,
      store,
      now: () => NOW,
      maxSteps: 1,
    })

    expect(partial.status).toBe('running')
    // 中途那一步已经落库了
    expect(store.saves).toHaveLength(1)
    expect(store.saves[0]?.state.completed.map((c) => c.stepId)).toEqual(['a'])

    // 拿落下来的那份接着跑，结果和一口气跑完一样——**这就是"可重入"**
    const resumed = await drive(TWO_STEPS, store.saves[0] as ProcessRun, {
      runner,
      store,
      now: () => NOW,
    })
    expect(resumed.status).toBe('completed')
    expect(resumed.state.completed.map((c) => c.stepId)).toEqual(['a', 'b'])
  })

  it('treats a rejection as a failed step, so compensation runs', async () => {
    // 拒绝**不是**"什么都不做"。默默把实例留在等待上的话，
    // 那个已经冻结的 Release 会一直冻结着
    const store = recordingStore()
    const runner = runnerThat(() => ({ status: 'ok' }))
    const awaiting = await drive(RELEASE_PROCESS, freshRun(RELEASE_PROCESS), {
      runner,
      store,
      now: () => NOW,
    })
    expect(awaiting.status).toBe('awaiting-human')

    const rejected = await drive(RELEASE_PROCESS, resolveHuman(awaiting, false, 'user://alice'), {
      runner,
      store,
      now: () => NOW,
    })
    expect(rejected.status).toBe('compensated')
    // 灰度一步都没走——拒绝之后不该有人继续往下推
    expect(runner.performed.filter((a) => a.kind === 'call' && a.connectorId === 'deploy')).toEqual([])
    // 撤销是**逆序**的：后做的先撤
    const undo = runner.performed
      .filter((a) => a.kind === 'call' || a.kind === 'transition')
      .map((a) => (a.kind === 'call' ? `${a.connectorId}.${a.operation}` : `→${a.to}`))
    expect(undo.slice(-3)).toEqual(['docs.deleteDraft', 'ci.discardArtifact', '→Planned'])
  })

  it('compensates the actions performed inside a loop, round tags and all', async () => {
    // 循环体里的步骤 id 形如 `widen#canary#0`，而补偿表按定义里的裸 id 建。
    // 不剥掉轮次标签的话，**循环里做过的每一件事都撤不回来**——
    // 而灰度恰恰是这个流程里唯一会真的改动线上流量的部分
    const store = recordingStore()
    // 观察永远是 degraded：循环撞上界 → 走补偿
    const runner = runnerThat((action) =>
      action.kind === 'call' && action.operation === 'canaryHealth'
        ? { status: 'ok', value: 'degraded' }
        : { status: 'ok' },
    )

    const awaiting = await drive(RELEASE_PROCESS, freshRun(RELEASE_PROCESS), {
      runner,
      store,
      now: () => NOW,
    })
    const done = await drive(RELEASE_PROCESS, resolveHuman(awaiting, true, 'user://alice'), {
      runner,
      store,
      now: () => NOW,
    })

    expect(done.status).toBe('compensated')
    const rollbacks = runner.performed.filter(
      (a) => a.kind === 'call' && a.operation === 'rollback',
    )
    // 灰度扩了 5 轮，就要回滚 5 次
    expect(rollbacks).toHaveLength(5)
  })

  it('only compensates what actually succeeded', async () => {
    // 失败的动作没有产生副作用（或者产生了一半，而那时撤销一个
    // 没发生过的操作只会把状态搞得更乱）
    const store = recordingStore()
    const runner = runnerThat((action) =>
      action.kind === 'transition' && action.to === 'Frozen'
        ? { status: 'failed' }
        : { status: 'ok' },
    )
    const result = await drive(RELEASE_PROCESS, freshRun(RELEASE_PROCESS), {
      runner,
      store,
      now: () => NOW,
    })

    expect(result.status).toBe('compensated')
    // 冻结没成功，所以"解冻"不该被执行
    expect(runner.performed.filter((a) => a.kind === 'transition' && a.to === 'Planned')).toEqual([])
  })
})
