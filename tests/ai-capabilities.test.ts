import { describe, expect, it } from 'vitest'
import {
  ACCEPTANCE_COVERAGE_MIN,
  acceptanceCoverage,
  actionableItems,
  markUnverified,
  MIN_SPRINT_CANDIDATES,
  UNVERIFIED_MARK,
  usableRecommendations,
  validateCandidates,
  validateSprintPlan,
  verifyMarking,
} from '../src/domain/ai/capabilities.ts'
import type { AcceptanceRef, PlannedTask, SprintPlan } from '../src/domain/ai/capabilities.ts'

/**
 * AI 能力的口径（FR-AI-002/004/006/007/009/010）。
 *
 * 每条需求的验收标准都是**可判定的条件**，不是"模型答得好不好"，
 * 所以这一组不需要模型就能逐条对着验收标准写。
 * 模型负责生成候选，这里负责判定候选合不合格。
 */

// ── FR-AI-002 ────────────────────────────────────────────────
describe('split stories must cover the parent acceptance criteria (FR-AI-002)', () => {
  const acceptances: AcceptanceRef[] = [
    { id: 'acc_1', given: '有账单', when: '点击导出', then: '得到一份 PDF 文件' },
    { id: 'acc_2', given: '有账单', when: '点击导出', then: '金额与账单一致' },
    { id: 'acc_3', given: '导出失败', when: '重试', then: '显示明确的失败原因' },
  ]

  it('passes when every criterion is covered', () => {
    const result = acceptanceCoverage(acceptances, [
      '导出账单为 PDF 文件',
      '校验导出金额与账单一致',
      '导出失败时显示失败原因',
    ])
    expect(result.ok).toBe(true)
    expect(result.rate).toBe(1)
  })

  it('lists exactly which criteria are uncovered', () => {
    // 只给一个百分比的话，使用者得自己去比对是哪几条漏了。
    // 验收标准的原文就是"未覆盖项显式列出"
    const result = acceptanceCoverage(acceptances, ['导出账单为 PDF 文件', '校验金额与账单一致'])
    expect(result.ok).toBe(false)
    expect(result.offenders).toHaveLength(1)
    expect(result.offenders[0]).toContain('acc_3')
  })

  it('holds the threshold at 95%', () => {
    // 口径写在常量里，能被指着讨论
    expect(ACCEPTANCE_COVERAGE_MIN).toBe(0.95)
    // 3 条里漏 1 条 = 66.7%，不到线
    const result = acceptanceCoverage(acceptances, ['导出账单为 PDF 文件', '校验金额与账单一致'])
    expect(result.rate).toBeLessThan(ACCEPTANCE_COVERAGE_MIN)
  })

  it('does not score an empty criteria list as perfect', () => {
    // 判 100% 会让"忘了写验收标准"表现为满分
    expect(acceptanceCoverage([], ['随便什么']).rate).toBe(0)
  })

  it('does not count a story that shares no substantive terms', () => {
    const result = acceptanceCoverage(
      [{ id: 'acc_x', given: 'g', when: 'w', then: '导出的 PDF 带公司抬头' }],
      ['完全无关的登录改造'],
    )
    expect(result.ok).toBe(false)
  })
})

// ── FR-AI-004 ────────────────────────────────────────────────
describe('sprint candidates must be feasible (FR-AI-004)', () => {
  const tasks: PlannedTask[] = [
    { id: 'task_a', points: 3 },
    { id: 'task_b', points: 5, dependsOn: ['task_a'] },
    { id: 'task_c', points: 8 },
  ]
  const plan = (over: Partial<SprintPlan> = {}): SprintPlan => ({
    id: 'plan_1',
    capacity: 10,
    taskIds: ['task_a', 'task_b'],
    ...over,
  })

  it('accepts a plan within capacity and in dependency order', () => {
    const result = validateSprintPlan(plan(), tasks)
    expect(result.ok).toBe(true)
    expect(result.points).toBe(8)
  })

  it('rejects a plan over capacity, and says by how much', () => {
    // 排了做不完的量，计划本身就是假的
    const result = validateSprintPlan(plan({ taskIds: ['task_a', 'task_b', 'task_c'] }), tasks)
    expect(result.ok).toBe(false)
    expect(result.offenders.join()).toMatch(/over capacity: 16 points planned against 10/)
  })

  it('rejects a dependency scheduled after its dependent', () => {
    // 这种排期看起来饱满，执行时第一天就卡住
    const result = validateSprintPlan(plan({ taskIds: ['task_b', 'task_a'] }), tasks)
    expect(result.ok).toBe(false)
    expect(result.offenders.join()).toMatch(/task_b is scheduled before its dependency task_a/)
  })

  it('rejects a dependency that is not in the sprint at all', () => {
    const result = validateSprintPlan(plan({ taskIds: ['task_b'] }), tasks)
    expect(result.ok).toBe(false)
    expect(result.offenders.join()).toMatch(/not in this sprint/)
  })

  it('does not flag a dependency that is already done', () => {
    // 依赖不在待排清单里 = 它已经交付了（或不归这个 sprint 管）。
    // 这条最初漏了，而它不是边角情况：真实 backlog 几乎每条都依赖着
    // 已交付的东西，于是那个版本会把**几乎每一份方案**判成非法。
    // 是写排程器（sprint-planner.ts）的时候撞出来的
    const withShipped: PlannedTask[] = [{ id: 'task_new', points: 3, dependsOn: ['shipped_last_sprint'] }]
    const result = validateSprintPlan(
      { id: 'plan_1', capacity: 10, taskIds: ['task_new'] },
      withShipped,
    )
    expect(result.ok).toBe(true)
  })

  it('flags a task the planner invented', () => {
    const result = validateSprintPlan(plan({ taskIds: ['task_ghost'] }), tasks)
    expect(result.ok).toBe(false)
    expect(result.offenders.join()).toMatch(/not a known task/)
  })

  it('requires at least two candidates', () => {
    // 只给一个方案不是"排期"，是"通知"
    expect(MIN_SPRINT_CANDIDATES).toBe(2)
    expect(validateCandidates([plan()], tasks).ok).toBe(false)
    expect(validateCandidates([plan(), plan({ id: 'plan_2', taskIds: ['task_c'] })], tasks).ok).toBe(
      true,
    )
  })

  it('names which candidate is infeasible', () => {
    const bad = plan({ id: 'plan_bad', taskIds: ['task_b', 'task_a'] })
    const result = validateCandidates([plan(), bad], tasks)
    expect(result.ok).toBe(false)
    expect(result.offenders.join()).toContain('plan_bad')
  })
})

