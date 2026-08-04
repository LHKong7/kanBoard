import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type pg from 'pg'
import type { FastifyInstance } from 'fastify'
import { assertNotSuperuser, queryAsTenant, setupTestDb, truncateAll } from '../helpers/db.ts'
import { buildServer } from '../../src/api/server.ts'
import { buildDefaultRegistry } from '../../src/ontology/defaults.ts'
import { buildDefaultWorkflowRegistry } from '../../src/workflow/defaults.ts'
import { defaultPolicies } from '../../src/identity/default-policies.ts'
import { createDb } from '../../src/infrastructure/db/client.ts'

const TENANT = 't_acme'

let pool: pg.Pool
let app: FastifyInstance

const asPM = {
  'x-principal': 'user://alice',
  'x-tenant': TENANT,
  'x-roles': 'PM',
  'x-capabilities': '',
}
const asRD = {
  'x-principal': 'user://bob',
  'x-tenant': TENANT,
  'x-roles': 'RD',
  'x-capabilities': '',
}

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

async function createRequirement(headers = asPM, attributes?: Record<string, unknown>) {
  return app.inject({
    method: 'POST',
    url: '/v1/resources',
    headers,
    payload: {
      type: 'Requirement',
      workspace: 'ws_platform',
      status: 'Draft',
      attributes: attributes ?? {
        title: 'ProjectOS M0',
        level: 'Feature',
        statement: '本体 + 统一 Resource + 权限 PDP 可用',
        priority: 'Must',
      },
    },
  })
}

describe('unified Resource API (ADR-0002)', () => {
  it('creates any registered entity type through the same endpoint', async () => {
    // 这条用例是统一模型的收益本身：五种类型，一个端点，零专用代码。
    const types: Array<[string, Record<string, unknown>]> = [
      ['Requirement', { title: 'r', level: 'Epic', statement: 's' }],
      ['Story', { title: 'st' }],
      ['Task', { title: 't' }],
      ['Decision', { question: 'q', chosen: 'c', rationale: 'r' }],
      ['Knowledge', { title: 'k', body: 'b' }],
    ]

    for (const [type, attributes] of types) {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/resources',
        headers: { ...asPM, 'x-roles': 'Admin' },
        payload: { type, workspace: 'ws_platform', attributes },
      })
      expect(res.statusCode, `${type}: ${res.body}`).toBe(201)
      expect(res.json().type).toBe(type)
    }
  })

  it('assigns a typed, sortable id', async () => {
    const res = await createRequirement()
    expect(res.statusCode).toBe(201)
    expect(res.json().id).toMatch(/^req_[0-9A-HJKMNP-TV-Z]{26}$/)
  })

  it('stamps the ontology version the instance was written under', async () => {
    const res = await createRequirement()
    // 本体加了状态机写入的时间戳字段，按 04-ontology 的兼容矩阵递增 minor
    expect(res.json().ontologyVersion).toBe('1.1.0')
  })

  it('rejects attributes that violate the ontology, with field-level detail', async () => {
    const res = await createRequirement(asPM, { title: 'x' }) // 缺 level 与 statement
    expect(res.statusCode).toBe(422)
    const body = res.json()
    expect(body.error).toBe('validation_failed')
    const paths = (body.details.fields as { path: string }[]).map((f) => f.path)
    expect(paths).toContain('level')
    expect(paths).toContain('statement')
  })

  it('rejects an unregistered entity type', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/resources',
      headers: asPM,
      payload: { type: 'Wormhole', workspace: 'ws_platform', attributes: {} },
    })
    expect(res.statusCode).toBe(422)
  })

  it('reads back what it wrote', async () => {
    const created = await createRequirement()
    const id = created.json().id
    const res = await app.inject({ method: 'GET', url: `/v1/resources/${id}`, headers: asPM })
    expect(res.statusCode).toBe(200)
    expect(res.json().attributes.title).toBe('ProjectOS M0')
    expect(res.headers['etag']).toBe('"1"')
  })
})

