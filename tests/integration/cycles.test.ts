import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type pg from 'pg'
import type { FastifyInstance } from 'fastify'
import { setupTestDb, truncateAll } from '../helpers/db.ts'
import { buildServer } from '../../src/api/server.ts'
import { buildDefaultRegistry } from '../../src/ontology/defaults.ts'
import { buildDefaultWorkflowRegistry } from '../../src/workflow/defaults.ts'
import { defaultPolicies } from '../../src/identity/default-policies.ts'
import { OutboxPoller } from '../../src/infrastructure/poller.ts'
import { DEFAULT_AUTOMATION_RULES } from '../../src/workflow/automation.ts'

/**
 * 周期（时间维度）与模块（范围维度）。
 *
 * 指南第一节说这两个维度正交，且**不对称**：一个工作项只能在一个周期里，
 * 却可以属于多个模块。这份用例盯的就是那处不对称——它是靠本体里的
 * `cardinality` 声明生效的，没有一处硬编码的关系名。
 */

const TENANT = 'default'
let pool: pg.Pool
let app: FastifyInstance

const asAdmin = {
  'x-principal': 'user://alice',
  'x-tenant': TENANT,
  'x-roles': 'Admin',
  'content-type': 'application/json',
}

beforeAll(async () => {
  pool = await setupTestDb()
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

async function create(
  type: string,
  attributes: Record<string, unknown>,
): Promise<{ id: string; version: number }> {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/resources',
    headers: asAdmin,
    payload: { type, workspace: 'ws', attributes },
  })
  expect(res.statusCode, res.body).toBe(201)
  return res.json()
}

async function relate(type: string, fromId: string, toId: string): Promise<number> {
  const res = await app.inject({
    method: 'POST',
    url: `/v1/resources/${fromId}/relations`,
    headers: asAdmin,
    payload: { type, toId },
  })
  return res.statusCode
}

async function relationsOf(id: string, type: string): Promise<string[]> {
  const res = await app.inject({
    method: 'GET',
    url: `/v1/resources/${id}/relations?direction=out&type=${type}`,
    headers: asAdmin,
  })
  expect(res.statusCode, res.body).toBe(200)
  return res.json().items.map((r: { toId: string }) => r.toId)
}

async function transition(id: string, to: string): Promise<number> {
  const res = await app.inject({
    method: 'POST',
    url: `/v1/resources/${id}/transitions`,
    headers: asAdmin,
    payload: { to },
  })
  return res.statusCode
}

const CYCLE = (name: string) => ({
  name,
  startAt: '2026-08-01T00:00:00.000Z',
  endAt: '2026-08-05T00:00:00.000Z',
})

describe('周期是互斥的，模块不是（指南 §1 的那处不对称）', () => {
  it('加入新周期会把工作项从旧周期移出', async () => {
    const s1 = await create('Sprint', CYCLE('S1'))
    const s2 = await create('Sprint', CYCLE('S2'))
    const task = await create('Task', { title: '一件事' })

    await relate('plannedIn', task.id, s1.id)
    expect(await relationsOf(task.id, 'plannedIn')).toEqual([s1.id])

    // 换周期。不需要先删旧的那条——那正是"挤掉"要省掉的一步
    await relate('plannedIn', task.id, s2.id)
    expect(await relationsOf(task.id, 'plannedIn')).toEqual([s2.id])
  })

  it('从周期那一侧挂进来，互斥同样生效', async () => {
    const s1 = await create('Sprint', CYCLE('S1'))
    const s2 = await create('Sprint', CYCLE('S2'))
    const task = await create('Task', { title: '一件事' })

    // 一次正向存、一次反向存。只清一个方向的话这条会漏
    await relate('plannedIn', task.id, s1.id)
    await relate('plans', s2.id, task.id)

    expect(await relationsOf(task.id, 'plannedIn')).toEqual([s2.id])
    expect(await relationsOf(s1.id, 'plans')).toEqual([])
  })

  it('重复挂同一个周期是幂等的，不会把自己挤掉', async () => {
    const s1 = await create('Sprint', CYCLE('S1'))
    const task = await create('Task', { title: '一件事' })

    await relate('plannedIn', task.id, s1.id)
    await relate('plannedIn', task.id, s1.id)

    expect(await relationsOf(task.id, 'plannedIn')).toEqual([s1.id])
  })

  it('模块是多对多的：两个模块都留着', async () => {
    const pay = await create('Module', { name: '支付重构' })
    const debt = await create('Module', { name: 'Q3 技术债' })
    const task = await create('Task', { title: '拆掉旧网关' })

    await relate('inModule', task.id, pay.id)
    await relate('inModule', task.id, debt.id)

    expect((await relationsOf(task.id, 'inModule')).sort()).toEqual([pay.id, debt.id].sort())
  })

  it('Story 也能排周期，不只是 Task', async () => {
    const s1 = await create('Sprint', CYCLE('S1'))
    const story = await create('Story', { title: '一个不拆任务的小需求' })
    expect(await relate('plannedIn', story.id, s1.id)).toBe(201)
    expect(await relationsOf(story.id, 'plannedIn')).toEqual([s1.id])
  })
})

