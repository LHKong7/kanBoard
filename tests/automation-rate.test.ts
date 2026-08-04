import { describe, expect, it } from 'vitest'
import {
  AUTOMATION_RUBRIC_VERSION,
  editRatio,
  grade,
  levenshtein,
  summarize,
} from '../src/domain/dashboard/automation-rate.ts'
import type { Grade, GradeInput } from '../src/domain/dashboard/automation-rate.ts'

/**
 * 北极星指标的口径（docs/prd/11-dashboard.md §2）。
 *
 * 这组用例是**对着口径表逐条写的**。指标口径最容易出的问题不是算错，
 * 是"文档说 A、代码算 B"，而且谁都没发现——所以每条断言都对应
 * 口径表里的一行。
 */

const NOW = new Date('2026-08-20T00:00:00Z')
const LONG_AGO = new Date('2026-08-01T00:00:00Z')

const input = (over: Partial<GradeInput> = {}): GradeInput => ({
  agent: 'agent://planner@1.0.0',
  firstAttributes: { title: 'Agent 写的标题', body: 'x'.repeat(100) },
  finalAttributes: { title: 'Agent 写的标题', body: 'x'.repeat(100) },
  terminalAt: LONG_AGO,
  overturned: false,
  now: NOW,
  ...over,
})

describe('分级对应口径表 §2.1', () => {
  it('无关联 AgentRun → L0', () => {
    expect(grade(input({ agent: null })).level).toBe('L0')
  })

  it('编辑幅度 = 0 → L3', () => {
    const g = grade(input())
    expect(g.level).toBe('L3')
    expect(g.editRatio).toBe(0)
  })

  it('编辑幅度 ≤ 20% 且 > 0 → L2', () => {
    // 100 字的正文改 10 个字符
    const g = grade(
      input({ finalAttributes: { title: 'Agent 写的标题', body: 'y'.repeat(10) + 'x'.repeat(90) } }),
    )
    expect(g.level).toBe('L2')
    expect(g.editRatio).toBeGreaterThan(0)
    expect(g.editRatio).toBeLessThanOrEqual(0.2)
  })

  it('编辑幅度 > 20% → L1', () => {
    const g = grade(
      input({ finalAttributes: { title: '人改的完全不同标题', body: 'z'.repeat(100) } }),
    )
    expect(g.level).toBe('L1')
    expect(g.editRatio).toBeGreaterThan(0.2)
  })

  it('20% 正好是 L2 的上界，不是 L1', () => {
    // 边界值要钉死：口径写的是"≤ 20%"。
    // 用改动**字符数**而不是目标比例来表达——比例经过取整之后
    // 表达不出 0.2 与刚过 0.2 的区别，那样的边界测试等于没测
    expect(gradeOfChanged(200)).toBe('L2') // 200/1000 = 0.2，含在 L2 内
    expect(gradeOfChanged(201)).toBe('L1') // 0.201，刚过界
  })
})

/** 在 1000 字的正文里改掉 `changed` 个字符 */
function gradeOfChanged(changed: number): string {
  const size = 1000
  return grade(
    input({
      firstAttributes: { body: 'x'.repeat(size) },
      finalAttributes: { body: 'y'.repeat(changed) + 'x'.repeat(size - changed) },
    }),
  ).level
}

describe('消歧规则 §2.5', () => {
  it('人点了"接受"但没改内容 → 仍算 L3', () => {
    // 点击接受是审阅行为，不是编辑。这条最容易被实现成 L2
    expect(grade(input()).level).toBe('L3')
  })

  it('状态机写的时间戳不算人工编辑', () => {
    // completedAt 是 entry action 写的，人没碰过
    const g = grade(
      input({
        firstAttributes: { title: 't' },
        finalAttributes: { title: 't', completedAt: '2026-08-01T00:00:00Z' },
      }),
    )
    expect(g.level).toBe('L3')
  })

  it('7 天内被推翻 → 从 L3 移除', () => {
    const g = grade(input({ overturned: true }))
    expect(g.level).not.toBe('L3')
    // 降到 L2 而不是 L0：产出确实是 Agent 做的，只是没站住
    expect(g.level).toBe('L2')
  })

  it('尚在 7 天窗口内的 L3 被标为临时', () => {
    // 藏起来会让指标看着更稳、实际更不可信
    const recent = grade(input({ terminalAt: new Date('2026-08-19T00:00:00Z') }))
    expect(recent.level).toBe('L3')
    expect(recent.provisional).toBe(true)

    const settled = grade(input())
    expect(settled.provisional).toBe(false)
  })
})

