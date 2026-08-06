import { describe, expect, it } from 'vitest'
import { burndown, dayKey } from '../src/domain/analytics/burndown.ts'
import type { BurndownItem } from '../src/domain/analytics/burndown.ts'

/**
 * 燃尽图是纯函数，所以这些用例不需要数据库，也不需要把时间调到某一天。
 * 指南 §5.1 列了四种"形态 → 含义"，这里逐一锁住它们真的能被算出来。
 */

const D = (iso: string): Date => new Date(iso)

function item(completedAt: string | null, points = 1, cancelled = false): BurndownItem {
  return { completedAt: completedAt === null ? null : D(completedAt), points, cancelled }
}

describe('燃尽图', () => {
  const start = D('2026-08-01T00:00:00.000Z')
  const end = D('2026-08-05T00:00:00.000Z')

  it('理想线从总量匀速降到零', () => {
    const result = burndown({
      start,
      end,
      now: D('2026-08-05T12:00:00.000Z'),
      items: [item(null), item(null), item(null), item(null)],
    })

    expect(result.points.map((p) => p.ideal)).toEqual([4, 3, 2, 1, 0])
  })

  it('实际线按完成时刻逐日下降', () => {
    const result = burndown({
      start,
      end,
      now: D('2026-08-05T12:00:00.000Z'),
      items: [
        item('2026-08-02T10:00:00.000Z'),
        item('2026-08-02T18:00:00.000Z'),
        item('2026-08-04T09:00:00.000Z'),
        item(null),
      ],
    })

    // 8-01 结束时一件没完成 → 4；8-02 完成两件 → 2；8-03 无变化 → 2；
    // 8-04 完成一件 → 1；8-05 → 1
    expect(result.points.map((p) => p.remaining)).toEqual([4, 2, 2, 1, 1])
  })

  it('未来的日子不画实际值，而不是画成持平', () => {
    const result = burndown({
      start,
      end,
      // 迭代才过了两天
      now: D('2026-08-02T12:00:00.000Z'),
      items: [item('2026-08-02T10:00:00.000Z'), item(null)],
    })

    expect(result.points.map((p) => p.remaining)).toEqual([2, 1, null, null, null])
  })

  it('取消掉的工作项照样烧掉，但不算完成', () => {
    const result = burndown({
      start,
      end,
      now: D('2026-08-05T12:00:00.000Z'),
      items: [
        item('2026-08-02T10:00:00.000Z'),
        // 被取消的那条也带完成时刻（状态机进终态时会盖章）
        item('2026-08-03T10:00:00.000Z', 1, true),
        item(null),
      ],
    })

    expect(result.completed).toBe(1)
    expect(result.cancelled).toBe(1)
    // 但两条都烧掉了：剩下的只有那条没做的
    expect(result.points.at(-1)?.remaining).toBe(1)
  })

  it('按点数烧时，一个 8 点的和一个 1 点的不算一样重', () => {
    const result = burndown({
      start,
      end,
      now: D('2026-08-05T12:00:00.000Z'),
      unit: 'points',
      items: [item('2026-08-02T10:00:00.000Z', 8), item(null, 1)],
    })

    expect(result.total).toBe(9)
    expect(result.points[0]?.remaining).toBe(9)
    expect(result.points[1]?.remaining).toBe(1)
    expect(result.unit).toBe('points')
  })

  it('起止同一天时只有一个点，且不出现 NaN', () => {
    const oneDay = D('2026-08-01T00:00:00.000Z')
    const result = burndown({ start: oneDay, end: oneDay, now: oneDay, items: [item(null)] })

    expect(result.points).toHaveLength(1)
    // spanDays 为 0 时理想线直接给 0——除以 0 会得到 NaN，
    // 而 NaN 在图上不是报错，是那条线整段消失
    expect(result.points[0]?.ideal).toBe(0)
    expect(Number.isNaN(result.points[0]?.ideal)).toBe(false)
  })

  it('一件都没有的周期不炸，总量为零', () => {
    const result = burndown({ start, end, now: D('2026-08-03T00:00:00.000Z'), items: [] })
    expect(result.total).toBe(0)
    expect(result.points.every((p) => p.ideal === 0)).toBe(true)
  })

  it('理想线不带浮点尾巴', () => {
    const result = burndown({
      start,
      end: D('2026-08-04T00:00:00.000Z'),
      now: D('2026-08-04T00:00:00.000Z'),
      items: [item(null), item(null), item(null), item(null), item(null), item(null), item(null)],
    })
    // 7 / 3 这种除不尽的情况下，不收的话会出现 4.666666666666667
    for (const point of result.points) {
      expect(String(point.ideal)).not.toMatch(/\.\d{3,}/)
    }
  })

  it('日期键是可排序的 YYYY-MM-DD', () => {
    expect(dayKey(D('2026-08-06T23:59:00.000Z'))).toBe('2026-08-06')
    const result = burndown({ start, end, now: end, items: [] })
    expect([...result.points.map((p) => p.day)].sort()).toEqual(result.points.map((p) => p.day))
  })
})
