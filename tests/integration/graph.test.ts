import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type pg from 'pg'
import type { FastifyInstance } from 'fastify'
import { assertNotSuperuser, queryAsTenant, setupTestDb, truncateAll } from '../helpers/db.ts'
import { buildServer } from '../../src/api/server.ts'
import { buildDefaultRegistry } from '../../src/ontology/defaults.ts'
import { buildDefaultWorkflowRegistry } from '../../src/workflow/defaults.ts'
import { defaultPolicies } from '../../src/identity/default-policies.ts'
import { MAX_PAGE_SIZE } from '../../src/domain/resource/ports.ts'
import type { Policy } from '../../src/identity/types.ts'

const TENANT = 't_acme'

/**
 * Agent 的授权是显式的两步：既要有 Capability，也要有 Policy 允许。
 * 只给 Capability 不给 Policy，PDP 仍然默认拒绝——这不是冗余，
 * 而是让"能做什么"和"在哪里能做"分开表达（PRD 07 的第 ③④⑤ 层）。
 */
const knowledgeAgentPolicy: Policy = {
  id: 'pol-knowledge-agent',
  effect: 'Allow',
  subject: 'agent://knowledge@1.0.0',
  action: 'Knowledge.*',
  scope: { kind: 'tenant', tenant: TENANT },
}
const asAdmin = {
  'x-principal': 'user://alice',
  'x-tenant': TENANT,
  'x-roles': 'Admin',
  'x-capabilities': '',
}

let pool: pg.Pool
let app: FastifyInstance

beforeAll(async () => {
  pool = await setupTestDb()
  await assertNotSuperuser(pool)
  app = buildServer({
    pool,
    registry: buildDefaultRegistry(),
    workflows: buildDefaultWorkflowRegistry(),
    policies: [...defaultPolicies(TENANT), knowledgeAgentPolicy],
  })
  await app.ready()
})

afterAll(async () => {
  await app.close()
  await pool.end()
})

async function create(type: string, attributes: Record<string, unknown>): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/resources',
    headers: asAdmin,
    payload: { type, workspace: 'ws_platform', attributes },
  })
  if (res.statusCode !== 201) throw new Error(`create ${type} failed: ${res.body}`)
  return res.json().id as string
}

async function relate(fromId: string, type: string, toId: string, confidence?: number) {
  return app.inject({
    method: 'POST',
    url: `/v1/resources/${fromId}/relations`,
    headers: asAdmin,
    payload: confidence === undefined ? { type, toId } : { type, toId, confidence },
  })
}

/** 建出 PRD 04 里的那条主链：Requirement → Story → Task */
async function seedChain(): Promise<{ req: string; story: string; task: string; decision: string }> {
  const req = await create('Requirement', { title: 'billing', level: 'Feature', statement: 's' })
  const story = await create('Story', { title: 'invoice pdf' })
  const task = await create('Task', { title: 'render pdf' })
  const decision = await create('Decision', { question: 'q', chosen: 'c', rationale: 'r' })

  await relate(req, 'implementedBy', story)
  await relate(story, 'decomposedInto', task)
  await relate(decision, 'explains', req)

  return { req, story, task, decision }
}

beforeEach(async () => {
  await truncateAll(pool)
})

describe('relations (FR-ONT-003/006)', () => {
  it('rejects a relation that violates the ontology domain', async () => {
    const task = await create('Task', { title: 't' })
    const story = await create('Story', { title: 's' })
    // implementedBy 的定义域是 Requirement，不是 Task
    const res = await relate(task, 'implementedBy', story)
    expect(res.statusCode).toBe(422)
  })

  it('rejects an unknown relation type', async () => {
    const a = await create('Task', { title: 'a' })
    const b = await create('Task', { title: 'b' })
    expect((await relate(a, 'teleportsTo', b)).statusCode).toBe(422)
  })

  it('is idempotent: creating the same edge twice yields one edge', async () => {
    // 自动关系建立规则会反复触发，重复不该报错也不该产生重复边
    const a = await create('Task', { title: 'a' })
    const b = await create('Task', { title: 'b' })
    expect((await relate(a, 'blockedBy', b)).statusCode).toBe(201)
    expect((await relate(a, 'blockedBy', b)).statusCode).toBe(201)

    const res = await app.inject({
      method: 'GET',
      url: `/v1/resources/${a}/relations?direction=out`,
      headers: asAdmin,
    })
    expect(res.json().items).toHaveLength(1)
  })

  it('finds an edge by its inverse name, flipped to the requested orientation (FR-ONT-003)', async () => {
    // 回归测试。一条边只存一行：`story --decomposedInto--> task`。
    // 从 task 查 `partOf` 必须找得到它，否则"逆关系"只是本体里的一句声明，
    // 查询时并不成立——而依赖它的自动化规则会静默地什么都不做。
    const { story, task } = await seedChain()

    const res = await app.inject({
      method: 'GET',
      url: `/v1/resources/${task}/relations?direction=out&type=partOf`,
      headers: asAdmin,
    })
    const items = res.json().items as Array<{ type: string; fromId: string; toId: string }>
    expect(items).toHaveLength(1)
    // 返回值按请求的方向呈现，调用方不必关心当初是从哪一头建的
    expect(items[0]).toMatchObject({ type: 'partOf', fromId: task, toId: story })
  })

  it('traverses an edge regardless of which end it was created from', async () => {
    const { req, story } = await seedChain()
    // 边存的是 implementedBy；沿它的逆名 implements 从 story 往回走也要通
    const res = await app.inject({
      method: 'POST',
      url: '/v1/graph:traverse',
      headers: asAdmin,
      payload: { start: story, follow: ['implements'], maxDepth: 2, direction: 'out' },
    })
    expect((res.json().items as { id: string }[]).map((i) => i.id)).toEqual([req])
  })

  it('reads the same edge from either direction (FR-ONT-003)', async () => {
    const { req, story } = await seedChain()

    const out = await app.inject({
      method: 'GET',
      url: `/v1/resources/${req}/relations?direction=out&type=implementedBy`,
      headers: asAdmin,
    })
    const incoming = await app.inject({
      method: 'GET',
      url: `/v1/resources/${story}/relations?direction=in&type=implementedBy`,
      headers: asAdmin,
    })
    expect(out.json().items).toHaveLength(1)
    expect(incoming.json().items).toHaveLength(1)
    expect(out.json().items[0].id).toBe(incoming.json().items[0].id)
  })
})

