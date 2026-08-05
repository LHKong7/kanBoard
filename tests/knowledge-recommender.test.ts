import { describe, expect, it } from 'vitest'
import { MIN_SCORE, recommendKnowledge } from '../src/domain/ai/knowledge-recommender.ts'
import type { KnowledgeCandidate } from '../src/domain/ai/knowledge-recommender.ts'

/**
 * 知识主动推荐（FR-AI-009）。
 *
 * 这一条曾被记成"要真实模型"。验收标准是「**推荐带出处与时效，
 * 点击率可统计**」——那说的是检索与留痕，不是生成。
 * "主动推荐"要的是把库里已有的知识在对的时候摆到人眼前，
 * 不是现编一段内容。
 *
 * 这一组的主题：**宁可少推，也不要用噪音换展示量。**
 * 一个推错过几次的推荐位，之后就再也没人看了——
 * 而它仍然会在指标上显示"有展示量"。
 */

const NOW = new Date('2026-08-01T00:00:00Z')
const RECENT = new Date('2026-07-01T00:00:00Z')

const candidate = (over: Partial<KnowledgeCandidate> = {}): KnowledgeCandidate => ({
  knowledgeId: 'k1',
  title: '连接池调优',
  text: '连接池数量设置与超时排查',
  sourceIds: ['task_1'],
  validUntil: null,
  hops: 1,
  updatedAt: RECENT,
  ...over,
})

describe('provenance and freshness gate before ranking (FR-AI-009)', () => {
  it('withholds knowledge with no provenance, however relevant', () => {
    // 排完序再筛的话，"扣下了几条"会混进"排在后面"里
    const { items, withheld } = recommendKnowledge(
      '连接池超时',
      [candidate({ sourceIds: [] })],
      NOW,
    )
    expect(items).toEqual([])
    expect(withheld.ok).toBe(false)
    expect(withheld.offenders.join()).toContain('k1')
  })

  it('withholds an expired one and says since when', () => {
    const { items, withheld } = recommendKnowledge(
      '连接池超时',
      [candidate({ validUntil: new Date('2026-01-01T00:00:00Z') })],
      NOW,
    )
    expect(items).toEqual([])
    expect(withheld.offenders.join()).toMatch(/stale/)
  })

  it('recommends one that is sourced and current', () => {
    const { items } = recommendKnowledge('连接池超时怎么排查', [candidate()], NOW)
    expect(items).toHaveLength(1)
    expect(items[0]?.knowledgeId).toBe('k1')
  })
})

