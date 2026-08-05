import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type pg from 'pg'
import type { FastifyInstance } from 'fastify'
import { assertNotSuperuser, setupTestDb, truncateAll } from '../helpers/db.ts'
import { buildServer } from '../../src/api/server.ts'
import { buildDefaultRegistry } from '../../src/ontology/defaults.ts'
import { buildDefaultWorkflowRegistry } from '../../src/workflow/defaults.ts'
import { defaultPolicies } from '../../src/identity/default-policies.ts'
import { MAX_PAGE_SIZE } from '../../src/domain/resource/ports.ts'

/**
 * 本体一致性巡检接进产品之后（FR-ONT-010）。
 *
 * 判定规则本身在 tests/ontology-health.test.ts 里逐条测过（纯函数）。
 * 这里测的是**另一件事**：那些规则拿到的快照是不是真的、完整的，
 * 以及扫不完的时候会不会说。
 *
 * 分开测是因为这两处的失败方式完全不同：判定错了会报错案，
 * 快照错了会**安静地报一份干净的报告**——而后者更危险。
 */

const TENANT = 't_health'
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

async function create(type: string, attributes: Record<string, unknown>, project?: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/resources',
    headers: asAdmin,
    payload: { type, workspace: 'ws_health', attributes, ...(project === undefined ? {} : { project }) },
  })
  expect(res.statusCode).toBe(201)
  return res.json().id as string
}

async function health(query = ''): Promise<{
  findings: { kind: string; resourceId?: string; relationId?: string }[]
  scanned: { resources: number; relations: number }
  affectedIds: string[]
  complete: boolean
}> {
  const res = await app.inject({ method: 'GET', url: `/v1/ontology/health${query}`, headers: asAdmin })
  expect(res.statusCode).toBe(200)
  return res.json()
}

describe('ontology health endpoint (FR-ONT-010)', () => {
  it('finds an object that belongs to no project', async () => {
    const orphan = await create('Task', { title: '没归属' })
    const report = await health()

    const found = report.findings.filter((f) => f.kind === 'orphan')
    expect(found.map((f) => f.resourceId)).toContain(orphan)
    // 验收标准的后半句：问题对象可在 UI 中筛选。**筛选靠的就是这个数组**
    expect(report.affectedIds).toContain(orphan)
  })

  it('finds a relation left pointing at a soft-deleted object', async () => {
    // 外键的级联只管硬删除，而这个系统是软删除——
    // 删掉一个 Task 会留下一堆指向它的关系，顺着走过去拿到一个已经不算存在的东西
    const project = await create('Project', { key: 'PH', name: 'p' })
    const story = await create('Story', { title: 's' }, project)
    const task = await create('Task', { title: 't' }, project)
    await app.inject({
      method: 'POST',
      url: `/v1/resources/${story}/relations`,
      headers: asAdmin,
      payload: { type: 'decomposedInto', toId: task },
    })
    const current = await app.inject({ method: 'GET', url: `/v1/resources/${task}`, headers: asAdmin })
    await app.inject({
      method: 'DELETE',
      url: `/v1/resources/${task}`,
      headers: { ...asAdmin, 'if-match': `"${current.json().version}"` },
    })

    const report = await health()
    const broken = report.findings.filter((f) => f.kind === 'broken-link')
    // 两条：story --decomposedInto--> task，以及项目自动建的 contains。
    // **删掉一个对象会让每一条碰到它的边同时断掉**，包括那些没人手工建过的
    expect(broken).toHaveLength(2)
    expect(new Set(broken.map((f) => f.resourceId))).toEqual(new Set([task]))
  })

  it('counts the deleted objects it scanned, not just the live ones', async () => {
    // 断链判定要知道**哪些被删了**。只取活着的对象，指向已删除对象的关系
    // 会被当成"指向一个从来没有过的 id"——结论碰巧一样，但那是运气
    const task = await create('Task', { title: '将被删除' })
    const current = await app.inject({ method: 'GET', url: `/v1/resources/${task}`, headers: asAdmin })
    await app.inject({
      method: 'DELETE',
      url: `/v1/resources/${task}`,
      headers: { ...asAdmin, 'if-match': `"${current.json().version}"` },
    })

    const report = await health()
    expect(report.scanned.resources).toBe(1)
    // 已删除的对象不再是孤儿——它已经不在了
    expect(report.findings.filter((f) => f.kind === 'orphan')).toHaveLength(0)
  })

  it('says so when it could not finish the scan', async () => {
    // 一份"发现 0 个问题"的报告，如果它其实只扫了前几个对象，
    // **比没有报告更坏**——它会让人不再去看
    const project = await create('Project', { key: 'PH', name: 'p' })
    for (let i = 0; i < 4; i++) await create('Task', { title: `t${i}` }, project)

    const partial = await health('?maxResources=2')
    expect(partial.complete).toBe(false)
    expect(partial.scanned.resources).toBe(2)

    const full = await health()
    expect(full.complete).toBe(true)
    expect(full.scanned.resources).toBe(5)
  })

  it('reports a clean tenant as clean, with the denominator', async () => {
    const project = await create('Project', { key: 'PH', name: 'p' })
    await create('Task', { title: 't' }, project)

    const report = await health()
    expect(report.findings).toEqual([])
    // "0 个问题"必须带着分母出现。10 个对象里 0 个和 10 万个里 0 个
    // 是完全不同的两句话
    expect(report.scanned.resources).toBe(2)
    expect(report.complete).toBe(true)
  })

  it('is a read that goes through the PDP like any other', async () => {
    // 一份巡检报告会列出全租户的对象 id。它必须走和"看一眼列表"同一道闸——
    // 一条绕过 PDP 的只读端点是最容易被忽略的那种泄漏：它不改任何东西，
    // 所以看起来无害
    await create('Task', { title: 't' })
    const res = await app.inject({
      method: 'GET',
      url: '/v1/ontology/health',
      // 默认策略只在 TENANT 里放行。换一个租户，同一个人就不该看得到
      headers: { ...asAdmin, 'x-tenant': 't_somewhere_else' },
    })
    expect(res.statusCode).toBe(403)
  })

  it('scans past the first page, for both resources and relations', async () => {
    // 两个扫描都是游标翻页的。翻页写错最常见的形态不是报错，是**永远拿第一页**——
    // 而那时报告只覆盖了前 200 个对象，看起来完全正常。
    // 所以这里刻意越过一页（MAX_PAGE_SIZE = 200）。
    const project = await create('Project', { key: 'PH', name: 'p' })
    await Promise.all(
      Array.from({ length: MAX_PAGE_SIZE + 5 }, (_, i) => create('Task', { title: `t${i}` }, project)),
    )

    const report = await health()
    expect(report.complete).toBe(true)
    expect(report.scanned.resources).toBe(MAX_PAGE_SIZE + 6)
    // 每个 Task 一条项目自动建的 contains
    expect(report.scanned.relations).toBe(MAX_PAGE_SIZE + 5)
    // 都归属项目，所以一个孤儿都没有
    expect(report.findings).toEqual([])
  })
})
