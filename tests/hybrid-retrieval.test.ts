import { describe, expect, it } from 'vitest'
import {
  answer,
  cosine,
  GROUNDING_MIN,
  groundingRate,
  learnExpansion,
  MIN_SCORE,
  vectorize,
} from '../src/domain/retrieval/hybrid.ts'
import type { Doc } from '../src/domain/retrieval/hybrid.ts'

/**
 * 图 + 向量混合检索，答案带出处（FR-ONT-011 / FR-RES-009）。
 *
 * 两条需求的验收标准都落在**出处**上，不在"答得好不好"上：
 * 「抽样问答中 ≥ 90% 返回可点击的来源实体」「结果含来源实体 ID，可点击跳转」。
 * 那是可判定的，所以这一组不需要模型。
 *
 * 主题：**一句读起来很像答案、却指不回任何实体的话，是最坏的产出。**
 * 它会被复制进周报，而没有人能追溯它是从哪儿来的。
 */

const docs: Doc[] = [
  {
    id: 'know_1',
    type: 'Knowledge',
    title: '连接池调优',
    text: '连接池数量设置过小会导致请求排队，超时排查从这里开始',
    hops: 1,
  },
  {
    id: 'know_2',
    type: 'Knowledge',
    title: '数据库连接排队',
    text: '请求排队与等待时间上升，通常来自连接数量不足',
    hops: 2,
  },
  {
    id: 'task_1',
    type: 'Task',
    title: '前端构建加速',
    text: '打包缓存与拆包策略',
    hops: null,
  },
  {
    id: 'know_3',
    type: 'Knowledge',
    title: 'PROJ-1234 事故复盘',
    text: '事故编号 PROJ-1234，根因是配置漂移',
    hops: 3,
  },
]

describe('every passage points back at an entity (FR-ONT-011 / FR-RES-009)', () => {
  it('carries the source id, type and title', () => {
    const result = answer('连接池 超时 排查', docs)
    expect(result.passages.length).toBeGreaterThan(0)
    for (const p of result.passages) {
      expect(p.sourceId).toBeTruthy()
      expect(p.sourceType).toBeTruthy()
      expect(p.sourceTitle).toBeTruthy()
    }
  })

  it('exposes the deduplicated source ids for the UI to link', () => {
    const result = answer('连接池 超时 排查', docs)
    expect(new Set(result.sourceIds).size).toBe(result.sourceIds.length)
    expect(result.sourceIds).toContain('know_1')
  })

  it('returns nothing rather than an answer with no source', () => {
    // 拿不出出处就返回空。**这不是失败，是正确的答案**
    const result = answer('完全无关的话题 xyzzy', docs)
    expect(result.passages).toEqual([])
    expect(result.sourceIds).toEqual([])
    expect(result.grounded).toBe(false)
  })

  it('never yields a passage without a source id', () => {
    // 这个组合绝不允许出现——它正是"没有出处的答案"
    for (const q of ['连接池', '排队', 'PROJ-1234', '构建']) {
      for (const p of answer(q, docs).passages) expect(p.sourceId).not.toBe('')
    }
  })

  it('quotes an excerpt, not the whole document', () => {
    // 答案里塞进整份文档，"带出处"就退化成"给你全文自己找"
    const long = [{ ...docs[0]!, text: 'x'.repeat(5000) }]
    expect(answer('连接池调优', long).passages[0]?.text.length).toBeLessThanOrEqual(300)
  })
})

