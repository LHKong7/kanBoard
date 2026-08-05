/**
 * 自动化分级与 Automation Rate（FR-DASH-015，口径见 docs/prd/11-dashboard.md §2）。
 *
 * 这是北极星指标，所以口径必须是**可复算、可争议但不可含糊**的。
 * 这个文件只做纯计算：给定「Agent 的初版」与「进入终态时的终版」，
 * 算出人工编辑了多少、该归哪一级。不碰数据库、不认识 HTTP，
 * 于是它可以被逐条对着口径表验证。
 */

/** 口径版本。变更必须走 ADR 并重算历史值（§2 末尾的规则） */
export const AUTOMATION_RUBRIC_VERSION = '1.0.0'

export type AutomationLevel = 'L0' | 'L1' | 'L2' | 'L3'

export type Grade = {
  level: AutomationLevel
  /** 人工编辑幅度，0..1。L0 时无意义，记 1 */
  editRatio: number
  /** 归因到哪个 Agent；L0 为 null */
  agent: string | null
  /**
   * 尚在 7 天推翻窗口内。
   *
   * 这类项**已经按 L3 计入**，但随时可能被扣回去。单独标出来，
   * 是因为"这个数字里有多少还可能变"本身就是使用者该知道的事——
   * 把它们藏起来，指标看着更稳，实际更不可信。
   */
  provisional: boolean
  /** 采纳后 7 天内被推翻（FR-DASH-016）。这是 Rework Rate 的分子 */
  reworked: boolean
}

export type GradeInput = {
  /** 产出是否出自 Agent（第一版的 createdBy 是 agent://…） */
  agent: string | null
  /** Agent 产出的初版属性 */
  firstAttributes: Record<string, unknown>
  /** 进入终态时的属性 */
  finalAttributes: Record<string, unknown>
  /**
   * **首次**进入终态的时刻，即"采纳"发生的那一刻。
   *
   * 是首次而不是最近一次：口径写的是"采纳后 7 天内"（§2.2 第 4 条），
   * 窗口从采纳起算。取最近一次的话，一个被推翻又重新完成的工作项
   * 会拿到一个刷新过的窗口，等于推翻一次就重置一次考核——
   * 反复推翻反而永远查不出来。
   */
  acceptedAt: Date
  /**
   * 采纳之后**首次**离开终态的时刻；从未被推翻则为 null。
   *
   * 存时刻而不是布尔值，是因为口径关心的是"多久之后"：
   * 半年后的一次 reopen 不该把当初的 L3 扣掉（§2.2 第 4 条只管 7 天内）。
   * 用布尔值表达不出这个区别，而它算错的方向是**低估**自动化率——
   * 一个越用越难看的指标，没人会想去查它为什么难看。
   */
  overturnedAt: Date | null
  now: Date
}

export const OVERTURN_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

/**
 * 文本字段做 Levenshtein 的长度上限。
 *
 * 超过就退回到长度差比例。理由很实际：Levenshtein 是 O(n·m)，
 * 一段 200,000 字符的 richtext 会算出 4×10^10 次操作——
 * 指标接口会直接把进程卡死。
 * **一个略粗但有界的估计，好过一个精确但会挂掉的计算。**
 */
const LEVENSHTEIN_MAX = 4_000

export function grade(input: GradeInput): Grade {
  // §2.1：无关联 AgentRun 即 L0。人做的活不该被算进自动化率的分子
  if (input.agent === null) {
    return { level: 'L0', editRatio: 1, agent: null, provisional: false, reworked: false }
  }

  const ratio = editRatio(input.firstAttributes, input.finalAttributes)
  const accepted = input.acceptedAt.getTime()
  const reworked =
    input.overturnedAt !== null && input.overturnedAt.getTime() - accepted < OVERTURN_WINDOW_MS

  // §2.5：7 天内被推翻的从 L3 移除。降到 L2 而不是 L0——
  // 产出确实是 Agent 做的，只是没站住
  if (reworked) {
    return {
      level: ratio === 0 ? 'L2' : gradeByRatio(ratio),
      editRatio: ratio,
      agent: input.agent,
      provisional: false,
      reworked: true,
    }
  }

  return {
    level: gradeByRatio(ratio),
    editRatio: ratio,
    agent: input.agent,
    // 只有 L3 才需要标注临时性：L0..L2 不进分子，推翻与否不改变它们
    provisional: ratio === 0 && input.now.getTime() - accepted < OVERTURN_WINDOW_MS,
    reworked: false,
  }
}

function gradeByRatio(ratio: number): AutomationLevel {
  if (ratio === 0) return 'L3'
  if (ratio <= 0.2) return 'L2'
  return 'L1'
}

/**
 * 编辑幅度（§2.1）。
 *
 * 多字段对象取**按字段长度加权**的平均：改一个 500 字的正文，
 * 与改一个 3 个字的标题，不该算作同等程度的人工介入。
 * 不加权的话，一次标题微调就能把一篇几乎原样接受的文档打成 L1。
 */
