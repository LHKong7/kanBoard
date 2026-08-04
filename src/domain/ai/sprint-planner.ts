import { validateCandidates, validateSprintPlan } from './capabilities.ts'
import type { PlannedTask, SprintPlan, Verdict } from './capabilities.ts'

/**
 * Sprint 候选方案生成（FR-AI-004）。
 *
 * 这一条先前被记成"要真实模型"。那是错的，而且错得挺明显：
 * 验收标准是「生成 ≥2 个候选方案，**不违反依赖与 capacity 约束**」——
 * 那是一个**排程问题**，不是一个语言问题。用模型去做它，
 * 换来的是一个偶尔会排出违反依赖的方案、而且没法解释为什么这么排的排程器。
 *
 * 所以这里是确定性的。模型在这条需求里能帮上忙的地方是**估点**
 * （FR-AI-003，那条确实要模型），不是排程本身。
 *
 * **候选方案之间必须真的不同。** 生成三份大同小异的方案不是"给了选择"，
 * 是把同一个决定说了三遍。所以每个策略回答的是一个不同的问题：
 *
 *   value-first      这个 sprint 我最想拿到什么？
 *   unblock-first    做什么能让后面的人最快开工？
 *   quick-wins       怎么让这个 sprint 结束时"完成"的条数最多？
 *
 * 这三个问题在真实的排期会上都会被问到，而且答案经常不一样——
 * 那正是"给两个以上候选"有意义的原因。
 */

export type BacklogTask = PlannedTask & {
  /** 越大越想先做 */
  priority?: number
}

export type PlanStrategy = 'value-first' | 'unblock-first' | 'quick-wins'

export const STRATEGIES: readonly PlanStrategy[] = ['value-first', 'unblock-first', 'quick-wins']

/** 策略在 UI 上怎么说。理由要能被读到，否则"选哪个"没有依据 */
export const STRATEGY_RATIONALE: Record<PlanStrategy, string> = {
  'value-first': '优先级最高的先排。想清楚这个 sprint 最想拿到什么时用它',
  'unblock-first': '先做挡住最多后续任务的。团队并行度低、总在互相等的时候用它',
  'quick-wins': '小任务优先。需要尽快看到一批"完成"时用它——但要小心它会推迟大件',
}

export type Candidate = {
  plan: SprintPlan
  strategy: PlanStrategy
  rationale: string
  /** 这份方案排了多少点 */
  points: number
  /** 因为依赖或容量没排进来的任务，以及原因 */
  excluded: readonly { taskId: string; reason: string }[]
}

/**
 * 生成候选方案。
 *
 * 每一份都**保证**满足依赖与容量——不是"尽量"。排不进去的任务
 * 进 `excluded` 并说明原因，而不是硬塞进去让下游的校验去拒。
 * 一个会产出非法方案的排程器，等于把"这方案能不能用"这个判断
 * 推给了看方案的人。
 */
export function planCandidates(
  backlog: readonly BacklogTask[],
  capacity: number,
  strategies: readonly PlanStrategy[] = STRATEGIES,
): { candidates: readonly Candidate[]; verdict: Verdict } {
  const seen = new Set<string>()
  const candidates: Candidate[] = []

  for (const strategy of strategies) {
    const candidate = planOne(backlog, capacity, strategy)
    // 两个策略排出一模一样的方案时只留一份。留着的话，
    // "三个候选"里有两个是同一个东西，而使用者要读完才发现
    const key = candidate.plan.taskIds.join(',')
    if (seen.has(key)) continue
    seen.add(key)
    candidates.push(candidate)
  }

  return {
    candidates,
    // 用同一组校验器把关（FR-AI-004 的口径）。生成侧和判定侧
    // 用同一把尺子，"生成器自己说它是对的"这件事就不成立了
    verdict: validateCandidates(
      candidates.map((c) => c.plan),
      backlog,
    ),
  }
}