describe('optimistic locking (FR-RES-003)', () => {
  it('accepts an update carrying the current version', async () => {
    const id = (await createRequirement()).json().id
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/resources/${id}`,
      headers: asPM,
      payload: { expectedVersion: 1, labels: ['q3'] },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().version).toBe(2)
    expect(res.json().labels).toEqual(['q3'])
  })

  it('rejects a stale write with 409 and reports the actual version', async () => {
    const id = (await createRequirement()).json().id
    await app.inject({
      method: 'PATCH',
      url: `/v1/resources/${id}`,
      headers: asPM,
      payload: { expectedVersion: 1, labels: ['q3'] },
    })
    const stale = await app.inject({
      method: 'PATCH',
      url: `/v1/resources/${id}`,
      headers: asPM,
      payload: { expectedVersion: 1, labels: ['q4'] },
    })
    expect(stale.statusCode).toBe(409)
    expect(stale.json().details).toEqual({ expected: 1, actual: 2 })
  })

  it('does not bump the version when nothing actually changed', async () => {
    // 无意义的版本漂移会让并发写互相冲突，白白制造 409
    const id = (await createRequirement()).json().id
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/resources/${id}`,
      headers: asPM,
      payload: { expectedVersion: 1, status: 'Draft' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().version).toBe(1)
  })

  it('accepts the version via If-Match as well as the body', async () => {
    const id = (await createRequirement()).json().id
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/resources/${id}`,
      headers: { ...asPM, 'if-match': '"1"' },
      payload: { labels: ['q3'] },
    })
    expect(res.statusCode).toBe(200)
  })

  it('refuses to change a lifecycle-governed status through a plain update', async () => {
    // 留一个 PATCH 能改 status 的口子，等于状态机形同虚设
    const id = (await createRequirement()).json().id
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/resources/${id}`,
      headers: asPM,
      payload: { expectedVersion: 1, status: 'Approved' },
    })
    expect(res.statusCode).toBe(409)
    expect(res.json().error).toBe('illegal_transition')
    expect(res.json().message).toMatch(/use the transition endpoint/)
  })
})

describe('history (FR-RES-005)', () => {
  it('records a field-level diff with the actor and reason', async () => {
    const id = (await createRequirement()).json().id
    await app.inject({
      method: 'PATCH',
      url: `/v1/resources/${id}`,
      headers: asPM,
      payload: {
        expectedVersion: 1,
        attributes: {
          title: 'ProjectOS M0',
          level: 'Feature',
          statement: '本体 + 统一 Resource + 权限 PDP 可用',
          priority: 'Should',
        },
        reason: '客户下调优先级',
      },
    })

    const res = await app.inject({ method: 'GET', url: `/v1/resources/${id}/history`, headers: asPM })
    expect(res.statusCode).toBe(200)
    const items = res.json().items as Array<{
      version: number
      changedBy: string
      reason: string | null
      changes: Array<{ path: string; from: unknown; to: unknown }>
    }>

    const latest = items[0]
    expect(latest?.version).toBe(2)
    expect(latest?.changedBy).toBe('user://alice')
    expect(latest?.reason).toBe('客户下调优先级')
    expect(latest?.changes).toEqual([
      { path: 'attributes.priority', from: 'Must', to: 'Should' },
    ])
  })

  it('keeps history after a soft delete', async () => {
    const id = (await createRequirement()).json().id
    const del = await app.inject({
      method: 'DELETE',
      url: `/v1/resources/${id}`,
      headers: { ...asPM, 'if-match': '"1"', 'x-roles': 'Admin' },
    })
    expect(del.statusCode).toBe(204)

    const gone = await app.inject({ method: 'GET', url: `/v1/resources/${id}`, headers: asPM })
    expect(gone.statusCode).toBe(200) // 软删除：仍可读到，只是 deletedAt 非空
    expect(gone.json().deletedAt).not.toBeNull()

    const history = await app.inject({ method: 'GET', url: `/v1/resources/${id}/history`, headers: asPM })
    expect((history.json().items as unknown[]).length).toBeGreaterThanOrEqual(2)
  })
})

