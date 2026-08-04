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
import type { AutomationRule } from '../../src/workflow/automation.ts'
import type { AutomationOutcome } from '../../src/domain/automation/runner.ts'

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

/** 一个 Story 带两个 Task 与一条验收标准，Story 已就绪 */
async function seedStoryWithTasks(): Promise<{ story: string; taskA: string; taskB: string }> {
  const story = await create('Story', { title: 'invoice pdf' })
  const taskA = await create('Task', { title: 'render', assignee: 'user://bob' })
  const taskB = await create('Task', { title: 'upload', assignee: 'user://carol' })
  await relate(story, 'decomposedInto', taskA)
  await relate(story, 'decomposedInto', taskB)
  // FR-DOM-004：没有验收标准的 Story 进不了 Ready。
  // 这个 fixture 原本没有这一条，加上守卫之后六个用例一起红——
  // 正是这条守卫此前不存在的证据
  const acceptance = await create('Acceptance', {
    given: '有一张已确认的账单',
    when: '用户点击导出',
    then: '得到一份 PDF，金额与账单一致',
  })
  await relate(story, 'acceptedBy', acceptance)
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

  it('allows only the declared reopen out of a terminal state', async () => {
    // ADR-0012：终态不再等于封闭，出口是一条显式的重开边。
    // 这条用例原本断言"任何迁移都 409"——放开重开时它红了
    const task = await create('Task', { title: 't', assignee: 'user://bob' })
    await move(task, 'Doing')
    await move(task, 'Done')

    // 没有声明的边照样拒绝：放开的是一条，不是整扇门
    expect((await move(task, 'Review')).statusCode).toBe(409)
    expect((await move(task, 'Doing')).statusCode).toBe(200)
  })

  it('keeps a terminal state without a reopen edge sealed', async () => {
    // Cancelled 没有重开边，于是它仍然是死路
    const task = await create('Task', { title: 't', assignee: 'user://bob' })
    await move(task, 'Cancelled')
    expect((await move(task, 'Doing')).statusCode).toBe(409)
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

/**
 * 其余动作类型（FR-WF-005：8 类动作全部可用）。
 *
 * 每条用例都跑一台**自带规则**的 poller，因为默认规则集里没有这些动作——
 * 用默认规则去测新动作，只会测到"默认规则没变"。
 */
describe('the rest of the action catalogue (FR-WF-005)', () => {
  const pollerWith = (rules: readonly AutomationRule[]) =>
    new OutboxPoller({
      pool,
      registry: buildDefaultRegistry(),
      workflows: buildDefaultWorkflowRegistry(),
      policies: defaultPolicies(TENANT),
      rules,
      tenants: [TENANT],
    })

  /** 跑到没有新事件为止，返回全部 outcome */
  async function drainWith(rules: readonly AutomationRule[]): Promise<AutomationOutcome[]> {
    const p = pollerWith(rules)
    const all: AutomationOutcome[] = []
    for (let i = 0; i < 6; i++) {
      const result = await p.pollOnce()
      all.push(...result.outcomes)
      if (result.claimed === 0) break
    }
    return all
  }

  const onTaskDoing = (then: AutomationRule['then']): AutomationRule[] => [
    {
      id: 'test-rule',
      owningContext: 'Execution',
      when: { event: 'ResourceStatusChanged', resourceType: 'Task', toStatus: 'Doing' },
      then,
    },
  ]

  const listOf = async (type: string) => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/resources?type=${type}`,
      headers: asAdmin,
    })
    return res.json().items as { id: string; attributes: Record<string, unknown>; status: string }[]
  }

  it('transition moves the subject itself, not only its relatives', async () => {
    const task = await create('Task', { title: 't', assignee: 'user://bob' })
    await move(task, 'Doing')
    await drainWith(onTaskDoing([{ kind: 'transition', to: 'Review' }]))
    expect(await statusOf(task)).toBe('Review')
  })

  it('transition records a decline when the subject is not in the expected state', async () => {
    // 找到了目标却没推动它，就是一次停滞——必须问得出"为什么没动"
    const task = await create('Task', { title: 't', assignee: 'user://bob' })
    await move(task, 'Doing')
    const outcomes = await drainWith(
      onTaskDoing([{ kind: 'transition', to: 'Review', onlyIfCurrentIn: ['Testing'] }]),
    )
    const skipped = outcomes.find((o) => o.action === 'transition')
    expect(skipped?.status).toBe('skipped')
    expect(skipped?.declines?.[0]?.reason).toMatch(/not in \["Testing"\]/)
    expect(await statusOf(task)).toBe('Doing')
  })

  it('assign changes the owner', async () => {
    const task = await create('Task', { title: 't', assignee: 'user://bob' })
    await move(task, 'Doing')
    await drainWith(onTaskDoing([{ kind: 'assign', to: 'user://carol' }]))

    const res = await app.inject({ method: 'GET', url: `/v1/resources/${task}`, headers: asAdmin })
    expect(res.json().owner).toBe('user://carol')
  })

  it('assign does not write a no-op history entry', async () => {
    // 一条什么都没改的 history 会让"这个对象被改过几次"变得不可信
    const task = await create('Task', { title: 't', assignee: 'user://bob' })
    await move(task, 'Doing')
    const outcomes = await drainWith(onTaskDoing([{ kind: 'assign', to: 'user://alice' }]))
    expect(outcomes.find((o) => o.action === 'assign')?.status).toBe('skipped')
  })

  it('createEntity creates an object and links it back', async () => {
    const task = await create('Task', { title: '登录接口 500', assignee: 'user://bob' })
    await move(task, 'Doing')
    await drainWith(
      onTaskDoing([
        {
          kind: 'createEntity',
          resourceType: 'Task',
          attributes: { title: 'RCA', assignee: 'user://bob' },
          relateBack: 'blockedBy',
        },
      ]),
    )

    const tasks = await listOf('Task')
    const rca = tasks.find((t) => t.attributes['title'] === 'RCA')
    expect(rca).toBeDefined()

    const rel = await app.inject({
      method: 'GET',
      url: `/v1/resources/${rca?.id}/relations`,
      headers: asAdmin,
    })
    expect(rel.json().items.some((r: { toId: string }) => r.toId === task)).toBe(true)
  })

  it('createEntity can take its title from the subject, without an expression language', async () => {
    // 规则里没有 `'RCA for ' + issue.key` 这种拼接：一旦允许表达式，
    // 就等于在配置里嵌了一门没有类型检查也没有调试器的语言
    const task = await create('Task', { title: '登录接口 500', assignee: 'user://bob' })
    await move(task, 'Doing')
    await drainWith(
      onTaskDoing([
        {
          kind: 'createEntity',
          resourceType: 'Task',
          attributes: { assignee: 'user://bob' },
          titleFromSubject: 'title',
        },
      ]),
    )

    const titles = (await listOf('Task')).map((t) => t.attributes['title'])
    expect(titles.filter((t) => t === '登录接口 500')).toHaveLength(2)
  })

  it('invokeAgent queues a real AgentRun rather than a private side channel', async () => {
    // 自动化发起的 Run 和人发起的 Run 必须走同一条路径，
    // 否则权限、预算、留痕都要再实现一遍——而重新实现的那份迟早会漏
    const agent = await create('Agent', { name: 'pm', principal: 'agent://pm@1.0.0' })
    const task = await create('Task', { title: 't', assignee: 'user://bob' })
    await move(task, 'Doing')
    await drainWith(
      onTaskDoing([{ kind: 'invokeAgent', agentId: agent, goal: '拆分这个任务', mode: 'Draft' }]),
    )

    const runs = await listOf('AgentRun')
    expect(runs).toHaveLength(1)
    expect(runs[0]?.status).toBe('Queued')
    expect(runs[0]?.attributes['trigger']).toBe('event')
    expect(runs[0]?.attributes['subject']).toBe(task)
  })

  it('notify creates an in-app notification addressed to the owner', async () => {
    const task = await create('Task', { title: 't', assignee: 'user://bob' })
    await move(task, 'Doing')
    await drainWith(
      onTaskDoing([{ kind: 'notify', recipient: 'owner', title: '任务开始了', severity: 'info' }]),
    )

    const notes = await listOf('Notification')
    expect(notes).toHaveLength(1)
    expect(notes[0]?.attributes['recipient']).toBe('user://alice')
    expect(notes[0]?.attributes['about']).toBe(task)
    expect(notes[0]?.status).toBe('Unread')
  })

  it('reports a failure when notify cannot work out who to tell', async () => {
    // 没有收件人的通知不该被安静地丢掉：它意味着一条规则认为
    // 有人该被告知，而系统答不出是谁
    const task = await create('Task', { title: 't', assignee: 'user://bob' })
    await move(task, 'Doing')
    const outcomes = await drainWith(
      onTaskDoing([{ kind: 'notify', recipient: '', title: '发给谁？' }]),
    )
    const failed = outcomes.find((o) => o.action === 'notify')
    expect(failed?.status).toBe('failed')
    expect(await listOf('Notification')).toHaveLength(0)
  })

  it('refuses to create a type the system principal was never granted', async () => {
    // 能创建什么是逐个类型授出去的，不是一个 `*.Create` 通配符。
    // 一条规则想创建没授权的类型，必须大声失败
    const task = await create('Task', { title: 't', assignee: 'user://bob' })
    await move(task, 'Doing')
    const outcomes = await drainWith(
      onTaskDoing([
        {
          kind: 'createEntity',
          resourceType: 'Knowledge',
          attributes: { title: 'k', body: 'b' },
        },
      ]),
    )
    const failed = outcomes.find((o) => o.action === 'createEntity')
    expect(failed?.status).toBe('failed')
    expect(await listOf('Knowledge')).toHaveLength(0)
  })
})

/**
 * 验收标准是进入执行的前提（FR-DOM-004）。
 *
 * 这条需求此前**没有实现**，而 `STORY_LIFECYCLE` 的注释写着 "FR-DOM-004"——
 * 它守的是 `decomposedInto`（有没有拆出任务），和验收标准毫无关系。
 * 引用了需求编号却做的是别的事，比不写注释更糟：
 * 它让人以为这条已经落地，于是没人会再去看。
 */
describe('a story needs acceptance criteria to enter execution (FR-DOM-004)', () => {
  const acceptance = () =>
    create('Acceptance', { given: '前置', when: '动作', then: '可观察的结果' })

  it('refuses Ready without one, and says which relation is missing', async () => {
    const story = await create('Story', { title: '没有验收标准的' })
    await relate(story, 'decomposedInto', await create('Task', { title: 't' }))

    const res = await move(story, 'Ready')
    expect(res.statusCode).toBe(409)
    expect(res.json().message).toMatch(/acceptedBy/)
    expect(await statusOf(story)).toBe('Draft')
  })

  it('allows Ready once one is attached', async () => {
    const story = await create('Story', { title: '有验收标准的' })
    await relate(story, 'decomposedInto', await create('Task', { title: 't' }))
    await relate(story, 'acceptedBy', await acceptance())

    expect((await move(story, 'Ready')).statusCode).toBe(200)
  })

  it('still requires tasks — acceptance alone is not enough', async () => {
    // 两条守卫是并列的，不是二选一
    const story = await create('Story', { title: '只有验收标准' })
    await relate(story, 'acceptedBy', await acceptance())

    const res = await move(story, 'Ready')
    expect(res.statusCode).toBe(409)
    expect(res.json().message).toMatch(/decomposedInto/)
  })

  it('keeps given / when / then as separate required fields', async () => {
    // 分成三个字段而不是一段自由文本：一条读起来像验收标准、
    // 其实没有可判定条件的描述，是需求评审里最贵的那种含糊
    const res = await app.inject({
      method: 'POST',
      url: '/v1/resources',
      headers: asAdmin,
      payload: { type: 'Acceptance', workspace: 'ws_platform', attributes: { given: '只有前置' } },
    })
    expect(res.statusCode).toBe(422)
    expect(JSON.stringify(res.json())).toMatch(/when|then/)
  })

  it('refuses to attach an acceptance to a Task', async () => {
    // 关系的 domain / range 由本体管着，不靠调用方自觉
    const task = await create('Task', { title: 't' })
    const res = await app.inject({
      method: 'POST',
      url: `/v1/resources/${task}/relations`,
      headers: asAdmin,
      payload: { type: 'acceptedBy', toId: await acceptance() },
    })
    expect(res.statusCode).toBe(422)
  })
})

/**
 * 一次发布只能装已完成的东西（FR-DOM-007）。
 *
 * 这个不变量必须由状态机守住，靠流程纪律守不住——
 * 赶发版的时候纪律是第一个被放弃的东西，而"上线了一个没做完的东西"
 * 的代价要到线上才知道。
 */
describe('a release ships only finished work (FR-DOM-007)', () => {
  const release = () => create('Release', { name: 'v1', version: '1.0.0' })

  async function doneTask(title: string) {
    const id = await create('Task', { title, assignee: 'user://bob' })
    for (const to of ['Doing', 'Done']) await move(id, to)
    return id
  }

  it('refuses to release while a task is unfinished, and names it', async () => {
    const rel = await release()
    const done = await doneTask('做完了的')
    const open = await create('Task', { title: '还没做完的', assignee: 'user://bob' })
    await relate(rel, 'ships', done)
    await relate(rel, 'ships', open)
    await move(rel, 'Frozen')

    const res = await move(rel, 'Released')
    expect(res.statusCode).toBe(409)
    // 只说"有未完成的"，使用者还得自己去一个个翻
    expect(res.json().message).toContain(open)
    expect(await statusOf(rel)).toBe('Frozen')
  })

  it('releases once everything is finished', async () => {
    const rel = await release()
    await relate(rel, 'ships', await doneTask('A'))
    await relate(rel, 'ships', await doneTask('B'))
    await move(rel, 'Frozen')

    expect((await move(rel, 'Released')).statusCode).toBe(200)
    expect(await statusOf(rel)).toBe('Released')
  })

  it('treats a cancelled task as shippable', async () => {
    // 卡着取消掉的任务不让发版，只会逼人把关系删掉——
    // 那样发布记录就不准了
    const rel = await release()
    const cancelled = await create('Task', { title: '取消了的', assignee: 'user://bob' })
    await move(cancelled, 'Cancelled')
    await relate(rel, 'ships', await doneTask('A'))
    await relate(rel, 'ships', cancelled)
    await move(rel, 'Frozen')

    expect((await move(rel, 'Released')).statusCode).toBe(200)
  })

  it('will not freeze an empty release', async () => {
    const rel = await release()
    const res = await move(rel, 'Frozen')
    expect(res.statusCode).toBe(409)
    expect(res.json().message).toMatch(/ships/)
  })

  it('shows the blocking reason in the available-transitions list', async () => {
    // 只在 POST 时才说不行的话，界面上那颗按钮看着是能点的
    const rel = await release()
    await relate(rel, 'ships', await create('Task', { title: '没做完', assignee: 'user://bob' }))
    await move(rel, 'Frozen')

    const res = await app.inject({
      method: 'GET',
      url: `/v1/resources/${rel}/transitions`,
      headers: asAdmin,
    })
    const released = (res.json().items as { to: string; ready: boolean; blockedBy: string | null }[])
      .find((t) => t.to === 'Released')
    expect(released?.ready).toBe(false)
    expect(released?.blockedBy).toMatch(/must be in/)
  })

  it('does not make other lifecycles pay for the neighbour lookup', async () => {
    // 邻居状态只为真的用到 allRelatedIn 的状态机装配。
    // Task 的状态机没有这类守卫，它的可用迁移不该受影响
    const task = await create('Task', { title: 't', assignee: 'user://bob' })
    const res = await app.inject({
      method: 'GET',
      url: `/v1/resources/${task}/transitions`,
      headers: asAdmin,
    })
    const doing = (res.json().items as { to: string; ready: boolean }[]).find((t) => t.to === 'Doing')
    expect(doing?.ready).toBe(true)
  })
})
