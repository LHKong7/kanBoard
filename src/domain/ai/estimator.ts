import { keyTerms } from './capabilities.ts'

/**
 * 自动估点并给出类比依据（FR-AI-003）。
 *
 * 这一条最后一个被记成"要真实模型"。它确实需要**数据**，但不需要**生成**：
 * 「给出类比依据」这句话本身就说明了做法——**找出以前做过的相似的事，
 * 看它们当时是几点**。那是检索加统计，不是语言生成。
 *
 * 验收标准是「中位偏差 ≤ 1 档（3 迭代样本）」。同一张需求表里
 * FR-AI-008 写的是「识别率 100%（**测试集**）」——也就是说，
 * PRD 自己认可用测试集来验准确度类的指标。这里照办：
 * 语料是种出来的，划分是留出法，偏差是算出来的。
 * **语料是种的这件事写在文档里**，别让人以为它跑过生产数据。
 *
 * 为什么不用模型：估点的可信度来自"凭什么这么估"。
 * 模型给一个数字加一段说辞，人无从核对；给出三条以前的相似任务
 * 和它们当时的点数，人能一眼判断这个类比成不成立——
 * **而能被判断的估算才有资格影响排期。**
 */

/** 估点档位。Fibonacci：相邻档之间的差要大到人能分辨，否则"3 还是 4"会吵一下午 */
export const BANDS = [1, 2, 3, 5, 8, 13, 21] as const

export type EstimatedStory = {
  id: string
  title: string
  /** 用于比对的正文 */
  text: string
  /** 已知点数。语料里必须有；被估的那条不需要 */
  points?: number
}

export type Analogy = {
  id: string
  title: string
  points: number
  /** 0..1。**要展示出来**：一个 0.12 的"类比"人一眼就知道不能信 */
  similarity: number
}

export type Estimate = {
  points: number
  /** 依据。空数组表示**没找到可比的**，而不是"随便估了一个" */
  analogies: readonly Analogy[]
  /** 一句能读的依据 */
  rationale: string
  /** 找不到相似的就没有估算。**不猜** */
  confident: boolean
}

/** 相似度低于这个不算类比。凑数的类比比没有类比更糟：它让估算看起来有依据 */
export const MIN_SIMILARITY = 0.12

/** 取最近的几条。太少一条离群点就带偏，太多会把不相干的拉进来 */
export const NEIGHBOURS = 3

/**
 * 估一条 Story 的点数。
 *
 * 用**中位数**而不是平均数：一条被错标成 21 点的历史任务，
 * 平均数会被它拽走一大截，中位数不会。历史数据里一定有标错的。
 */
export function estimate(
  target: EstimatedStory,
  corpus: readonly EstimatedStory[],
  neighbours = NEIGHBOURS,
): Estimate {
  const targetTerms = new Set(keyTerms(`${target.title} ${target.text}`))

  const scored = corpus
    .filter((s) => s.id !== target.id && typeof s.points === 'number')
    .map((s) => ({
      story: s,
      similarity: similarityOf(targetTerms, keyTerms(`${s.title} ${s.text}`)),
    }))
    .filter((x) => x.similarity >= MIN_SIMILARITY)
    // 同分时按 id 定序，否则同一条输入两次会给出不同的依据
    .sort((a, b) => b.similarity - a.similarity || a.story.id.localeCompare(b.story.id))
    .slice(0, neighbours)

  if (scored.length === 0) {
    // **没有可比的就不估。** 给一个默认值（比如中位档）会让人以为
    // 系统看过历史了，而它什么也没看到
    return {
      points: 0,
      analogies: [],
      rationale: '没有找到可比的历史任务，无法给出有依据的估算',
      confident: false,
    }
  }

  const analogies: Analogy[] = scored.map((x) => ({
    id: x.story.id,
    title: x.story.title,
    points: x.story.points ?? 0,
    similarity: round(x.similarity),
  }))

  const points = snapToBand(median(analogies.map((a) => a.points)))
  return {
    points,
    analogies,
    rationale: `与 ${analogies.length} 条历史任务相似（最接近的是「${analogies[0]?.title}」，当时 ${analogies[0]?.points} 点）`,
    confident: true,
  }
}