// ── FR-AI-007 ────────────────────────────────────────────────
describe('unsourced statements are marked, not hidden (FR-AI-007)', () => {
  const claims = [
    { text: '导出功能已上线', sourceIds: ['task_1'] },
    { text: '用户希望支持批量导出', sourceIds: [] },
  ]

  it('marks the unsourced ones', () => {
    const { text, unverified } = markUnverified(claims)
    expect(unverified).toBe(1)
    expect(text).toContain(`${UNVERIFIED_MARK}用户希望支持批量导出`)
    // 有出处的不加标记，否则标记就没有信息量了
    expect(text).toContain('\n')
    expect(text.startsWith(UNVERIFIED_MARK)).toBe(false)
  })

  it('marks rather than deletes', () => {
    // 删掉会让文档读起来完整而实际上缺了内容
    const { text } = markUnverified(claims)
    expect(text).toContain('用户希望支持批量导出')
  })

  it('catches an unsourced claim presented as fact', () => {
    const rendered = '导出功能已上线\n用户希望支持批量导出'
    const result = verifyMarking(claims, rendered)
    expect(result.ok).toBe(false)
    expect(result.offenders.join()).toContain('批量导出')
  })

  it('passes when the rendering carries the marks', () => {
    const { text } = markUnverified(claims)
    expect(verifyMarking(claims, text).ok).toBe(true)
  })
})

// ── FR-AI-009 ────────────────────────────────────────────────
describe('recommendations carry provenance and freshness (FR-AI-009)', () => {
  const now = new Date('2026-08-01T00:00:00Z')
  const rec = (over: Record<string, unknown> = {}) => ({
    knowledgeId: 'k1',
    title: '连接池调优',
    sourceIds: ['task_1'],
    validUntil: new Date('2026-12-01T00:00:00Z'),
    ...over,
  })

  it('passes a sourced, current recommendation', () => {
    const { usable, verdict } = usableRecommendations([rec()], now)
    expect(verdict.ok).toBe(true)
    expect(usable).toHaveLength(1)
  })

  it('withholds one with no provenance', () => {
    // 接受它的人无从核实
    const { usable, verdict } = usableRecommendations([rec({ sourceIds: [] })], now)
    expect(verdict.ok).toBe(false)
    expect(usable).toHaveLength(0)
  })

  it('withholds a stale one', () => {
    // 过期的知识主动推送比不推更糟：它带着系统的背书
    const { usable, verdict } = usableRecommendations(
      [rec({ validUntil: new Date('2026-07-01T00:00:00Z') })],
      now,
    )
    expect(verdict.ok).toBe(false)
    expect(verdict.offenders.join()).toMatch(/stale/)
    expect(usable).toHaveLength(0)
  })

  it('allows knowledge with no expiry', () => {
    // 没写有效期不等于过期
    expect(usableRecommendations([rec({ validUntil: null })], now).usable).toHaveLength(1)
  })
})

// ── FR-AI-010 ────────────────────────────────────────────────
describe('action items need an owner before they can be created (FR-AI-010)', () => {
  it('keeps the ones with an assignee', () => {
    const { actionable, verdict } = actionableItems([
      { text: '补一份回归用例', assignee: 'user://bob' },
    ])
    expect(verdict.ok).toBe(true)
    expect(actionable).toHaveLength(1)
  })

  it('refuses "we should do X" with nobody attached', () => {
    // 那不是行动项，是一句感想。允许它落库的话，
    // 任务列表会迅速长满没人负责的条目
    const { actionable, verdict } = actionableItems([
      { text: '补一份回归用例', assignee: 'user://bob' },
      { text: '我们应该多写点测试', assignee: null },
    ])
    expect(verdict.ok).toBe(false)
    expect(verdict.offenders.join()).toContain('多写点测试')
    expect(actionable).toHaveLength(1)
  })

  it('treats an empty assignee as no assignee — in both halves of the answer', () => {
    const { actionable, verdict } = actionableItems([{ text: '找人跟进', assignee: '' }])
    expect(actionable).toHaveLength(0)
    // 只断言 actionable 的话，"悄悄丢掉一条 + 报告全都有负责人"这个组合
    // 测不出来。变异测试就是这么逮到它的
    expect(verdict.ok).toBe(false)
    expect(verdict.offenders.join()).toContain('找人跟进')
  })
})
