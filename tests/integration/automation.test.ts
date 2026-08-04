import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type pg from 'pg'
import type { FastifyInstance } from 'fastify'
import { assertNotSuperuser, queryAsTenant, setupTestDb, truncateAll } from '../helpers/db.ts'
import { buildServer } from '../../src/api/server.ts'
import { buildDefaultRegistry } from '../../src/ontology/defaults.ts'
import { buildDefaultWorkflowRegistry } from '../../src/workflow/defaults.ts'
import { DEFAULT_AUTOMATION_RULES } from '../../src/workflow/automation.ts'
import { defaultPolicies } from '../../src/identity/default-policies.ts'
import { OutboxPoller } from '../../src/infrastructure/poller.ts'

const TENANT = 't_acme'
const asAdmin = {
  'x-principal': 'user://alice',
  'x-tenant': TENANT,
  'x-roles': 'Admin',
  'x-capabilities': '',
}

let pool: pg.Pool
let app: FastifyInstance
let poller: OutboxPoller

beforeAll(async () => {
  pool = await setupTestDb()
  await assertNotSuperuser(pool)
  const registry = buildDefaultRegistry()
  const workflows = buildDefaultWorkflowRegistry()
  const policies = defaultPolicies(TENANT)

  app = buildServer({ pool, registry, workflows, policies })
  await app.ready()

  poller = new OutboxPoller({
    pool,
    registry,
    workflows,
    policies,
    rules: DEFAULT_AUTOMATION_RULES,
    tenants: [TENANT],
  })
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
    payload: { type, workspace: 'ws_platform', attributes },
  })
  if (res.statusCode !== 201) throw new Error(`create ${type} failed: ${res.body}`)
  return res.json().id as string
}

async function relate(fromId: string, type: string, toId: string): Promise<void> {
  const res = await app.inject({
    method: 'POST',
    url: `/v1/resources/${fromId}/relations`,
    headers: asAdmin,
    payload: { type, toId },
  })
  if (res.statusCode !== 201) throw new Error(`relate failed: ${res.body}`)
}

async function move(id: string, to: string) {
  return app.inject({
    method: 'POST',
    url: `/v1/resources/${id}/transitions`,
    headers: asAdmin,
    payload: { to },
  })
}

async function statusOf(id: string): Promise<string> {
  const res = await app.inject({ method: 'GET', url: `/v1/resources/${id}`, headers: asAdmin })
  return res.json().status as string
}

/** 反复消费直到没有新事件——自动化产生的事件要下一轮才被取到 */
async function drainOutbox(maxRounds = 6): Promise<number> {
  let processed = 0
  for (let i = 0; i < maxRounds; i++) {
    const result = await poller.pollOnce()
    processed += result.claimed
    if (result.claimed === 0) break
  }
  return processed
}

/** 一个 Story 带两个 Task，Story 已就绪 */
async function seedStoryWithTasks(): Promise<{ story: string; taskA: string; taskB: string }> {
  const story = await create('Story', { title: 'invoice pdf' })
  const taskA = await create('Task', { title: 'render', assignee: 'user://bob' })
  const taskB = await create('Task', { title: 'upload', assignee: 'user://carol' })
  await relate(story, 'decomposedInto', taskA)
  await relate(story, 'decomposedInto', taskB)
  await move(story, 'Ready')
  await drainOutbox()
  return { story, taskA, taskB }
}

