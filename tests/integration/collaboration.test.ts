import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type pg from 'pg'
import type { FastifyInstance } from 'fastify'
import { assertNotSuperuser, setupTestDb, truncateAll } from '../helpers/db.ts'
import { buildServer } from '../../src/api/server.ts'
import { buildDefaultRegistry } from '../../src/ontology/defaults.ts'
import { buildDefaultWorkflowRegistry } from '../../src/workflow/defaults.ts'
import { DEFAULT_AUTOMATION_RULES } from '../../src/workflow/automation.ts'
import { defaultPolicies } from '../../src/identity/default-policies.ts'
import { OutboxPoller } from '../../src/infrastructure/poller.ts'

/**
 * 协作最小闭环：评论 + @提及 + 导出。
 *
 * 「最小」是认真的——一个不能评论的工具只有一个人用得起来。
 * 这一套验的是这个闭环走的是**系统本来那条路**：
 *
 *   评论是普通资源（没有专用端点，ADR-0002）
 *   评论挂在对象上靠**关系**（不是一个点不动的 id 属性）
 *   @ 到谁由**服务端**从正文解析（客户端说了不算）
 *   通知由**自动化规则**产生（不是评论端点里的一段旁路代码）
 */

const TENANT = 't_collab'
const headersFor = (principal: string, roles: string) => ({
  'x-principal': principal,
  'x-tenant': TENANT,
  'x-roles': roles,
  'x-capabilities': '',
})
/** 建被讨论的对象用管理员：这一套要验的是评论，不是谁能建 Story */
const asAdmin = headersFor('user://admin', 'Admin')
/** 评论的人是个**普通角色**——协作能力不该只有管理员有 */
const asAlice = headersFor('user://alice', 'PM')
const asGuest = headersFor('user://gary', 'Guest')

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

async function create(
  type: string,
  attributes: Record<string, unknown>,
  headers = asAdmin,
): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/resources',
    headers,
    payload: { type, workspace: 'ws_platform', attributes },
  })
  if (res.statusCode !== 201) throw new Error(`create ${type}: ${res.body}`)
  return res.json().id as string
}

/** 发一条评论：建对象 + 挂关系。两步都走统一 API，没有 /comments 端点 */
async function comment(about: string, body: string, headers = asAlice): Promise<string> {
  const id = await create('Comment', { body }, headers)
  const res = await app.inject({
    method: 'POST',
    url: `/v1/resources/${id}/relations`,
    headers,
    payload: { type: 'commentsOn', toId: about },
  })
  if (res.statusCode !== 201) throw new Error(`relate: ${res.body}`)
  return id
}

const story = () =>
  create('Story', { title: '导出账单', role: 'PM', capability: '导出', value: '对账' })

const notifications = async (): Promise<{ recipient: string; title: string }[]> => {
  const res = await app.inject({
    method: 'GET',
    url: '/v1/resources?type=Notification',
    // 用管理员读通知：PM 的能力集里没有 Notification.Read，
    // 而这里要看的是"通知有没有产生"，不是"谁读得到通知"
    headers: asAdmin,
  })
  return res.json().items.map((n: { attributes: Record<string, string> }) => ({
    recipient: n.attributes['recipient'] ?? '',
    title: n.attributes['title'] ?? '',
  }))
}

