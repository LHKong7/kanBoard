import { keyTerms } from '../ai/capabilities.ts'

/**
 * 图检索 + 向量检索混合问答，答案带出处（FR-ONT-011 / FR-RES-009）。
 *
 * 两条需求的验收标准都落在**出处**上：
 *   FR-ONT-011  抽样问答中 ≥ 90% 返回可点击的来源实体
 *   FR-RES-009  结果含来源实体 ID，可点击跳转
 *
 * 也就是说，被考的不是"答得好不好"，是**每一句话能不能指回它的来源**。
 * 那是可判定的，所以这一层不需要模型。
 *
 * "向量"这个词容易让人以为必须接一个 embedding 服务。这里用的是
 * **本地确定性向量**：词项做成稀疏向量算余弦。它没有语义泛化能力
 * （"汽车"和"轿车"对不上），但它有两个更要紧的性质——
 * **不需要外部依赖，而且同样的输入永远给同样的结果**。
 * 接了真 embedding 之后换掉 `vectorize` 即可，
 * 混合与出处这两层不用动。
 *
 * 两路召回 + 一路重排：
 *   词面  精确词、编号、专有名词——向量最不擅长的那些   （召回）
 *   向量  用词不同但说的是一回事                       （召回）
 *   图    同样相关时，离当前话题近的排前面               （**只重排**）
 *
 * 图为什么不单独召回，见 `answer` 里那段注释——一句话：
 * 「离得近」不等于「回答了这个问题」。
 */

export type Doc = {
  id: string
  type: string
  title: string
  text: string
  /** 图上距离当前话题几跳。null = 不连通 */
  hops: number | null
}

/** 一段带出处的答案片段 */
export type Passage = {
  /** **来源实体 id。可点击跳转的就是它**（两条需求的验收标准） */
  sourceId: string
  sourceType: string
  sourceTitle: string
  text: string
  score: number
  /** 这一条是被哪一路召回的。调参时要知道是哪一路在起作用 */
  via: readonly ('lexical' | 'vector' | 'graph')[]
}

export type Answer = {
  passages: readonly Passage[]
  /** 去重后的来源实体 id */
  sourceIds: readonly string[]
  /** **没有出处就没有答案**（见下） */
  grounded: boolean
}

export const WEIGHTS = { lexical: 1, vector: 1, graph: 0.5 } as const
/**
 * 低于这个分不进答案。宁可答不出，也不要给一段看起来像答案的噪音。
 *
 * 0.15 是量出来的，不是拍的：一篇讲别的事、只碰巧共享一个词的文档
 * 得分约 0.10，而一次货真价实的命中在 0.7 以上。中间这段空得很宽，
 * 门槛落在里面。
 *
 * 原来是 0.05——那个值**什么也拦不住**（`textual > 0` 那道闸之后，
 * 任何沾一点边的东西都在 0.05 以上），于是它是一条从不生效的检查。
 * 变异测试逮到了：把它删掉，用例全绿。
 */
export const MIN_SCORE = 0.15

/**
 * 稀疏向量：词项 → 权重。
 *
 * **这里走过两版弯路，都是同一个错误，值得记下来。**
 *
 * 第一版按 `keyTerms` 的词做向量，而词面那一路用的也是 `keyTerms`——
 * 两路是同一个信号的两种归一化。第二版换成字符三元组，看起来不同了，
 * 其实还是同一批字符的另一个 n-gram 尺度（`keyTerms` 对中文本来就出双字），
 * 于是两路**仍然总是同时命中**。变异测试两次都把任一路的权重清零而用例全绿，
 * 说的就是这件事：**「混合」当时是个名字，不是一个事实。**
 *
 * 真正让向量那一路独立的，是它能匹配**字面上根本不重合**的词。
 * 这一版用语料自己的**共现**做扩展：在同一篇文档里反复一起出现的词
 * 被认为相关，于是问句里的「连接数量」可以命中一篇只写了「连接池」的文档——
 * 而词面那一路对此无能为力。这是 embedding 出现之前的老办法，
 * 好处是**完全本地、完全确定**。
 *
 * ⚠️ 它给不了真 embedding 的那种泛化（"汽车"对"轿车"，语料里从不共现就没辙）。
 * 换成真 embedding 时替换这个函数即可，**上层不认识向量是怎么来的**。
 */
