import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type pg from 'pg'
import type { FastifyInstance } from 'fastify'
import { assertNotSuperuser, setupTestDb, truncateAll } from '../helpers/db.ts'
import { buildServer } from '../../src/api/server.ts'
import { buildDefaultRegistry } from '../../src/ontology/defaults.ts'
import { buildDefaultWorkflowRegistry } from '../../src/workflow/defaults.ts'
import { defaultPolicies } from '../../src/identity/default-policies.ts'
import type { Policy } from '../../src/identity/types.ts'

/**
 * Ask 策略：挂起 + 人工确认 + **超时拒绝**（FR-IAM-009）。
 *
 * 在这一组之前，Ask 只是同步抛一个 428：没有挂起单，没有人能"批准"，
 * 也没有任何东西会超时。也就是说这条需求的三段里只做了第一段，
 * 而 428 让它看起来像是做完了。
 */

const TENANT = 't_acme'
const asRd = {
  'x-principal': 'user://rd',
  'x-tenant': TENANT,
  'x-roles': 'RD',
  'x-capabilities': 'Task.Create,Task.Update,Task.Read,Approval.Read',
}
const asApprover = {
  'x-principal': 'user://lead',
  'x-tenant': TENANT,
  'x-roles': 'Admin',
  'x-capabilities': '',
}

let pool: pg.Pool
let app: FastifyInstance
let clockNow = new Date('2026-08-01T00:00:00Z')
const clock = { now: () => clockNow }

/** 让 Task.Update 走人工确认 */
function policiesWithAsk(): Policy[] {
  return [
    ...defaultPolicies(TENANT),
    {
      id: 'pol-ask-task-update',
      effect: 'Ask',
      subject: 'role:RD',
      action: 'Task.Update',
      scope: { kind: 'tenant', tenant: TENANT },
      description: '改任务要人确认',
    },
    {
      id: 'pol-ask-task-delete',
      effect: 'Ask',
      subject: 'role:RD',
      action: 'Task.Delete',
      scope: { kind: 'tenant', tenant: TENANT },
      description: '删任务也要人确认',
    },
  ]
}

beforeAll(async () => {
  pool = await setupTestDb()
  await assertNotSuperuser(pool)
  app = buildServer({
    pool,
    registry: buildDefaultRegistry(),
    workflows: buildDefaultWorkflowRegistry(),
    policies: policiesWithAsk(),
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

async function makeTask(): Promise<{ id: string; version: number }> {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/resources',
    headers: asRd,
    payload: { type: 'Task', workspace: 'ws', attributes: { title: 't' } },
  })
  if (res.statusCode !== 201) throw new Error(res.body)
  return { id: res.json().id as string, version: res.json().version as number }
}

const patch = (id: string, version: number, extra: Record<string, string> = {}) =>
  app.inject({
    method: 'PATCH',
    url: `/v1/resources/${id}`,
    headers: { ...asRd, ...extra },
    payload: { expectedVersion: version, attributes: { title: '改过的' } },
  })

const approvals = async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/v1/resources?type=Approval',
    headers: asApprover,
  })
  return res.json().items as { id: string; status: string; attributes: Record<string, unknown> }[]
}

const decide = (id: string, to: string) =>
  app.inject({
    method: 'POST',
    url: `/v1/resources/${id}/transitions`,
    headers: asApprover,
    payload: { to },
  })

describe('Ask suspends the operation (FR-IAM-009)', () => {
  it('returns 428 and leaves a pending approval behind', async () => {
    const task = await makeTask()
    const res = await patch(task.id, task.version)

    expect(res.statusCode).toBe(428)
    expect(res.json().details.approvalId).toBeTruthy()

    const pending = await approvals()
    expect(pending).toHaveLength(1)
    expect(pending[0]?.status).toBe('Pending')
    // 挂起单要说清楚"谁、要做什么、被哪条策略挡的"
    expect(pending[0]?.attributes['action']).toBe('Task.Update')
    expect(pending[0]?.attributes['requestedBy']).toBe('user://rd')
    expect(pending[0]?.attributes['matchedPolicy']).toBe('pol-ask-task-update')
  })

  it('does not apply the change while it is pending', async () => {
    const task = await makeTask()
    await patch(task.id, task.version)

    const after = await app.inject({
      method: 'GET',
      url: `/v1/resources/${task.id}`,
      headers: asRd,
    })
    expect(after.json().attributes.title).toBe('t')
  })

  it('carries an expiry, because a suspension without one waits forever', async () => {
    const task = await makeTask()
    await patch(task.id, task.version)
    const expiresAt = (await approvals())[0]?.attributes['expiresAt']
    expect(typeof expiresAt).toBe('string')
    expect(new Date(String(expiresAt)).getTime()).toBeGreaterThan(clockNow.getTime())
  })
})

