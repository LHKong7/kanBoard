import { describe, expect, it } from 'vitest'
import {
  BANDS,
  bandDistance,
  estimate,
  evaluate,
  MIN_SIMILARITY,
  NEIGHBOURS,
  snapToBand,
} from '../src/domain/ai/estimator.ts'
import { ALL, CORPUS, HOLDOUT } from './fixtures/estimation-corpus.ts'

/**
 * 自动估点并给出类比依据（FR-AI-003）。
 *
 * 验收标准：**中位偏差 ≤ 1 档（3 迭代样本）。**
 *
 * 这一条最后一个被记成"要真实模型"。它确实需要**数据**，但不需要**生成**：
 * 「给出类比依据」本身就说明了做法——找出以前做过的相似的事，
 * 看它们当时是几点。检索加统计。
 *
 * ⚠️ 语料是种出来的（`tests/fixtures/estimation-corpus.ts`），不是生产数据。
 * 同一张需求表里 FR-AI-008 用的也是「测试集」，PRD 认可这种验证方式，
 * 但**别把下面那个中位偏差读成"在真实项目上验证过"**。
 */

describe('the acceptance bar itself (FR-AI-003)', () => {
  it('holds median band deviation at or under 1 across the held-out iteration', () => {
    const result = evaluate(HOLDOUT, CORPUS)
    expect(result.medianBandDeviation).toBeLessThanOrEqual(1)
  })

  it('actually estimated most of the held-out set — abstaining is not a way to win', () => {
    // 弃权不计入中位偏差，所以一个"只在特别有把握时才估"的系统
    // 会拿到漂亮的中位数而实际什么忙也没帮上。这条断言堵住那条路
    const result = evaluate(HOLDOUT, CORPUS)
    expect(result.estimated).toBeGreaterThanOrEqual(HOLDOUT.length - 2)
  })

  it('reports how many it declined to estimate', () => {
    // 这个数字大本身就是个问题，必须看得见
    const result = evaluate(HOLDOUT, CORPUS)
    expect(result.abstained).toBeGreaterThanOrEqual(1) // 机房搬迁那条
  })

  it('does not report a perfect score when it estimated nothing', () => {
    // `median([])` 是 0，于是一个什么都没估的评估会显示"中位偏差 0 档"——
    // **完美地通过了验收标准，而它一条都没算过**。
    // 这是这一组里最危险的一种失败：它看起来是最好的结果
    const nothing = evaluate([], CORPUS)
    expect(nothing.medianBandDeviation).toBe(Infinity)
    expect(nothing.estimated).toBe(0)

    // 全部弃权也一样
    const allAbstained = evaluate(
      [{ id: 'z', title: '机房搬迁演练', text: '协调网络割接窗口', points: 21 }],
      CORPUS,
    )
    expect(allAbstained.medianBandDeviation).toBe(Infinity)
  })

  it('shows the per-story deviation so a bad estimate can be traced', () => {
    const result = evaluate(HOLDOUT, CORPUS)
    for (const row of result.perStory) {
      expect(row.bands).toBe(bandDistance(row.actual, row.predicted))
    }
  })
})

describe('the estimate carries its analogy (FR-AI-003)', () => {
  it('names the past stories it reasoned from', () => {
    // 模型给一个数字加一段说辞，人无从核对；给出三条以前的相似任务
    // 和它们当时的点数，人能一眼判断这个类比成不成立
    const result = estimate(
      { id: 'new', title: '导出发票为 PDF', text: '生成 PDF 文件，包含明细与合计' },
      CORPUS,
    )
    expect(result.confident).toBe(true)
    expect(result.analogies.length).toBeGreaterThan(0)
    expect(result.analogies.map((a) => a.title).join()).toMatch(/PDF/)
  })

  it('shows the similarity, so a weak analogy is visible as one', () => {
    // 一个 0.12 的"类比"人一眼就知道不能信
    const result = estimate(
      { id: 'new', title: '导出发票为 PDF', text: '生成 PDF 文件，包含明细与合计' },
      CORPUS,
    )
    for (const a of result.analogies) {
      expect(a.similarity).toBeGreaterThanOrEqual(MIN_SIMILARITY)
      expect(a.similarity).toBeLessThanOrEqual(1)
    }
  })

  it('reads as a sentence, not as three numbers', () => {
    const result = estimate(
      { id: 'new', title: '导出发票为 CSV', text: '生成 CSV 文件，包含明细' },
      CORPUS,
    )
    expect(result.rationale).toMatch(/相似/)
    expect(result.rationale).toMatch(/点/)
  })
})

