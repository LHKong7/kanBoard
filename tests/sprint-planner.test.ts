import { describe, expect, it } from 'vitest'
import { planCandidates, STRATEGIES, unblockDepth } from '../src/domain/ai/sprint-planner.ts'
import type { BacklogTask } from '../src/domain/ai/sprint-planner.ts'
import { validateSprintPlan } from '../src/domain/ai/capabilities.ts'

/**
 * Sprint 候选方案生成（FR-AI-004）。
 *
 * 这一条先前被记成"要真实模型"。读一遍验收标准就知道那是错的：
 * 「生成 ≥2 个候选方案，**不违反依赖与 capacity 约束**」是一个**排程问题**，
 * 不是一个语言问题。用模型做它，换来的是一个偶尔排出违反依赖的方案、
 * 而且说不清为什么这么排的排程器。
 *
 * 这一组的主题：**方案必须是合法的，而且必须真的不同。**
 * 三份大同小异的方案不是"给了选择"，是把同一个决定说了三遍。
 */

const backlog: BacklogTask[] = [
  { id: 'a', points: 3, priority: 1 },
  { id: 'b', points: 5, priority: 9, dependsOn: ['a'] },
  { id: 'c', points: 2, priority: 5 },
  { id: 'd', points: 8, priority: 7 },
]

describe('every candidate is feasible, not merely proposed (FR-AI-004)', () => {
  it('produces plans that satisfy dependencies and capacity', () => {
    const { candidates, verdict } = planCandidates(backlog, 10)
    expect(verdict.ok).toBe(true)
    for (const c of candidates) {
      expect(validateSprintPlan(c.plan, backlog).ok).toBe(true)
    }
  })

  it('never exceeds capacity', () => {
    for (const capacity of [1, 3, 7, 10, 18, 100]) {
      const { candidates } = planCandidates(backlog, capacity)
      for (const c of candidates) expect(c.points).toBeLessThanOrEqual(capacity)
    }
  })

  it('puts a dependency before the task that needs it', () => {
    const { candidates } = planCandidates(backlog, 10)
    for (const c of candidates) {
      const ids = [...c.plan.taskIds]
      if (ids.includes('b')) expect(ids.indexOf('a')).toBeLessThan(ids.indexOf('b'))
    }
  })

  it('does not schedule half a dependency chain', () => {
    // 排了一半的链比不排更糟：方案看起来饱满，第一天就卡住。
    // capacity 5 装得下 b(5) 但装不下 a+b(8)
    const { candidates } = planCandidates([backlog[0]!, backlog[1]!], 5)
    for (const c of candidates) expect([...c.plan.taskIds]).not.toContain('b')
  })

  it('says why a task did not make it in', () => {
    // 只给一份排进去的清单，人得自己推断剩下的为什么没进来
    const { candidates } = planCandidates(backlog, 5)
    const reasons = candidates.flatMap((c) => c.excluded.map((e) => e.reason)).join(' ')
    expect(reasons).toMatch(/capacity|dependency chain/)
  })

  it('takes everything when capacity is not a constraint', () => {
    const { candidates } = planCandidates(backlog, 100)
    for (const c of candidates) expect(c.plan.taskIds).toHaveLength(4)
  })

  it('returns an empty plan rather than an illegal one when nothing fits', () => {
    const { candidates } = planCandidates(backlog, 1)
    for (const c of candidates) {
      expect(c.plan.taskIds).toHaveLength(0)
      expect(c.excluded).toHaveLength(4)
    }
  })
})