/**
 * 相似度：**当前这条**的词里有多少被历史那条覆盖。
 *
 * 分母取被估的那条，和知识推荐那边同一个理由：
 * 除以历史那条的词数会让内容详尽的历史任务吃亏，
 * 而写得详细的历史任务恰恰是最好的类比对象。
 */
function similarityOf(targetTerms: ReadonlySet<string>, candidateTerms: readonly string[]): number {
  if (targetTerms.size === 0) return 0
  const candidate = new Set(candidateTerms)
  const hits = [...targetTerms].filter((t) => candidate.has(t)).length
  return hits / targetTerms.size
}

/**
 * 落到最近的档位。档与档之间没有中间值——"4 点"在这个体系里不存在。
 *
 * **正好卡在两档中间时往上取。** 4 到 3 和到 5 都是 1，
 * 用 `<` 会静悄悄地取 3——而估少了的代价比估多了大得多：
 * 估多了这个迭代少排一件事，估少了是承诺了做不完的量，
 * 而那要到迭代末尾才暴露出来。用 `<=` 让这个偏向成为一个写下来的决定。
 */
export function snapToBand(value: number): number {
  let best: number = BANDS[0]
  let bestGap = Math.abs(value - best)
  for (const band of BANDS) {
    const gap = Math.abs(value - band)
    if (gap <= bestGap) {
      best = band
      bestGap = gap
    }
  }
  return best
}

/** 两个档位差几档。验收标准说的"1 档"就是这个 */
export function bandDistance(a: number, b: number): number {
  const ia = BANDS.indexOf(snapToBand(a) as (typeof BANDS)[number])
  const ib = BANDS.indexOf(snapToBand(b) as (typeof BANDS)[number])
  return Math.abs(ia - ib)
}

export type Evaluation = {
  /** 中位偏差，单位是**档**。验收标准要 ≤ 1 */
  medianBandDeviation: number
  /** 估出来的条数。**没估的不算进中位数**，否则弃权会拉高分数 */
  estimated: number
  /** 找不到类比而弃权的条数。这个数字大本身就是个问题 */
  abstained: number
  perStory: readonly { id: string; actual: number; predicted: number; bands: number }[]
}

/**
 * 留出法评估（FR-AI-003 的「中位偏差 ≤ 1 档」）。
 *
 * **弃权的不计入中位偏差，但要单独报出来。** 计入的话，
 * 一个"只在特别有把握时才估"的系统会拿到一个漂亮的中位数，
 * 而它实际上什么忙也没帮上；反过来把弃权当成"偏差很大"，
 * 又会逼着系统去猜——而猜出来的估点比没有估点更糟。
 */
export function evaluate(
  holdout: readonly EstimatedStory[],
  corpus: readonly EstimatedStory[],
  neighbours = NEIGHBOURS,
): Evaluation {
  const perStory: { id: string; actual: number; predicted: number; bands: number }[] = []
  let abstained = 0

  for (const story of holdout) {
    const actual = story.points
    if (typeof actual !== 'number') continue
    const result = estimate(story, corpus, neighbours)
    if (!result.confident) {
      abstained++
      continue
    }
    perStory.push({
      id: story.id,
      actual,
      predicted: result.points,
      bands: bandDistance(actual, result.points),
    })
  }

  return {
    medianBandDeviation: perStory.length === 0 ? Infinity : median(perStory.map((p) => p.bands)),
    estimated: perStory.length,
    abstained,
    perStory,
  }
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  // 偶数个取中间两个的平均。取靠左那个会让偏差系统性偏小
  return sorted.length % 2 === 0 ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2 : (sorted[mid] ?? 0)
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000
}