describe('编辑幅度按字段长度加权', () => {
  it('改一个短标题不会把整篇几乎原样的文档打成 L1', () => {
    // 不加权的话：标题 100% 改动 + 正文 0%，平均 50% → L1，明显不合理
    const g = grade(
      input({
        firstAttributes: { title: 'abc', body: 'x'.repeat(2000) },
        finalAttributes: { title: 'xyz', body: 'x'.repeat(2000) },
      }),
    )
    expect(g.level).toBe('L3' === g.level ? 'L3' : 'L2')
    expect(g.editRatio).toBeLessThan(0.05)
  })

  it('新增一个字段算作该字段被完全改写', () => {
    expect(editRatio({ a: 'x' }, { a: 'x', b: 'new' })).toBeGreaterThan(0)
  })

  it('两边都空时是 0 而不是 NaN', () => {
    expect(editRatio({}, {})).toBe(0)
  })
})

describe('超长文本不会把进程算死', () => {
  it('对 200k 字符的正文在合理时间内给出结果', () => {
    // Levenshtein 是 O(n·m)：200k × 200k 是 4×10^10 次操作，
    // 指标接口会直接卡死。超过阈值退回长度差估计
    const big = 'x'.repeat(200_000)
    const started = Date.now()
    const ratio = editRatio({ body: big }, { body: big + 'y'.repeat(1000) })
    expect(Date.now() - started).toBeLessThan(500)
    expect(ratio).toBeGreaterThan(0)
  })

  it('相同的超长文本仍然是 0', () => {
    const big = 'x'.repeat(200_000)
    expect(editRatio({ body: big }, { body: big })).toBe(0)
  })
})

describe('Levenshtein 本身', () => {
  it('算的是编辑距离', () => {
    expect(levenshtein('kitten', 'sitting')).toBe(3)
    expect(levenshtein('', 'abc')).toBe(3)
    expect(levenshtein('same', 'same')).toBe(0)
  })
})

describe('汇总公式 §2.2', () => {
  const g = (level: Grade['level'], provisional = false): Grade => ({
    level,
    editRatio: 0,
    agent: 'agent://a@1',
    provisional,
  })

  it('Automation Rate = L3 / 全部进入终态的工作项', () => {
    const s = summarize([g('L3'), g('L3'), g('L0'), g('L1')])
    expect(s.total).toBe(4)
    expect(s.automationRate).toBe(0.5)
  })

  it('分母包含人做的工作项', () => {
    // 只统计 Agent 碰过的，率会虚高得毫无意义
    expect(summarize([g('L3'), g('L0'), g('L0'), g('L0')]).automationRate).toBe(0.25)
  })

  it('AI 主导率 = (L2 + L3) / 全部', () => {
    expect(summarize([g('L3'), g('L2'), g('L0'), g('L0')]).aiLedRate).toBe(0.5)
  })

  it('没有任何工作项时是 0，不是 NaN', () => {
    // NaN 在界面上是一片吓人的空白
    const s = summarize([])
    expect(s.automationRate).toBe(0)
    expect(s.aiLedRate).toBe(0)
  })

  it('报出临时计入的数量', () => {
    expect(summarize([g('L3', true), g('L3')]).provisional).toBe(1)
  })

  it('带上口径版本，便于发现口径漂移', () => {
    expect(summarize([]).rubricVersion).toBe(AUTOMATION_RUBRIC_VERSION)
  })
})
