import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type pg from 'pg'
import type { FastifyInstance } from 'fastify'
import { assertNotSuperuser, setupTestDb, truncateAll } from '../helpers/db.ts'
import { buildServer } from '../../src/api/server.ts'
import { buildDefaultRegistry } from '../../src/ontology/defaults.ts'
import { buildDefaultWorkflowRegistry } from '../../src/workflow/defaults.ts'
import { defaultPolicies } from '../../src/identity/default-policies.ts'
import { InMemoryLinkStore, runPhase } from '../../src/domain/migration/runner.ts'
import { serviceIn } from '../../src/infrastructure/service-factory.ts'
import { createDb, withTenant } from '../../src/infrastructure/db/client.ts'
import { BufferedAuditSink, flushAudit } from '../../src/infrastructure/outbox.pg.ts'
import { systemClock } from '../../src/platform/clock.ts'
import type { Caller } from '../../src/domain/resource/service.ts'
import { MIGRATION_PRINCIPAL } from '../../src/identity/types.ts'
import { translateIssues } from '../../src/infrastructure/connectors/jira.ts'
import type { SyncSource } from '../../src/domain/migration/runner.ts'
import type { ExternalRecord } from '../../src/domain/migration/sync.ts'
import type { JiraIssue, JiraSourceOptions } from '../../src/infrastructure/connectors/jira.ts'

/**
 * 三阶段迁移演练，跑在**真库**上（FR-CON-007）。
 *
 * `tests/migration-sync.test.ts` 验的是判断逻辑；这一组验的是
 * **判断真的应用得下去**——而"应用得下去"要过本体校验、生命周期守卫、
 * 权限、审计。迁移工具最典型的失败就是在这里：判断全对，
 * 写的时候被不变量挡住，然后那批数据悄悄少了一半。
 *
 * 走的是普通的 `service.create` / `update`。另开一条迁移专用写路径能省事，
 * 代价是迁进来的数据**从第一天起就不满足系统自己的不变量**，
 * 之后所有守卫在这批数据上都失效——它们只挡后来的人。
 *
 * ⚠️ 这仍然不是 FR-CON-007 要的那场演练：源是内存里的假 Jira。
 * 验收标准要的是一次**已经发生的**、对着真实实例的演练。
 */

const TENANT = 'default'
let pool: pg.Pool
let app: FastifyInstance

const asAdmin = {
  'x-principal': 'user://alice',
  'x-tenant': TENANT,
  'x-roles': 'Admin',
  'x-capabilities': '',
}

const JIRA_MAPPING: JiraSourceOptions = {
  fields: [
    { from: 'summary', to: 'title' },
    { from: 'assignee', to: 'assignee', translate: (v) => `user://${String(v)}` },
  ],
  status: { 'To Do': 'Todo', 'In Progress': 'Doing' },
  ignore: ['reporter'],
}

const issue = (key: string, fields: Record<string, unknown>): JiraIssue => ({
  id: key,
  key,
  fields: { updated: '2026-01-02T00:00:00.000+0000', ...fields },
})

/** 内存里的假源。真源是什么由适配器负责，引擎不认识它 */
class FakeSource implements SyncSource {
  records: ExternalRecord[]
  readonly written: { externalId: string; fields: Record<string, unknown> }[] = []
  constructor(records: ExternalRecord[]) {
    this.records = records
  }
  async readAll(): Promise<readonly ExternalRecord[]> {
    return this.records
  }
  async write(externalId: string, fields: Record<string, unknown>): Promise<void> {
    this.written.push({ externalId, fields })
    const found = this.records.find((r) => r.externalId === externalId)
    if (found !== undefined) found.fields = { ...fields }
  }
}

beforeAll(async () => {
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
})

beforeEach(async () => {
  await truncateAll(pool)
})

/**
 * 迁移是一个**后台作业**，不是一次 HTTP 请求，所以它自己组装 service。
 * 用的是和 HTTP、poller、SLA 巡检、Agent runner 同一个工厂
 * （`serviceIn`）——那份接线只有一处，加依赖时不会漏掉某条路径。
 */
const migrationCaller: Caller = {
  subject: {
    principal: MIGRATION_PRINCIPAL,
    tenant: TENANT,
    roles: [],
    // 迁移只建和改，**不迁移状态**：状态由映射表决定，
    // 让迁移作业能推状态机等于给它一把绕开守卫的钥匙
    capabilities: ['*.Create', '*.Read', '*.Update'],
  },
}