describe('domain events land in the outbox in the same transaction (FR-RES-006)', () => {
  it('writes ResourceCreated alongside the resource', async () => {
    const id = (await createRequirement()).json().id
    const rows = await queryAsTenant<{ event_type: string; resource_id: string }>(
      pool,
      TENANT,
      'SELECT event_type, resource_id FROM outbox_events ORDER BY seq',
    )
    expect(rows.map((r) => r.event_type)).toContain('ResourceCreated')
    expect(rows.some((r) => r.resource_id === id)).toBe(true)
  })

  it('emits a dedicated status-change event so subscribers need not diff', async () => {
    const id = (await createRequirement()).json().id
    await app.inject({
      method: 'POST',
      url: `/v1/resources/${id}/transitions`,
      headers: asPM,
      payload: { to: 'Review' },
    })
    const rows = await queryAsTenant<{ event_type: string; payload: { from: string; to: string } }>(
      pool,
      TENANT,
      `SELECT event_type, payload FROM outbox_events WHERE event_type = 'ResourceStatusChanged'`,
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]?.payload).toMatchObject({ from: 'Draft', to: 'Review' })
  })

  it('leaves no event behind when the write is rejected', async () => {
    // 校验失败发生在事务内，事件不该被写出去
    await createRequirement(asPM, { title: 'incomplete' })
    const rows = await queryAsTenant(pool, TENANT, 'SELECT 1 AS ok FROM outbox_events')
    expect(rows).toHaveLength(0)
  })
})

describe('query (FR-RES-002/012)', () => {
  beforeEach(async () => {
    for (let i = 0; i < 5; i++) {
      await app.inject({
        method: 'POST',
        url: '/v1/resources',
        headers: { ...asRD, 'x-roles': 'RD' },
        payload: {
          type: 'Task',
          workspace: 'ws_platform',
          status: i % 2 === 0 ? 'Todo' : 'Doing',
          labels: i < 2 ? ['q3'] : [],
          attributes: { title: `task ${i}` },
        },
      })
    }
  })

  it('filters by type and status', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/resources:query',
      headers: asRD,
      payload: { type: 'Task', filter: { status: ['Doing'] } },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().items).toHaveLength(2)
  })

  it('filters by label', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/resources:query',
      headers: asRD,
      payload: { type: 'Task', filter: { labels: ['q3'] } },
    })
    expect(res.json().items).toHaveLength(2)
  })

  it('filters by attribute value', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/resources:query',
      headers: asRD,
      payload: { type: 'Task', filter: { attributes: { title: 'task 3' } } },
    })
    expect(res.json().items).toHaveLength(1)
  })

  it('pages with a stable cursor and no duplicates', async () => {
    const seen: string[] = []
    let cursor: string | undefined
    for (let guard = 0; guard < 10; guard++) {
      const res: { json(): { items: Array<{ id: string }>; nextCursor: string | null } } =
        await app.inject({
          method: 'POST',
          url: '/v1/resources:query',
          headers: asRD,
          payload: { type: 'Task', page: { size: 2, cursor } },
        })
      const body = res.json()
      seen.push(...body.items.map((i) => i.id))
      if (body.nextCursor === null) break
      cursor = body.nextCursor
    }
    expect(seen).toHaveLength(5)
    expect(new Set(seen).size).toBe(5)
  })

  it('hides soft-deleted resources by default', async () => {
    const listed = await app.inject({
      method: 'POST',
      url: '/v1/resources:query',
      headers: asRD,
      payload: { type: 'Task' },
    })
    const victim = listed.json().items[0]

    await app.inject({
      method: 'DELETE',
      url: `/v1/resources/${victim.id}`,
      headers: { ...asRD, 'if-match': `"${victim.version}"` },
    })

    const after = await app.inject({
      method: 'POST',
      url: '/v1/resources:query',
      headers: asRD,
      payload: { type: 'Task' },
    })
    expect(after.json().items).toHaveLength(4)

    const withDeleted = await app.inject({
      method: 'POST',
      url: '/v1/resources:query',
      headers: asRD,
      payload: { type: 'Task', filter: { includeDeleted: true } },
    })
    expect(withDeleted.json().items).toHaveLength(5)
  })
})

