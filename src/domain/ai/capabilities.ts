/**
 * AI 能力的**口径与校验**（FR-AI-002/004/006/007/009/010）。
 *
 * 每条 AI 需求的验收标准读下来都不是"模型答得好不好"，而是
 * **产出要满足什么可判定的条件**：
 *
 *   FR-AI-002  覆盖率 ≥ 95%，未覆盖项显式列出
 *   FR-AI-004  不违反依赖与 capacity 约束，可一键应用与撤销
 *   FR-AI-006  每条风险可点击到触发它的实体
 *   FR-AI-007  无出处内容被标注为"待确认"
 *   FR-AI-009  推荐带出处与时效
 *   FR-AI-010  行动项可一键创建并关联负责人
 *
 * 这些全是纯计算，因此可以在没有模型的情况下逐条钉死。
 * 模型负责**生成候选**，这里负责**判定候选合不合格**——
 * 两件事分开之后，"AI 做得对不对"就不再是一个只能靠感觉回答的问题。
 *
 * 判定失败时不写"大概不太行"，而是把**具体哪几条不满足**列出来。
 * 一个只会说"未达标"的校验，使用者除了重跑一次别无选择。
 */

export type Verdict = {
  ok: boolean
  /** 一句人能读的结论 */
  reason: string
  /** 具体不满足的项。**空数组表示真的没有**，不是"没查" */
  offenders: readonly string[]
}

const pass = (reason: string): Verdict => ({ ok: true, reason, offenders: [] })

// ── FR-AI-002：拆出来的 Story 要覆盖父需求的验收标准 ──────────

/** 覆盖率门槛。写成常量而不是散在判断里：口径要能被指着讨论 */
export const ACCEPTANCE_COVERAGE_MIN = 0.95

export type AcceptanceRef = { id: string; given: string; when: string; then: string }

/**
 * 每条验收标准是否被至少一个 Story 覆盖。
 *
 * 判定方式是**关键词重合**，不是语义理解——这一层没有模型。
 * 粗，但可复算、可争议；换成"模型自己说覆盖了"的话，
 * 这条验收标准就等于让被考核的人自己打分。
 */
export function acceptanceCoverage(
  acceptances: readonly AcceptanceRef[],
  storyTexts: readonly string[],
): Verdict & { rate: number } {
  if (acceptances.length === 0) {
    // 没有验收标准时不该判 100%——那会让"忘了写验收标准"表现为满分
    return { ...pass('no acceptance criteria to cover'), rate: 0 }
  }
  const haystack = storyTexts.join('\n').toLowerCase()
  const uncovered = acceptances.filter((a) => !covers(haystack, a))
  const rate = round((acceptances.length - uncovered.length) / acceptances.length)

  return {
    ok: rate >= ACCEPTANCE_COVERAGE_MIN,
    reason:
      rate >= ACCEPTANCE_COVERAGE_MIN
        ? `covers ${pct(rate)} of acceptance criteria`
        : `covers only ${pct(rate)}, below the required ${pct(ACCEPTANCE_COVERAGE_MIN)}`,
    // 未覆盖项**显式列出**，这是验收标准的原文要求。
    // 只给一个百分比的话，使用者得自己去比对是哪几条漏了
    offenders: uncovered.map((a) => `${a.id}: ${a.then.slice(0, 60)}`),
    rate,
  }
}

/** `then` 里的特征片段有没有出现在 Story 文本里 */
function covers(haystack: string, acceptance: AcceptanceRef): boolean {
  const terms = keyTerms(acceptance.then)
  if (terms.length === 0) return false
  const hits = terms.filter((t) => haystack.includes(t)).length
  // 过半命中即认为覆盖。要求全中会把同义改写一律判成没覆盖
  return hits * 2 >= terms.length
}

/**
 * 切出用于比对的片段。
 *
 * 中文没有空格，按空白切会把「显示明确的失败原因」整句当成一个词，
 * 于是只要 Story 换了半个字就判成没覆盖——那样这条校验永远是红的，
 * 而永远红的校验会被人关掉。
 *
 * 所以中日韩用**双字滑窗**，拉丁文用词。这和检索那边的决定是同一个
 * （ADR：用 pg_trgm 而不是 to_tsvector，理由也是中英混排的分词）。
 */