describe('a comment is an ordinary resource on an ordinary relation', () => {
  it('hangs off the object it discusses, and is reachable from it', async () => {
    const target = await story()
    const id = await comment(target, '这条我来做')

    // 从对象出发能拿到它的评论——这正是用关系而不是属性换来的：
    // 一个字符串 id 点不动，也走不进图遍历
    const res = await app.inject({
      method: 'GET',
      url: `/v1/resources/${target}/relations?direction=in&type=commentsOn`,
      headers: asAlice,
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().items.map((r: { fromId: string }) => r.fromId)).toEqual([id])
  })

  it('fetches a whole thread in one request, not one per comment', async () => {
    // ids 批量取存在的理由就是避免 N+1：逐个 GET 会让一次抽屉展开
    // 发出几十条请求
    const target = await story()
    const first = await comment(target, '一')
    const second = await comment(target, '二')

    const res = await app.inject({
      method: 'GET',
      url: `/v1/resources?type=Comment&ids=${first},${second}`,
      headers: asAlice,
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().items).toHaveLength(2)
  })

  it('refuses to hang a comment on something nobody should be discussing', async () => {
    // 值域是白名单。放开的话，评论会长到 Notification、Approval
    // 这类系统自己产生的对象上
    const notification = await create('Notification', {
      title: 'x',
      recipient: 'user://alice',
    })
    const id = await create('Comment', { body: '?' })
    const res = await app.inject({
      method: 'POST',
      url: `/v1/resources/${id}/relations`,
      headers: asAlice,
      payload: { type: 'commentsOn', toId: notification },
    })
    expect(res.statusCode).toBeGreaterThanOrEqual(400)
  })

  it('does not grow a board tab of its own', async () => {
    // Comment 刻意没有 lifecycle。看板只列有生命周期的类型，
    // 于是评论不会自己变成一列一列的东西
    const res = await app.inject({
      method: 'GET',
      url: '/v1/ontology/entity-types',
      headers: asAlice,
    })
    const def = res.json().items.find((t: { name: string }) => t.name === 'Comment')
    expect(def).toBeDefined()
    expect(def.lifecycle ?? null).toBeNull()
  })

  it('lets a guest read the discussion but not join it', async () => {
    const target = await story()
    await comment(target, '大家看下')

    const read = await app.inject({
      method: 'GET',
      url: '/v1/resources?type=Comment',
      headers: asGuest,
    })
    expect(read.statusCode).toBe(200)
    expect(read.json().items).toHaveLength(1)

    const write = await app.inject({
      method: 'POST',
      url: '/v1/resources',
      headers: asGuest,
      payload: { type: 'Comment', workspace: 'ws_platform', attributes: { body: '我也说一句' } },
    })
    expect(write.statusCode).toBe(403)
  })
})

describe('being @-mentioned reaches you (FR-WF-005)', () => {
  it('turns a mention into a notification, through the ordinary automation path', async () => {
    const target = await story()
    await comment(target, '@bob 这条你熟，帮忙看下')

    // 通知不是评论端点里的一段旁路代码：它由 outbox → poller → 自动化规则产生，
    // 和其余自动化走同一条路，因此同样留痕、同样受权限约束
    await poller.pollOnce()

    const items = await notifications()
    expect(items).toHaveLength(1)
    expect(items[0]?.recipient).toBe('user://bob')
    expect(items[0]?.title).toContain('提到了你')
  })

  it('notifies everyone mentioned, not just the first', async () => {
    const target = await story()
    await comment(target, '@bob @carol 一起看下')
    await poller.pollOnce()

    const recipients = (await notifications()).map((n) => n.recipient).sort()
    expect(recipients).toEqual(['user://bob', 'user://carol'])
  })

  it('does not notify the author of their own comment', async () => {
    const target = await story()
    await comment(target, '@alice 提醒我自己一下')
    await poller.pollOnce()

    expect(await notifications()).toHaveLength(0)
  })

  it('stays quiet when nobody was mentioned', async () => {
    // 大多数评论都不 @ 人。这条路径要是记成失败，
    // 自动化面板会被一片红淹掉，真正的失败就看不见了
    const target = await story()
    await comment(target, '这条我来做')
    await poller.pollOnce()

    expect(await notifications()).toHaveLength(0)
  })

  it('ignores an email in the body', async () => {
    // 正文里写邮箱太常见了。没挡住的话，会给 user://example.com 发通知
    const target = await story()
    await comment(target, '账单发到 finance@example.com 就行')
    await poller.pollOnce()

    expect(await notifications()).toHaveLength(0)
  })
})

describe('data can be taken out (CSV / JSON)', () => {
  const exportAs = (format: string, payload: Record<string, unknown> = {}) =>
    app.inject({
      method: 'POST',
      url: '/v1/resources:export',
      headers: asAlice,
      payload: { type: 'Story', format, ...payload },
    })

  it('exports the filtered set as CSV', async () => {
    await story()
    const res = await exportAs('csv')

    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('text/csv')
    expect(res.headers['content-disposition']).toContain('attachment')
    expect(res.body).toContain('导出账单')
    // 截断状态要能被程序看见，不只是人看见
    expect(res.headers['x-export-truncated']).toBe('false')
  })

  it('exports as JSON when asked', async () => {
    await story()
    const res = await exportAs('json')

    expect(res.statusCode).toBe(200)
    const parsed = JSON.parse(res.body)
    expect(parsed.items).toHaveLength(1)
    expect(parsed.truncated).toBe(false)
  })

  it('exports what the filter selected, not everything', async () => {
    await story()
    await create('Task', { title: '不该出现在 Story 导出里' }, asAdmin)

    const res = await exportAs('csv')
    expect(res.body).toContain('导出账单')
    expect(res.body).not.toContain('不该出现在 Story 导出里')
  })

  it('never exports what the caller cannot read', async () => {
    // 导出和列表走同一次 service.query，所以它不可能成为一条绕过权限的旁路
    await story()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/resources:export',
      headers: headersFor('user://nobody', 'Guest'),
      payload: { type: 'Story', format: 'csv' },
    })
    // Guest 有 *.Read，所以这里应当放行——要验的是它走的是同一条授权，
    // 而不是"导出永远放行"
    expect(res.statusCode).toBe(200)

    const denied = await app.inject({
      method: 'POST',
      url: '/v1/resources:export',
      headers: headersFor('user://nobody', 'AIAgent'),
      payload: { type: 'Story', format: 'csv' },
    })
    // AIAgent 角色是空集合，且没有声明能力
    expect(denied.statusCode).toBe(403)
  })

  it('rejects an unknown format instead of guessing', async () => {
    const res = await exportAs('pdf')
    expect(res.statusCode).toBe(400)
  })
})
