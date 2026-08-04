import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type pg from 'pg'
import type { FastifyInstance } from 'fastify'
import { assertNotSuperuser, setupTestDb, truncateAll } from '../helpers/db.ts'
import { buildServer } from '../../src/api/server.ts'
import { buildDefaultRegistry } from '../../src/ontology/defaults.ts'
import { buildDefaultWorkflowRegistry } from '../../src/workflow/defaults.ts'
import { defaultPolicies } from '../../src/identity/default-policies.ts'
import { serviceIn } from '../../src/infrastructure/service-factory.ts'
import { createDb, withTenant } from '../../src/infrastructure/db/client.ts'
import { BufferedAuditSink, flushAudit } from '../../src/infrastructure/outbox.pg.ts'
import { systemClock } from '../../src/platform/clock.ts'
import { InMemoryLinkStore, runPhase } from '../../src/domain/migration/runner.ts'
import { JiraSource } from '../../src/infrastructure/connectors/jira.ts'
import { MIGRATION_PRINCIPAL } from '../../src/identity/types.ts'
import type { Caller } from '../../src/domain/resource/service.ts'
import type { JiraIssue, JiraSourceOptions } from '../../src/infrastructure/connectors/jira.ts'

/**
 * 三阶段迁移演练，**跑在真的 HTTP 路径上**（FR-CON-007）。
 *
 * `migration-rehearsal.test.ts` 用的是内存里的假源，于是分页、认证头、
 * 字段裁剪、错误映射这几段整个被跳过了——而迁移工具丢数据，
 * 恰恰最常丢在分页上。这一组把演练跑在 `JiraSource` 上：
 * 真的发 HTTP、真的翻页、真的回写，对面是一个在监听的服务器。
 *
 * ⚠️ **成色**：对面那个服务器讲的是 Jira 的协议，但报文形状来自公开文档，
 * 不是从一个真实实例上抓的（GitHub 那组用的是从本仓库 CI 真抓下来的报文，
 * 两者不是一个成色）。整条管线验到位了，**"Jira 真的长这样吗"没有**。
 */

const TENANT = 'default'
const WS = 'ws_platform'
const AUTH = { email: 'migrator@acme.com', token: 'not-a-real-token' }

let pool: pg.Pool
let app: FastifyInstance
let jira: Server
let baseUrl: string

const asAdmin = {
  'x-principal': 'user://alice',
  'x-tenant': TENANT,
  'x-roles': 'Admin',
  'x-capabilities': '',
}

const migrationCaller: Caller = {
  subject: {
    principal: MIGRATION_PRINCIPAL,
    tenant: TENANT,
    roles: [],
    capabilities: ['*.Create', '*.Read', '*.Update'],
  },
}

const MAPPING: JiraSourceOptions = {
  fields: [
    { from: 'summary', to: 'title' },
    { from: 'assignee', to: 'assignee' },
  ],
  status: { 'To Do': 'Todo', 'In Progress': 'Doing' },
  ignore: ['reporter'],
}

/** 假 Jira 的库存。测试直接改它来模拟"源那边变了" */
let issues: JiraIssue[] = []
/** 收到过的请求，用来断言真的翻了页、真的带了认证 */
let seen: { method: string; url: string; auth: string | undefined; body: string }[] = []
/** 一页几条。给得小是为了让翻页真的发生 */
const PAGE = 2