async function rehearse(
  phase: 'mirror' | 'parallel' | 'cutover',
  source: FakeSource,
  links: InMemoryLinkStore,
) {
  const db = createDb(pool)
  const audit = new BufferedAuditSink()
  try {
    return await withTenant(db, TENANT, async (trx) =>
      runPhase({
        phase,
        source,
        links,
        service: serviceIn(trx, TENANT, {
          registry: buildDefaultRegistry(),
          workflows: buildDefaultWorkflowRegistry(),
          policies: defaultPolicies(TENANT),
          audit,
          clock: systemClock,
        }),
        caller: migrationCaller,
        resourceType: 'Task',
        workspace: 'ws_platform',
      }),
    )
  } finally {
    // 审计与业务事务分开落盘：业务回滚时留痕不能跟着没。
    // 但仍要在租户上下文里——RLS 是开着的，而且第一版就是漏了这一层
    // 被它拦下来的（`new row violates row-level security policy`）。
    // 那正是 FR-IAM-015 想要的表现：漏配租户不是"写进了别人的库"，是写不进去
    const entries = audit.drain()
    if (entries.length > 0) await withTenant(db, TENANT, (trx) => flushAudit(trx, entries))
  }
}

describe('a migration rehearsal runs through the ordinary write path (FR-CON-007)', () => {
  it('creates real Tasks that satisfy the same invariants as hand-made ones', async () => {
    const { records, problems } = translateIssues(
      [issue('PROJ-1', { summary: '导出账单', status: { name: 'To Do' } })],
      JIRA_MAPPING,
    )
    expect(problems).toEqual([])

    const links = new InMemoryLinkStore()
    const report = await rehearse('mirror', new FakeSource([...records]), links)

    expect(report.created).toBe(1)
    expect(report.rejected).toEqual([])
    expect(report.reconciliation.clean).toBe(true)

    // 真的落库了，而且带着可辨认的标记
    const listed = await app.inject({
      method: 'GET',
      url: '/v1/resources?type=Task',
      headers: asAdmin,
    })
    const items = listed.json().items as { labels: string[]; attributes: Record<string, unknown> }[]
    expect(items).toHaveLength(1)
    expect(items[0]?.labels).toContain('migrated')
    expect(items[0]?.attributes['title']).toBe('导出账单')
  })

  it('reports a record the local invariants refuse, instead of losing it quietly', async () => {
    // Task 的 title 是必填。一条没有 summary 的 Jira issue 写不进来——
    // **这不是守卫的问题，是这次迁移的问题**，而它必须出现在报告里
    const links = new InMemoryLinkStore()
    const report = await rehearse(
      'mirror',
      new FakeSource([{ externalId: 'PROJ-9', fields: { assignee: 'user://bob' }, updatedAt: new Date() }]),
      links,
    )

    expect(report.created).toBe(0)
    expect(report.rejected).toHaveLength(1)
    expect(report.rejected[0]?.externalId).toBe('PROJ-9')
    // 对账也要看得出来：源里有、这边没有 = 丢了
    expect(report.reconciliation.missing).toEqual(['PROJ-9'])
    expect(report.reconciliation.clean).toBe(false)
  })

  it('keeps going after a rejection so one run produces the whole report', async () => {
    // 遇到第一条问题就中断的话，人只能一条一条修、一次一次重跑
    const links = new InMemoryLinkStore()
    const report = await rehearse(
      'mirror',
      new FakeSource([
        { externalId: 'P-1', fields: { assignee: 'user://bob' }, updatedAt: new Date() },
        { externalId: 'P-2', fields: { title: '好的一条' }, updatedAt: new Date() },
        { externalId: 'P-3', fields: {}, updatedAt: new Date() },
      ]),
      links,
    )
    expect(report.created).toBe(1)
    expect(report.rejected.map((r) => r.externalId)).toEqual(['P-1', 'P-3'])
  })

  it('is idempotent — running the same phase twice does not duplicate anything', async () => {
    // 演练一定会被重跑。第二遍产出一份副本的话，"无数据丢失"会变成"数据翻倍"
    const links = new InMemoryLinkStore()
    const source = new FakeSource([{ externalId: 'P-1', fields: { title: 'a' }, updatedAt: new Date() }])

    const first = await rehearse('mirror', source, links)
    const second = await rehearse('mirror', source, links)

    expect(first.created).toBe(1)
    expect(second.created).toBe(0)
    expect(second.unchanged).toBe(1)

    const listed = await app.inject({ method: 'GET', url: '/v1/resources?type=Task', headers: asAdmin })
    expect(listed.json().items).toHaveLength(1)
  })
})