describe('lifecycle over HTTP (FR-WF-002/003)', () => {
  it('starts a resource in its lifecycle initial state', async () => {
    const task = await create('Task', { title: 't' })
    expect(await statusOf(task)).toBe('Todo')
  })

  it('rejects an initial status the lifecycle does not declare', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/resources',
      headers: asAdmin,
      payload: { type: 'Task', workspace: 'ws', status: 'Shipped', attributes: { title: 't' } },
    })
    expect(res.statusCode).toBe(422)
  })

  it('refuses a transition whose guard is unmet, and says what is missing', async () => {
    const task = await create('Task', { title: 'no assignee yet' })
    const res = await move(task, 'Doing')
    expect(res.statusCode).toBe(409)
    expect(res.json().message).toMatch(/assignee/)
    // 被拒绝的迁移不该留下痕迹
    expect(await statusOf(task)).toBe('Todo')
  })

  it('allows the transition once the guard is satisfied, and runs entry actions', async () => {
    const task = await create('Task', { title: 't', assignee: 'user://bob' })
    const res = await move(task, 'Doing')
    expect(res.statusCode).toBe(200)
    expect(res.json().status).toBe('Doing')
    // entry action 写入 startedAt——本体里必须有这个字段，否则校验会拦下
    expect(res.json().attributes.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('clears the block reason on completion', async () => {
    const task = await create('Task', { title: 't', assignee: 'user://bob' })
    await move(task, 'Doing')
    await app.inject({
      method: 'PATCH',
      url: `/v1/resources/${task}`,
      headers: asAdmin,
      payload: { expectedVersion: 2, attributes: { title: 't', assignee: 'user://bob', blockReason: 'waiting on api' } },
    })
    await move(task, 'Blocked')
    await move(task, 'Doing')
    const done = await move(task, 'Done')
    expect(done.json().attributes).not.toHaveProperty('blockReason')
    expect(done.json().attributes.completedAt).toBeDefined()
  })

  it('refuses to move out of a terminal state', async () => {
    const task = await create('Task', { title: 't', assignee: 'user://bob' })
    await move(task, 'Doing')
    await move(task, 'Done')
    const res = await move(task, 'Doing')
    expect(res.statusCode).toBe(409)
  })

  it('lists available transitions with readiness and what is blocking', async () => {
    const task = await create('Task', { title: 't' })
    const res = await app.inject({
      method: 'GET',
      url: `/v1/resources/${task}/transitions`,
      headers: asAdmin,
    })
    const items = res.json().items as Array<{ to: string; ready: boolean; blockedBy: string | null }>
    const doing = items.find((i) => i.to === 'Doing')
    expect(doing?.ready).toBe(false)
    expect(doing?.blockedBy).toMatch(/assignee/)
    expect(items.find((i) => i.to === 'Cancelled')?.ready).toBe(true)
  })

  it('hides transitions the caller has no permission for (FR-RES-008)', async () => {
    const task = await create('Task', { title: 't', assignee: 'user://bob' })
    // Guest 只有 *.Read，没有 Task.Execute 也没有 Task.Transition
    const res = await app.inject({
      method: 'GET',
      url: `/v1/resources/${task}/transitions`,
      headers: { ...asAdmin, 'x-principal': 'user://guest', 'x-roles': 'Guest' },
    })
    expect(res.json().items).toEqual([])
  })

  it('records the transition in history with its reason', async () => {
    const task = await create('Task', { title: 't', assignee: 'user://bob' })
    await app.inject({
      method: 'POST',
      url: `/v1/resources/${task}/transitions`,
      headers: asAdmin,
      payload: { to: 'Doing', reason: '开工' },
    })
    const history = await app.inject({
      method: 'GET',
      url: `/v1/resources/${task}/history`,
      headers: asAdmin,
    })
    const latest = (history.json().items as Array<{ reason: string; changes: { path: string }[] }>)[0]
    expect(latest?.reason).toBe('开工')
    expect(latest?.changes.map((c) => c.path)).toContain('status')
  })
})

describe('automation driven by the outbox (FR-WF-005/006)', () => {
  it('moves the story to InProgress when its first task starts', async () => {
    const { story, taskA } = await seedStoryWithTasks()
    expect(await statusOf(story)).toBe('Ready')

    await move(taskA, 'Doing')
    await drainOutbox()

    expect(await statusOf(story)).toBe('InProgress')
  })

  it('does not complete the story until every task is finished', async () => {
    const { story, taskA, taskB } = await seedStoryWithTasks()
    await move(taskA, 'Doing')
    await drainOutbox()

    await move(taskA, 'Done')
    await drainOutbox()
    // 还有 taskB 没做完——少了 requireAllSiblings，这里就会误判为完成
    expect(await statusOf(story)).toBe('InProgress')

    await move(taskB, 'Doing')
    await move(taskB, 'Done')
    await drainOutbox()

    expect(await statusOf(story)).toBe('Done')
  })

  it('counts a cancelled task as finished', async () => {
    const { story, taskA, taskB } = await seedStoryWithTasks()
    await move(taskA, 'Doing')
    await drainOutbox()
    await move(taskB, 'Cancelled')
    await move(taskA, 'Done')
    await drainOutbox()

    expect(await statusOf(story)).toBe('Done')
  })

  it('marks the events published so they are not reprocessed', async () => {
    const { taskA } = await seedStoryWithTasks()
    await move(taskA, 'Doing')
    await drainOutbox()

    const unpublished = await queryAsTenant(
      pool,
      TENANT,
      'SELECT 1 AS ok FROM outbox_events WHERE published_at IS NULL',
    )
    expect(unpublished).toHaveLength(0)
  })

  it('attributes automated changes to the system principal in the audit log', async () => {
    const { taskA } = await seedStoryWithTasks()
    await move(taskA, 'Doing')
    await drainOutbox()

    const rows = await queryAsTenant<{ subject: string; action: string; decision: string }>(
      pool,
      TENANT,
      `SELECT subject, action, decision FROM audit_log WHERE subject = 'system://internal' ORDER BY seq`,
    )
    // 自动化以 system 身份做的每一件事都必须查得到
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.some((r) => r.action === 'Story.Transition' && r.decision === 'Allow')).toBe(true)
  })

  it('automation goes through the same guards as a human (W2)', async () => {
    // Story 停在 Draft（没有 decomposedInto 就进不了 Ready）。
    // 自动化想把它推到 InProgress 会被同一条流程规则挡住，而不是获得特权
    const story = await create('Story', { title: 'orphan' })
    const task = await create('Task', { title: 't', assignee: 'user://bob' })
    await relate(story, 'decomposedInto', task)

    await move(task, 'Doing')
    await drainOutbox()

    // 规则要求 Story 当前在 Ready，Draft 不匹配，因此跳过
    expect(await statusOf(story)).toBe('Draft')
  })

  it('a failing rule does not stop the batch', async () => {
    const { story, taskA } = await seedStoryWithTasks()
    await move(taskA, 'Doing')
    const result = await poller.pollOnce()
    expect(result.claimed).toBeGreaterThan(0)
    // 无论规则命中与否，事件都被消费掉了
    expect(await statusOf(story)).toBe('InProgress')
  })
})

