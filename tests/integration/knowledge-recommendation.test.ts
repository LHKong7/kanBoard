import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type pg from 'pg'
import type { FastifyInstance } from 'fastify'
import { assertNotSuperuser, setupTestDb, truncateAll } from '../helpers/db.ts'
import { buildServer } from '../../src/api/server.ts'
import { buildDefaultRegistry } from '../../src/ontology/defaults.ts'
import { buildDefaultWorkflowRegistry } from '../../src/workflow/defaults.ts'
import { defaultPolicies } from '../../src/identity/default-policies.ts'

/**
 * 知识推荐的留痕与点击率（FR-AI-009）。
 *
 * 验收标准里「**点击率可统计**」这半句，决定了推荐要做成一个
 * **领域对象**而不是一条埋点日志：推荐被点了没有，就是这个对象
 * 现在处于哪个状态，于是点击率是一次普通的分组计数，
 * 和别的指标走同一条路径——**系统里不需要为它新开一条写路径**
 * （FR-DASH-005 的原话是"指标由事件流自动物化，无人工填报"）。
 */

const TENANT = 'default'
const WS = 'ws_platform'
let pool: pg.Pool
let app: FastifyInstance

const asAdmin = {
  'x-principal': 'user://alice',
  'x-tenant': TENANT,
  'x-roles': 'Admin',
  'x-capabilities': '',
}

beforeAll(async () => {
  pool = await setupTestDb()
  await assertNotSuperuser(pool)
  app = buildServer({
    pool,
    registry: buildDefaultRegistry(),
    workflows: buildDefaultWorkflowRegistry(),
    policies: defaultPolicies(TENANT),
    tenant: TENANT,
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
    payload: { type, workspace: WS, attributes },
  })
  if (res.statusCode !== 201) throw new Error(`create ${type}: ${res.body}`)
  return res.json().id as string
}

async function transition(id: string, to: string) {
  return app.inject({
    method: 'POST',
    url: `/v1/resources/${id}/transitions`,
    headers: asAdmin,
    payload: { to },
  })
}

const recommendation = (reason = '和当前内容有 3 处措辞重合') =>
  create('Recommendation', { reason, score: 0.62 })

async function metric(id: string): Promise<{ total: number; groups: { key: string; count: number }[] }> {
  const res = await app.inject({ method: 'GET', url: `/v1/metrics/${id}`, headers: asAdmin })
  if (res.statusCode !== 200) throw new Error(`metric ${id}: ${res.body}`)
  return res.json() as { total: number; groups: { key: string; count: number }[] }
}

describe('a recommendation is a domain object, not a log line (FR-AI-009)', () => {
  it('starts as Shown, and uses createdAt as the moment it was shown', async () => {
    const id = await recommendation()
    const got = await app.inject({ method: 'GET', url: `/v1/resources/${id}`, headers: asAdmin })
    expect(got.json().status).toBe('Shown')
    // 一开始这里有个 `shownAt` 属性，配着 Shown 状态的 entry action。
    // 它**永远填不上**：entry action 只在迁移进入某状态时运行，
    // 而初始状态是创建时直接落的，不走迁移。那就又是一个
    // "看起来配置好了、实际什么也不做"的字段，和 `sla` 一个毛病。
    // 资源自带的 createdAt 说的正是这件事
    expect(got.json().createdAt).toBeTruthy()
    expect(got.json().attributes.shownAt).toBeUndefined()
  })

  it('requires a reason — a recommendation nobody can question is not one', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/resources',
      headers: asAdmin,
      payload: { type: 'Recommendation', workspace: WS, attributes: { score: 0.9 } },
    })
    expect(res.statusCode).toBe(422)
  })

  it('records the click as an ordinary transition', async () => {
    const id = await recommendation()
    expect((await transition(id, 'Clicked')).statusCode).toBeLessThan(300)
    const got = await app.inject({ method: 'GET', url: `/v1/resources/${id}`, headers: asAdmin })
    expect(got.json().status).toBe('Clicked')
    expect(got.json().attributes.respondedAt).toBeTruthy()
  })

  it('cannot be un-clicked', async () => {
    // Clicked 是终态。允许改回去的话，点击率就成了一个可以被编辑的数字
    const id = await recommendation()
    await transition(id, 'Clicked')
    expect((await transition(id, 'Dismissed')).statusCode).toBeGreaterThanOrEqual(400)
  })

  it('links to the knowledge it recommends, so provenance is one hop further', async () => {
    // 出处不单独记：Knowledge 本身就必须有 derivedFrom（FR-DOM-008），
    // 顺着再走一步就到了。同一件事只表达一次
    const knowledge = await create('Knowledge', { title: '连接池调优', body: '正文' })
    const id = await recommendation()
    const linked = await app.inject({
      method: 'POST',
      url: `/v1/resources/${id}/relations`,
      headers: asAdmin,
      payload: { type: 'recommends', toId: knowledge },
    })
    expect(linked.statusCode).toBe(201)
  })
})

describe('click-through is a query, not a counter (FR-AI-009 + FR-DASH-005)', () => {
  it('counts clicked over answered', async () => {
    const clicked = [await recommendation(), await recommendation(), await recommendation()]
    const dismissed = [await recommendation()]
    for (const id of clicked) await transition(id, 'Clicked')
    for (const id of dismissed) await transition(id, 'Dismissed')

    const rate = await metric('knowledge.recommendations.click-through')
    expect(rate.total).toBeCloseTo(0.75, 5)
  })

  it('excludes ones nobody has responded to yet', async () => {
    // 分母用推过的总数的话，刚推完一批点击率就掉——
    // 而那只说明推得及时，不说明推得差
    const clicked = await recommendation()
    await transition(clicked, 'Clicked')
    await recommendation() // 还挂在 Shown
    await recommendation()

    const rate = await metric('knowledge.recommendations.click-through')
    expect(rate.total).toBe(1)
    // 分母只数已表态的那两条之一，不是三条
    expect(rate.groups.find((g) => g.key === 'denominator')?.count).toBe(1)
  })

  it('shows the response distribution so a stuck queue is visible', async () => {
    // Shown 长期居高说明推的位置没人看，而点击率那个数字看不出这件事
    const clicked = await recommendation()
    await transition(clicked, 'Clicked')
    await recommendation()

    const body = await metric('knowledge.recommendations.by-status')
    const byKey = Object.fromEntries(body.groups.map((g) => [g.key, g.count]))
    expect(byKey['Shown']).toBe(1)
    expect(byKey['Clicked']).toBe(1)
  })

  it('needs no write path of its own — the numbers come from the resources', async () => {
    // 指标即查询（FR-DASH-005）。存一个计数器就要有人维护它，
    // 而维护漏了的表现是"这个数字有点不对"，没人查得出为什么
    const before = await metric('knowledge.recommendations.click-through')
    expect(before.total).toBe(0)

    const id = await recommendation()
    await transition(id, 'Clicked')
    expect((await metric('knowledge.recommendations.click-through')).total).toBe(1)
  })
})
