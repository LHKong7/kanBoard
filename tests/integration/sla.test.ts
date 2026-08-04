import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type pg from 'pg'
import type { FastifyInstance } from 'fastify'
import { assertNotSuperuser, queryAsTenant, setupTestDb, truncateAll } from '../helpers/db.ts'
import { buildServer } from '../../src/api/server.ts'
import { buildDefaultRegistry } from '../../src/ontology/defaults.ts'
import { buildDefaultWorkflowRegistry } from '../../src/workflow/defaults.ts'
import { defaultPolicies } from '../../src/identity/default-policies.ts'
import { SlaSweeper } from '../../src/infrastructure/sla-sweeper.pg.ts'
import { slaNotifier, ESCALATION_PRINCIPAL } from '../../src/infrastructure/sla-notifier.ts'

/**
 * SLA 超时（FR-WF-002 的 sla 要素）。
 *
 * 在这一组用例之前，`sla` 是状态机定义里一个**没有任何代码读取**的字段：
 * Task 的 `Doing` 上写着"5 天超时通知 owner"，而 5 天之后什么也不会发生。
 * 所以这里的每一条都在回答"它现在真的会做点什么吗"。
 *
 * 时间用可控时钟推进：等 5 天的测试是不能进 CI 的。
 */

const TENANT = 't_acme'
const DAY = 24 * 60 * 60 * 1000
const asAdmin = {
  'x-principal': 'user://alice',
  'x-tenant': TENANT,
  'x-roles': 'Admin',
  'x-capabilities': '',
}

let pool: pg.Pool
let app: FastifyInstance

/** 可拨动的时钟。巡检读它来决定"现在几点" */
let clockNow = new Date('2026-08-01T00:00:00Z')
const clock = { now: () => clockNow }

beforeAll(async () => {
  pool = await setupTestDb()
  await assertNotSuperuser(pool)
  app = buildServer({
    pool,
    registry: buildDefaultRegistry(),
    workflows: buildDefaultWorkflowRegistry(),
    policies: defaultPolicies(TENANT),
    // 服务端用同一个可拨动时钟：否则对象的 status_since 落在真实当下，
    // 而巡检按假时钟算 cutoff，两者永远对不上——用例会全绿或全红，
    // 但无论哪种都没测到东西
    clock,
  })
  await app.ready()
})

afterAll(async () => {
  await app.close()
  await pool.end()
})

beforeEach(async () => {
  await truncateAll(pool)
  clockNow = new Date('2026-08-01T00:00:00Z')
})

function sweeper(withNotifier = true): SlaSweeper {
  const registry = buildDefaultRegistry()
  const workflows = buildDefaultWorkflowRegistry()
  const policies = defaultPolicies(TENANT)
  return new SlaSweeper({
    pool,
    tenants: [TENANT],
    workflows,
    clock,
    ...(withNotifier
      ? { onBreach: slaNotifier({ pool, registry, workflows, policies, clock }) }
      : {}),
  })
}

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

async function move(id: string, to: string) {
  const res = await app.inject({
    method: 'POST',
    url: `/v1/resources/${id}/transitions`,
    headers: asAdmin,
    payload: { to },
  })
  if (res.statusCode !== 200) throw new Error(`transition ${id} → ${to}: ${res.body}`)
}

async function patch(id: string, attributes: Record<string, unknown>): Promise<void> {
  const current = await app.inject({ method: 'GET', url: `/v1/resources/${id}`, headers: asAdmin })
  const res = await app.inject({
    method: 'PATCH',
    url: `/v1/resources/${id}`,
    headers: asAdmin,
    payload: { expectedVersion: current.json().version, attributes },
  })
  if (res.statusCode !== 200) throw new Error(`patch ${id}: ${res.body}`)
}

const notifications = async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/v1/resources?type=Notification',
    headers: asAdmin,
  })
  return res.json().items as { id: string; attributes: Record<string, unknown> }[]
}

