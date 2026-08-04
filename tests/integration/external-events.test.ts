import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createHmac } from 'node:crypto'
import type pg from 'pg'
import type { FastifyInstance } from 'fastify'
import { assertNotSuperuser, queryAsTenant, setupTestDb, truncateAll } from '../helpers/db.ts'
import { buildServer } from '../../src/api/server.ts'
import { buildDefaultRegistry } from '../../src/ontology/defaults.ts'
import { buildDefaultWorkflowRegistry } from '../../src/workflow/defaults.ts'
import { defaultPolicies } from '../../src/identity/default-policies.ts'
import { GITHUB_SOURCE } from '../../src/infrastructure/external-events.ts'
import { OutboxPoller } from '../../src/infrastructure/poller.ts'
import type { AutomationRule } from '../../src/workflow/automation.ts'

/**
 * 外部事件触发自动化（FR-WF-006）。
 *
 * 验收标准是「PR 合并自动推进 Task」。GitHub 是**发送方**——
 * 它拨这个号这件事没法在这里验证，但**接的这一半可以完整验证**，
 * 而且必须：验签、认出说的是哪个对象、翻译、进 outbox、跑自动化。
 * 这一整条链路里没有一步依赖 GitHub 真的存在。
 *
 * 报文用的是 GitHub 真实的 pull_request webhook 形状。
 */

const TENANT = 'default'
const SECRET = 'shhh-webhook-secret'
const asAdmin = {
  'x-principal': 'user://alice',
  'x-tenant': TENANT,
  'x-roles': 'Admin',
  'x-capabilities': '',
}

let pool: pg.Pool
let app: FastifyInstance

/** PR 合并后把 Task 推进到 Done */
const RULES: AutomationRule[] = [
  {
    id: 'pr-merged-completes-task',
    owningContext: 'Execution',
    description: 'PR 合并时把关联的 Task 推进到 Done',
    when: {
      event: 'ExternalEvent',
      externalSource: 'github',
      externalEvent: 'pull_request.closed',
    },
    then: [{ kind: 'transition', to: 'Done', onlyIfCurrentIn: ['Doing', 'Review', 'Testing'] }],
  },
]