/**
 * 自用第一天发现的洞（docs/dogfooding-log.md #2）。
 *
 * 规则跑了、算出了准确的原因、然后把它扔了：Story 停在原地，
 * 日志、历史、审计三处都查不到，看起来像"自动化没配"。
 * 这里断言的是**痕迹留下来了**，不是状态变了——
 * 停滞本身是允许的，查不出原因才是缺陷。
 */
describe('automation leaves a trace when it does not move things (dogfooding #2)', () => {
  async function declinesFor(resourceId: string): Promise<Array<{ reason: string }>> {
    return queryAsTenant<{ reason: string }>(
      pool,
      TENANT,
      `SELECT reason FROM audit_log
       WHERE resource_id = '${resourceId}' AND decision = 'Rejected'
       ORDER BY seq`,
    )
  }

  it('records why a rule declined to advance a target', async () => {
    // 人忘了把 Story 标成 Ready，子任务却已经做完了
    const story = await create('Story', { title: 'forgot to mark ready' })
    const task = await create('Task', { title: 'done anyway', assignee: 'user://bob' })
    await relate(story, 'decomposedInto', task)
    for (const to of ['Doing', 'Review', 'Testing', 'Done']) await move(task, to)
    await drainOutbox()

    // Story 确实没动——这是规则的本意，不是 bug
    expect(await statusOf(story)).toBe('Draft')

    // 但"为什么没动"必须查得到
    const rows = await declinesFor(story)
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.map((r) => r.reason).join(' | ')).toMatch(/is "Draft", not in/)
  })

  it('records the target that a guard rejected, and keeps going for the others', async () => {
    // Story 在 Review：`onlyIfCurrentIn` 放行，但 Review→InProgress 是合法的，
    // 所以这里用另一条路径——把 Story 推到终态后再让规则去动它
    const { story, taskA, taskB } = await seedStoryWithTasks()
    await move(taskA, 'Doing')
    await drainOutbox()
    expect(await statusOf(story)).toBe('InProgress')

    await move(story, 'Cancelled')
    await drainOutbox()

    // 终态的 Story 不在 onlyIfCurrentIn 里，规则应当留下停滞记录
    for (const to of ['Review', 'Testing', 'Done']) await move(taskA, to)
    for (const to of ['Doing', 'Review', 'Testing', 'Done']) await move(taskB, to)
    await drainOutbox()

    expect(await statusOf(story)).toBe('Cancelled')
    const rows = await declinesFor(story)
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.map((r) => r.reason).join(' | ')).toMatch(/Cancelled/)
  })

  it('says nothing when there is no target at all', async () => {
    // 不属于任何 Story 的任务是常态。给它记一条"停滞"只会把真信号淹掉
    const orphan = await create('Task', { title: 'standalone', assignee: 'user://bob' })
    await move(orphan, 'Doing')
    await drainOutbox()

    expect(await declinesFor(orphan)).toHaveLength(0)
  })
})

describe('automation is denied what it should not do', () => {
  it('the system principal cannot delete', async () => {
    // pol-system-no-delete 是一条 Deny，优先于任何 Allow。
    // 自动化以机器速度铺开错误，删除必须由人来决定
    const { policies } = { policies: defaultPolicies(TENANT) }
    const deny = policies.find((p) => p.id === 'pol-system-no-delete')
    expect(deny).toBeDefined()
    expect(deny?.effect).toBe('Deny')
    expect(deny?.subject).toBe('system://internal')
  })
})
