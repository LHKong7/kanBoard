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

  it('has no duplicate metric ids', async () => {
    // 重复的 id 会让 findMetric 永远返回第一条，
    // 表现是"改了口径却不生效"——极难查
    const body = (await app.inject({ method: 'GET', url: '/v1/metrics', headers: asAdmin })).json()
    const ids = (body.items as { id: string }[]).map((m) => m.id)
    expect(new Set(ids).size).toBe(ids.length)
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

/**
 * Automation Rate（FR-DASH-015，口径见 docs/prd/11-dashboard.md §2）。
 *
 * 纯计算部分在 tests/automation-rate.test.ts 里逐条对着口径表验证过。
 * 这里验证的是**接进真实数据之后仍然对**：历史能还原出 Agent 初版，
 * 终态取自状态机而不是另写一份清单，分母包含人做的工作项。
 */
describe('Automation Rate over real data (FR-DASH-015)', () => {
  const rate = async (qs = '') =>
    app.inject({ method: 'GET', url: `/v1/metrics:automation-rate${qs}`, headers: asAdmin })

  async function agentTask(title: string, edit?: Record<string, unknown>) {
    // 以 Agent 身份创建，这样 createdBy 是 agent://
    const asAgent = {
      'x-principal': 'agent://planner@1.0.0',
      'x-tenant': TENANT,
      'x-roles': 'AIAgent',
      'x-capabilities': 'Task.*',
    }
    const created = await app.inject({
      method: 'POST',
      url: '/v1/resources',
      headers: asAgent,
      payload: { type: 'Task', workspace: 'ws', attributes: { title, assignee: 'user://bob' } },
    })
    const id = created.json().id as string

    if (edit !== undefined) {
      const current = await app.inject({ method: 'GET', url: `/v1/resources/${id}`, headers: asAdmin })
      await app.inject({
        method: 'PATCH',
        url: `/v1/resources/${id}`,
        headers: asAdmin,
        payload: {
          expectedVersion: current.json().version,
          attributes: { ...current.json().attributes, ...edit },
        },
      })
    }
    for (const to of ['Doing', 'Review', 'Testing', 'Done']) await move(id, to)
    return id
  }

  it('does not collide with GET /v1/metrics/:id', async () => {
    // 这个项目在 `:query` 上栽过一次：Fastify 把冒号后的部分当成了路径参数
    const res = await rate()
    expect(res.statusCode).toBe(200)
    expect(res.json().rubricVersion).toBeTruthy()

    const byId = await metric('project.tasks.blocked')
    expect(byId.statusCode).toBe(200)
    expect(byId.json().id).toBe('project.tasks.blocked')
  })

  it('counts an untouched agent output as L3', async () => {
    await agentTask('Agent 原样被接受的任务')
    const body = (await rate()).json()
    expect(body.byLevel.L3).toBe(1)
    expect(body.automationRate).toBe(1)
  })

  it('counts human work in the denominator', async () => {
    // 只统计 Agent 碰过的，率会虚高到毫无意义
    await agentTask('Agent 的')
    const human = await create('Task', { title: '人做的', assignee: 'user://bob' })
    for (const to of ['Doing', 'Review', 'Testing', 'Done']) await move(human, to)

    const body = (await rate()).json()
    expect(body.total).toBe(2)
    expect(body.byLevel.L0).toBe(1)
    expect(body.automationRate).toBe(0.5)
  })

  it('drops to a lower level once a human edits the output', async () => {
    await agentTask('原标题', { title: '人重写过的完全不同的标题内容' })
    const body = (await rate()).json()
    expect(body.byLevel.L3).toBe(0)
    expect(body.items[0].editRatio).toBeGreaterThan(0)
  })

  it('ignores items that have not reached a terminal state', async () => {
    // 未进入终态的产出不计入（§2.3）
    const asAgent = {
      'x-principal': 'agent://planner@1.0.0',
      'x-tenant': TENANT,
      'x-roles': 'AIAgent',
      'x-capabilities': 'Task.*',
    }
    await app.inject({
      method: 'POST',
      url: '/v1/resources',
      headers: asAgent,
      payload: { type: 'Task', workspace: 'ws', attributes: { title: '还没做完' } },
    })
    expect((await rate()).json().total).toBe(0)
  })

  it('exposes the drill-down and the rubric version', async () => {
    // 一个没人能验证的数字不配当北极星
    await agentTask('可下钻的任务')
    const body = (await rate()).json()
    expect(body.items).toHaveLength(1)
    expect(body.items[0].title).toBe('可下钻的任务')
    expect(body.items[0].agent).toBe('agent://planner@1.0.0')
    expect(body.rubricVersion).toBe('1.0.0')
  })

  it('flags recent L3 items as provisional', async () => {
    // 刚进终态的项还在 7 天推翻窗口内，随时可能被扣回去
    await agentTask('刚刚完成的')
    const body = (await rate()).json()
    expect(body.provisional).toBe(1)
  })

  it('grades against the version at acceptance, not the current one', async () => {
    // §2 的编辑幅度是"到**进入终态时**的最终版本"。
    // 采纳之后的补充不是"采纳前的人工修改"，算进去会让一个
    // 原样接受、后来才被人补了一句的产出莫名其妙降级
    const id = await agentTask('原样接受的任务')
    const current = await app.inject({ method: 'GET', url: `/v1/resources/${id}`, headers: asAdmin })
    await app.inject({
      method: 'PATCH',
      url: `/v1/resources/${id}`,
      headers: asAdmin,
      payload: {
        expectedVersion: current.json().version,
        attributes: { ...current.json().attributes, title: '完成之后才补的完全不同的标题' },
      },
    })

    const body = (await rate()).json()
    expect(body.items[0].editRatio).toBe(0)
    expect(body.byLevel.L3).toBe(1)
  })
})

/**
 * 7 天推翻窗口的回溯修正（FR-DASH-016）。
 *
 * 这是「指标即查询」真正兑现的地方：历史值没有被存下来，
 * 所以它**天然**会随事实变化而变化。如果指标是物化写入的，
 * 回溯修正就得额外写一套重算任务——而那套任务漏跑一次，
 * 没有任何人会发现。
 */
describe('overturn window and retroactive correction (FR-DASH-016)', () => {
  const rate = async (qs = '') =>
    app.inject({ method: 'GET', url: `/v1/metrics:automation-rate${qs}`, headers: asAdmin })

  async function agentTaskDone(title: string) {
    const created = await app.inject({
      method: 'POST',
      url: '/v1/resources',
      headers: {
        'x-principal': 'agent://planner@1.0.0',
        'x-tenant': TENANT,
        'x-roles': 'AIAgent',
        'x-capabilities': 'Task.*',
      },
      payload: { type: 'Task', workspace: 'ws', attributes: { title, assignee: 'user://bob' } },
    })
    const id = created.json().id as string
    for (const to of ['Doing', 'Review', 'Testing', 'Done']) await move(id, to)
    return id
  }

  it('reopening a Done task is possible at all', async () => {
    // 在 ADR-0012 之前这条迁移不存在，于是"被推翻"在系统里
    // 根本无法表达，Rework Rate 会永远是 0——不是因为质量好
    const id = await agentTaskDone('会被重开的任务')
    await move(id, 'Doing')
    const after = await app.inject({ method: 'GET', url: `/v1/resources/${id}`, headers: asAdmin })
    expect(after.json().status).toBe('Doing')
  })

  it('deducts a reopened item from L3 and counts it as rework', async () => {
    const settled = await agentTaskDone('站住了的任务')
    const overturned = await agentTaskDone('被推翻的任务')

    const before = (await rate()).json()
    expect(before.byLevel.L3).toBe(2)
    expect(before.automationRate).toBe(1)
    expect(before.reworked).toBe(0)

    await move(overturned, 'Doing')

    // 同一个查询，同一段时期，数字变了——因为事实变了。
    // 这就是"回溯修正"，没有额外的重算任务
    const after = (await rate()).json()
    expect(after.byLevel.L3).toBe(1)
    expect(after.automationRate).toBe(0.5)
    expect(after.reworked).toBe(1)
    expect(after.reworkRate).toBe(0.5)
    expect(after.items.find((i: { id: string }) => i.id === settled).level).toBe('L3')
    expect(after.items.find((i: { id: string }) => i.id === overturned).reworked).toBe(true)
  })

  it('keeps a reopened item in the denominator', async () => {
    // 最容易写错的一条：按当前状态过滤的话，被重开的项此刻不在终态，
    // 于是从分子和分母同时消失。自动化率照样下降，看起来"生效了"，
    // 但 Rework Rate 恒为 0，回溯修正根本没有发生
    const id = await agentTaskDone('被推翻的任务')
    await move(id, 'Doing')

    const body = (await rate()).json()
    expect(body.total).toBe(1)
    expect(body.accepted).toBe(1)
    expect(body.reworked).toBe(1)
  })

  it('never counts an item that has not been accepted yet', async () => {
    // 只走到 Review 的任务从未进入终态，重开与否都与它无关
    const created = await app.inject({
      method: 'POST',
      url: '/v1/resources',
      headers: {
        'x-principal': 'agent://planner@1.0.0',
        'x-tenant': TENANT,
        'x-roles': 'AIAgent',
        'x-capabilities': 'Task.*',
      },
      payload: { type: 'Task', workspace: 'ws', attributes: { title: '在做', assignee: 'user://bob' } },
    })
    for (const to of ['Doing', 'Review']) await move(created.json().id, to)
    expect((await rate()).json().total).toBe(0)
  })

  it('scopes the metric to a period by acceptance time', async () => {
    await agentTaskDone('本期完成的')

    // 采纳发生在"现在"，所以一个位于过去的窗口里应当空无一物
    const past = (await rate('?from=2020-01-01T00:00:00Z&to=2020-02-01T00:00:00Z')).json()
    expect(past.total).toBe(0)
    expect(past.automationRate).toBe(0)

    const wide = (await rate('?from=2020-01-01T00:00:00Z')).json()
    expect(wide.total).toBe(1)
  })

  it('rejects a period whose end precedes its start', async () => {
    // from > to 会安静地返回空区间，看起来像"这段时间没干活"
    const res = await rate('?from=2026-09-01T00:00:00Z&to=2026-08-01T00:00:00Z')
    expect(res.statusCode).toBe(400)
    expect(res.json().message).toMatch(/validation/)
  })

  it('rejects an unknown query parameter instead of ignoring it', async () => {
    // 打错的 `form=` 会被静默忽略，然后返回一个范围完全不对的数字
    const res = await rate('?form=2026-08-01T00:00:00Z')
    expect(res.statusCode).toBe(400)
  })
})

/**
 * Agent 视角的指标集（FR-DASH-003：8 项）。
 *
 * 这一组需要指标模型能做**求和 / 求平均 / 比率**——
 * 数条数答不了"花了多少钱"。扩展的是动作种类，不是自由度：
 * 仍然只接受属性名，不接受表达式。
 */
describe('the Agent metric set (FR-DASH-003)', () => {
  async function run(attributes: Record<string, unknown>, status?: string) {
    const agent = await create('Agent', { name: 'a', principal: 'agent://a@1.0.0' })
    const id = await create('AgentRun', {
      goal: 'g',
      agent,
      mode: 'Autonomous',
      trigger: 'human',
      ...attributes,
    })
    if (status !== undefined) {
      for (const to of status === 'Succeeded' ? ['Running', 'Succeeded'] : ['Running', status]) {
        await move(id, to)
      }
    }
    return id
  }

  it('sums cost across runs', async () => {
    await run({ costUsd: 1.5 })
    await run({ costUsd: 2.25 })
    const body = (await metric('agent.cost.total')).json()
    expect(body.total).toBeCloseTo(3.75, 4)
  })

  it('sums tokens across runs', async () => {
    await run({ tokensUsed: 1000 })
    await run({ tokensUsed: 250 })
    expect((await metric('agent.tokens.total')).json().total).toBe(1250)
  })

  it('averages latency, and reports how many runs it averaged', async () => {
    // 平均值背后是 3 条还是 300 条，决定了它值不值得当回事
    await run({ durationMs: 1000 })
    await run({ durationMs: 3000 })
    const body = (await metric('agent.latency.avg')).json()
    expect(body.total).toBe(2000)
    expect(body.groups.find((g: { key: string }) => g.key === 'counted').count).toBe(2)
  })

  it('skips runs that have no value rather than counting them as zero', async () => {
    // 当成 0 的话，一批还没结算的 Run 会把平均成本悄悄拉低——
    // 一个看起来像好消息的坏消息。
    //
    // 注意"属性是字符串"这种情形在这里**造不出来**：本体校验
    // 已经把它挡在写入之前了。数据库那侧的 jsonb_typeof 过滤
    // 防的是更早的本体版本留下的旧数据
    await run({ costUsd: 2 })
    await run({}) // 还没结算，没有 costUsd
    const body = (await metric('agent.cost.total')).json()
    expect(body.total).toBe(2)
    expect(body.groups.find((g: { key: string }) => g.key === 'counted').count).toBe(1)
  })

  it('computes success rate over finished runs only', async () => {
    // 把 Queued / Running 算进分母，成功率会随排队长度上下跳，
    // 而那和成功不成功毫无关系
    await run({}, 'Succeeded')
    await run({}, 'Failed')
    await run({}) // 还在 Queued，不该进分母

    const body = (await metric('agent.success-rate')).json()
    expect(body.total).toBe(0.5)
    expect(body.groups.find((g: { key: string }) => g.key === 'denominator').count).toBe(2)
  })

  it('returns 0 rather than NaN when there is nothing to divide', async () => {
    // NaN 在界面上是一片吓人的空白
    expect((await metric('agent.success-rate')).json().total).toBe(0)
    expect((await metric('agent.cost.total')).json().total).toBe(0)
  })

  it('offers all eight Agent metrics, counting the north star', async () => {
    const catalogue = (await app.inject({ method: 'GET', url: '/v1/metrics', headers: asAdmin }))
      .json().items as { id: string; scope: string }[]
    const agentMetrics = catalogue.filter((m) => m.scope === 'agent')
    // PRD §1.3 列了 8 项。目录里的这些覆盖 Cost / Token / Success Rate /
    // Acceptance Rate / Latency / Ask Rate，Automation Rate 与 Rework Rate
    // 走它自己的路径（形状不一样）
    expect(agentMetrics.length).toBeGreaterThanOrEqual(6)
    for (const id of [
      'agent.cost.total',
      'agent.tokens.total',
      'agent.success-rate',
      'agent.acceptance-rate',
      'agent.latency.avg',
      'agent.ask-rate',
    ]) {
      expect(agentMetrics.map((m) => m.id)).toContain(id)
    }
    const rate = await app.inject({
      method: 'GET',
      url: '/v1/metrics:automation-rate',
      headers: asAdmin,
    })
    expect(rate.statusCode).toBe(200)
    // Rework Rate 和它一起返回，凑满第 8 项所需的口径
    expect(rate.json()).toHaveProperty('reworkRate')
  })

  it('drills down from an aggregate the same way as from a count', async () => {
    await run({ costUsd: 1 })
    const items = await app.inject({
      method: 'GET',
      url: '/v1/metrics/agent.cost.total/items',
      headers: asAdmin,
    })
    expect(items.json().items).toHaveLength(1)
  })

  it('applies permissions to aggregates too', async () => {
    // 少了这一步，指标就是一条绕过权限的旁路：看不到某个项目的人，
    // 照样能从它的成本总额里推出信息
    await run({ costUsd: 9 })
    const res = await app.inject({
      method: 'GET',
      url: '/v1/metrics/agent.cost.total',
      headers: { ...asAdmin, 'x-principal': 'user://nobody', 'x-roles': 'Nobody' },
    })
    expect(res.statusCode).toBeGreaterThanOrEqual(400)
  })
})