/**
 * 检索（FR-RES-016）。
 *
 * 自用日志 #3：142 条需求里找一条，只能全量拉到内存用正则匹配——
 * 记不住 id 的人无法使用这个系统。这组用例锁住的是"能找到"这件事本身。
 */
describe('search (FR-RES-016)', () => {
  let taskId: string

  beforeEach(async () => {
    const mk = async (attributes: Record<string, unknown>, labels: string[] = []) => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/resources',
        headers: asRD,
        payload: { type: 'Task', workspace: 'ws_platform', labels, attributes },
      })
      return res.json().id as string
    }
    taskId = await mk({ title: 'FR-WF-001 每个 EntityType 可绑定可配置状态机' }, ['wf'])
    await mk({ title: 'FR-DASH-015 按口径计算自动化分级', description: '含状态机三个字' })
    await mk({ title: 'unrelated english task' }, ['misc'])
  })

  const search = async (text: string, extra: Record<string, unknown> = {}) => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/resources:query',
      headers: asRD,
      payload: { type: 'Task', filter: { text, ...extra } },
    })
    expect(res.statusCode).toBe(200)
    return (res.json().items as Array<{ id: string }>).map((i) => i.id)
  }

  it('finds Chinese substrings — the default FTS parser cannot tokenize these', async () => {
    // 这条是选 trigram 而不是 to_tsvector 的全部理由：
    // 默认分词器不切中文，整段中文是一个 token，搜「状态机」会一无所获
    const hits = await search('状态机')
    expect(hits).toHaveLength(2)
    expect(hits).toContain(taskId)
  })

  it('finds an ASCII identifier embedded in a title', async () => {
    expect(await search('FR-WF-001')).toEqual([taskId])
  })

  it('matches labels as well as attribute values', async () => {
    expect(await search('wf')).toEqual([taskId])
  })

  it('does not match attribute *names* — searching "title" must not return everything', async () => {
    // 用 attributes::text 建索引就会踩这个：键名进了索引，
    // 于是搜 "title" 命中全表。一个永远返回一切的搜索框比没有更糟
    expect(await search('title')).toEqual([])
  })

  it('treats LIKE wildcards as literal text', async () => {
    // 不转义的话，搜一个 % 等于「匹配一切」
    expect(await search('%')).toEqual([])
    expect(await search('_')).toEqual([])
  })

  it('looks up by pasted resource id', async () => {
    expect(await search(taskId)).toEqual([taskId])
  })

  it('combines with other filters instead of replacing them', async () => {
    // 检索词与其余条件是 AND：标签对不上就该落空
    expect(await search('状态机', { labels: ['misc'] })).toEqual([])
    expect(await search('状态机', { labels: ['wf'] })).toEqual([taskId])
  })

  it('still answers short terms, even though the index cannot help', async () => {
    // 中文两字词（需求 / 状态 / 权限）太常见，不能因为走不了索引就拒绝
    expect(await search('状态')).toHaveLength(2)
  })

  it('excludes soft-deleted resources unless asked', async () => {
    const before = await search('状态机')
    const current = await app.inject({ method: 'GET', url: `/v1/resources/${taskId}`, headers: asRD })
    await app.inject({
      method: 'DELETE',
      url: `/v1/resources/${taskId}`,
      headers: { ...asRD, 'if-match': `"${current.json().version}"` },
    })
    expect(await search('状态机')).toHaveLength(before.length - 1)
    expect(await search('状态机', { includeDeleted: true })).toHaveLength(before.length)
  })

  it('keeps the search index in step with edits', async () => {
    // 生成列由数据库维护。若改成应用层写入的普通列，就会有"改了标题但搜不到"的窗口
    const current = await app.inject({ method: 'GET', url: `/v1/resources/${taskId}`, headers: asRD })
    await app.inject({
      method: 'PATCH',
      url: `/v1/resources/${taskId}`,
      headers: asRD,
      payload: {
        expectedVersion: current.json().version,
        attributes: { title: '改成了完全不同的标题 renamed' },
      },
    })
    expect(await search('renamed')).toEqual([taskId])
    expect(await search('FR-WF-001')).toEqual([])
  })
})