describe('ranking uses three signals (FR-AI-009)', () => {
  it('prefers the one whose wording actually overlaps', () => {
    // id 顺序**故意**和期望顺序相反。原来的用例里 'relevant' < 'unrelated'，
    // 于是把词面重合整个从打分里删掉，靠 id 兜底也能排对——变异测试逮到的
    const { items } = recommendKnowledge('连接池超时排查', [
      candidate({ knowledgeId: 'zzz-relevant', title: '连接池超时', text: '连接池超时的排查步骤' }),
      candidate({ knowledgeId: 'aaa-unrelated', title: '前端构建加速', text: '打包缓存与拆包' }),
    ], NOW)
    expect(items[0]?.knowledgeId).toBe('zzz-relevant')
  })

  it('lets graph proximity break a tie the words cannot', () => {
    // 只按关键词匹配的话，看不见同一个项目里刚踩过的坑
    const { items } = recommendKnowledge('连接池超时', [
      candidate({ knowledgeId: 'near', hops: 1 }),
      candidate({ knowledgeId: 'far', hops: 6 }),
    ], NOW)
    expect(items[0]?.knowledgeId).toBe('near')
  })

  it('treats "not connected" as zero, not as "very far"', () => {
    // "没关系"和"关系很远"是两回事。断言的是**分数本身**：
    // 只比顺序的话，把 null 当成"距离一千跳"也排得出同样的顺序，
    // 于是那条规则从来没被真正测到
    const disconnected = recommendKnowledge(
      '连接池超时',
      [candidate({ knowledgeId: 'disconnected', hops: null })],
      NOW,
    ).items[0]
    const veryFar = recommendKnowledge(
      '连接池超时',
      [candidate({ knowledgeId: 'far', hops: 1000 })],
      NOW,
    ).items[0]
    // 一千跳仍然贡献了一点分；不连通**一点都不贡献**
    expect(veryFar?.score).toBeGreaterThan(disconnected?.score ?? 0)
  })

  it('prefers the fresher of two equally relevant notes', () => {
    // 同样：id 顺序故意反着来，否则删掉新鲜度也能靠 id 兜底排对
    const { items } = recommendKnowledge('连接池超时', [
      candidate({ knowledgeId: 'aaa-old', updatedAt: new Date('2023-01-01T00:00:00Z') }),
      candidate({ knowledgeId: 'zzz-new', updatedAt: RECENT }),
    ], NOW)
    expect(items[0]?.knowledgeId).toBe('zzz-new')
  })

  it('does not penalise a long document for being long', () => {
    // 两条都**完整覆盖**了当前问题，区别只是长的那条还讲了别的十件事。
    // 分母取被推那条的词数（最初的写法）会让它得分低一大截，
    // 而长文档往往正是最有用的那种
    const query = '连接池超时排查步骤'
    const short = recommendKnowledge(query, [
      candidate({ knowledgeId: 'short', title: '连接池超时排查步骤', text: '' }),
    ], NOW).items[0]
    const long = recommendKnowledge(query, [
      candidate({
        knowledgeId: 'long',
        title: '连接池超时排查步骤',
        text: '另外还讲了构建缓存、灰度发布、告警分级、值班轮换、容量评估等等一大堆别的东西',
      }),
    ], NOW).items[0]
    expect(long?.score).toBe(short?.score)
  })
})

describe('it would rather say nothing (FR-AI-009)', () => {
  it('drops candidates below the score floor', () => {
    // 一个推错过几次的推荐位，之后就再也没人看了——
    // 而它仍然会在指标上显示"有展示量"
    const { items } = recommendKnowledge('完全无关的话题', [
      candidate({ knowledgeId: 'noise', title: 'xxx', text: 'yyy', hops: null, updatedAt: new Date('2020-01-01T00:00:00Z') }),
    ], NOW)
    expect(items).toEqual([])
  })

  it('keeps the floor visible as a constant', () => {
    expect(MIN_SCORE).toBeGreaterThan(0)
  })

  it('respects the limit', () => {
    const many = Array.from({ length: 20 }, (_, i) => candidate({ knowledgeId: `k${i}` }))
    expect(recommendKnowledge('连接池超时', many, NOW, 3).items).toHaveLength(3)
  })

  it('is deterministic when scores tie', () => {
    // 每次刷新顺序都变的推荐位，人没法回头找上次看到的那条
    const tied = [candidate({ knowledgeId: 'b' }), candidate({ knowledgeId: 'a' })]
    const once = recommendKnowledge('连接池超时', tied, NOW).items.map((i) => i.knowledgeId)
    const twice = recommendKnowledge('连接池超时', [...tied].reverse(), NOW).items.map((i) => i.knowledgeId)
    expect(once).toEqual(twice)
  })
})

describe('every recommendation carries a readable reason (FR-AI-009)', () => {
  it('says which signal actually drove it', () => {
    // "因为词面重合 0.42、图距离 2、新鲜度 0.8" 对使用者没有任何帮助
    const { items } = recommendKnowledge('连接池超时排查', [
      candidate({ title: '连接池超时', text: '连接池超时排查' }),
    ], NOW)
    expect(items[0]?.reason).toMatch(/措辞重合/)
  })

  it('falls back to proximity when the words do not match', () => {
    const { items } = recommendKnowledge('毫不相干', [
      candidate({ knowledgeId: 'near', title: 'x', text: 'y', hops: 0, updatedAt: new Date('2019-01-01T00:00:00Z') }),
    ], NOW)
    expect(items[0]?.reason).toMatch(/跳/)
  })

  it('never emits an empty reason', () => {
    const { items } = recommendKnowledge('连接池超时', [candidate(), candidate({ knowledgeId: 'k2' })], NOW)
    for (const item of items) expect(item.reason.length).toBeGreaterThan(0)
  })
})
