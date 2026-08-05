import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type pg from 'pg'
import type { FastifyInstance } from 'fastify'
import { assertNotSuperuser, queryAsTenant, setupTestDb, truncateAll } from '../helpers/db.ts'
import { buildServer } from '../../src/api/server.ts'
import { buildDefaultRegistry } from '../../src/ontology/defaults.ts'
import { buildDefaultWorkflowRegistry, DEFAULT_LIFECYCLES } from '../../src/workflow/defaults.ts'
import { defaultPolicies } from '../../src/identity/default-policies.ts'
import { ReloadingWorkflowRegistry } from '../../src/infrastructure/lifecycle-store.pg.ts'

/**
 * 可配置状态机（FR-WF-001）。
 *
 * 验收标准是「修改状态机定义后新实例即时生效」——"即时"排除了重启，
 * 所以这组用例全部在**同一个进程、不重建 server** 的前提下断言。
 */

const TENANT = 't_acme'
const asAdmin = { 'x-principal': 'user://alice', 'x-tenant': TENANT, 'x-roles': 'Admin', 'x-capabilities': '' }
const asPM = { 'x-principal': 'user://bob', 'x-tenant': TENANT, 'x-roles': 'PM', 'x-capabilities': '' }

let pool: pg.Pool
let app: FastifyInstance
let lifecycles: ReloadingWorkflowRegistry

beforeAll(async () => {
  pool = await setupTestDb()
  await assertNotSuperuser(pool)
  lifecycles = new ReloadingWorkflowRegistry({
    pool,
    tenant: TENANT,
    builtins: DEFAULT_LIFECYCLES,
    ttlMs: 0,
  })
  app = buildServer({
    pool,
    registry: buildDefaultRegistry(),
    workflows: buildDefaultWorkflowRegistry(),
    lifecycles,
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
  lifecycles.invalidate()
})

const putLifecycle = async (body: object, headers = asAdmin, id = 'task-default') =>
  app.inject({ method: 'PUT', url: `/v1/workflows/${id}`, headers, payload: body })

async function createTask() {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/resources',
    headers: asAdmin,
    payload: { type: 'Task', workspace: 'ws', attributes: { title: 't', assignee: 'user://bob' } },
  })
  return res.json()
}

/** 一台极简的 Task 状态机：Todo → Shipped，没有中间态 */
const SIMPLIFIED = {
  id: 'task-default',
  entityType: 'Task',
  initial: 'Todo',
  states: [{ name: 'Todo' }, { name: 'Shipped', terminal: true }],
  transitions: [{ from: ['Todo'], to: 'Shipped' }],
}

describe('a lifecycle change takes effect without a restart (FR-WF-001)', () => {
  it('changes the available transitions for the very next request', async () => {
    // 改之前：内置状态机，Todo 只能去 Doing / Cancelled
    const before = await createTask()
    const beforeMoves = await app.inject({
      method: 'GET',
      url: `/v1/resources/${before.id}/transitions`,
      headers: asAdmin,
    })
    expect(beforeMoves.json().items.map((t: { to: string }) => t.to)).toContain('Doing')

    expect((await putLifecycle(SIMPLIFIED)).statusCode).toBe(200)

    // 同一个进程、同一个 app 实例，没有重启
    const after = await createTask()
    const afterMoves = await app.inject({
      method: 'GET',
      url: `/v1/resources/${after.id}/transitions`,
      headers: asAdmin,
    })
    const targets = afterMoves.json().items.map((t: { to: string }) => t.to)
    expect(targets).toEqual(['Shipped'])
  })

  it('lets the new transition actually run', async () => {
    await putLifecycle(SIMPLIFIED)
    const task = await createTask()
    const res = await app.inject({
      method: 'POST',
      url: `/v1/resources/${task.id}/transitions`,
      headers: asAdmin,
      payload: { to: 'Shipped' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().status).toBe('Shipped')
  })

  it('shows the new definition on GET /v1/workflows', async () => {
    await putLifecycle(SIMPLIFIED)
    const res = await app.inject({ method: 'GET', url: '/v1/workflows', headers: asAdmin })
    const task = res.json().items.find((l: { entityType: string }) => l.entityType === 'Task')
    expect(task.states.map((s: { name: string }) => s.name)).toEqual(['Todo', 'Shipped'])
  })

  it('leaves other entity types on their built-in definitions', async () => {
    // 改流程应当是增量的，不需要先把全部内置定义导进库
    await putLifecycle(SIMPLIFIED)
    const res = await app.inject({ method: 'GET', url: '/v1/workflows', headers: asAdmin })
    const story = res.json().items.find((l: { entityType: string }) => l.entityType === 'Story')
    expect(story.states.map((s: { name: string }) => s.name)).toContain('InProgress')
  })
})

describe('an illegal definition never gets stored', () => {
  it('rejects a machine whose initial state does not exist', async () => {
    // 存进去之后，损害要等到有人试图迁移才出现——那时离原因已经很远
    const res = await putLifecycle({ ...SIMPLIFIED, initial: 'Nowhere' })
    expect(res.statusCode).toBeGreaterThanOrEqual(400)

    const listed = await app.inject({ method: 'GET', url: '/v1/workflows', headers: asAdmin })
    const task = listed.json().items.find((l: { entityType: string }) => l.entityType === 'Task')
    expect(task.states.map((s: { name: string }) => s.name)).toContain('Doing')
  })

  it('rejects a transition pointing at an undeclared state', async () => {
    const res = await putLifecycle({
      ...SIMPLIFIED,
      transitions: [{ from: ['Todo'], to: 'Atlantis' }],
    })
    expect(res.statusCode).toBeGreaterThanOrEqual(400)
  })

  it('rejects a body whose id disagrees with the path', async () => {
    const res = await putLifecycle(SIMPLIFIED, asAdmin, 'something-else')
    expect(res.statusCode).toBe(400)
    expect(res.json().message).toMatch(/path says/)
  })

  it('rejects unknown fields rather than dropping them', async () => {
    const res = await putLifecycle({ ...SIMPLIFIED, sates: [] })
    expect(res.statusCode).toBe(400)
  })
})

describe('changing a lifecycle is a privileged act', () => {
  it('refuses a non-admin', async () => {
    // 一次修改同时改变了该类型**所有**对象的可用动作
    const res = await putLifecycle(SIMPLIFIED, asPM)
    expect(res.statusCode).toBe(403)
    expect(res.json().message).toMatch(/Admin/)
  })

  it('records who changed it and bumps the revision', async () => {
    const first = await putLifecycle(SIMPLIFIED)
    expect(first.json().revision).toBe(1)
    const second = await putLifecycle({ ...SIMPLIFIED, states: [...SIMPLIFIED.states, { name: 'Held' }] })
    expect(second.json().revision).toBe(2)

    // 必须用 queryAsTenant：应用连接受 FORCE RLS 约束，
    // 没有租户上下文时这条 SELECT 什么都查不到——而且不报错。
    // 写这条断言时我自己先踩了一次
    const rows = await queryAsTenant<{ updated_by: string }>(
      pool,
      TENANT,
      `SELECT updated_by FROM lifecycles WHERE id = 'task-default'`,
    )
    expect(rows[0]?.updated_by).toBe('user://alice')
  })
})