export function vectorize(text: string, expansion?: Expansion): Map<string, number> {
  const v = new Map<string, number>()
  for (const term of keyTerms(text)) v.set(term, (v.get(term) ?? 0) + 1)
  if (expansion === undefined) return v

  // 扩展项的权重压低：它是"可能相关"，不该和原词一样重。
  // 给一样的权重，一次扩展就能把一篇原词一个都没有的文档顶到第一
  for (const [term, weight] of [...v]) {
    for (const [related, strength] of expansion.get(term) ?? []) {
      if (v.has(related)) continue
      v.set(related, weight * strength * EXPANSION_DAMPING)
    }
  }
  return v
}

/** 词 → （相关词 → 强度） */
export type Expansion = Map<string, Map<string, number>>

/** 扩展项相对原词的权重上限 */
export const EXPANSION_DAMPING = 0.5
/** 共现多少次才算相关。1 次是巧合 */
const MIN_COOCCURRENCE = 2
/** 每个词最多扩展几个。不封顶的话，常见词会把整个词表拉进来 */
const MAX_EXPANSION = 4

/**
 * 从语料里学出共现关系。
 *
 * **只用语料，不用外部服务**——同样的语料永远学出同样的扩展表，
 * 于是"为什么这次搜到了、上次没搜到"是查得清的。
 */
export function learnExpansion(docs: readonly Doc[]): Expansion {
  const together = new Map<string, Map<string, number>>()
  for (const doc of docs) {
    const terms = [...new Set(keyTerms(`${doc.title} ${doc.text}`))]
    for (const a of terms) {
      const row = together.get(a) ?? new Map<string, number>()
      for (const b of terms) {
        if (a === b) continue
        row.set(b, (row.get(b) ?? 0) + 1)
      }
      together.set(a, row)
    }
  }

  const out: Expansion = new Map()
  for (const [term, row] of together) {
    const top = [...row]
      .filter(([, n]) => n >= MIN_COOCCURRENCE)
      // 同分按词定序，否则同一份语料两次学出不同的扩展表
      .sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))
      .slice(0, MAX_EXPANSION)
    if (top.length === 0) continue
    const strongest = top[0]?.[1] ?? 1
    out.set(term, new Map(top.map(([t, n]) => [t, n / strongest])))
  }
  return out
}

export function cosine(a: Map<string, number>, b: Map<string, number>): number {
  let dot = 0
  // 只遍历较小的那个：一篇长文档和一个短问句求相似度时，
  // 遍历长的那边纯属浪费
  const [small, large] = a.size <= b.size ? [a, b] : [b, a]
  for (const [term, weight] of small) dot += weight * (large.get(term) ?? 0)
  if (dot === 0) return 0
  const norm = (m: Map<string, number>): number =>
    Math.sqrt([...m.values()].reduce((s, w) => s + w * w, 0))
  const denom = norm(a) * norm(b)
  return denom === 0 ? 0 : dot / denom
}

/**
 * 回答一个问题。
 *
 * **拿不出出处就返回空**，而不是返回一段没有来源的文字。
 * 一句读起来很像答案、却指不回任何实体的话，是这套东西最坏的产出：
 * 它会被复制进周报，而没有人能追溯它是从哪儿来的。
 */