export function keyTerms(text: string): string[] {
  const lower = text.toLowerCase()
  const out: string[] = []

  for (const word of lower.split(/[\s,，。、；;:：（）()"'"'`]+/)) {
    if (word === '') continue
    if (/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(word)) {
      // 双字滑窗。停用字单独成片段没有信息量，跳过以它们开头的
      for (let i = 0; i + 2 <= word.length; i++) {
        const gram = word.slice(i, i + 2)
        if (/^[的了是在和与及地得]/.test(gram)) continue
        out.push(gram)
      }
    } else if (word.length >= 2) {
      out.push(word)
    }
  }
  return [...new Set(out)]
}

// ── FR-AI-004：Sprint 候选方案不得违反依赖与 capacity ─────────

export type PlannedTask = {
  id: string
  points: number
  /** 必须先完成的任务 */
  dependsOn?: readonly string[]
}

export type SprintPlan = {
  id: string
  capacity: number
  /** 按顺序排进这个 sprint 的任务 */
  taskIds: readonly string[]
}

/**
 * 一份候选方案是否可行。
 *
 * 两条约束，各自的失败方式完全不同：
 *   - 超 capacity：排了做不完的量。计划本身就是假的。
 *   - 依赖倒置：B 依赖 A，却把 B 排在 A 前面（或 A 根本没排）。
 *     这种排期看起来饱满，执行时第一天就卡住。
 */
export function validateSprintPlan(
  plan: SprintPlan,
  tasks: readonly PlannedTask[],
): Verdict & { points: number } {
  const byId = new Map(tasks.map((t) => [t.id, t]))
  const offenders: string[] = []

  let points = 0
  for (const id of plan.taskIds) {
    const task = byId.get(id)
    if (task === undefined) {
      offenders.push(`${id}: not a known task`)
      continue
    }
    points += task.points
  }
  if (points > plan.capacity) {
    offenders.push(`over capacity: ${points} points planned against ${plan.capacity}`)
  }

  // 依赖必须排在前面。用位置比较而不是"在不在这个 sprint 里"：
  // 同一个 sprint 内的顺序同样决定第一天能不能开工
  const position = new Map(plan.taskIds.map((id, i) => [id, i]))
  for (const id of plan.taskIds) {
    for (const dep of byId.get(id)?.dependsOn ?? []) {
      const at = position.get(dep)
      if (at === undefined) {
        offenders.push(`${id} depends on ${dep}, which is not in this sprint`)
      } else if (at > (position.get(id) ?? 0)) {
        offenders.push(`${id} is scheduled before its dependency ${dep}`)
      }
    }
  }

  return {
    ok: offenders.length === 0,
    reason: offenders.length === 0 ? `feasible: ${points}/${plan.capacity} points` : 'plan is not feasible',
    offenders,
    points,
  }
}

/** 至少要几个候选方案（FR-AI-004 原文：≥ 2） */
export const MIN_SPRINT_CANDIDATES = 2

export function validateCandidates(
  plans: readonly SprintPlan[],
  tasks: readonly PlannedTask[],
): Verdict {
  if (plans.length < MIN_SPRINT_CANDIDATES) {
    // 只给一个方案不是"排期"，是"通知"。要能比较才谈得上选择
    return {
      ok: false,
      reason: `only ${plans.length} candidate(s); at least ${MIN_SPRINT_CANDIDATES} are required`,
      offenders: [],
    }
  }
  const offenders = plans
    .map((p) => ({ p, v: validateSprintPlan(p, tasks) }))
    .filter((x) => !x.v.ok)
    .flatMap((x) => x.v.offenders.map((o) => `${x.p.id}: ${o}`))

  return {
    ok: offenders.length === 0,
    reason: offenders.length === 0 ? `${plans.length} feasible candidates` : 'some candidates are infeasible',
    offenders,
  }
}

// ── FR-AI-006：每条风险可点击到触发它的实体 ──────────────────

export type EvidencedItem = { id: string; statement: string; evidence: readonly string[] }

/**
 * 每一条都必须指得出证据实体。
 *
 * 没有证据的风险条目是这类产出里最没用也最常见的东西：
 * 读起来像洞察，跟进时无从下手，而且没人能判断它是不是模型编的。
 */
export function requireEvidence(items: readonly EvidencedItem[]): Verdict {
  const offenders = items.filter((i) => i.evidence.length === 0).map((i) => `${i.id}: ${i.statement.slice(0, 60)}`)
  return {
    ok: offenders.length === 0,
    reason: offenders.length === 0 ? `all ${items.length} items cite evidence` : 'some items cite no evidence',
    offenders,
  }
}

// ── FR-AI-007：无出处的内容标注为"待确认" ────────────────────

/** 无出处内容的标注。写成常量，UI 与校验用的是同一个串 */
export const UNVERIFIED_MARK = '［待确认］'

export type Claim = { text: string; sourceIds: readonly string[] }

/**
 * 给没有出处的陈述打上标记。
 *
 * **标注而不是删除**：一段没有出处的陈述可能仍然是对的，
 * 删掉会让文档读起来完整而实际上缺了内容。标出来才让读的人
 * 知道哪几句需要自己去核。
 */
export function markUnverified(claims: readonly Claim[]): { text: string; unverified: number } {
  let unverified = 0
  const lines = claims.map((c) => {
    if (c.sourceIds.length > 0) return c.text
    unverified++
    return `${UNVERIFIED_MARK}${c.text}`
  })
  return { text: lines.join('\n'), unverified }
}

/** 成文之后再查一遍：没出处的句子必须带着标记 */
export function verifyMarking(claims: readonly Claim[], rendered: string): Verdict {
  const offenders = claims
    .filter((c) => c.sourceIds.length === 0 && !rendered.includes(`${UNVERIFIED_MARK}${c.text}`))
    .map((c) => c.text.slice(0, 60))
  return {
    ok: offenders.length === 0,
    reason: offenders.length === 0 ? 'every unsourced claim is marked' : 'unsourced claims are presented as fact',
    offenders,
  }
}

// ── FR-AI-009：推荐带出处与时效 ──────────────────────────────

export type Recommendation = {
  knowledgeId: string
  title: string
  /** 这条知识是从哪儿来的 */
  sourceIds: readonly string[]
  /** 到期时间。过期的知识推给人比不推更糟 */
  validUntil: Date | null
}

export function usableRecommendations(
  items: readonly Recommendation[],
  now: Date,
): { usable: Recommendation[]; verdict: Verdict } {
  const offenders: string[] = []
  const usable: Recommendation[] = []

  for (const item of items) {
    if (item.sourceIds.length === 0) {
      // 没有出处的"知识"没资格被主动推给人：接受它的人无从核实
      offenders.push(`${item.knowledgeId}: no provenance`)
      continue
    }
    if (item.validUntil !== null && item.validUntil.getTime() <= now.getTime()) {
      // 过期的知识主动推送，比不推更糟：它带着系统的背书
      offenders.push(`${item.knowledgeId}: stale since ${item.validUntil.toISOString()}`)
      continue
    }
    usable.push(item)
  }

  return {
    usable,
    verdict: {
      ok: offenders.length === 0,
      reason: offenders.length === 0 ? `${usable.length} recommendations are sourced and current` : 'some recommendations were withheld',
      offenders,
    },
  }
}

// ── FR-AI-010：行动项可一键创建并关联负责人 ──────────────────

export type ActionItem = { text: string; assignee: string | null }

/**
 * 判据只写一次。
 *
 * 之前"留下哪些"和"报告哪些"各写了一遍同一个条件，方向还是相反的
 * （`=== null || === ''` 对 `!== null && !== ''`）。变异测试逮到了这个：
 * 改掉其中一处，另一处仍然把空负责人剔掉了，于是调用方拿到的是
 * **一份少了一条的清单，外加一句"全都有负责人"**——丢东西而不报错，
 * 正是这个项目里最贵的那类 bug。
 */
const hasOwner = (item: ActionItem): boolean => item.assignee !== null && item.assignee !== ''

/**
 * 会议纪要里的行动项要能一键变成 Task。
 *
 * 没有负责人的行动项不允许创建——**"我们应该做 X" 不是行动项**，
 * 它是一句感想。允许它落库的话，任务列表会迅速长满没人负责的条目，
 * 而那会让整个列表失去意义。
 */
export function actionableItems(items: readonly ActionItem[]): {
  actionable: ActionItem[]
  verdict: Verdict
} {
  const offenders = items.filter((i) => !hasOwner(i)).map((i) => i.text.slice(0, 60))
  return {
    actionable: items.filter(hasOwner),
    verdict: {
      ok: offenders.length === 0,
      reason: offenders.length === 0 ? `all ${items.length} action items have an owner` : 'some action items have no owner',
      offenders,
    },
  }
}

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000
}

function pct(value: number): string {
  return `${Math.round(value * 100)}%`
}