beforeAll(async () => {
  jira = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += String(c)))
    req.on('end', () => {
      const url = new URL(req.url ?? '', 'http://x')
      seen.push({
        method: req.method ?? '',
        url: req.url ?? '',
        auth: req.headers['authorization'] as string | undefined,
        body,
      })

      if (url.pathname === '/rest/api/3/search') {
        const startAt = Number(url.searchParams.get('startAt') ?? '0')
        const maxResults = Number(url.searchParams.get('maxResults') ?? String(PAGE))
        const slice = issues.slice(startAt, startAt + maxResults)
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ issues: slice, startAt, maxResults, total: issues.length }))
        return
      }

      const put = /^\/rest\/api\/3\/issue\/(.+)$/.exec(url.pathname)
      if (put !== null && req.method === 'PUT') {
        const key = decodeURIComponent(put[1] ?? '')
        const payload = JSON.parse(body) as { fields: Record<string, unknown> }
        const found = issues.find((i) => i.key === key)
        if (found !== undefined) Object.assign(found.fields, payload.fields)
        res.writeHead(204)
        res.end()
        return
      }

      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ errorMessages: ['not found'] }))
    })
  })
  await new Promise<void>((resolve) => jira.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${(jira.address() as AddressInfo).port}`

  pool = await setupTestDb()
  await assertNotSuperuser(pool)
  app = buildServer({
    pool,
    registry: buildDefaultRegistry(),
    workflows: buildDefaultWorkflowRegistry(),
    policies: defaultPolicies(TENANT),
    tenant: TENANT,
  })
  await app.ready()
})

afterAll(async () => {
  await app.close()
  await pool.end()
  await new Promise<void>((resolve) => jira.close(() => resolve()))
})

beforeEach(async () => {
  await truncateAll(pool)
  seen = []
  // 五条，页大小 2 → 一定要翻三页才读得全
  issues = [
    issue('PROJ-1', '打通导出接口', 'To Do'),
    issue('PROJ-2', '导出 UI', 'In Progress'),
    issue('PROJ-3', '导出文档', 'To Do'),
    issue('PROJ-4', '导出性能压测', 'To Do'),
    issue('PROJ-5', '导出灰度开关', 'In Progress'),
  ]
})

function issue(key: string, summary: string, status: string): JiraIssue {
  return {
    id: key,
    key,
    fields: {
      summary,
      assignee: 'user://bob',
      reporter: { name: 'carol' },
      status: { name: status },
      updated: '2026-08-01T00:00:00.000+0000',
    },
  }
}

function source(): JiraSource {
  return new JiraSource({
    ...MAPPING,
    baseUrl,
    jql: 'project = PROJ ORDER BY key',
    auth: AUTH,
    pageSize: PAGE,
  })
}

async function rehearse(phase: 'mirror' | 'parallel' | 'cutover', src: JiraSource, store: InMemoryLinkStore) {
  const db = createDb(pool)
  const audit = new BufferedAuditSink()
  try {
    return await withTenant(db, TENANT, (trx) =>
      runPhase({
        phase,
        source: src,
        links: store,
        service: serviceIn(trx, TENANT, {
          registry: buildDefaultRegistry(),
          workflows: buildDefaultWorkflowRegistry(),
          policies: defaultPolicies(TENANT),
          audit,
          clock: systemClock,
        }),
        caller: migrationCaller,
        resourceType: 'Task',
        workspace: WS,
      }),
    )
  } finally {
    const entries = audit.drain()
    if (entries.length > 0) await withTenant(db, TENANT, (trx) => flushAudit(trx, entries))
  }
}

async function tasks(): Promise<{ id: string; status: string; attributes: Record<string, unknown> }[]> {
  const res = await app.inject({ method: 'GET', url: '/v1/resources?type=Task', headers: asAdmin })
  return res.json().items as { id: string; status: string; attributes: Record<string, unknown> }[]
}

describe('the rehearsal runs over real HTTP (FR-CON-007)', () => {
  it('reads every page — five issues at two per page', async () => {
    const store = new InMemoryLinkStore()
    const report = await rehearse('mirror', source(), store)

    expect(report.created).toBe(5)
    expect(report.rejected).toEqual([])
    // 真的翻了页：三次 search（0, 2, 4）
    const searches = seen.filter((s) => s.url.startsWith('/rest/api/3/search'))
    expect(searches.length).toBeGreaterThanOrEqual(3)
    expect(searches.map((s) => new URL(s.url, 'http://x').searchParams.get('startAt'))).toContain('4')
  })

  it('sends credentials, and asks only for the fields it maps', async () => {
    await rehearse('mirror', source(), new InMemoryLinkStore())
    const search = seen.find((s) => s.url.startsWith('/rest/api/3/search'))
    expect(search?.auth).toMatch(/^Basic /)
    // 不限定字段的话，每条 issue 会带回几十 KB，
    // 其中大部分是我们不映射、因此也不该看到的内容
    const fields = new URL(search?.url ?? '', 'http://x').searchParams.get('fields')
    expect(fields).toContain('summary')
    expect(fields).not.toContain('reporter')
  })

  it('lands them as real Tasks in the right status', async () => {
    await rehearse('mirror', source(), new InMemoryLinkStore())
    const all = await tasks()
    expect(all).toHaveLength(5)
    // 状态由映射表决定，建的时候就落在那儿——
    // 让它们全落在 Todo 再由人一条条推，那不是迁移是重录一遍
    expect(all.filter((t) => t.status === 'Doing')).toHaveLength(2)
    expect(all.filter((t) => t.status === 'Todo')).toHaveLength(3)
  })

  it('reconciles clean — nothing was lost across the wire', async () => {
    const store = new InMemoryLinkStore()
    const report = await rehearse('mirror', source(), store)
    expect(report.reconciliation.missing).toEqual([])
    expect(report.reconciliation.clean).toBe(true)
    expect(report.reconciliation.matched).toBe(5)
  })
})

describe('all three phases, end to end over HTTP (FR-CON-007)', () => {
  it('mirror → parallel → cutover, with nothing lost', async () => {
    const store = new InMemoryLinkStore()
    const src = source()

    // ① 镜像：全部过来
    const mirror = await rehearse('mirror', src, store)
    expect(mirror.created).toBe(5)
    expect(mirror.reconciliation.clean).toBe(true)

    // 镜像期间有人在这边改了一条 —— 传不回去，但要看得见
    const first = (await tasks()).find((t) => t.attributes['title'] === '打通导出接口')
    const got = await app.inject({ method: 'GET', url: `/v1/resources/${first?.id}`, headers: asAdmin })
    await app.inject({
      method: 'PATCH',
      url: `/v1/resources/${first?.id}`,
      headers: { ...asAdmin, 'if-match': got.headers['etag'] as string },
      payload: { attributes: { ...(got.json().attributes as object), title: '打通导出接口（改过）' } },
    })

    const held = await rehearse('mirror', src, store)
    expect(held.held.map((h) => h.externalId)).toContain('PROJ-1')
    expect(seen.some((s) => s.method === 'PUT')).toBe(false)

    // ② 并行：这次真的 PUT 回去了
    const parallel = await rehearse('parallel', src, store)
    expect(parallel.updatedRemote).toBeGreaterThanOrEqual(1)
    const put = seen.find((s) => s.method === 'PUT')
    expect(put?.url).toContain('PROJ-1')
    // 反向映射：写回去的是 Jira 的字段名，不是我们的
    expect(JSON.parse(put?.body ?? '{}').fields).toHaveProperty('summary')
    expect(issues.find((i) => i.key === 'PROJ-1')?.fields['summary']).toBe('打通导出接口（改过）')

    // 源那边也改一条，拉下来
    const proj2 = issues.find((i) => i.key === 'PROJ-2')
    if (proj2 !== undefined) proj2.fields['summary'] = '导出 UI（源那边改的）'
    const pulled = await rehearse('parallel', src, store)
    expect(pulled.updatedLocal).toBeGreaterThanOrEqual(1)

    // ③ 切换：不再回写
    seen = []
    const beforeCutover = (await tasks()).find((t) => String(t.attributes['title']).includes('导出文档'))
    const got3 = await app.inject({
      method: 'GET',
      url: `/v1/resources/${beforeCutover?.id}`,
      headers: asAdmin,
    })
    await app.inject({
      method: 'PATCH',
      url: `/v1/resources/${beforeCutover?.id}`,
      headers: { ...asAdmin, 'if-match': got3.headers['etag'] as string },
      payload: { attributes: { ...(got3.json().attributes as object), title: '导出文档（切换后改的）' } },
    })
    const cutover = await rehearse('cutover', src, store)
    expect(cutover.updatedRemote).toBe(0)
    expect(seen.some((s) => s.method === 'PUT')).toBe(false)
    expect(cutover.held.map((h) => h.externalId)).toContain('PROJ-3')

    // 演练的判据：**一条都没丢**
    expect(cutover.reconciliation.missing).toEqual([])
    expect(cutover.conflicts).toEqual([])
    expect(cutover.rejected).toEqual([])
    expect((await tasks())).toHaveLength(5)
  })
})

describe('the rehearsal refuses to succeed on a partial read (FR-CON-007)', () => {
  it('throws when Jira reports more issues than it hands over', async () => {
    // 少读一页不会报错，后面的对账会把它报成"源系统里少了这些"——
    // 而那时人会去查 Jira，查的是一个根本没出问题的地方
    const short = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      // 说有 99 条，给完这一页就没有了
      res.end(
        JSON.stringify({
          issues: [issue('PROJ-9', '只给一条', 'To Do')],
          startAt: 0,
          maxResults: 2,
          total: 99,
        }),
      )
    })
    await new Promise<void>((resolve) => short.listen(0, '127.0.0.1', resolve))
    const src = new JiraSource({
      ...MAPPING,
      baseUrl: `http://127.0.0.1:${(short.address() as AddressInfo).port}`,
      jql: 'project = PROJ',
      pageSize: 2,
    })

    // 这个服务器忽略 startAt，于是第二页又是 PROJ-9 —— 先撞上重复检测
    await expect(src.readAll()).rejects.toThrow(/twice|partial set/)
    await new Promise<void>((resolve) => short.close(() => resolve()))
  })

  it('refuses a server whose pagination never advances', async () => {
    // **这条是把演练跑到真 HTTP 上才逼出来的。** 一个每次都返回第一页的
    // 服务器，会让"条数对不对得上 total"那个检查顺利通过——
    // 因为它累加到 total 条就停了，而那 total 条是同一条复制了 total 遍。
    // 迁移里"数据翻倍"和"数据丢失"一样糟，而且更难发现：对账会说一条不少
    const stuck = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          issues: [issue('PROJ-1', '永远是第一页', 'To Do')],
          startAt: 0,
          maxResults: 1,
          total: 50,
        }),
      )
    })
    await new Promise<void>((resolve) => stuck.listen(0, '127.0.0.1', resolve))
    const src = new JiraSource({
      ...MAPPING,
      baseUrl: `http://127.0.0.1:${(stuck.address() as AddressInfo).port}`,
      jql: 'project = PROJ',
      pageSize: 1,
    })
    await expect(src.readAll()).rejects.toThrow(/twice; pagination is not advancing/)
    await new Promise<void>((resolve) => stuck.close(() => resolve()))
  })

  it('separates "we sent something wrong" from "the other side is down"', async () => {
    // 一次持续几小时的迁移，两种完全不同的问题给同一句话，
    // 是最耗人的那种错误信息
    const broken = createServer((_req, res) => {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ errorMessages: ["Field 'nope' does not exist"] }))
    })
    await new Promise<void>((resolve) => broken.listen(0, '127.0.0.1', resolve))
    const src = new JiraSource({
      ...MAPPING,
      baseUrl: `http://127.0.0.1:${(broken.address() as AddressInfo).port}`,
      jql: 'nope = 1',
    })
    await expect(src.readAll()).rejects.toThrow(/400/)
    await new Promise<void>((resolve) => broken.close(() => resolve()))
  })
})