export function answer(
  question: string,
  docs: readonly Doc[],
  limit = 5,
  expansion?: Expansion,
): Answer {
  const qTerms = new Set(keyTerms(question))
  // 扩展**只加在问句上**，不加在文档上。两边都扩的话，两个本来无关的
  // 东西会通过各自的扩展项在中间碰上，而那种命中没人解释得了
  const qVector = vectorize(question, expansion ?? learnExpansion(docs))

  const scored: Passage[] = []
  for (const doc of docs) {
    const body = `${doc.title} ${doc.text}`
    const terms = new Set(keyTerms(body))

    // ① 词面：问句里的词有多少被这篇覆盖
    const hits = [...qTerms].filter((t) => terms.has(t)).length
    const lexical = qTerms.size === 0 ? 0 : hits / qTerms.size

    // ② 向量：余弦
    const vector = cosine(qVector, vectorize(body))

    // ③ 图：越近越高；不连通是 0，不是"很远"
    const graph = doc.hops === null ? 0 : 1 / (1 + doc.hops)

    // **图只重排，不单独召回。**
    //
    // 第一版是三路直接相加，结果是：任何一个问题都会把图上邻近的文档
    // 捞出来——哪怕一个词都不沾。用例当场红了，而它红得对：
    // 「离得近」不等于「回答了这个问题」，返回这样一段话，
    // 它带着出处、读起来像答案、而且和问题无关。
    //
    // 这一点和知识推荐（FR-AI-009）不一样，值得写下来：那边的"查询"
    // 是一个工作项，图上邻近本身就是相关性的证据；这边的查询是一个**问句**，
    // 邻近说明不了任何事。同一个信号，在两个场景里的地位不同。
    const textual = lexical * WEIGHTS.lexical + vector * WEIGHTS.vector
    if (textual <= 0) continue

    const score = textual + graph * WEIGHTS.graph
    if (score < MIN_SCORE) continue

    const via: ('lexical' | 'vector' | 'graph')[] = []
    if (lexical > 0) via.push('lexical')
    if (vector > 0) via.push('vector')
    if (graph > 0) via.push('graph')

    scored.push({
      sourceId: doc.id,
      sourceType: doc.type,
      sourceTitle: doc.title,
      // 截一段，不是整篇。答案里塞进整份文档，"带出处"就退化成"给你全文自己找"
      text: doc.text.slice(0, 300),
      score: Math.round(score * 10_000) / 10_000,
      via,
    })
  }

  scored.sort((a, b) => b.score - a.score || a.sourceId.localeCompare(b.sourceId))
  const passages = scored.slice(0, limit)
  return {
    passages,
    // 去重。**今天它其实去不掉什么**：一篇文档只产出一段 passage，
    // 所以 id 天然不重复（变异测试确认过——改成不去重，用例全绿）。
    // 留着是因为一旦开始按段落切分（一篇长文出多段），它就是必需的，
    // 而那时忘了加的表现是出处列表里同一篇文档出现五次
    sourceIds: [...new Set(passages.map((p) => p.sourceId))],
    // 一条都没有 = 答不出。**这不是失败，是正确的答案**
    grounded: passages.length > 0,
  }
}

/**
 * 出处覆盖率（FR-ONT-011 的验收标准：抽样问答中 ≥ 90% 返回可点击来源）。
 *
 * 注意分母：**只数应当答得出的那些**。把"本来就没有资料可答"的问题
 * 算进去，会把一个诚实弃权的系统判成不合格——而那正好会逼它去编。
 */
export const GROUNDING_MIN = 0.9

export function groundingRate(
  samples: readonly { question: string; answerable: boolean }[],
  docs: readonly Doc[],
): { rate: number; ok: boolean; ungrounded: readonly string[] } {
  const expected = samples.filter((s) => s.answerable)
  if (expected.length === 0) return { rate: 0, ok: false, ungrounded: [] }

  const ungrounded: string[] = []
  for (const sample of expected) {
    const result = answer(sample.question, docs)
    // 有 passage 但没有 sourceId 是绝不允许的组合——那正是"没有出处的答案"
    if (!result.grounded || result.sourceIds.length === 0) ungrounded.push(sample.question)
  }

  const rate = (expected.length - ungrounded.length) / expected.length
  return { rate: Math.round(rate * 10_000) / 10_000, ok: rate >= GROUNDING_MIN, ungrounded }
}