/**
 * 自用第一天发现的洞（docs/dogfooding-log.md #1）。
 *
 * 分页写成了 `{limit, cursor}` 而不是 `{page:{size, cursor}}`。
 * Zod 默认剥掉未知字段，于是接口回 200、游标永远停在第一页，
 * 142 条需求被翻成 1000 条重复结果——调用方没有任何办法察觉。
 * 宽松解析在这里买不到兼容性，只买到"看起来成功的错误答案"。
 */
describe('malformed request bodies are rejected, not silently trimmed (dogfooding #1)', () => {
  beforeEach(async () => {
    for (let i = 0; i < 5; i++) {
      await app.inject({
        method: 'POST',
        url: '/v1/resources',
        headers: asRD,
        payload: { type: 'Task', workspace: 'ws_platform', attributes: { title: `t${i}` } },
      })
    }
  })

  it('rejects pagination written at the top level instead of under page', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/resources:query',
      headers: asRD,
      payload: { type: 'Task', limit: 200, cursor: 'whatever' },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().details.map((d: { path: string }) => d.path)).toContain('limit')
  })

  it('rejects a misspelled field on create rather than dropping it', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/resources',
      headers: asRD,
      // `label` 少了个 s：静默丢弃的话，这条资源会不带任何标签地建出来
      payload: {
        type: 'Task',
        workspace: 'ws_platform',
        label: ['q3'],
        attributes: { title: 't' },
      },
    })
    expect(res.statusCode).toBe(400)
  })

  it('still accepts the documented pagination shape', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/resources:query',
      headers: asRD,
      payload: { type: 'Task', page: { size: 2 } },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().items).toHaveLength(2)
    expect(res.json().nextCursor).toBeTruthy()
  })

  it('advances the cursor instead of returning the same page forever', async () => {
    const seen = new Set<string>()
    let cursor: string | undefined
    for (let page = 0; page < 10; page++) {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/resources:query',
        headers: asRD,
        payload: { type: 'Task', page: { size: 2, ...(cursor === undefined ? {} : { cursor }) } },
      })
      const body = res.json()
      for (const item of body.items) seen.add(item.id)
      cursor = body.nextCursor ?? undefined
      if (cursor === undefined) break
    }
    // beforeEach 建了 5 条，翻完必须正好是 5 条不重复的
    expect(seen.size).toBe(5)
    expect(cursor).toBeUndefined()
  })
})

describe('authorization is on the write path, not beside it (FR-ARCH-002)', () => {
  it('rejects a create the caller lacks capability for', async () => {
    // RD 没有 Requirement.Create
    const res = await createRequirement(asRD)
    expect(res.statusCode).toBe(403)
    expect(res.json().message).toMatch(/lacks capability/)
  })

  it('rejects an unauthenticated request', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/resources', payload: { type: 'Task' } })
    expect(res.statusCode).toBe(401)
  })

  it('records both allowed and denied attempts in the audit log (FR-IAM-013)', async () => {
    await createRequirement(asPM) // Allow
    await createRequirement(asRD) // Deny

    const rows = await queryAsTenant<{ subject: string; action: string; decision: string }>(
      pool,
      TENANT,
      'SELECT subject, action, decision FROM audit_log ORDER BY seq',
    )
    expect(rows).toEqual([
      { subject: 'user://alice', action: 'Requirement.Create', decision: 'Allow' },
      { subject: 'user://bob', action: 'Requirement.Create', decision: 'Deny' },
    ])
  })

  it('does not reveal that a resource exists in another tenant', async () => {
    const id = (await createRequirement()).json().id
    const res = await app.inject({
      method: 'GET',
      url: `/v1/resources/${id}`,
      headers: { ...asPM, 'x-tenant': 't_other' },
    })
    // 404 而不是 403：403 会泄漏"这个 id 在别处存在"
    expect(res.statusCode).toBe(404)
  })
})