export function editRatio(
  first: Record<string, unknown>,
  final: Record<string, unknown>,
): number {
  // 派生字段（时间戳之类）由状态机写入，不是人的编辑
  const keys = [...new Set([...Object.keys(first), ...Object.keys(final)])].filter(
    (k) => !DERIVED_KEYS.test(k),
  )
  if (keys.length === 0) return 0

  let weighted = 0
  let totalWeight = 0

  for (const key of keys) {
    const a = first[key]
    const b = final[key]
    const { ratio, weight } = fieldDistance(a, b)
    weighted += ratio * weight
    totalWeight += weight
  }

  return totalWeight === 0 ? 0 : round(weighted / totalWeight)
}

/** 状态机 entry action 写的字段。人没碰过它们 */
const DERIVED_KEYS = /At$|^(startedAt|completedAt|acceptedAt|publishedAt|approvedAt)$/

function fieldDistance(a: unknown, b: unknown): { ratio: number; weight: number } {
  if (a === undefined && b === undefined) return { ratio: 0, weight: 0 }
  // 新增或删除一个字段，就是这个字段被完全改写
  if (a === undefined || b === undefined) {
    return { ratio: 1, weight: Math.max(len(a), len(b), 1) }
  }
  if (typeof a === 'string' && typeof b === 'string') {
    if (a === b) return { ratio: 0, weight: Math.max(a.length, 1) }
    const weight = Math.max(a.length, b.length, 1)
    if (weight > LEVENSHTEIN_MAX) {
      // 太长就用长度差估计。粗，但有界，而且不会低估大改
      const diff = Math.abs(a.length - b.length) / weight
      return { ratio: Math.max(diff, 0.01), weight }
    }
    return { ratio: levenshtein(a, b) / weight, weight }
  }
  // 非文本：相等即 0，不等即 1。权重取 1，避免数字字段被长度稀释掉
  return { ratio: JSON.stringify(a) === JSON.stringify(b) ? 0 : 1, weight: 1 }
}

function len(value: unknown): number {
  return typeof value === 'string' ? value.length : 1
}

/** 两行滚动的 Levenshtein：O(n·m) 时间，O(min(n,m)) 空间 */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  if (a.length === 0) return b.length
  if (b.length === 0) return a.length
  // 短的那个当列，内存占用取决于它
  if (a.length > b.length) [a, b] = [b, a]

  let prev = Array.from({ length: a.length + 1 }, (_, i) => i)
  let curr = new Array<number>(a.length + 1)

  for (let j = 1; j <= b.length; j++) {
    curr[0] = j
    for (let i = 1; i <= a.length; i++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      curr[i] = Math.min((curr[i - 1] ?? 0) + 1, (prev[i] ?? 0) + 1, (prev[i - 1] ?? 0) + cost)
    }
    ;[prev, curr] = [curr, prev]
  }
  return prev[a.length] ?? 0
}

export type AutomationSummary = {
  rubricVersion: string
  /** 同期进入终态的全部工作项（分母），人做的也算 */
  total: number
  byLevel: Record<AutomationLevel, number>
  /** L3 / total */
  automationRate: number
  /** (L2 + L3) / total */
  aiLedRate: number
  /** L3 里还在 7 天窗口内、可能被扣回去的数量 */
  provisional: number
  /** 被采纳的 Agent 产出数量，即 Rework Rate 的分母 */
  accepted: number
  /** 采纳后 7 天内被推翻的数量 */
  reworked: number
  /**
   * Rework Rate = reworked / accepted（§1.3）。
   *
   * 分母是**被采纳的 Agent 产出**，不是全部工作项：人自己写的东西
   * 被推翻，说明不了 Agent 的产出质量。用全部工作项作分母会让
   * Rework Rate 随着人工工作量的增加而下降——一个可以靠多干活
   * 刷好看的指标，等于没有指标。
   */
  reworkRate: number
}

export function summarize(grades: readonly Grade[]): AutomationSummary {
  const byLevel: Record<AutomationLevel, number> = { L0: 0, L1: 0, L2: 0, L3: 0 }
  let provisional = 0
  let accepted = 0
  let reworked = 0
  for (const g of grades) {
    byLevel[g.level]++
    if (g.provisional) provisional++
    if (g.agent !== null) accepted++
    if (g.reworked) reworked++
  }
  const total = grades.length
  return {
    rubricVersion: AUTOMATION_RUBRIC_VERSION,
    total,
    byLevel,
    // 分母为 0 时返回 0 而不是 NaN：NaN 在界面上会显示成一个吓人的空白，
    // 而"还没有任何工作项进入终态"应该显示成 0
    automationRate: total === 0 ? 0 : round(byLevel.L3 / total),
    aiLedRate: total === 0 ? 0 : round((byLevel.L2 + byLevel.L3) / total),
    provisional,
    accepted,
    reworked,
    reworkRate: accepted === 0 ? 0 : round(reworked / accepted),
  }
}

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000
}
