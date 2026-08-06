/**
 * 燃尽图（project-management-guide §5.1 的第一张图）。
 *
 * 纯函数：进去一批工作项的完成时刻，出来两条序列。不查库、不读时钟——
 * 于是"迭代过半时进度落后"这种情形可以直接写成用例，
 * 而不需要先把时间调到那一天。
 */

export type BurndownItem = {
  /** 完成时刻。未完成为 null */
  completedAt: Date | null
  /** 估点。按条数烧时忽略 */
  points: number
  /**
   * 是否被取消。
   *
   * 取消掉的工作项**照样要烧掉**，但**不算完成**。这个区分很要紧：
   * 当成完成的话，一个把范围砍掉一半的迭代会显示出一条漂亮的燃尽线；
   * 当成未完成的话，线永远落不了地，而事实是那些事确实不做了。
   */
  cancelled: boolean
}

export type BurndownPoint = {
  /** `YYYY-MM-DD` */
  day: string
  /** 匀速理想线 */
  ideal: number
  /**
   * 当天结束时的实际剩余。**未来的日子是 null**，不是 0 也不是持平。
   *
   * 补成持平的话，图上会出现一条从今天一直延伸到迭代结束的水平线，
   * 而那条线看起来像"从今天起就没有进展了"——一个还没发生的坏消息。
   */
  remaining: number | null
}

export type Burndown = {
  points: BurndownPoint[]
  /** 总量（条数或点数，取决于 unit） */
  total: number
  /** 已完成量 */
  completed: number
  /** 取消掉的量。单独报，因为它既不是完成也不是剩余 */
  cancelled: number
  unit: 'count' | 'points'
}

export type BurndownInput = {
  start: Date
  end: Date
  items: readonly BurndownItem[]
  /** 算到哪一天为止有实际值。通常是"现在" */
  now: Date
  unit?: 'count' | 'points'
}

const DAY_MS = 24 * 60 * 60 * 1000

/** `YYYY-MM-DD`（UTC）。格式选它是因为字典序即时间序 */
export function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10)
}

function startOfUtcDay(date: Date): number {
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
}

export function burndown(input: BurndownInput): Burndown {
  const unit = input.unit ?? 'count'
  const weight = (item: BurndownItem): number => (unit === 'points' ? item.points : 1)

  const total = input.items.reduce((sum, item) => sum + weight(item), 0)
  const completed = input.items
    .filter((i) => i.completedAt !== null && !i.cancelled)
    .reduce((sum, item) => sum + weight(item), 0)
  const cancelled = input.items
    .filter((i) => i.cancelled)
    .reduce((sum, item) => sum + weight(item), 0)

  const firstDay = startOfUtcDay(input.start)
  const lastDay = startOfUtcDay(input.end)
  // 起止同一天也要出一个点：一个只有一天的迭代不该画出一张空图
  const spanDays = Math.max(0, Math.round((lastDay - firstDay) / DAY_MS))
  const today = startOfUtcDay(input.now)

  const points: BurndownPoint[] = []
  for (let index = 0; index <= spanDays; index++) {
    const dayStart = firstDay + index * DAY_MS
    const dayEnd = dayStart + DAY_MS

    // 理想线：从总量匀速降到 0。spanDays 为 0 时只有一个点，直接给 0——
    // 除以 0 会得到 NaN，而 NaN 在图上不是报错，是**那条线整段消失**
    const ideal = spanDays === 0 ? 0 : total * (1 - index / spanDays)

    let remaining: number | null = null
    if (dayStart <= today) {
      // 到这一天结束为止，烧掉的 = 已完成的 + 已取消的。
      // 取消也烧：那些事不会再占用这个迭代的任何时间
      const burned = input.items
        .filter((item) => item.completedAt !== null && item.completedAt.getTime() < dayEnd)
        .reduce((sum, item) => sum + weight(item), 0)
      remaining = round(total - burned)
    }

    points.push({ day: dayKey(new Date(dayStart)), ideal: round(ideal), remaining })
  }

  return { points, total: round(total), completed: round(completed), cancelled: round(cancelled), unit }
}

/**
 * 保留两位小数。
 *
 * 理想线是浮点除法算出来的，不收的话图例上会出现 `3.0000000000000004`。
 * 这不是显示问题——两个数值相等的点会被当成不等，
 * 于是"实际是否贴着理想线"这个判断在边界上会随机翻转。
 */
function round(value: number): number {
  return Math.round(value * 100) / 100
}