describe('a human decision lets it through (FR-IAM-009)', () => {
  it('accepts the operation once the approval is granted', async () => {
    const task = await makeTask()
    await patch(task.id, task.version)
    const approval = (await approvals())[0]!
    expect((await decide(approval.id, 'Approved')).statusCode).toBe(200)

    const retried = await patch(task.id, task.version, { 'x-approval': approval.id })
    expect(retried.statusCode).toBe(200)
    expect(retried.json().attributes.title).toBe('改过的')
  })

  it('refuses a rejected approval', async () => {
    const task = await makeTask()
    await patch(task.id, task.version)
    const approval = (await approvals())[0]!
    await decide(approval.id, 'Rejected')

    const retried = await patch(task.id, task.version, { 'x-approval': approval.id })
    expect(retried.statusCode).toBe(403)
    expect(retried.json().message).toMatch(/Rejected/)
  })

  it('refuses an approval issued for a different action', async () => {
    // 一张批准只对它被签发时那件事有效。不比对的话，
    // "批准改一个字段"就能拿去删掉整个对象
    const task = await makeTask()
    await patch(task.id, task.version)
    const approval = (await approvals())[0]!
    await decide(approval.id, 'Approved')

    // 删除同样被 Ask 挡着，于是这张 Task.Update 的批准会被真的拿去比对
    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/resources/${task.id}`,
      headers: { ...asRd, 'x-approval': approval.id, 'if-match': `"${task.version}"` },
    })
    expect(res.statusCode).toBe(403)
    expect(res.json().message).toMatch(/Task\.Update/)
  })

  it('refuses an approval that does not exist', async () => {
    const task = await makeTask()
    const res = await patch(task.id, task.version, { 'x-approval': 'approval_nope' })
    expect(res.statusCode).toBe(403)
    expect(res.json().message).toMatch(/no such approval/)
  })
})

describe('silence is not consent — approvals time out (FR-IAM-009)', () => {
  it('refuses an approval that has expired', async () => {
    const task = await makeTask()
    await patch(task.id, task.version)
    const approval = (await approvals())[0]!
    await decide(approval.id, 'Approved')

    // 批准是有效的，但过了有效期
    clockNow = new Date(clockNow.getTime() + 25 * 60 * 60 * 1000)

    const retried = await patch(task.id, task.version, { 'x-approval': approval.id })
    expect(retried.statusCode).toBe(403)
    expect(retried.json().message).toMatch(/expired/)
  })

  it('judges expiry at use time, not by a background job', async () => {
    // 靠定时任务把状态刷成 Expired 的话，任务停掉的那几天里
    // 过期的批准照样能用——一个安静失效的护栏
    const task = await makeTask()
    await patch(task.id, task.version)
    const approval = (await approvals())[0]!
    await decide(approval.id, 'Approved')
    clockNow = new Date(clockNow.getTime() + 25 * 60 * 60 * 1000)

    // 状态**仍然是 Approved**——没有任何任务跑过
    expect((await approvals())[0]?.status).toBe('Approved')
    // 但它已经不能用了
    expect((await patch(task.id, task.version, { 'x-approval': approval.id })).statusCode).toBe(403)
  })

  it('keeps Expired separate from Rejected', async () => {
    // 合并的话，"有多少确认是被人拒的、多少是没人管"就再也分不出来，
    // 而这两件事要采取的行动完全不同
    const task = await makeTask()
    await patch(task.id, task.version)
    const approval = (await approvals())[0]!
    expect((await decide(approval.id, 'Expired')).statusCode).toBe(200)
    expect((await approvals())[0]?.status).toBe('Expired')
  })
})