beforeAll(async () => {
  pool = await setupTestDb()
  await assertNotSuperuser(pool)
  app = buildServer({
    pool,
    registry: buildDefaultRegistry(),
    workflows: buildDefaultWorkflowRegistry(),
    policies: defaultPolicies(TENANT),
    externalSources: [GITHUB_SOURCE(SECRET)],
    tenant: TENANT,
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

const sign = (body: string) => `sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}`

/** GitHub 真实的 pull_request webhook 形状（取用到的字段） */
function prPayload(taskRef: string, merged = true) {
  return JSON.stringify({
    action: 'closed',
    pull_request: {
      number: 42,
      title: `修复导出 (${taskRef})`,
      body: '顺手改了下文案',
      merged,
      html_url: 'https://github.com/acme/platform/pull/42',
      head: { ref: 'fix/export' },
    },
    repository: { full_name: 'acme/platform' },
  })
}

async function post(body: string, headers: Record<string, string> = {}) {
  return app.inject({
    method: 'POST',
    url: '/events/github',
    headers: {
      'content-type': 'application/json',
      'x-github-event': 'pull_request',
      'x-signature-256': sign(body),
      ...headers,
    },
    payload: body,
  })
}

async function makeTask(): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/resources',
    headers: asAdmin,
    payload: { type: 'Task', workspace: 'ws', attributes: { title: 't', assignee: 'user://bob' } },
  })
  const id = res.json().id as string
  await app.inject({
    method: 'POST',
    url: `/v1/resources/${id}/transitions`,
    headers: asAdmin,
    payload: { to: 'Doing' },
  })
  return id
}

const statusOf = async (id: string) =>
  (await app.inject({ method: 'GET', url: `/v1/resources/${id}`, headers: asAdmin })).json()
    .status as string

async function drain(): Promise<void> {
  const poller = new OutboxPoller({
    pool,
    registry: buildDefaultRegistry(),
    workflows: buildDefaultWorkflowRegistry(),
    policies: defaultPolicies(TENANT),
    rules: RULES,
    tenants: [TENANT],
  })
  for (let i = 0; i < 4; i++) {
    if ((await poller.pollOnce()).claimed === 0) break
  }
}

describe('a merged PR advances its task (FR-WF-006)', () => {
  it('accepts the webhook and completes the task', async () => {
    const task = await makeTask()
    const res = await post(prPayload(task))

    // 202 而不是 200：事件收下了，自动化还没跑
    expect(res.statusCode).toBe(202)
    expect(res.json().subject).toBe(task)

    await drain()
    expect(await statusOf(task)).toBe('Done')
  })

  it('finds the task id in the branch name too', async () => {
    // 人本来就把工单号写在标题、分支名或描述里。
    // 要求外部系统改流程来配合我们，是这类集成最常见的死法
    const task = await makeTask()
    const body = JSON.stringify({
      action: 'closed',
      pull_request: {
        number: 7,
        title: '没有单号的标题',
        body: '',
        merged: true,
        head: { ref: `feature/${task}` },
      },
    })
    expect((await post(body)).json().subject).toBe(task)
  })

  it('goes through the same automation engine as internal events', async () => {
    // 另开一条外部事件专用的处理链会省一点事，代价是那条链上的
    // 熔断、留痕、幂等都要重新实现一遍
    const task = await makeTask()
    await post(prPayload(task))
    await drain()

    const history = await app.inject({
      method: 'GET',
      url: `/v1/resources/${task}/history`,
      headers: asAdmin,
    })
    const entries = history.json().items as { changedBy: string; reason: string | null }[]
    const automated = entries.find((e) => (e.reason ?? '').includes('automation:'))
    expect(automated?.changedBy).toBe('system://internal')
  })
})

describe('the payload is untrusted input', () => {
  it('refuses an unsigned request', async () => {
    const task = await makeTask()
    const res = await app.inject({
      method: 'POST',
      url: '/events/github',
      headers: { 'content-type': 'application/json', 'x-github-event': 'pull_request' },
      payload: prPayload(task),
    })
    expect(res.statusCode).toBe(401)
    expect(await statusOf(task)).toBe('Doing')
  })

  it('refuses a bad signature', async () => {
    const task = await makeTask()
    const res = await post(prPayload(task), { 'x-signature-256': 'sha256=deadbeef' })
    expect(res.statusCode).toBe(401)
  })

  it('refuses a signature computed over different bytes', async () => {
    // 验签必须对**原始报文**做。拿解析后的对象重新序列化去验的话，
    // 改动 body 而保留签名就可能蒙混过去
    const task = await makeTask()
    const signed = prPayload(task)
    const tampered = signed.replace('修复导出', '删库跑路')
    const res = await app.inject({
      method: 'POST',
      url: '/events/github',
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'pull_request',
        'x-signature-256': sign(signed),
      },
      payload: tampered,
    })
    expect(res.statusCode).toBe(401)
  })

  it('refuses an event that names no ProjectOS object', async () => {
    // 一个不知道在说谁的事件，自动化引擎除了记一笔什么也做不了，
    // 而它会安静地堆在 outbox 里，看起来像"事件收到了"
    const body = JSON.stringify({
      action: 'closed',
      pull_request: { number: 1, title: '随便改改', body: '', head: { ref: 'main' } },
    })
    const res = await post(body)
    expect(res.statusCode).toBe(422)
    expect(res.json().message).toMatch(/no ProjectOS resource id/)
  })

  it('names the configured sources when the source is unknown', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/events/gitlab',
      headers: { 'content-type': 'application/json', 'x-signature-256': 'x' },
      payload: '{}',
    })
    expect(res.statusCode).toBe(404)
    expect(res.json().details.known).toContain('github')
  })

  it('carries only the declared fields into the event', async () => {
    // 原始报文里可能有 token、邮箱、整棵 diff。**只带声明过的字段**
    const task = await makeTask()
    const body = JSON.stringify({
      action: 'closed',
      pull_request: {
        number: 9,
        title: task,
        merged: true,
        head: { ref: 'x' },
        // 这两个字段没在 detailFrom 里
        installation_token: 'ghs_SUPERSECRET',
        diff: 'x'.repeat(10_000),
      },
    })
    await post(body)

    // 必须用 queryAsTenant：应用角色受 FORCE RLS 约束，没有租户上下文时
    // 这条查询返回空集**而且不报错**——断言"里面没有密钥"就会因为
    // 一行都没查到而通过。第一版就是这么写的，它绿得毫无意义
    const rows = await queryAsTenant<{ payload: Record<string, unknown> }>(
      pool,
      TENANT,
      `SELECT payload FROM outbox_events WHERE event_type = 'ExternalEvent'`,
    )
    expect(rows.length).toBe(1)
    const serialised = JSON.stringify(rows)
    expect(serialised).not.toContain('ghs_SUPERSECRET')
    expect(serialised.length).toBeLessThan(5_000)
  })

  it('does not act on an event whose name does not match the rule', async () => {
    const task = await makeTask()
    // 同一个 PR 被 reopen，不是 closed
    const body = prPayload(task).replace('"closed"', '"reopened"')
    expect((await post(body)).statusCode).toBe(202)
    await drain()
    expect(await statusOf(task)).toBe('Doing')
  })
})