describe('the candidates are actually different (FR-AI-004)', () => {
  it('offers at least two', () => {
    // 只给一个方案不是"排期"，是"通知"
    const { candidates } = planCandidates(backlog, 10)
    expect(candidates.length).toBeGreaterThanOrEqual(2)
  })

  it('each strategy answers a different question', () => {
    const { candidates } = planCandidates(backlog, 10)
    const shapes = new Set(candidates.map((c) => c.plan.taskIds.join(',')))
    // 三个策略在这个 backlog 上不该收敛成同一份方案
    expect(shapes.size).toBeGreaterThanOrEqual(2)
  })

  it('value-first leads with the highest priority work it can legally start', () => {
    // id 顺序**故意**和优先级顺序相反。原来的用例用的是 a/b/c/d 加递增优先级，
    // 于是"按 id 排"和"按优先级排"给出同一个答案——把优先级排序
    // 整个删掉照样绿。变异测试逮到的
    const priced: BacklogTask[] = [
      { id: 'zzz-critical', points: 4, priority: 99 },
      { id: 'aaa-trivial', points: 4, priority: 1 },
      { id: 'mmm-middle', points: 4, priority: 50 },
    ]
    const { candidates } = planCandidates(priced, 8, ['value-first'])
    expect([...(candidates[0]?.plan.taskIds ?? [])]).toEqual(['zzz-critical', 'mmm-middle'])
  })

  it('quick-wins maximises how many things finish', () => {
    const { candidates } = planCandidates(backlog, 10)
    const quick = candidates.find((c) => c.strategy === 'quick-wins')
    const value = candidates.find((c) => c.strategy === 'value-first')
    expect((quick?.plan.taskIds.length ?? 0)).toBeGreaterThanOrEqual(value?.plan.taskIds.length ?? 0)
  })

  it('carries a rationale a human can act on', () => {
    // "选哪个"没有依据的话，人只会永远选第一个
    const { candidates } = planCandidates(backlog, 10)
    for (const c of candidates) expect(c.rationale.length).toBeGreaterThan(8)
  })

  it('collapses two strategies that produced the same plan', () => {
    // 留着的话，"三个候选"里有两个是同一个东西，而使用者要读完才发现
    const single: BacklogTask[] = [{ id: 'only', points: 1, priority: 1 }]
    const { candidates } = planCandidates(single, 10)
    expect(candidates).toHaveLength(1)
  })
})

describe('unblock-first knows what is actually blocking (FR-AI-004)', () => {
  it('counts indirect dependents, not just direct ones', () => {
    // 只数直接依赖的话，一个挡住一条长链的任务会和一个挡住
    // 一个叶子的任务看起来一样重要
    const chain: BacklogTask[] = [
      { id: 'root', points: 1 },
      { id: 'mid', points: 1, dependsOn: ['root'] },
      { id: 'leaf', points: 1, dependsOn: ['mid'] },
      { id: 'lonely', points: 1 },
      { id: 'child', points: 1, dependsOn: ['lonely'] },
    ]
    const depth = unblockDepth(chain)
    expect(depth.get('root')).toBe(2)
    expect(depth.get('lonely')).toBe(1)
    expect(depth.get('leaf')).toBe(0)
  })

  it('does not hang on a dependency cycle', () => {
    // 环本身由本体的 acyclic 检测负责报，排程器只要别死在这儿
    const cyclic: BacklogTask[] = [
      { id: 'x', points: 1, dependsOn: ['y'] },
      { id: 'y', points: 1, dependsOn: ['x'] },
    ]
    expect(() => unblockDepth(cyclic)).not.toThrow()
    expect(() => planCandidates(cyclic, 10)).not.toThrow()
  })

  it('schedules the biggest unblocker first when asked to', () => {
    // id 顺序**故意**和阻塞深度顺序相反，而且容量只够装一个：
    // 原来的用例里"按 id 排"碰巧也把 root 排在最前，
    // 于是把阻塞深度排序删掉照样绿
    const chain: BacklogTask[] = [
      { id: 'zzz-root', points: 3, priority: 0 },
      { id: 'yyy-mid', points: 3, priority: 0, dependsOn: ['zzz-root'] },
      { id: 'aaa-shiny', points: 3, priority: 99 },
    ]
    const { candidates } = planCandidates(chain, 3, ['unblock-first'])
    // 只装得下一个，而挡住后续工作最多的是 zzz-root
    expect([...(candidates[0]?.plan.taskIds ?? [])]).toEqual(['zzz-root'])
  })
})

describe('a dependency outside the backlog is already done', () => {
  it('does not treat it as unschedulable', () => {
    // backlog 里没有 = 它已经完成了（或不归这个 sprint 管）。
    // 当成"依赖不满足"的话，一个 sprint 里除了全新任务什么都排不进来
    const tasks: BacklogTask[] = [{ id: 'next', points: 3, dependsOn: ['shipped-last-sprint'] }]
    const { candidates } = planCandidates(tasks, 10)
    expect([...(candidates[0]?.plan.taskIds ?? [])]).toEqual(['next'])
  })
})

describe('the generator is held to the same rules it will be judged by', () => {
  it('runs every strategy through the shared validator', () => {
    // 生成侧和判定侧用同一把尺子，"生成器自己说它是对的"就不成立了
    for (const strategy of STRATEGIES) {
      const { candidates } = planCandidates(backlog, 9, [strategy])
      for (const c of candidates) expect(validateSprintPlan(c.plan, backlog).ok).toBe(true)
    }
  })
})