describe('the three phases, against a real database (FR-CON-007)', () => {
  it('mirror pulls down but holds local edits', async () => {
    const links = new InMemoryLinkStore()
    const source = new FakeSource([{ externalId: 'P-1', fields: { title: 'a' }, updatedAt: new Date() }])
    await rehearse('mirror', source, links)

    // 在这边改一下
    const listed = await app.inject({ method: 'GET', url: '/v1/resources?type=Task', headers: asAdmin })
    const id = (listed.json().items as { id: string }[])[0]?.id
    const got = await app.inject({ method: 'GET', url: `/v1/resources/${id}`, headers: asAdmin })
    await app.inject({
      method: 'PATCH',
      url: `/v1/resources/${id}`,
      headers: { ...asAdmin, 'if-match': got.headers['etag'] as string },
      payload: { attributes: { title: '这边改的' } },
    })

    const report = await rehearse('mirror', source, links)
    // 传不回去，但**看得见**
    expect(report.held.map((h) => h.externalId)).toEqual(['P-1'])
    expect(report.updatedRemote).toBe(0)
    expect(source.records[0]?.fields['title']).toBe('a')
  })

  it('parallel carries the local edit back to the source', async () => {
    const links = new InMemoryLinkStore()
    const source = new FakeSource([{ externalId: 'P-1', fields: { title: 'a' }, updatedAt: new Date() }])
    await rehearse('mirror', source, links)

    const listed = await app.inject({ method: 'GET', url: '/v1/resources?type=Task', headers: asAdmin })
    const id = (listed.json().items as { id: string }[])[0]?.id
    const got = await app.inject({ method: 'GET', url: `/v1/resources/${id}`, headers: asAdmin })
    await app.inject({
      method: 'PATCH',
      url: `/v1/resources/${id}`,
      headers: { ...asAdmin, 'if-match': got.headers['etag'] as string },
      payload: { attributes: { title: '这边改的' } },
    })

    const report = await rehearse('parallel', source, links)
    expect(report.updatedRemote).toBe(1)
    expect(source.written).toHaveLength(1)
    expect(source.records[0]?.fields['title']).toBe('这边改的')
  })

  it('surfaces a conflict rather than picking a winner', async () => {
    const links = new InMemoryLinkStore()
    const source = new FakeSource([{ externalId: 'P-1', fields: { title: 'a' }, updatedAt: new Date() }])
    await rehearse('mirror', source, links)

    // 两边各改各的
    const listed = await app.inject({ method: 'GET', url: '/v1/resources?type=Task', headers: asAdmin })
    const id = (listed.json().items as { id: string }[])[0]?.id
    const got = await app.inject({ method: 'GET', url: `/v1/resources/${id}`, headers: asAdmin })
    await app.inject({
      method: 'PATCH',
      url: `/v1/resources/${id}`,
      headers: { ...asAdmin, 'if-match': got.headers['etag'] as string },
      payload: { attributes: { title: '这边改的' } },
    })
    source.records[0] = { externalId: 'P-1', fields: { title: '那边改的' }, updatedAt: new Date() }

    const report = await rehearse('parallel', source, links)
    expect(report.conflicts).toHaveLength(1)
    expect([...(report.conflicts[0]?.fields ?? [])]).toEqual(['title'])
    // 谁都没被覆盖
    expect(report.updatedLocal).toBe(0)
    expect(report.updatedRemote).toBe(0)
    expect(source.records[0]?.fields['title']).toBe('那边改的')
  })

  it('cutover stops writing back — the old system stops drifting', async () => {
    const links = new InMemoryLinkStore()
    const source = new FakeSource([{ externalId: 'P-1', fields: { title: 'a' }, updatedAt: new Date() }])
    await rehearse('mirror', source, links)

    const listed = await app.inject({ method: 'GET', url: '/v1/resources?type=Task', headers: asAdmin })
    const id = (listed.json().items as { id: string }[])[0]?.id
    const got = await app.inject({ method: 'GET', url: `/v1/resources/${id}`, headers: asAdmin })
    await app.inject({
      method: 'PATCH',
      url: `/v1/resources/${id}`,
      headers: { ...asAdmin, 'if-match': got.headers['etag'] as string },
      payload: { attributes: { title: '切换后改的' } },
    })

    const report = await rehearse('cutover', source, links)
    expect(report.updatedRemote).toBe(0)
    expect(source.written).toEqual([])
    expect(report.held.map((h) => h.externalId)).toEqual(['P-1'])
  })
})