describe('two recall routes plus a re-ranker (FR-ONT-011)', () => {
  it('lexical finds an exact identifier that vectors would blur', () => {
    const result = answer('PROJ-1234', docs)
    expect(result.sourceIds).toContain('know_3')
  })

  it('vectors match a document that shares no wording at all', () => {
    // **这条是向量那一路唯一能证明自己的地方**：字面零重合。
    // 语料里"熔断"和"降级"反复一起出现，于是问"熔断"能命中只写了
    // "降级"的那篇——词面对此无能为力。
    //
    // 前两版这条是测不出来的：向量先是按同一批词做的，
    // 后来换成字符三元组，还是同一批字符的另一个 n-gram 尺度，
    // 于是两路总是同时命中。变异测试两次把任一路清零都全绿——
    // "混合"当时是个名字，不是一个事实
    const corpus: Doc[] = [
      { id: 'a', type: 'Knowledge', title: '熔断与降级', text: '熔断触发后降级到只读', hops: null },
      { id: 'b', type: 'Knowledge', title: '降级预案', text: '降级到只读，熔断阈值配置', hops: null },
      { id: 'c', type: 'Knowledge', title: '只读降级演练', text: '降级 熔断 演练记录', hops: null },
      { id: 'target', type: 'Knowledge', title: '降级', text: '降级', hops: null },
    ]
    const expansion = learnExpansion(corpus)
    // 问句只有"熔断"，target 里一个"熔断"都没有
    const result = answer('熔断', [corpus[3]!], 5, expansion)
    expect(result.sourceIds).toEqual(['target'])
    expect(result.passages[0]?.via).toEqual(['vector'])
  })

  it('the lexical route stands on its own when nothing co-occurs', () => {
    const result = answer('PROJ-1234', docs)
    expect(result.passages[0]?.via).toContain('lexical')
    expect(result.sourceIds).toContain('know_3')
  })

  it('weights an expanded term below the real thing', () => {
    // 给一样的权重的话，一次扩展就能把一篇原词一个都没有的文档顶到第一。
    // 两篇都**只靠向量那一路**命中（词面都是 0），于是比的就是权重本身
    const corpus: Doc[] = [
      { id: 'c1', type: 'Knowledge', title: '熔断 降级', text: '熔断 降级', hops: null },
      { id: 'c2', type: 'Knowledge', title: '熔断 降级', text: '熔断 降级', hops: null },
    ]
    const expansion = learnExpansion(corpus)
    // 直接看权重：扩展项必须**严格轻于**原词。
    // 只比两次检索的总分是测不出来的——词面那一路会先把它们分开
    const v = vectorize('熔断', expansion)
    const original = v.get('熔断') ?? 0
    for (const [term, weight] of v) {
      if (term === '熔断') continue
      expect(weight).toBeLessThan(original)
    }
    expect(v.size).toBeGreaterThan(1) // 确实扩展出了东西，不是空跑
  })

  it('does not let an expansion overwrite a term the question really used', () => {
    // 「降级」既是问句里的原词，又是「熔断」的扩展项。
    // 不判断的话，原词的权重会被压低成扩展项的权重
    const corpus: Doc[] = [
      { id: 'c1', type: 'Knowledge', title: '熔断 降级', text: '熔断 降级', hops: null },
      { id: 'c2', type: 'Knowledge', title: '熔断 降级', text: '熔断 降级', hops: null },
    ]
    const expansion = learnExpansion(corpus)
    const v = vectorize('熔断 降级', expansion)
    expect(v.get('降级')).toBe(1)
  })

  it('drops a match that is real but far too weak to show', () => {
    // 文字上**确实沾了一点**（所以 textual > 0 那道闸拦不住它），
    // 但一个几十词的问句里只对上一个词，这条不该进答案。
    // 下限就是为这种情况存在的
    // 填充词故意用**互不重合**的拉丁词。第一版用的是 `问句词0` /
    // `正文词0` 这种，而它们共享 `词0` 这个双字——所谓"无关"的两段文本
    // 其实高度重合，实测反而比真命中还高分。**造 fixture 也会造错，
    // 而造错的 fixture 会让人以为代码错了。**
    const filler = 'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa quebec romeo sierra tango'
    const question = `${filler} 连接池`
    // 一篇讲别的事、只不过碰巧也出现过"连接"两个字的文档
    const faint: Doc[] = [
      { id: 'faint', type: 'Task', title: '机房搬迁', text: '连接 nebula quasar pulsar', hops: null },
    ]
    // 实测：这种约 0.10，而一次货真价实的命中在 0.7 以上
    expect(answer(question, faint, 5, new Map()).passages).toEqual([])
  })

  it('the lexical route changes the ranking, not just the recall', () => {
    // 余弦按**文档**长度归一，词面按**问句**长度归一——方向不同。
    // 这一对刻意造成两者结论相反：A 只覆盖一半问句但用词集中，
    // B 覆盖全部问句却被稀释。去掉词面那一路，顺序就反过来
    const a: Doc = { id: 'a', type: 'Task', title: '甲甲 甲甲 甲甲', text: '', hops: null }
    const b: Doc = { id: 'b', type: 'Task', title: '甲甲 乙乙 丙丙 丁丁 戊戊 己己 庚庚', text: '', hops: null }
    const ranked = answer('甲甲 乙乙', [a, b], 5, new Map()).passages.map((p) => p.sourceId)
    expect(ranked[0]).toBe('b')
  })

  it('graph proximity lifts a doc that is close to the current topic', () => {
    const near = { ...docs[0]!, id: 'near', hops: 0 }
    const far = { ...docs[0]!, id: 'far', hops: 8 }
    const result = answer('连接池 超时', [far, near])
    expect(result.passages[0]?.sourceId).toBe('near')
  })

  it('treats "not connected" as zero, not as "very far"', () => {
    const disconnected = answer('连接池 超时', [{ ...docs[0]!, id: 'x', hops: null }]).passages[0]
    const veryFar = answer('连接池 超时', [{ ...docs[0]!, id: 'x', hops: 1000 }]).passages[0]
    expect(veryFar?.score).toBeGreaterThan(disconnected?.score ?? 0)
  })

  it('breaks a tie deterministically', () => {
    // 两篇一模一样、只有 id 不同。不定序的话，同一个问题两次刷新
    // 给出不同的第一条，而人会以为内容变了
    const twins: Doc[] = [
      { id: 'zzz', type: 'Knowledge', title: '连接池调优', text: '排查', hops: 1 },
      { id: 'aaa', type: 'Knowledge', title: '连接池调优', text: '排查', hops: 1 },
    ]
    expect(answer('连接池 调优 排查', twins).passages.map((p) => p.sourceId)).toEqual(['aaa', 'zzz'])
  })

  it('records which route found it, so tuning has something to look at', () => {
    const result = answer('连接池 超时 排查', docs)
    expect(result.passages[0]?.via.length).toBeGreaterThan(0)
    expect(result.passages[0]?.via).toContain('lexical')
  })

  it('keeps the score floor visible as a constant', () => {
    expect(MIN_SCORE).toBeGreaterThan(0)
  })
})

