import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type pg from 'pg'
import type { FastifyInstance } from 'fastify'
import { assertNotSuperuser, setupTestDb, truncateAll } from '../helpers/db.ts'
import { buildServer } from '../../src/api/server.ts'
import { buildDefaultRegistry } from '../../src/ontology/defaults.ts'
import { buildDefaultWorkflowRegistry } from '../../src/workflow/defaults.ts'
import { defaultPolicies } from '../../src/identity/default-policies.ts'

/**
 * 带出处的问答接进产品之后（FR-ONT-011 / FR-RES-009）。
 *
 * 混合检索本身在 tests/hybrid-retrieval.test.ts 里测过（纯函数，固定语料）。
 * 这里测的是**候选集**：库里的对象怎么变成语料。
 *
 * 这一段最容易出的错不是"答得不好"，是**答得出来但指不回去**，
 * 或者候选集根本没把该有的对象捞进来——两种都表现为
 * "这个系统搜不到东西"，而原因完全不同。
 */

const TENANT = 't_search'
const asAdmin = { 'x-principal': 'user://alice', 'x-tenant': TENANT, 'x-roles': 'Admin', 'x-capabilities': '' }

let pool: pg.Pool
let app: FastifyInstance

beforeAll(async () => {
  pool = await setupTestDb()
  await assertNotSuperuser(pool)
  app = buildServer({
    pool,
    registry: buildDefaultRegistry(),
    workflows: buildDefaultWorkflowRegistry(),
    policies: defaultPolicies(TENANT),
  })
  await app.ready()
})

afterAll(async () => {
  await app.close()
  await pool.end()
})

beforeEach(async () => {
  await truncateAll(pool)
})

async function create(type: string, attributes: Record<string, unknown>): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/resources',
    headers: asAdmin,
    payload: { type, workspace: 'ws_search', attributes },
  })
  expect(res.statusCode).toBe(201)
  return res.json().id as string
}

type AnswerBody = {
  passages: { sourceId: string; sourceTitle: string; text: string; via: string[] }[]
  sourceIds: string[]
  grounded: boolean
  candidates: number
}

async function ask(query: string): Promise<AnswerBody> {
  const res = await app.inject({ method: 'GET', url: `/v1/search:answer?${query}`, headers: asAdmin })
  expect(res.statusCode).toBe(200)
  return res.json() as AnswerBody
}

