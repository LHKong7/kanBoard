import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type pg from 'pg'
import type { FastifyInstance } from 'fastify'
import { assertNotSuperuser, setupTestDb, truncateAll } from '../helpers/db.ts'
import { buildServer } from '../../src/api/server.ts'
import { buildDefaultRegistry } from '../../src/ontology/defaults.ts'
import { buildDefaultWorkflowRegistry } from '../../src/workflow/defaults.ts'
import { defaultPolicies } from '../../src/identity/default-policies.ts'

/**
 * Dashboard 指标（FR-DASH-005/006/010/011）。
 *
 * 这组用例真正在保护的是**指标与明细同源**这件事。
 * 功能性断言（"能返回一个数"）几乎没有价值——
 * 有价值的是"这个数点开之后，条数对得上"，
 * 因为对不上时没人会报 bug，只会默默不再相信这个数字。
 */

const TENANT = 't_acme'
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

async function create(type: string, attributes: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/resources',
    headers: asAdmin,
    payload: { type, workspace: 'ws_platform', attributes, ...extra },
  })
  if (res.statusCode !== 201) throw new Error(`create ${type}: ${res.body}`)
  return res.json().id as string
}

async function move(id: string, to: string) {
  const res = await app.inject({
    method: 'POST',
    url: `/v1/resources/${id}/transitions`,
    headers: asAdmin,
    payload: { to },
  })
  if (res.statusCode !== 200) throw new Error(`transition ${id} → ${to}: ${res.body}`)
}

const metric = async (id: string, qs = '') =>
  app.inject({ method: 'GET', url: `/v1/metrics/${id}${qs}`, headers: asAdmin })
const items = async (id: string, qs = '') =>
  app.inject({ method: 'GET', url: `/v1/metrics/${id}/items${qs}`, headers: asAdmin })

/** 三个任务：一个 Blocked，两个 Todo */
async function seedTasks() {
  // blockReason 是 Blocked 状态的守卫要求的——状态机在这里替我们把关
  const a = await create('Task', { title: '会被阻塞的', assignee: 'user://bob', blockReason: '等上游接口' })
  await create('Task', { title: '普通任务 1' })
  await create('Task', { title: '普通任务 2' })
  await move(a, 'Doing')
  await move(a, 'Blocked')
  return a
}

describe('metrics are computed, never entered by hand (FR-DASH-005)', () => {
  it('exposes no write path for metrics at all', async () => {
    // 这条不是在测某个 404，是在测**不存在填报入口**这件事本身。
    // 只要有人加了写路径，它就会红
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
      const res = await app.inject({ method, url: '/v1/metrics', headers: asAdmin, payload: {} })
      expect(res.statusCode, `${method} /v1/metrics`).toBe(404)
    }
    const one = await app.inject({
      method: 'POST',
      url: '/v1/metrics/project.tasks.blocked',
      headers: asAdmin,
      payload: { total: 999 },
    })
    expect(one.statusCode).toBe(404)
  })

  it('reflects reality the moment it changes (FR-DASH-011)', async () => {
    // 现算的，所以新鲜度是 0——不需要等物化任务
    expect((await metric('project.tasks.blocked')).json().total).toBe(0)
    await seedTasks()
    expect((await metric('project.tasks.blocked')).json().total).toBe(1)
  })

  it('publishes the definition alongside the number', async () => {
    // 口径不跟着数字走，两个人会读出两个意思
    const body = (await metric('project.tasks.blocked')).json()
    expect(body.definition).toMatch(/Blocked/)
    expect(body.direction).toBe('lower-is-better')
  })
})