describe('the vector half is deterministic and local (FR-ONT-011)', () => {
  it('gives identical results for identical input', () => {
    // 接真 embedding 之前，同样的输入必须永远给同样的结果——
    // 否则"为什么这次没搜到"永远查不清
    expect(answer('连接池', docs).sourceIds).toEqual(answer('连接池', docs).sourceIds)
  })

  it('scores an identical text as 1', () => {
    const v = vectorize('连接池 超时 排查')
    expect(cosine(v, v)).toBeCloseTo(1, 6)
  })

  it('scores disjoint texts as 0', () => {
    expect(cosine(vectorize('连接池调优'), vectorize('前端构建加速'))).toBe(0)
  })

  it('learns the same expansion table from the same corpus, every time', () => {
    // 不定序的话，同一份语料两次学出不同的扩展表，
    // 而"为什么这次搜到了、上次没搜到"就永远查不清
    const a = learnExpansion(docs)
    const b = learnExpansion([...docs].reverse())
    for (const [term, row] of a) {
      expect([...(b.get(term) ?? [])].sort()).toEqual([...row].sort())
    }
  })

  it('keeps a stable top-N when several terms tie on frequency', () => {
    // 并列时不定序的话，截断留下的是哪几个每次都可能不同——
    // 于是同一个问句时灵时不灵
    // 六个并列的词，但**每篇文档里的出现顺序都不同**。
    // 只把文档数组倒过来是测不出来的——同一篇文档里的词序没变
    const orders = [
      '核心词 甲甲 乙乙 丙丙 丁丁 戊戊 己己',
      '核心词 己己 戊戊 丁丁 丙丙 乙乙 甲甲',
      '核心词 丙丙 甲甲 己己 乙乙 戊戊 丁丁',
    ]
    const build = (list: string[]): Doc[] =>
      list.map((title, i) => ({ id: `d${i}`, type: 'Task', title, text: '', hops: null }))
    const first = [...(learnExpansion(build(orders)).get('核心') ?? [])].map(([t]) => t)
    const again = [...(learnExpansion(build([...orders].reverse())).get('核心') ?? [])].map(([t]) => t)
    expect(first).toEqual(again)
    expect(first.length).toBeGreaterThan(0)
  })

  it('does not relate two terms that met only once', () => {
    // 一次共现是巧合。当成相关的话，扩展表会被噪音塞满
    const once: Doc[] = [{ id: 'x', type: 'Task', title: '孤例甲 孤例乙', text: '', hops: null }]
    expect(learnExpansion(once).size).toBe(0)
  })

  it('is symmetric', () => {
    const a = vectorize('连接池 超时')
    const b = vectorize('连接池 排队 超时')
    expect(cosine(a, b)).toBeCloseTo(cosine(b, a), 10)
  })

  it('handles an empty side without dividing by zero', () => {
    expect(cosine(vectorize(''), vectorize('连接池'))).toBe(0)
  })
})

