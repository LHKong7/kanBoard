import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type pg from 'pg'
import type { FastifyInstance } from 'fastify'
import { assertNotSuperuser, setupTestDb, truncateAll } from '../helpers/db.ts'
import { buildServer } from '../../src/api/server.ts'
import { buildDefaultRegistry } from '../../src/ontology/defaults.ts'
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