describe('grounded answers (FR-ONT-011 / FR-RES-009)', () => {
  it('answers with the id of the object the answer came from', async () => {
    const knowledge = await create('Knowledge', {
      title: '灰度发布策略',
      body: '灰度分三轮扩大流量，每轮观察十分钟，指标异常立即回滚',
    })
    await create('Knowledge', { title: '报销流程', body: '发票贴单后交行政' })

    const result = await ask('q=灰度怎么回滚')
    expect(result.grounded).toBe(true)
    // **验收标准就是这一行**：结果含来源实体 ID
    expect(result.sourceIds).toContain(knowledge)
    expect(result.passages[0]?.sourceId).toBe(knowledge)
  })

  it('the returned id really resolves — a source you cannot open is not a source', async () => {
    // "可点击跳转"如果只是返回一个字符串，那它随时可能是个跳不过去的 id。
    // 所以这里真的拿它再去取一次
    await create('Knowledge', { title: '扩容手册', body: '连接池打满时先加实例再排查慢查询' })
    const result = await ask('q=连接池打满怎么办')
    expect(result.sourceIds.length).toBeGreaterThan(0)

    for (const id of result.sourceIds) {
      const res = await app.inject({ method: 'GET', url: `/v1/resources/${id}`, headers: asAdmin })
      expect(res.statusCode).toBe(200)
    }
  })

  it('says it cannot answer instead of returning something that reads like one', async () => {
    // 一句读起来很像答案、却指不回任何实体的话，是这套东西最坏的产出：
    // 它会被复制进周报，而没有人能追溯它是从哪儿来的
    await create('Knowledge', { title: '报销流程', body: '发票贴单后交行政' })

    const result = await ask('q=quarterly capacity forecast methodology')
    expect(result.grounded).toBe(false)
    expect(result.passages).toEqual([])
    expect(result.sourceIds).toEqual([])
  })

  it('recalls per term, not by matching the whole question as a substring', async () => {
    // 整句话作为子串几乎不会出现在任何对象里。按整句检索的表现是
    // **永远答不出来**，而它看起来和"库里确实没有"一模一样
    const doc = await create('Knowledge', { title: '数据库连接池', body: '默认二十个连接' })
    const result = await ask('q=我们这套系统的数据库连接池默认开多少个连接')
    expect(result.sourceIds).toContain(doc)
    expect(result.candidates).toBeGreaterThan(0)
  })

  it('lets a focus object break the tie, without recalling on proximity alone', async () => {
    // 图只重排。它要是能单独召回，任何问题都会把图上邻近的对象捞出来——
    // 那些结果带着出处、读起来像答案、而且和问题无关
    const project = await create('Project', { key: 'PS', name: '支付平台' })
    const far = await create('Knowledge', { title: '限流方案', body: '令牌桶限流，超出直接拒绝' })
    const near = await create('Knowledge', { title: '限流方案', body: '令牌桶限流，超出直接拒绝' })
    await app.inject({
      method: 'POST',
      url: `/v1/resources/${project}/relations`,
      headers: asAdmin,
      payload: { type: 'contains', toId: near },
    })

    // 不给焦点：两篇一模一样，排序由 id 定序兜底，两个都在
    const blind = await ask('q=限流是怎么做的')
    expect(blind.sourceIds).toEqual(expect.arrayContaining([far, near]))

    // 给了焦点：项目里的那一篇排前面
    const focused = await ask(`q=限流是怎么做的&near=${project}`)
    expect(focused.sourceIds[0]).toBe(near)

    // 而一个完全不沾边的问题，即使有焦点也不该把邻近的东西捞出来
    const unrelated = await ask(`q=payroll tax withholding schedule&near=${project}`)
    expect(unrelated.grounded).toBe(false)
  })

  it('narrows to one type when asked, instead of scanning everything', async () => {
    // 中文二元组短于三字符、走不了 trigram 索引，不带 type 的话
    // 每个词都要扫一遍全租户。这个参数存在的理由一半是性能，
    // 一半是**知道自己在找什么的调用方应该说出来**
    await create('Knowledge', { title: '限流方案', body: '令牌桶限流' })
    const task = await create('Task', { title: '实现限流中间件' })

    const all = await ask('q=限流')
    expect(all.sourceIds.length).toBeGreaterThan(1)

    const narrowed = await ask('q=限流&type=Task')
    expect(narrowed.sourceIds).toEqual([task])
  })

  it('meets the sampled grounding bar against real objects, not a fixture corpus', async () => {
    // FR-ONT-011 的验收标准：**抽样问答中 ≥ 90% 返回可点击的来源实体**。
    // 这一条此前只在一份固定语料上量过——那证明的是打分函数，
    // 不是这套东西在库里的表现
    const corpus = [
      { title: '灰度发布策略', body: '灰度分三轮扩大流量，每轮观察十分钟' },
      { title: '数据库连接池', body: '默认二十个连接，打满时先加实例' },
      { title: '限流方案', body: '令牌桶限流，超出直接拒绝' },
      { title: '回滚手册', body: '指标异常立即回滚到上一个版本' },
      { title: '值班交接', body: '每日早会同步未闭环的告警' },
      { title: '发票报销', body: '发票贴单后交行政，月底结算' },
      { title: '压测流程', body: '压测前隔离环境，压测后清理数据' },
      { title: '密钥轮换', body: '密钥每季度轮换一次，旧密钥保留七天' },
      { title: '告警分级', body: '告警分为致命、严重、提示三级' },
      { title: '容量评估', body: '容量按峰值的两倍冗余准备' },
    ]
    for (const doc of corpus) await create('Knowledge', doc)

    // 每个问题都**确实有**一篇能回答它的文档（答不出来的问题不该算进分母，
    // 那会把一个诚实弃权的系统判成不合格，而那正好会逼它去编）
    const questions = [
      '灰度是怎么做的',
      '连接池默认多少',
      '限流用什么算法',
      '出问题了怎么回滚',
      '值班怎么交接',
      '报销要走什么流程',
      '压测之前要做什么',
      '密钥多久轮换一次',
      '告警分几级',
      '容量要留多少冗余',
    ]
    const grounded: string[] = []
    const ungrounded: string[] = []
    for (const q of questions) {
      const result = await ask(`q=${encodeURIComponent(q)}`)
      // 有 passage 却没有 sourceId 是绝不允许的组合——那正是"没有出处的答案"
      if (result.grounded && result.sourceIds.length > 0) grounded.push(q)
      else ungrounded.push(q)
    }

    const rate = grounded.length / questions.length
    expect(rate, `答不出来的：${ungrounded.join('、')}`).toBeGreaterThanOrEqual(0.9)
  })

  it('matches attribute values, never attribute names', async () => {
    // 把键名也算进文本的话，每个对象都含有 "title"、每个 Knowledge 都含有
    // "body"——于是搜这两个词会命中全库，而且每一条都带着出处，
    // 看起来完全正常。仓储里 `search_text` 是同一个口径
    await create('Knowledge', { title: '灰度发布', body: '分三轮扩大流量' })
    await create('Task', { title: '实现灰度开关' })
    expect((await ask('q=title body statement')).grounded).toBe(false)
  })

  it('ranks the focus object itself first when it answers the question', async () => {
    // 焦点对象自己是 0 跳。不把它算进去的话，"我正在看这个东西，
    // 它自己说了什么" 反而排在别人后面——而那是最常见的一次提问
    const other = await create('Knowledge', { title: '限流方案', body: '令牌桶限流，超出直接拒绝' })
    const focus = await create('Knowledge', { title: '限流方案', body: '令牌桶限流，超出直接拒绝' })

    const result = await ask(`q=限流是怎么做的&near=${focus}`)
    expect(result.sourceIds[0]).toBe(focus)
    expect(result.sourceIds).toContain(other)
  })

  it('is a read that goes through the PDP like any other', async () => {
    await create('Knowledge', { title: 'k', body: 'b' })
    const res = await app.inject({
      method: 'GET',
      url: '/v1/search:answer?q=k',
      headers: { ...asAdmin, 'x-tenant': 't_somewhere_else' },
    })
    expect(res.statusCode).toBe(403)
  })

  it('rejects a question longer than the limit rather than truncating it silently', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/search:answer?q=${'词'.repeat(600)}`,
      headers: asAdmin,
    })
    expect(res.statusCode).toBe(400)
  })
})