/** 把一个任务推进到 Doing（SLA 5 天） */
async function doingTask(title = 't'): Promise<string> {
  const id = await create('Task', { title, assignee: 'user://bob' })
  await move(id, 'Doing')
  return id
}

describe('the sla field finally does something (FR-WF-002)', () => {
  it('says nothing while the task is still inside its window', async () => {
    await doingTask()
    clockNow = new Date(clockNow.getTime() + 4 * DAY)
    const { breaches } = await sweeper().sweepOnce()
    expect(breaches).toHaveLength(0)
    expect(await notifications()).toHaveLength(0)
  })

  it('reports a breach once the window has passed', async () => {
    // Task 的 Doing 是 5 天，超时动作 notify-owner
    const task = await doingTask()
    clockNow = new Date(clockNow.getTime() + 6 * DAY)

    const { breaches } = await sweeper().sweepOnce()
    expect(breaches).toHaveLength(1)
    expect(breaches[0]?.resourceId).toBe(task)
    expect(breaches[0]?.action).toBe('notify-owner')
    expect(breaches[0]?.overdueMs).toBe(DAY)
  })

  it('notifies the owner, and says how overdue it is', async () => {
    // "超时了"三个字不够：还得有人去翻历史才知道超了多久
    await doingTask()
    clockNow = new Date(clockNow.getTime() + 6 * DAY)
    await sweeper().sweepOnce()

    const notes = await notifications()
    expect(notes).toHaveLength(1)
    expect(notes[0]?.attributes['recipient']).toBe('user://alice')
    expect(notes[0]?.attributes['severity']).toBe('warning')
    expect(String(notes[0]?.attributes['body'])).toMatch(/超出约定 1 天/)
  })

  it('escalates to someone other than the owner', async () => {
    // Blocked 的超时动作是 escalate。再通知同一个人一遍，
    // 是把"升级"做成了"重复提醒"——会超时正是因为 owner 没动它
    const task = await doingTask()
    await patch(task, { title: 't', assignee: 'user://bob', blockReason: '等接口' })
    await move(task, 'Blocked')

    clockNow = new Date(clockNow.getTime() + 3 * DAY)
    const { breaches } = await sweeper().sweepOnce()
    expect(breaches[0]?.action).toBe('escalate')

    const notes = await notifications()
    expect(notes[0]?.attributes['recipient']).toBe(ESCALATION_PRINCIPAL)
    expect(notes[0]?.attributes['severity']).toBe('critical')
  })

  it('does not report the same breach twice', async () => {
    // 巡检是反复跑的。没有去重的话，几小时之后收件箱里全是同一件事——
    // 一个吵到没人看的告警等于没有告警
    await doingTask()
    clockNow = new Date(clockNow.getTime() + 6 * DAY)

    const s = sweeper()
    expect((await s.sweepOnce()).breaches).toHaveLength(1)
    clockNow = new Date(clockNow.getTime() + DAY)
    expect((await s.sweepOnce()).breaches).toHaveLength(0)
    expect(await notifications()).toHaveLength(1)
  })

  it('reports again after the object re-enters the state', async () => {
    // 重新进入这个状态是一次新的计时，因此也该能重新告警。
    // 用 (id, status) 去重的话，一个反复超时的对象只在第一次被提醒
    const task = await doingTask()
    clockNow = new Date(clockNow.getTime() + 6 * DAY)
    const s = sweeper()
    expect((await s.sweepOnce()).breaches).toHaveLength(1)

    // 走一圈回到 Doing
    await move(task, 'Review')
    await move(task, 'Doing')
    clockNow = new Date(clockNow.getTime() + 6 * DAY)
    expect((await s.sweepOnce()).breaches).toHaveLength(1)
    expect(await notifications()).toHaveLength(2)
  })

  it('does not let an unrelated edit reset the clock', async () => {
    // 这是最容易写错的一条：用 updated_at 计时的话，
    // 一个停滞三周、昨天被人补了个描述的任务看起来"刚动过"——
    // 而那正好是最该报警的对象
    const task = await doingTask()
    clockNow = new Date(clockNow.getTime() + 6 * DAY)
    await patch(task, { title: '改了标题', assignee: 'user://bob' })

    const { breaches } = await sweeper().sweepOnce()
    expect(breaches).toHaveLength(1)
    expect(breaches[0]?.resourceId).toBe(task)
  })

  it('does resets the clock when the status actually changes', async () => {
    const task = await doingTask()
    clockNow = new Date(clockNow.getTime() + 4 * DAY)
    await move(task, 'Review')
    await move(task, 'Doing')

    // 重新进入 Doing，计时归零：再过 4 天仍在窗口内
    clockNow = new Date(clockNow.getTime() + 4 * DAY)
    expect((await sweeper().sweepOnce()).breaches).toHaveLength(0)
  })

  it('ignores states that declare no sla', async () => {
    // Todo 上没有 sla。一个躺在 Todo 里一年的任务不该被这套机制报警——
    // 那是待办积压，不是超时
    await create('Task', { title: '躺着的', assignee: 'user://bob' })
    clockNow = new Date(clockNow.getTime() + 365 * DAY)
    expect((await sweeper().sweepOnce()).breaches).toHaveLength(0)
  })

  it('ignores soft-deleted resources', async () => {
    const task = await doingTask()
    const current = await app.inject({ method: 'GET', url: `/v1/resources/${task}`, headers: asAdmin })
    const gone = await app.inject({
      method: 'DELETE',
      url: `/v1/resources/${task}`,
      // If-Match 是必需的。第一版这里漏了它，删除静默 428，
      // 于是这条用例在"没删掉"的对象上断言"删掉了就不告警"——绿的，且什么也没测
      headers: { ...asAdmin, 'if-match': `"${current.json().version}"` },
    })
    expect(gone.statusCode).toBe(204)
    clockNow = new Date(clockNow.getTime() + 6 * DAY)
    expect((await sweeper().sweepOnce()).breaches).toHaveLength(0)
  })

  it('records the breach so it can be queried later', async () => {
    await doingTask()
    clockNow = new Date(clockNow.getTime() + 6 * DAY)
    await sweeper().sweepOnce()

    const rows = await queryAsTenant<{ action: string; notification_id: string | null }>(
      pool,
      TENANT,
      'SELECT action, notification_id FROM sla_breaches',
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]?.action).toBe('notify-owner')
    // 通知 id 记下来，于是"这次告警发出去了吗"是可查的
    expect(rows[0]?.notification_id).toBeTruthy()
  })

  it('does not mark a breach as handled when the notification failed', async () => {
    // 反过来记账的话，动作失败的那次超时就**永远不会再被报**——
    // 一次静默的漏报，而且看起来一切正常
    await doingTask()
    clockNow = new Date(clockNow.getTime() + 6 * DAY)

    const registry = buildDefaultRegistry()
    const workflows = buildDefaultWorkflowRegistry()
    const failing = new SlaSweeper({
      pool,
      tenants: [TENANT],
      workflows,
      clock,
      onBreach: async () => {
        throw new Error('notification channel is down')
      },
    })
    expect((await failing.sweepOnce()).breaches).toHaveLength(0)

    const rows = await queryAsTenant(pool, TENANT, 'SELECT 1 FROM sla_breaches')
    expect(rows).toHaveLength(0)

    // 通道恢复之后，同一次超时仍然报得出来
    const working = new SlaSweeper({
      pool,
      tenants: [TENANT],
      workflows,
      clock,
      onBreach: slaNotifier({ pool, registry, workflows, policies: defaultPolicies(TENANT), clock }),
    })
    expect((await working.sweepOnce()).breaches).toHaveLength(1)
  })
})