describe('drilling down cannot disagree with the metric (FR-DASH-006)', () => {
  it('returns exactly as many items as the metric counted', async () => {
    await seedTasks()
    const total = (await metric('project.tasks.blocked')).json().total
    const detail = (await items('project.tasks.blocked')).json()
    expect(detail.items).toHaveLength(total)
    expect(detail.items[0].status).toBe('Blocked')
  })

  it('drills into one bucket of a distribution', async () => {
    await seedTasks()
    const dist = (await metric('project.tasks.by-status')).json()
    const todo = dist.groups.find((g: { key: string }) => g.key === 'Todo')
    expect(todo.count).toBe(2)

    const detail = (await items('project.tasks.by-status', '?group=Todo')).json()
    expect(detail.items).toHaveLength(todo.count)
    expect(detail.items.every((i: { status: string }) => i.status === 'Todo')).toBe(true)
  })

  it('keeps the two in step when scoped to a project', async () => {
    // scope 只作用在一边的话，指标和明细就会各说各话
    const project = await create('Project', { key: 'PA', name: 'A' })
    await create('Task', { title: '项目内' }, { project })
    await create('Task', { title: '项目外' })

    const scoped = `?project=${project}`
    expect((await metric('project.tasks.by-status', scoped)).json().total).toBe(1)
    expect((await items('project.tasks.by-status', scoped)).json().items).toHaveLength(1)
  })

  it('scopes to a project only when asked', async () => {
    // 不传 project 就是全租户，传了就只算那个项目。
    // 注意这条**没有**覆盖 definedOnly 那个防御逻辑：
    // 现有指标的 filter 里都没有 project，覆盖成 undefined 也不改变任何东西。
    // 那段防御的说明写在 service.ts 里，此处不假装测到了它
    const project = await create('Project', { key: 'PB', name: 'B' })
    await create('Task', { title: '项目内' }, { project })
    await create('Task', { title: '项目外' })

    expect((await metric('project.tasks.by-status')).json().total).toBe(2)
    expect((await metric('project.tasks.by-status', `?project=${project}`)).json().total).toBe(1)
  })
})

describe('metrics obey the same permissions as the data (FR-DASH-010)', () => {
  it('goes through the PDP rather than reading the tables directly', async () => {
    await seedTasks()
    const res = await app.inject({
      method: 'GET',
      url: '/v1/metrics/project.tasks.blocked',
      headers: { ...asAdmin, 'x-roles': 'Nobody' },
    })
    // 角色不合法 → 认证阶段就拒；关键是**没有绕过身份检查的旁路**
    expect(res.statusCode).toBe(401)
  })

  it('refuses an unauthenticated read of the catalogue', async () => {
    expect((await app.inject({ method: 'GET', url: '/v1/metrics' })).statusCode).toBe(401)
  })
})

describe('the catalogue is self-describing', () => {
  it('lists every metric with its scope and definition', async () => {
    const body = (await app.inject({ method: 'GET', url: '/v1/metrics', headers: asAdmin })).json()
    expect(body.items.length).toBeGreaterThan(0)
    for (const m of body.items) {
      expect(m.id, JSON.stringify(m)).toMatch(/^[a-z][a-z0-9.-]*$/)
      expect(m.definition.length).toBeGreaterThan(0)
      expect(['project', 'team', 'agent', 'knowledge']).toContain(m.scope)
    }
  })

  it('says which metrics exist when the id is wrong', async () => {
    const res = await metric('project.tasks.blocekd')
    expect(res.statusCode).toBe(404)
    expect(res.json().details.known).toContain('project.tasks.blocked')
  })
})

describe('agent metrics make the review burden visible (FR-DASH-003)', () => {
  it('counts runs waiting on a human', async () => {
    const agent = await create('Agent', { name: 'a', principal: 'agent://a@1.0.0' })
    const run = await create('AgentRun', {
      goal: 'g',
      agent,
      mode: 'Draft',
      trigger: 'human',
    })
    expect((await metric('agent.runs.awaiting-review')).json().total).toBe(0)

    await move(run, 'Running')
    await move(run, 'AwaitingReview')
    expect((await metric('agent.runs.awaiting-review')).json().total).toBe(1)

    // 这个数字是"Agent 制造了多少审阅负担"，方向必须是越小越好
    expect((await metric('agent.runs.awaiting-review')).json().direction).toBe('lower-is-better')
  })
})