describe('the analogy set is bounded and stable (FR-AI-003)', () => {
  it('shows at most the nearest few, not every match', () => {
    // 十几条"依据"和没有依据是一回事——没人会逐条看
    const result = estimate(
      { id: 'new', title: '导出发票为 PDF', text: '生成 PDF 文件，包含明细与合计' },
      CORPUS,
    )
    expect(result.analogies.length).toBeLessThanOrEqual(NEIGHBOURS)
  })

  it('gives the same analogies for the same input, whatever order history arrives in', () => {
    // 同一条需求刷新两次给出不同依据的话，人没法拿它去讨论
    const target = { id: 'new', title: '导出发票为 CSV', text: '生成 CSV 文件，包含明细' }
    const forward = estimate(target, CORPUS).analogies.map((a) => a.id)
    const backward = estimate(target, [...CORPUS].reverse()).analogies.map((a) => a.id)
    expect(forward).toEqual(backward)
  })

  it('does not penalise a detailed history entry for being detailed', () => {
    // 分母取历史那条的词数，会让写得详细的历史任务相似度偏低——
    // 而写得详细的历史任务恰恰是最好的类比对象。
    // 两条都完整覆盖了当前需求，区别只是详细的那条还写了别的
    const target = { id: 'x', title: '导出账单为 PDF', text: '' }
    const terse = estimate(target, [
      { id: 'terse', title: '导出账单为 PDF', text: '', points: 8 },
    ])
    const detailed = estimate(target, [
      {
        id: 'detailed',
        title: '导出账单为 PDF',
        text: '另外还处理了分页、水印、字体嵌入、大文件分片以及失败重试等等一堆事情',
        points: 8,
      },
    ])
    expect(detailed.analogies[0]?.similarity).toBe(terse.analogies[0]?.similarity)
  })
})

describe('it declines rather than guesses (FR-AI-003)', () => {
  it('abstains when nothing in history is comparable', () => {
    // 给一个默认值会让人以为系统看过历史了，而它什么也没看到
    const result = estimate({ id: 'x', title: '机房搬迁演练', text: '协调网络割接窗口与回滚方案' }, CORPUS)
    expect(result.confident).toBe(false)
    expect(result.points).toBe(0)
    expect(result.analogies).toEqual([])
    expect(result.rationale).toMatch(/没有找到可比/)
  })

  it('abstains on an empty corpus instead of inventing a median', () => {
    const result = estimate({ id: 'x', title: '导出账单为 PDF', text: '生成 PDF' }, [])
    expect(result.confident).toBe(false)
  })

  it('ignores history that has no points recorded', () => {
    const unlabelled = [{ id: 'h1', title: '导出账单为 PDF', text: '生成 PDF 文件，包含明细与合计' }]
    expect(estimate({ id: 'x', title: '导出发票为 PDF', text: '生成 PDF 文件' }, unlabelled).confident).toBe(
      false,
    )
  })

  it('never uses the story itself as its own analogy', () => {
    // 语料里已经有这一条时，拿它自己当依据会得到一个完美但毫无意义的估算
    const target = CORPUS[0]!
    const result = estimate(target, CORPUS)
    expect(result.analogies.map((a) => a.id)).not.toContain(target.id)
  })
})

describe('one mislabelled record does not move the answer (FR-AI-003)', () => {
  it('uses the median, so a 13-point outlier among small tasks is outvoted', () => {
    // 历史数据里一定有标错的。平均数会被它拽走一大截
    const poisoned = [
      { id: 'a', title: '加一个只读字段', text: '多返回一个字段', points: 1 },
      { id: 'b', title: '再加一个只读字段', text: '多返回一个字段', points: 1 },
      { id: 'c', title: '又加一个只读字段', text: '多返回一个字段', points: 13 },
    ]
    const result = estimate({ id: 'x', title: '还加一个只读字段', text: '多返回一个字段' }, poisoned)
    expect(result.points).toBe(1)
  })

  it('survives the mislabelled row that is deliberately in the corpus', () => {
    // s3-08 是一条明显的小活被标成 13 点。它在留出集里，
    // 会贡献一个大偏差——而中位数应当扛得住
    const result = evaluate(HOLDOUT, CORPUS)
    const bad = result.perStory.find((p) => p.id === 's3-08')
    expect(bad?.actual).toBe(13)
    expect(bad?.bands).toBeGreaterThan(1) // 它自己确实估错了
    expect(result.medianBandDeviation).toBeLessThanOrEqual(1) // 但中位数没被带走
  })
})

describe('bands are bands (FR-AI-003)', () => {
  it('snaps to the nearest band — "4 点" does not exist', () => {
    expect(snapToBand(2.4)).toBe(2)
    expect(snapToBand(100)).toBe(21)
  })

  it('rounds up when a value sits exactly between two bands', () => {
    // 4 到 3 和到 5 都是 1。往下取的代价比往上取大得多：
    // 估多了这个迭代少排一件事，估少了是承诺了做不完的量，
    // 而那要到迭代末尾才暴露出来
    expect(snapToBand(4)).toBe(5)
    expect(snapToBand(1.5)).toBe(2)
    expect(snapToBand(10.5)).toBe(13)
  })

  it('measures deviation in bands, not in points', () => {
    // 验收标准说的是"1 档"。按点数算的话 8 和 13 差 5，
    // 听起来很糟，实际只差一档
    expect(bandDistance(8, 13)).toBe(1)
    expect(bandDistance(1, 2)).toBe(1)
    expect(bandDistance(1, 13)).toBe(5)
    expect(bandDistance(5, 5)).toBe(0)
  })

  it('keeps the ladder visible', () => {
    expect([...BANDS]).toEqual([1, 2, 3, 5, 8, 13, 21])
  })
})

describe('the sample is three iterations, as the criterion says', () => {
  it('evaluates against a genuinely held-out iteration', () => {
    // 留出集不能出现在训练语料里，否则这个测试测的是"能不能背下来"
    const corpusIds = new Set(CORPUS.map((s) => s.id))
    for (const story of HOLDOUT) expect(corpusIds.has(story.id)).toBe(false)
    expect(ALL).toHaveLength(CORPUS.length + HOLDOUT.length)
  })
})