function planOne(
  backlog: readonly BacklogTask[],
  capacity: number,
  strategy: PlanStrategy,
): Candidate {
  const byId = new Map(backlog.map((t) => [t.id, t]))
  const depth = unblockDepth(backlog)

  const ordered = [...backlog].sort((a, b) => {
    switch (strategy) {
      case 'value-first':
        return (b.priority ?? 0) - (a.priority ?? 0) || a.id.localeCompare(b.id)
      case 'unblock-first':
        return (depth.get(b.id) ?? 0) - (depth.get(a.id) ?? 0) || a.id.localeCompare(b.id)
      case 'quick-wins':
        return a.points - b.points || a.id.localeCompare(b.id)
    }
  })

  const chosen: string[] = []
  const inPlan = new Set<string>()
  const excluded: { taskId: string; reason: string }[] = []
  let points = 0

  /**
   * 试着把一个任务连同它的依赖一起排进去。
   *
   * 依赖必须**先于**它出现，而且要么整条链都排得进去，要么一个都不排——
   * 排了一半的依赖链比不排更糟：方案看起来饱满，第一天就卡住。
   */
  const admit = (task: BacklogTask, chain: Set<string>): boolean => {
    if (inPlan.has(task.id)) return true
    if (chain.has(task.id)) return false // 依赖成环，交给上游的环检测报
    chain.add(task.id)

    const pending: BacklogTask[] = []
    for (const depId of task.dependsOn ?? []) {
      const dep = byId.get(depId)
      // 依赖不在 backlog 里 = 它已经完成了（或不归这个 sprint 管）
      if (dep === undefined) continue
      if (inPlan.has(depId)) continue
      pending.push(dep)
    }

    // 先算总量再决定，避免"依赖排进去了、它本身没排下"的半截状态
    const bundle = [...pending, task]
    const cost = bundle.reduce((sum, t) => sum + t.points, 0)
    if (points + cost > capacity) return false

    for (const dep of pending) {
      if (!admit(dep, chain)) return false
    }
    if (inPlan.has(task.id)) return true
    chosen.push(task.id)
    inPlan.add(task.id)
    points += task.points
    return true
  }

  for (const task of ordered) {
    if (inPlan.has(task.id)) continue
    const before = points
    if (!admit(task, new Set())) {
      excluded.push({
        taskId: task.id,
        reason:
          before + task.points > capacity
            ? `would exceed capacity (${before} + ${task.points} > ${capacity})`
            : 'its dependency chain does not fit in this sprint',
      })
    }
  }

  const plan: SprintPlan = { id: `plan-${strategy}`, capacity, taskIds: chosen }
  // 自查一遍再交出去。生成器自己不查的话，"保证满足约束"就只是一句注释。
  //
  // **老实说：现在没有任何用例能让这一条抛出来**（变异测试确认过——
  // 改成 `if (false)` 全部用例照样绿）。它的触发条件是"排程逻辑有 bug"，
  // 而当前的排程逻辑没有 bug。留着不是为了现在，是因为改坏排序或
  // 容量计算的那一天，它会把一份非法方案变成一次崩溃——
  // 而非法方案会被当成建议交给人，然后按它开工。
  const check = validateSprintPlan(plan, backlog)
  if (!check.ok) {
    throw new Error(
      `sprint planner produced an infeasible plan (${strategy}): ${check.offenders.join('; ')}`,
    )
  }

  return {
    plan,
    strategy,
    rationale: STRATEGY_RATIONALE[strategy],
    points,
    excluded,
  }
}

/**
 * 每个任务挡住了多少后续工作（含间接）。
 *
 * `unblock-first` 用它排序。只数直接依赖的话，一个挡住一条长链的任务
 * 会和一个挡住一个叶子的任务看起来一样重要。
 */
export function unblockDepth(backlog: readonly BacklogTask[]): Map<string, number> {
  const dependents = new Map<string, string[]>()
  for (const task of backlog) {
    for (const dep of task.dependsOn ?? []) {
      dependents.set(dep, [...(dependents.get(dep) ?? []), task.id])
    }
  }

  const memo = new Map<string, number>()
  const walk = (id: string, chain: Set<string>): number => {
    const cached = memo.get(id)
    if (cached !== undefined) return cached
    // 成环时返回 0 而不是死循环。环本身由本体的 acyclic 检测负责报
    if (chain.has(id)) return 0
    chain.add(id)
    const children = dependents.get(id) ?? []
    const total = children.reduce((sum, child) => sum + 1 + walk(child, chain), 0)
    chain.delete(id)
    memo.set(id, total)
    return total
  }

  const out = new Map<string, number>()
  for (const task of backlog) out.set(task.id, walk(task.id, new Set()))
  return out
}
