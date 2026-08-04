import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type pg from 'pg'
import type { FastifyInstance } from 'fastify'
import { assertNotSuperuser, queryAsTenant, setupTestDb, truncateAll } from '../helpers/db.ts'
import { buildServer } from '../../src/api/server.ts'
import { buildDefaultRegistry } from '../../src/ontology/defaults.ts'
import { buildDefaultWorkflowRegistry } from '../../src/workflow/defaults.ts'
import { defaultPolicies } from '../../src/identity/default-policies.ts'
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