describe('the acceptance bar: ≥90% of answerable questions carry a source (FR-ONT-011)', () => {
  const samples = [
    { question: '连接池 超时 怎么 排查', answerable: true },
    { question: '连接 数量 不足 排队', answerable: true },
    { question: 'PROJ-1234 根因', answerable: true },
    { question: '前端 构建 加速', answerable: true },
    { question: '打包 缓存 拆包', answerable: true },
    { question: '连接池 调优', answerable: true },
    { question: '事故 复盘 配置 漂移', answerable: true },
    { question: '请求 排队 等待', answerable: true },
    { question: '连接池 数量 设置', answerable: true },
    { question: '超时 排查 开始', answerable: true },
  ]

  it('meets the bar', () => {
    const result = groundingRate(samples, docs)
    expect(result.rate).toBeGreaterThanOrEqual(GROUNDING_MIN)
    expect(result.ok).toBe(true)
  })

  it('names the questions it could not ground', () => {
    const withGap = [...samples, { question: 'zzzz 完全 无关', answerable: true }]
    const result = groundingRate(withGap, docs)
    expect(result.ungrounded).toContain('zzzz 完全 无关')
  })

  it('does not count questions nothing could answer', () => {
    // 把"本来就没资料可答"的问题算进分母，会把一个诚实弃权的系统
    // 判成不合格——而那正好会逼它去编
    const withUnanswerable = [...samples, { question: '明年的预算是多少', answerable: false }]
    expect(groundingRate(withUnanswerable, docs).rate).toBe(groundingRate(samples, docs).rate)
  })

  it('does not report a perfect rate when there was nothing to measure', () => {
    // 空样本集算 100% 的话，一次什么都没跑的评估会完美通过
    const result = groundingRate([], docs)
    expect(result.ok).toBe(false)
    expect(result.rate).toBe(0)
  })

  it('fails the bar when the corpus cannot support the questions', () => {
    expect(groundingRate(samples, []).ok).toBe(false)
  })
})