describe('translation problems reach the rehearsal report (FR-CON-007)', () => {
  it('surfaces an unmapped field instead of dropping it', async () => {
    issues = [
      {
        id: 'PROJ-7',
        key: 'PROJ-7',
        fields: {
          summary: '有个自定义字段',
          status: { name: 'To Do' },
          updated: '2026-08-01T00:00:00.000+0000',
          customfield_10099: '客户承诺的上线日期',
        },
      },
    ]
    const src = source()
    await rehearse('mirror', src, new InMemoryLinkStore())
    // 自定义字段是迁移丢数据的重灾区，而且丢了没有痕迹
    expect(src.problems).toHaveLength(1)
    expect(src.problems[0]?.detail).toContain('customfield_10099')
  })

  it('accumulates problems across phases rather than overwriting them', async () => {
    // 一次演练会分阶段跑好几遍，每一遍的问题都该留在报告里
    issues = [
      {
        id: 'PROJ-8',
        key: 'PROJ-8',
        fields: {
          summary: '状态没映射',
          status: { name: 'Awaiting Deployment' },
          updated: '2026-08-01T00:00:00.000+0000',
        },
      },
    ]
    const src = source()
    const store = new InMemoryLinkStore()
    await rehearse('mirror', src, store)
    await rehearse('parallel', src, store)
    expect(src.problems.length).toBeGreaterThanOrEqual(2)
    expect(src.problems[0]?.kind).toBe('unmapped-status')
  })
})