describe('燃尽图与周期进度', () => {
  it('燃尽图按周期里工作项的完成时刻算出来', async () => {
    const cycle = await create('Sprint', CYCLE('S1'))
    const a = await create('Task', { title: 'a', assignee: 'user://bob' })
    const b = await create('Task', { title: 'b', assignee: 'user://bob' })
    await relate('plans', cycle.id, a.id)
    await relate('plans', cycle.id, b.id)

    await transition(a.id, 'Doing')
    expect(await transition(a.id, 'Done')).toBe(200)

    const res = await app.inject({
      method: 'GET',
      url: `/v1/cycles/${cycle.id}/burndown`,
      headers: asAdmin,
    })
    expect(res.statusCode, res.body).toBe(200)
    const body = res.json()
    expect(body.total).toBe(2)
    expect(body.completed).toBe(1)
    // 五天的周期 → 五个点，理想线从 2 匀速降到 0
    expect(body.points).toHaveLength(5)
    expect(body.points[0].ideal).toBe(2)
    expect(body.points.at(-1).ideal).toBe(0)
  })

  it('对着一个不是周期的对象要燃尽图，会说清它是什么', async () => {
    const task = await create('Task', { title: 'a' })
    const res = await app.inject({
      method: 'GET',
      url: `/v1/cycles/${task.id}/burndown`,
      headers: asAdmin,
    })
    expect(res.statusCode).toBe(422)
    expect(res.json().message).toMatch(/is a Task, not a cycle/)
  })

  it('进度按状态组算，完成率的分母不含取消掉的', async () => {
    const cycle = await create('Sprint', CYCLE('S1'))
    const done = await create('Task', { title: 'done', assignee: 'user://bob' })
    const cancelled = await create('Task', { title: 'cancelled' })
    await relate('plans', cycle.id, done.id)
    await relate('plans', cycle.id, cancelled.id)

    await transition(done.id, 'Doing')
    await transition(done.id, 'Done')
    await transition(cancelled.id, 'Cancelled')

    const res = await app.inject({
      method: 'GET',
      url: `/v1/cycles/${cycle.id}/progress`,
      headers: asAdmin,
    })
    expect(res.statusCode, res.body).toBe(200)
    const body = res.json()
    expect(body.total).toBe(2)
    expect(body.completed).toBe(1)
    expect(body.cancelled).toBe(1)
    // 砍掉一半范围、剩下的做完了 → 100%，而不是 50%
    expect(body.completionRate).toBe(1)
    expect(body.byGroup).toMatchObject({ Completed: 1, Cancelled: 1 })
  })
})

describe('周期关闭时冻结进度快照', () => {
  it('关闭之后再改工作项，快照不动', async () => {
    const cycle = await create('Sprint', CYCLE('S1'))
    const a = await create('Task', { title: 'a', assignee: 'user://bob' })
    const b = await create('Task', { title: 'b', assignee: 'user://bob' })
    await relate('plans', cycle.id, a.id)
    await relate('plans', cycle.id, b.id)
    await transition(a.id, 'Doing')
    await transition(a.id, 'Done')

    await transition(cycle.id, 'Active')
    expect(await transition(cycle.id, 'Closed')).toBe(200)

    // 自动化经 outbox 异步展开，所以要推一轮 poller
    const poller = new OutboxPoller({
      pool,
      tenants: [TENANT],
      registry: buildDefaultRegistry(),
      workflows: buildDefaultWorkflowRegistry(),
      policies: defaultPolicies(TENANT),
      rules: DEFAULT_AUTOMATION_RULES,
    })
    await poller.pollOnce()

    const afterClose = await app.inject({
      method: 'GET',
      url: `/v1/resources/${cycle.id}`,
      headers: asAdmin,
    })
    const snapshot = afterClose.json().attributes.progressSnapshot
    expect(snapshot, JSON.stringify(afterClose.json().attributes)).toBeDefined()
    expect(snapshot.total).toBe(2)
    expect(snapshot.completed).toBe(1)

    // 周期关掉之后又完成了一件。快照**不该**跟着变——
    // 变了的话，回顾会上的数字和一周后再看时对不上
    await transition(b.id, 'Doing')
    await transition(b.id, 'Done')

    const later = await app.inject({
      method: 'GET',
      url: `/v1/resources/${cycle.id}`,
      headers: asAdmin,
    })
    expect(later.json().attributes.progressSnapshot.completed).toBe(1)

    // 而现算出来的进度是变了的——两个数字都在，各自说得清自己是什么
    const live = await app.inject({
      method: 'GET',
      url: `/v1/cycles/${cycle.id}/progress`,
      headers: asAdmin,
    })
    expect(live.json().completed).toBe(2)
  })
})
