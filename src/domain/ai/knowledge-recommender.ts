import { keyTerms, usableRecommendations } from './capabilities.ts'
import type { Recommendation, Verdict } from './capabilities.ts'

/**
 * 知识主动推荐（FR-AI-009）。
 *
 * 这一条也曾被记成"要真实模型"。验收标准是「**推荐带出处与时效，
 * 点击率可统计**」——那说的是检索与留痕，不是生成。
 * "主动推荐"要的是把库里已有的知识在对的时候摆到人眼前，
 * 而不是现编一段内容。
 *
 * 排序是确定性的，而且**理由要能读**。一个说不出为什么推这条的推荐系统，
 * 用户第一次点错之后就再也不看它了——而它仍然会在指标上显示"有展示量"。
 *
 * 三个信号，各自防一种失败：
 *
 *   词面重合   防"推了一堆无关的"
 *   图上相邻   防"只会按关键词匹配，看不见同一个项目里刚踩过的坑"
 *   新鲜度     防"推了一条三年前的、当时是对的"
 */

export type KnowledgeCandidate = Recommendation & {
  /** 用于词面比对的正文 */
  text: string
  /**
   * 图上距离：这条知识和当前对象隔几跳。
   * `null` 表示图上不连通——不是"很远"，是"没关系"，两者要分开
   */
  hops: number | null
  updatedAt: Date
}

export type Ranked = {
  knowledgeId: string
  title: string
  score: number
  /** 为什么推这条。**说不出理由就不推** */
  reason: string
}

/** 每一档的权重。写成常量而不是散在算式里：口径要能被指着讨论 */
export const WEIGHTS = { overlap: 1, proximity: 0.6, freshness: 0.3 } as const

/** 排序分低于这个就不推。**宁可少推，也不要用噪音换展示量** */
export const MIN_SCORE = 0.15

/** 多久之前的知识开始被视为"旧"。到期与"旧"是两件事 */
const STALE_AFTER_DAYS = 365

export function recommendKnowledge(
  subjectText: string,
  candidates: readonly KnowledgeCandidate[],
  now: Date,
  limit = 5,
): { items: readonly Ranked[]; withheld: Verdict } {
  // 先过出处与时效这道闸（FR-AI-009 的原文）。**这一步在排序之前**：
  // 一条没有出处的知识不该因为分数高就被推出去，而排完序再筛
  // 会让"扣下了几条"这个信息混进"排在后面"里
  const { usable, verdict } = usableRecommendations(candidates, now)
  const usableIds = new Set(usable.map((u) => u.knowledgeId))

  const subjectTerms = new Set(keyTerms(subjectText))
  const items: Ranked[] = []

  for (const candidate of candidates) {
    if (!usableIds.has(candidate.knowledgeId)) continue

    const terms = new Set(keyTerms(`${candidate.title} ${candidate.text}`))
    const hits = [...subjectTerms].filter((t) => terms.has(t)).length
    // 分母是**当前对象**的词数，不是被推那条的，也不是两者的并集。
    //
    // 问的是"这条知识覆盖了我正在看的东西的多少"。除以被推那条的词数
    // （最初就是这么写的）会让长文档天然吃亏——一篇覆盖了全部问题、
    // 但还讲了别的十件事的文档，得分反而低于一句正好对上的短笔记，
    // 而长文档往往正是最有用的那种。注释当时写的就是这个理由，
    // 代码做的却是相反的事，是变异测试把这处不一致翻出来的。
    const overlap = subjectTerms.size === 0 ? 0 : hits / subjectTerms.size

    // 越近越高。不连通给 0，不是给一个很小的正数——
    // "没关系"和"关系很远"是两回事
    const proximity = candidate.hops === null ? 0 : 1 / (1 + candidate.hops)

    const ageDays = (now.getTime() - candidate.updatedAt.getTime()) / 86_400_000
    const freshness = Math.max(0, 1 - ageDays / STALE_AFTER_DAYS)

    const score = round(
      overlap * WEIGHTS.overlap + proximity * WEIGHTS.proximity + freshness * WEIGHTS.freshness,
    )
    if (score < MIN_SCORE) continue

    items.push({
      knowledgeId: candidate.knowledgeId,
      title: candidate.title,
      score,
      reason: reasonFor({ overlap, hits, proximity, hops: candidate.hops, freshness }),
    })
  }

  items.sort((a, b) => b.score - a.score || a.knowledgeId.localeCompare(b.knowledgeId))
  return { items: items.slice(0, limit), withheld: verdict }
}

/**
 * 把分数翻译成一句人话。
 *
 * 说的是**最强的那个信号**，不是把三个都念一遍：
 * "因为词面重合 0.42、图距离 2、新鲜度 0.8" 对使用者没有任何帮助。
 */
function reasonFor(signals: {
  overlap: number
  hits: number
  proximity: number
  hops: number | null
  freshness: number
}): string {
  const ranked: { weight: number; text: string }[] = [
    { weight: signals.overlap * WEIGHTS.overlap, text: `和当前内容有 ${signals.hits} 处措辞重合` },
    {
      weight: signals.proximity * WEIGHTS.proximity,
      text: signals.hops === null ? '' : `在图上距当前对象 ${signals.hops} 跳`,
    },
    { weight: signals.freshness * WEIGHTS.freshness, text: '最近更新过' },
  ].filter((r) => r.text !== '')

  ranked.sort((a, b) => b.weight - a.weight)
  return ranked[0]?.text ?? '相关'
}

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000
}