describe('relation removal and confirmation', () => {
  it('removes a relation and reports it gone', async () => {
    const { req, story } = await seedChain()
    const listed = await app.inject({
      method: 'GET',
      url: `/v1/resources/${req}/relations?direction=out&type=implementedBy`,
      headers: asAdmin,
    })
    const relationId = listed.json().items[0].id

    const del = await app.inject({
      method: 'DELETE',
      url: `/v1/relations/${relationId}`,
      headers: asAdmin,
    })
    expect(del.statusCode).toBe(204)

    const after = await app.inject({
      method: 'GET',
      url: `/v1/resources/${req}/relations?direction=out&type=implementedBy`,
      headers: asAdmin,
    })
    expect(after.json().items).toHaveLength(0)
    // 对象本身不受影响：删的是边，不是节点
    const stillThere = await app.inject({ method: 'GET', url: `/v1/resources/${story}`, headers: asAdmin })
    expect(stillThere.statusCode).toBe(200)
  })

  it('refuses to remove a relation the caller cannot update the source of', async () => {
    const { req } = await seedChain()
    const listed = await app.inject({
      method: 'GET',
      url: `/v1/resources/${req}/relations?direction=out&type=implementedBy`,
      headers: asAdmin,
    })
    const relationId = listed.json().items[0].id

    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/relations/${relationId}`,
      headers: { ...asAdmin, 'x-principal': 'user://guest', 'x-roles': 'Guest' },
    })
    expect(res.statusCode).toBe(403)
  })

  it('returns 404 for an unknown relation', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/v1/relations/relation_00000000000000000000000000',
      headers: asAdmin,
    })
    expect(res.statusCode).toBe(404)
  })
})

describe('confirming agent-inferred relations (FR-ONT-006)', () => {
  const asAgent = {
    'x-principal': 'agent://knowledge@1.0.0',
    'x-tenant': TENANT,
    'x-roles': 'AIAgent',
    'x-capabilities': 'Knowledge.Update,Knowledge.Read,Task.Read',
  }

  async function inferredRelation(): Promise<{ knowledge: string; relationId: string }> {
    const knowledge = await create('Knowledge', { title: 'k', body: 'b' })
    const task = await create('Task', { title: 't' })
    const res = await app.inject({
      method: 'POST',
      url: `/v1/resources/${knowledge}/relations`,
      headers: asAgent,
      payload: { type: 'derivedFrom', toId: task, confidence: 0.8 },
    })
    return { knowledge, relationId: res.json().id as string }
  }

  it('confirms a pending relation', async () => {
    const { relationId } = await inferredRelation()
    const res = await app.inject({
      method: 'POST',
      url: `/v1/relations/${relationId}/confirmation`,
      headers: asAdmin,
      payload: { confirmed: true },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().confirmed).toBe(true)
  })

  it('a rejected relation stops satisfying guards and stops being traversed', async () => {
    // 否决 ≠ 删除：记录留着（它是负样本），但不再产生任何效力
    const { knowledge, relationId } = await inferredRelation()

    const before = await app.inject({
      method: 'GET',
      url: `/v1/resources/${knowledge}/transitions`,
      headers: asAdmin,
    })
    expect((before.json().items as { to: string; ready: boolean }[]).find((t) => t.to === 'Published')?.ready).toBe(true)

    await app.inject({
      method: 'POST',
      url: `/v1/relations/${relationId}/confirmation`,
      headers: asAdmin,
      payload: { confirmed: false },
    })

    const after = await app.inject({
      method: 'GET',
      url: `/v1/resources/${knowledge}/transitions`,
      headers: asAdmin,
    })
    const published = (after.json().items as { to: string; ready: boolean; blockedBy: string | null }[]).find(
      (t) => t.to === 'Published',
    )
    expect(published?.ready).toBe(false)
    expect(published?.blockedBy).toMatch(/derivedFrom/)

    // 记录仍在，只是被标记为否决
    const listed = await app.inject({
      method: 'GET',
      url: `/v1/resources/${knowledge}/relations?direction=out`,
      headers: asAdmin,
    })
    expect(listed.json().items[0].confirmed).toBe(false)
  })

  it('refuses to confirm a human-created relation', async () => {
    const a = await create('Task', { title: 'a' })
    const b = await create('Task', { title: 'b' })
    const created = await relate(a, 'blockedBy', b)
    const res = await app.inject({
      method: 'POST',
      url: `/v1/relations/${created.json().id}/confirmation`,
      headers: asAdmin,
      payload: { confirmed: false },
    })
    expect(res.statusCode).toBe(422)
  })
})

describe('graph traversal (FR-ONT-004, FR-RES-007)', () => {
  it('walks the requirement chain down to tasks', async () => {
    const { req, story, task } = await seedChain()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/graph:traverse',
      headers: asAdmin,
      payload: { start: req, follow: ['implementedBy', 'decomposedInto'], maxDepth: 5, direction: 'out' },
    })
    expect(res.statusCode).toBe(200)
    const items = res.json().items as Array<{ id: string; depth: number; path: string[] }>

    expect(res.json().truncated).toBe(false)
    expect(items.map((i) => i.id)).toEqual([story, task])
    expect(items[0]).toMatchObject({ depth: 1, path: ['implementedBy'] })
    expect(items[1]).toMatchObject({ depth: 2, path: ['implementedBy', 'decomposedInto'] })
  })

  it('honours maxDepth', async () => {
    const { req, story } = await seedChain()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/graph:traverse',
      headers: asAdmin,
      payload: { start: req, follow: ['implementedBy', 'decomposedInto'], maxDepth: 1, direction: 'out' },
    })
    expect((res.json().items as { id: string }[]).map((i) => i.id)).toEqual([story])
  })

  it('terminates on cycles instead of recursing forever', async () => {
    // blockedBy 成环在真实项目里很常见，不能假设图是 DAG
    const a = await create('Task', { title: 'a' })
    const b = await create('Task', { title: 'b' })
    const c = await create('Task', { title: 'c' })
    await relate(a, 'blockedBy', b)
    await relate(b, 'blockedBy', c)
    await relate(c, 'blockedBy', a)

    const res = await app.inject({
      method: 'POST',
      url: '/v1/graph:traverse',
      headers: asAdmin,
      payload: { start: a, follow: ['blockedBy'], maxDepth: 10, direction: 'out' },
    })
    expect(res.statusCode).toBe(200)
    const ids = (res.json().items as { id: string }[]).map((i) => i.id)
    expect(new Set(ids)).toEqual(new Set([b, c]))
  })

  it('excludes soft-deleted nodes', async () => {
    const { req, story } = await seedChain()
    const current = await app.inject({ method: 'GET', url: `/v1/resources/${story}`, headers: asAdmin })
    await app.inject({
      method: 'DELETE',
      url: `/v1/resources/${story}`,
      headers: { ...asAdmin, 'if-match': `"${current.json().version}"` },
    })

    const res = await app.inject({
      method: 'POST',
      url: '/v1/graph:traverse',
      headers: asAdmin,
      payload: { start: req, follow: ['implementedBy'], maxDepth: 3, direction: 'out' },
    })
    expect(res.json().items).toHaveLength(0)
  })

  it('caps the result and says so, instead of returning an unbounded response', async () => {
    // 没有上限的遍历不是"偶尔慢"，是没有上界。
    // 截断本身可以接受，不告诉调用方才不行——他会以为拿到了全部。
    const project = await create('Project', { key: 'P1', name: 'big' })
    const kids: string[] = []
    for (let i = 0; i < 5; i++) {
      const task = await create('Task', { title: `t${i}` })
      await relate(project, 'contains', task)
      kids.push(task)
    }

    const capped = await app.inject({
      method: 'POST',
      url: '/v1/graph:traverse',
      headers: asAdmin,
      payload: { start: project, follow: ['contains'], maxDepth: 2, direction: 'out', limit: 2 },
    })
    expect(capped.json().items).toHaveLength(2)
    expect(capped.json().truncated).toBe(true)

    const full = await app.inject({
      method: 'POST',
      url: '/v1/graph:traverse',
      headers: asAdmin,
      payload: { start: project, follow: ['contains'], maxDepth: 2, direction: 'out', limit: 50 },
    })
    expect(full.json().items).toHaveLength(5)
    expect(full.json().truncated).toBe(false)
  })

  it('rejects a limit above the hard maximum', async () => {
    const { req } = await seedChain()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/graph:traverse',
      headers: asAdmin,
      payload: { start: req, follow: ['implementedBy'], maxDepth: 2, direction: 'out', limit: 99999 },
    })
    expect(res.statusCode).toBe(400)
  })

  it('rejects an unknown relation type in follow', async () => {
    const { req } = await seedChain()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/graph:traverse',
      headers: asAdmin,
      payload: { start: req, follow: ['wormhole'], maxDepth: 3, direction: 'out' },
    })
    expect(res.statusCode).toBe(422)
  })

  it('follows every declared relation type when follow is omitted', async () => {
    // `follow` 的上限是 10，而本体里声明了 28 种关系。要"展开一个对象
    // 周围的全部关系"，调用方只能截断——而截断掉的那些不会报错，
    // 图只是安静地少了几种边。省略 follow 必须等于「全部」
    const { decision, req, story } = await seedChain()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/graph:traverse',
      headers: asAdmin,
      payload: { start: req, maxDepth: 2, direction: 'both' },
    })
    expect(res.statusCode).toBe(200)
    const ids = (res.json().items as { id: string }[]).map((i) => i.id)
    // 沿 implementedBy 向下、沿 explains 的逆向上——两个方向都跟到了
    expect(ids).toContain(story)
    expect(ids).toContain(decision)
  })
})

/**
 * 关系图（FR-ONT-012）。
 *
 * 比 `:traverse` 多两样东西，而这张图缺了任一样都画不出来：
 * 节点上写什么（标题在 attributes 里），以及节点**彼此之间**怎么连。
 */
describe('subgraph (FR-ONT-012)', () => {
  it('returns the start node itself, with attributes, alongside what it reaches', async () => {
    const { decision, req, story, task } = await seedChain()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/graph:subgraph',
      headers: asAdmin,
      payload: { start: req, maxDepth: 2, direction: 'both' },
    })
    expect(res.statusCode).toBe(200)
    const nodes = res.json().nodes as { id: string; depth: number; attributes: { title?: string } }[]

    // 起点自己在图上——`:traverse` 只回 depth > 0，圆心得自己补
    const start = nodes.find((n) => n.id === req)
    expect(start).toMatchObject({ depth: 0 })
    // 标题跟着节点一起回来，否则画出来的是一圈没有名字的圆点
    expect(start?.attributes.title).toBe('billing')
    // direction: 'both' 也会沿 `explains` 的逆向上走到 Decision——
    // 那正是这张图该有的样子：一个需求周围的东西不只在它下游
    expect(nodes.map((n) => n.id).sort()).toEqual([decision, req, story, task].sort())

    // 跳数必须跟着节点回来。图是按它分层画的（同心圆），
    // 全算成 0 的话七个节点会叠在圆心上——**没有报错，只是那张图不再有意义**
    const depthById = new Map(nodes.map((n) => [n.id, n.depth]))
    expect(depthById.get(story)).toBe(1)
    expect(depthById.get(task)).toBe(2)
  })

  it('includes edges between nodes at the same depth, which a traversal path cannot express', async () => {
    // traverse 的 `DISTINCT ON (id)` 每个节点只留最短的那条路径，
    // 于是同层之间的横向连边一条也不在结果里。少画一条边不是"简化"，
    // 是**告诉看图的人那两个东西没关系**
    const story = await create('Story', { title: 'root' })
    const a = await create('Task', { title: 'a' })
    const b = await create('Task', { title: 'b' })
    await relate(story, 'decomposedInto', a)
    await relate(story, 'decomposedInto', b)
    await relate(a, 'blocks', b) // 同为 depth 1 的两个节点之间的边

    const res = await app.inject({
      method: 'POST',
      url: '/v1/graph:subgraph',
      headers: asAdmin,
      payload: { start: story, maxDepth: 1, direction: 'both' },
    })
    const edges = res.json().edges as { fromId: string; toId: string; type: string }[]
    expect(edges).toHaveLength(3)
    expect(edges).toContainEqual(expect.objectContaining({ fromId: a, toId: b, type: 'blocks' }))
  })

  it('never draws an edge with a dangling end', async () => {
    // 起点是无条件放进图里的，但 `query` 不返回软删除的对象。
    // 拿"遍历命中的 id"去查边的话，这里会回来一条一端悬空的连线——
    // **那条线本身就说出了"这里还有个东西"**
    const story = await create('Story', { title: 'about to go' })
    const task = await create('Task', { title: 'still here' })
    await relate(story, 'decomposedInto', task)
    const current = await app.inject({ method: 'GET', url: `/v1/resources/${story}`, headers: asAdmin })
    const removed = await app.inject({
      method: 'DELETE',
      url: `/v1/resources/${story}`,
      headers: { ...asAdmin, 'if-match': `"${current.json().version}"` },
    })
    expect(removed.statusCode).toBe(204)

    const res = await app.inject({
      method: 'POST',
      url: '/v1/graph:subgraph',
      headers: asAdmin,
      payload: { start: story, maxDepth: 2, direction: 'both' },
    })
    expect(res.statusCode).toBe(200)
    // 起点自己不在节点里了（`query` 不返回软删除的对象），
    // 于是那条 story → task 的边也必须一起消失
    const nodes = res.json().nodes as { id: string }[]
    expect(nodes.map((n) => n.id)).not.toContain(story)
    expect(res.json().edges).toEqual([])
    // 遍历本身照旧走得出去——邻居还在，只是没有任何边指回那个已删除的圆心。
    // 这一条记下来是因为它容易被读成"图应该是空的"：不是，
    // 空的是**边**，节点该在的还在
    expect(nodes.map((n) => n.id)).toEqual([task])
  })

  it('returns an empty graph, not an error, when nothing at all is visible', async () => {
    // 一个已删除、且没有任何活着的邻居的起点 —— 节点集是空的。
    // 拿着空集合去查边必须短路：Kysely 的 `in []` 生成 `in ()`，PG 直接语法错误。
    // 也就是说这里的"空集合提前返回"不是省一次往返，是**唯一没有炸掉的那条路**
    const lonely = await create('Task', { title: 'nobody' })
    const current = await app.inject({ method: 'GET', url: `/v1/resources/${lonely}`, headers: asAdmin })
    await app.inject({
      method: 'DELETE',
      url: `/v1/resources/${lonely}`,
      headers: { ...asAdmin, 'if-match': `"${current.json().version}"` },
    })

    const res = await app.inject({
      method: 'POST',
      url: '/v1/graph:subgraph',
      headers: asAdmin,
      payload: { start: lonely, maxDepth: 2, direction: 'both' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().nodes).toEqual([])
    expect(res.json().edges).toEqual([])
  })

  it('drops a soft-deleted neighbour together with the edge that reached it', async () => {
    const story = await create('Story', { title: 'visible' })
    const task = await create('Task', { title: 'gone' })
    await relate(story, 'decomposedInto', task)
    const current = await app.inject({ method: 'GET', url: `/v1/resources/${task}`, headers: asAdmin })
    await app.inject({
      method: 'DELETE',
      url: `/v1/resources/${task}`,
      headers: { ...asAdmin, 'if-match': `"${current.json().version}"` },
    })

    const res = await app.inject({
      method: 'POST',
      url: '/v1/graph:subgraph',
      headers: asAdmin,
      payload: { start: story, maxDepth: 2, direction: 'both' },
    })
    expect((res.json().nodes as { id: string }[]).map((n) => n.id)).toEqual([story])
    expect(res.json().edges).toEqual([])
  })

  it('stops the walk at the node cap instead of letting the page clamp eat the rest', async () => {
    // 节点是用 `query` 一次取回来的，而它把 size 夹在 MAX_PAGE_SIZE。
    // 遍历要是走得比这条线远，多出来的节点会被**静默丢掉**，
    // 而 truncated 依然是 false——一张看起来完整的、缺了东西的图。
    const hub = await create('Story', { title: 'hub' })
    const kids = await Promise.all(
      Array.from({ length: MAX_PAGE_SIZE + 5 }, (_, i) => create('Task', { title: `t${i}` })),
    )
    await Promise.all(kids.map((k) => relate(hub, 'decomposedInto', k)))

    const res = await app.inject({
      method: 'POST',
      url: '/v1/graph:subgraph',
      headers: asAdmin,
      // limit 不传，用服务端默认值（500）——它比上界大，正是会踩到那个坑的用法
      payload: { start: hub, maxDepth: 1, direction: 'both' },
    })
    expect(res.statusCode).toBe(200)
    const nodes = res.json().nodes as unknown[]
    expect(nodes.length).toBeLessThanOrEqual(MAX_PAGE_SIZE)
    // **被截断了就必须说**。这一条才是真正的断言：节点数上限本身可以商量，
    // "少了而不告诉你"不行
    expect(res.json().truncated).toBe(true)
  })

  it('draws a rejected edge between two visible nodes, but never walks through one', async () => {
    // 否决 ≠ 删除。遍历里的边是**通路**，否决过的走不过去；
    // 图上的边是**说明**，两端本来就在图上，画成虚线说的是
    // "有人看过这条关系并且否掉了它"。藏起来的后果是下周有人再推断一次同样的边，
    // 而图上没有任何痕迹说明这事发生过
    const asAgent = {
      'x-principal': 'agent://knowledge@1.0.0',
      'x-tenant': TENANT,
      'x-roles': 'AIAgent',
      'x-capabilities': 'Knowledge.Update,Knowledge.Read,Task.Read',
    }
    const project = await create('Project', { key: 'PX', name: 'hub' })
    const task = await create('Task', { title: 'reachable' })
    const knowledge = await create('Knowledge', { title: 'k', body: 'b' })
    const orphan = await create('Task', { title: 'only via a rejected edge' })
    expect((await relate(project, 'contains', task)).statusCode).toBe(201)
    expect((await relate(project, 'contains', knowledge)).statusCode).toBe(201)

    // 两条 Agent 推断的边，都否掉：一条在两个已经在图上的节点之间，
    // 一条通往一个别无他路可达的节点
    for (const toId of [task, orphan]) {
      const inferred = await app.inject({
        method: 'POST',
        url: `/v1/resources/${knowledge}/relations`,
        headers: asAgent,
        payload: { type: 'derivedFrom', toId, confidence: 0.8 },
      })
      await app.inject({
        method: 'POST',
        url: `/v1/relations/${inferred.json().id}/confirmation`,
        headers: asAdmin,
        payload: { confirmed: false },
      })
    }

    const res = await app.inject({
      method: 'POST',
      url: '/v1/graph:subgraph',
      headers: asAdmin,
      payload: { start: project, maxDepth: 2, direction: 'both' },
    })
    const nodes = (res.json().nodes as { id: string }[]).map((n) => n.id)
    // 只能靠一条被否决的边走到的节点**不在图上**——否决过的边不产生可达性
    expect(nodes).not.toContain(orphan)
    expect(nodes.sort()).toEqual([project, task, knowledge].sort())

    const edges = res.json().edges as { fromId: string; toId: string; confirmed: boolean | null }[]
    const rejected = edges.find((e) => e.fromId === knowledge && e.toId === task)
    expect(rejected?.confirmed).toBe(false)
    // 通往 orphan 的那条边一端不在图上，绝不能画出来
    expect(edges.some((e) => e.toId === orphan || e.fromId === orphan)).toBe(false)
  })

  it('reports truncation for a graph smaller than the cap too', async () => {
    const hub = await create('Story', { title: 'small hub' })
    for (let i = 0; i < 12; i++) {
      await relate(hub, 'decomposedInto', await create('Task', { title: `t${i}` }))
    }
    const res = await app.inject({
      method: 'POST',
      url: '/v1/graph:subgraph',
      headers: asAdmin,
      payload: { start: hub, maxDepth: 1, direction: 'both', limit: 5 },
    })
    expect(res.json().truncated).toBe(true)
    // 起点 + limit 个
    expect((res.json().nodes as unknown[]).length).toBe(6)
  })
})


describe('shortest path (FR-ONT-005)', () => {
  it('connects an incident back to the decision that explains it', async () => {
    // PRD 04 §5.1 的追溯场景：Task ← Story ← Requirement ← Decision
    const { task, decision } = await seedChain()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/graph:path',
      headers: asAdmin,
      payload: { from: task, to: decision, maxDepth: 6 },
    })
    expect(res.statusCode).toBe(200)
    const path = res.json().path as { nodes: string[]; relations: string[] }
    expect(path).not.toBeNull()
    expect(path.nodes[0]).toBe(task)
    expect(path.nodes[path.nodes.length - 1]).toBe(decision)
    expect(path.relations).toEqual(['decomposedInto', 'implementedBy', 'explains'])
  })

  it('returns null when nothing connects them', async () => {
    const { task } = await seedChain()
    const orphan = await create('Knowledge', { title: 'k', body: 'b' })
    const res = await app.inject({
      method: 'POST',
      url: '/v1/graph:path',
      headers: asAdmin,
      payload: { from: task, to: orphan, maxDepth: 6 },
    })
    expect(res.json().path).toBeNull()
  })
})

describe('agent-inferred relations (FR-ONT-006)', () => {
  const asAgent = {
    'x-principal': 'agent://knowledge@1.0.0',
    'x-tenant': TENANT,
    'x-roles': 'AIAgent',
    'x-capabilities': 'Knowledge.Update,Knowledge.Read,Task.Read',
  }

  it('denies an agent that has the capability but no policy granting it', async () => {
    // 两层都要过：这个 Agent 有 Task.Read 能力，但没有任何 policy 允许它写 Task
    const a = await create('Task', { title: 'a' })
    const b = await create('Task', { title: 'b' })
    const res = await app.inject({
      method: 'POST',
      url: `/v1/resources/${a}/relations`,
      headers: { ...asAgent, 'x-capabilities': 'Task.Update' },
      payload: { type: 'blockedBy', toId: b, confidence: 0.9 },
    })
    expect(res.statusCode).toBe(403)
  })

  it('requires a confidence value from an agent', async () => {
    const knowledge = await create('Knowledge', { title: 'k', body: 'b' })
    const task = await create('Task', { title: 't' })
    const res = await app.inject({
      method: 'POST',
      url: `/v1/resources/${knowledge}/relations`,
      headers: asAgent,
      payload: { type: 'derivedFrom', toId: task },
    })
    expect(res.statusCode).toBe(422)
    expect(res.json().message).toMatch(/confidence/)
  })

  it('marks an agent-inferred edge as pending confirmation and keeps it out of traversal defaults', async () => {
    const knowledge = await create('Knowledge', { title: 'k', body: 'b' })
    const task = await create('Task', { title: 't' })
    const res = await app.inject({
      method: 'POST',
      url: `/v1/resources/${knowledge}/relations`,
      headers: asAgent,
      payload: { type: 'derivedFrom', toId: task, confidence: 0.82 },
    })
    expect(res.statusCode).toBe(201)
    expect(res.json()).toMatchObject({
      confidence: 0.82,
      confirmed: null, // 待人工确认
      createdBy: 'agent:knowledge@1.0.0',
    })
  })

  it('records a human-created edge as confirmed', async () => {
    const a = await create('Task', { title: 'a' })
    const b = await create('Task', { title: 'b' })
    const res = await relate(a, 'blockedBy', b)
    expect(res.json()).toMatchObject({ createdBy: 'human', confirmed: true, confidence: null })
  })
})

/**
 * `project` 字段与 contains 边的一致性（docs/dogfooding-log.md #6）。
 *
 * 「这个对象属于哪个项目」被存了两份：标量字段与图上的边。
 * 此前没有任何东西让两份保持一致——自用一轮之后，26 个对象声称属于某个项目，
 * 在图里却完全不可达，而系统一声没吭。这组用例锁住的是：
 * **写了 project 就一定能在图上走到它**。
 */
describe('project containment is maintained, not left to discipline (dogfooding #6)', () => {
  async function createIn(
    project: string | null,
    type: string,
    attributes: Record<string, unknown>,
  ) {
    return app.inject({
      method: 'POST',
      url: '/v1/resources',
      headers: asAdmin,
      payload: { type, workspace: 'ws_platform', ...(project === null ? {} : { project }), attributes },
    })
  }

  it('creates the containment edge when project is set', async () => {
    const project = await create('Project', { key: 'PX', name: 'Platform' })
    const res = await createIn(project, 'Task', { title: 'inside the project' })
    expect(res.statusCode).toBe(201)

    const relations = await app.inject({
      method: 'GET',
      url: `/v1/resources/${res.json().id}/relations?direction=in&type=contains`,
      headers: asAdmin,
    })
    const items = relations.json().items as Array<{ fromId: string; createdBy: string }>
    expect(items).toHaveLength(1)
    expect(items[0]?.fromId).toBe(project)
    // 系统维持的不变式，不是某个人手工建的
    expect(items[0]?.createdBy).toBe('system')
  })

  it('makes the object reachable from the project by traversal', async () => {
    // 这才是重点：边存在不是目的，能从项目走到它才是
    const project = await create('Project', { key: 'PY', name: 'Reachable' })
    const knowledge = (await createIn(project, 'Knowledge', { title: 'k', body: 'b' })).json().id

    const res = await app.inject({
      method: 'POST',
      url: '/v1/graph:traverse',
      headers: asAdmin,
      payload: { start: project, follow: ['contains'], maxDepth: 2 },
    })
    const ids = (res.json().items as Array<{ id: string }>).map((h) => h.id)
    expect(ids).toContain(knowledge)
  })

  it('rejects a project that does not exist', async () => {
    // 以前这里回 201：project 是一个没有任何约束的字符串
    const res = await createIn('prj_00000000000000000000000000', 'Task', { title: 't' })
    expect(res.statusCode).toBe(422)
    expect(res.json().message).toMatch(/does not exist/)
  })

  it('rejects a project that is not actually a Project', async () => {
    const notAProject = await create('Task', { title: 'just a task' })
    const res = await createIn(notAProject, 'Task', { title: 't' })
    expect(res.statusCode).toBe(422)
    expect(res.json().message).toMatch(/must reference a Project/)
  })

  it('rejects a type the ontology will not let a Project contain', async () => {
    // 存字段但不建边就是在制造半连接对象。本体不允许就直接拒绝，
    // 要让 Project 装下新类型，去改本体（ADR-0001）
    const project = await create('Project', { key: 'PZ', name: 'Strict' })
    const res = await createIn(project, 'Agent', {
      name: 'coder',
      principal: 'agent://coder@1.0.0',
    })
    expect(res.statusCode).toBe(422)
    expect(res.json().message).toMatch(/contains/)
  })

  it('leaves the object unlinked when no project is given', async () => {
    const res = await createIn(null, 'Task', { title: 'standalone' })
    expect(res.statusCode).toBe(201)
    const relations = await app.inject({
      method: 'GET',
      url: `/v1/resources/${res.json().id}/relations?direction=both`,
      headers: asAdmin,
    })
    expect(relations.json().items).toHaveLength(0)
  })

  it('emits a RelationCreated event for the edge it created', async () => {
    // 悄悄插一条边、不发事件，等于让自动化和下游消费者看不到它
    const project = await create('Project', { key: 'PE', name: 'Events' })
    const task = (await createIn(project, 'Task', { title: 'watched' })).json().id

    const events = await queryAsTenant<{ event_type: string; payload: Record<string, unknown> }>(
      pool,
      TENANT,
      `SELECT event_type, payload FROM outbox_events WHERE event_type = 'RelationCreated'`,
    )
    expect(
      events.some((e) => e.payload['toId'] === task && e.payload['relationType'] === 'contains'),
    ).toBe(true)
  })
})

/**
 * 重复建边是幂等的，但幂等不等于可以谎报（docs/dogfooding-log.md #8）。
 *
 * 唯一索引 + `ON CONFLICT DO NOTHING` 保证了自动化规则反复触发不会报错，
 * 但此前服务层把**刚构造的对象**原样返回：接口回 201，附带一个
 * 数据库里根本不存在的 id，事件里也带着它。
 */
describe('creating the same edge twice returns the edge that exists', () => {
  it('returns the persisted relation, not a fabricated one', async () => {
    const story = await create('Story', { title: 's' })
    const task = await create('Task', { title: 't' })

    const first = await relate(story, 'decomposedInto', task)
    const second = await relate(story, 'decomposedInto', task)
    expect(first.statusCode).toBe(201)
    expect(second.statusCode).toBe(201)

    // 同一条边，同一个 id
    expect(second.json().id).toBe(first.json().id)

    // 而且这个 id 真的能用——以前拿第二次的 id 去删会 404
    const removed = await app.inject({
      method: 'DELETE',
      url: `/v1/relations/${second.json().id}`,
      headers: asAdmin,
    })
    expect(removed.statusCode).toBe(204)
  })

  it('does not emit a second RelationCreated event for the same edge', async () => {
    // 重复发事件会让下游自动化对同一条边跑两遍
    const story = await create('Story', { title: 's2' })
    const task = await create('Task', { title: 't2' })
    await relate(story, 'decomposedInto', task)
    await relate(story, 'decomposedInto', task)

    const events = await queryAsTenant<{ payload: Record<string, unknown> }>(
      pool,
      TENANT,
      `SELECT payload FROM outbox_events WHERE event_type = 'RelationCreated'`,
    )
    const forThisEdge = events.filter(
      (e) => e.payload['fromId'] === story && e.payload['toId'] === task,
    )
    expect(forThisEdge).toHaveLength(1)
  })
})

/**
 * 依赖不允许成环（FR-DOM-005）。
 *
 * 环意味着这几件事互相等对方先做完，谁也开不了工。这是能在写入时
 * 判掉的错，而在排期会上才发现的话，代价大得多。
 *
 * "哪些关系不能成环"写在**本体**里（`acyclic: true`），不是服务层的一处 if：
 * 新增一种依赖关系时，作者要回答的是一个建模问题，而不是记得去改代码。
 */
describe('acyclic relations (FR-DOM-005)', () => {
  it('refuses a direct two-node cycle, and shows the path', async () => {
    const a = await create('Task', { title: 'A' })
    const b = await create('Task', { title: 'B' })
    expect((await relate(a, 'blockedBy', b)).statusCode).toBe(201)

    const res = await relate(b, 'blockedBy', a)
    expect(res.statusCode).toBe(422)
    expect(res.json().message).toMatch(/cycle/)
    // 只说"会成环"的话，使用者得自己在图里找是哪几条边
    expect(res.json().details.path).toBeDefined()
  })

  it('refuses a longer cycle', async () => {
    const [a, b, c] = [
      await create('Task', { title: 'A' }),
      await create('Task', { title: 'B' }),
      await create('Task', { title: 'C' }),
    ]
    await relate(a, 'blockedBy', b)
    await relate(b, 'blockedBy', c)
    expect((await relate(c, 'blockedBy', a)).statusCode).toBe(422)
  })

  it('refuses a self-loop', async () => {
    const a = await create('Task', { title: 'A' })
    const res = await relate(a, 'blockedBy', a)
    expect(res.statusCode).toBe(422)
    expect(res.json().message).toMatch(/itself/)
  })

  it('catches a cycle closed from the other direction', async () => {
    // 一条边只存一行：A blocks B 可能是以 blockedBy 从 B 存过来的。
    // 只查出边的话，从另一头建的依赖全部看不见，判环会漏掉一半
    const a = await create('Task', { title: 'A' })
    const b = await create('Task', { title: 'B' })
    expect((await relate(a, 'blocks', b)).statusCode).toBe(201)

    // a blocks b，因此 b 不能再 blocks a
    expect((await relate(b, 'blocks', a)).statusCode).toBe(422)
    // 换成等价的逆关系表达，同样要拦下
    expect((await relate(a, 'blockedBy', b)).statusCode).toBe(422)
  })

  it('allows a diamond — shared dependencies are not cycles', async () => {
    // 判环判过头会拦下大量合法建模。A 和 B 都依赖 C 是完全正常的
    const [a, b, c] = [
      await create('Task', { title: 'A' }),
      await create('Task', { title: 'B' }),
      await create('Task', { title: 'C' }),
    ]
    expect((await relate(a, 'blockedBy', c)).statusCode).toBe(201)
    expect((await relate(b, 'blockedBy', c)).statusCode).toBe(201)
  })

  it('takes the rule from the ontology, not from a list in the service', async () => {
    // "哪些关系不能成环"是建模决定。写死在服务层的话，
    // 新增一种依赖关系时作者要记得去改一处 if——而他不会记得
    const res = await app.inject({
      method: 'GET',
      url: '/v1/ontology/relation-types',
      headers: asAdmin,
    })
    const types = res.json().items as { name: string; acyclic?: boolean }[]
    expect(types.find((t) => t.name === 'blockedBy')?.acyclic).toBe(true)
    expect(types.find((t) => t.name === 'blocks')?.acyclic).toBe(true)
    // 没标的关系不该被这条规则波及
    expect(types.find((t) => t.name === 'explains')?.acyclic).toBeUndefined()
  })

  it('does not check relations that are not declared acyclic', async () => {
    // `derivedFrom` 没标 acyclic，建立时不该走判环那条路径
    const knowledge = await create('Knowledge', { title: 'K', body: 'b' })
    const decision = await create('Decision', { question: 'q', chosen: 'c', rationale: 'r' })
    expect((await relate(knowledge, 'derivedFrom', decision)).statusCode).toBe(201)
  })
})

/**
 * 风险要指得出触发它的实体（FR-AI-006）。
 *
 * 这一条的第一版实现是错的，值得记下来：它是 Agent 运行时里的一个
 * 产出闸，检查 `attributes.evidence` 空不空。两处错——
 * Risk 的本体里根本没有这个属性（于是那个闸会拒掉**每一条**风险提议），
 * 而且一个字符串数组**点不动**。「可点击到实体」在这个系统里的意思是关系。
 *
 * 现在它是 Risk 生命周期上的守卫，和 Knowledge 的来源守卫同一套机制，
 * 于是它对**所有**风险生效——Agent 建的和人建的一视同仁。
 */
describe('a risk must point at what triggered it (FR-AI-006)', () => {
  async function riskReadyFor(to: string) {
    const risk = await create('Risk', {
      description: '导出接口可能超时',
      probability: 'high',
      impact: 'high',
      mitigation: '加一层缓存',
    })
    // Mitigating 还要求 owner
    await app.inject({
      method: 'PATCH',
      url: `/v1/resources/${risk}`,
      headers: { ...asAdmin, 'if-match': `"1"` },
      payload: { owner: 'user://bob' },
    })
    const res = await app.inject({
      method: 'GET',
      url: `/v1/resources/${risk}/transitions`,
      headers: asAdmin,
    })
    const target = (res.json().items as { to: string; ready: boolean; blockedBy: string | null }[]).find(
      (t) => t.to === to,
    )
    return { risk, target }
  }

  it('will not start mitigating a risk with no evidence, and says which relation is missing', async () => {
    const { target } = await riskReadyFor('Mitigating')
    expect(target?.ready).toBe(false)
    // 说得出缺的是什么。只说"守卫未满足"的话，人只能去读源码
    expect(target?.blockedBy).toMatch(/evidencedBy/)
  })

  it('lets it through once it cites an entity', async () => {
    const { risk } = await riskReadyFor('Mitigating')
    const task = await create('Task', { title: '导出任务' })
    expect((await relate(risk, 'evidencedBy', task)).statusCode).toBe(201)

    const after = await app.inject({
      method: 'GET',
      url: `/v1/resources/${risk}/transitions`,
      headers: asAdmin,
    })
    const target = (after.json().items as { to: string; ready: boolean }[]).find((t) => t.to === 'Mitigating')
    expect(target?.ready).toBe(true)
  })

  it('still lets a risk be logged without evidence — the gate is on acting, not on noticing', async () => {
    // 闸设在入口会让人不敢登记风险，而漏登记比登记得潦草糟得多
    const { target } = await riskReadyFor('Accepted')
    expect(target?.ready).toBe(true)
  })

  it('does not let a risk cite something that cannot be evidence', async () => {
    const { risk } = await riskReadyFor('Mitigating')
    const other = await create('Risk', {
      description: '另一条', probability: 'low', impact: 'low',
    })
    // 值域给得窄是有意的：允许指向任意对象的话，"有证据"就不再意味着什么
    expect((await relate(risk, 'evidencedBy', other)).statusCode).toBeGreaterThanOrEqual(400)
  })
})
