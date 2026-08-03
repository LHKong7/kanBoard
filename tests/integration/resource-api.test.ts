import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type pg from 'pg'
import type { FastifyInstance } from 'fastify'
import { assertNotSuperuser, queryAsTenant, setupTestDb, truncateAll } from '../helpers/db.ts'
import { buildServer } from '../../src/api/server.ts'
import { buildDefaultRegistry } from '../../src/ontology/defaults.ts'
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
    expect(res.json().ontologyVersion).toBe('1.0.0')
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
      payload: { expectedVersion: 1, status: 'Review' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().version).toBe(2)
    expect(res.json().status).toBe('Review')
  })

  it('rejects a stale write with 409 and reports the actual version', async () => {
    const id = (await createRequirement()).json().id
    await app.inject({
      method: 'PATCH',
      url: `/v1/resources/${id}`,
      headers: asPM,
      payload: { expectedVersion: 1, status: 'Review' },
    })
    const stale = await app.inject({
      method: 'PATCH',
      url: `/v1/resources/${id}`,
      headers: asPM,
      payload: { expectedVersion: 1, status: 'Approved' },
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
      payload: { status: 'Review' },
    })
    expect(res.statusCode).toBe(200)
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
      method: 'PATCH',
      url: `/v1/resources/${id}`,
      headers: asPM,
      payload: { expectedVersion: 1, status: 'Review' },
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
