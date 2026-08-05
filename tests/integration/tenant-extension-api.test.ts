import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type pg from 'pg'
import type { FastifyInstance } from 'fastify'
import { assertNotSuperuser, setupTestDb, truncateAll } from '../helpers/db.ts'
import { buildServer } from '../../src/api/server.ts'
import { buildDefaultRegistry } from '../../src/ontology/defaults.ts'
import { buildDefaultWorkflowRegistry } from '../../src/workflow/defaults.ts'
import { defaultPolicies } from '../../src/identity/default-policies.ts'

/**
 * 租户级本体扩展接进产品之后（FR-ONT-009）。
 *
 * 验收标准：**扩展字段仅本租户可见，命名空间隔离。**
 *
 * 校验规则本身在 tests/tenant-extension.test.ts 里测过（纯函数）。
 * 这里测的是"可见"和"隔离"这两个词落到接口上是什么：
 * 一个租户加的字段能不能真的写进对象、会不会出现在别人的表单里、
 * 会不会和别人重名。
 */

const A = 't_alpha'
const B = 't_beta'
const asA = { 'x-principal': 'user://alice', 'x-tenant': A, 'x-roles': 'Admin', 'x-capabilities': '' }
const asB = { 'x-principal': 'user://bob', 'x-tenant': B, 'x-roles': 'Admin', 'x-capabilities': '' }

let pool: pg.Pool
let app: FastifyInstance

beforeAll(async () => {
  pool = await setupTestDb()
  await assertNotSuperuser(pool)
  app = buildServer({
    pool,
    registry: buildDefaultRegistry(),
    workflows: buildDefaultWorkflowRegistry(),
    policies: [...defaultPolicies(A), ...defaultPolicies(B)],
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

async function extend(headers: typeof asA, entityType: string, attributes: unknown[]) {
  return app.inject({
    method: 'PUT',
    url: `/v1/ontology/extensions/${entityType}`,
    headers,
    payload: { attributes },
  })
}

async function attributesOf(headers: typeof asA, entityType: string): Promise<string[]> {
  const res = await app.inject({ method: 'GET', url: '/v1/ontology/entity-types', headers })
  expect(res.statusCode).toBe(200)
  const def = (res.json().items as { name: string; attributes: { name: string }[] }[]).find(
    (t) => t.name === entityType,
  )
  return (def?.attributes ?? []).map((a) => a.name)
}

describe('tenant ontology extensions (FR-ONT-009)', () => {
  it('an extension shows up in its own tenant and nowhere else', async () => {
    expect((await extend(asA, 'Task', [{ name: `x_${A}_costCentre`, kind: 'string' }])).statusCode).toBe(200)

    expect(await attributesOf(asA, 'Task')).toContain(`x_${A}_costCentre`)
    // **这就是"仅本租户可见"**：另一个租户的表单上没有这个字段
    expect(await attributesOf(asB, 'Task')).not.toContain(`x_${A}_costCentre`)
  })

  it('does not mutate the shared base registry', async () => {
    // registryFor 返回的是一份新注册表。改基底的话，一个租户加的字段
    // 会立刻出现在所有租户的表单上——而那正是这条需求要防的事
    await extend(asA, 'Task', [{ name: `x_${A}_costCentre`, kind: 'string' }])
    const before = await attributesOf(asB, 'Task')

    // A 再加一个，B 看到的仍然没变
    await extend(asA, 'Task', [
      { name: `x_${A}_costCentre`, kind: 'string' },
      { name: `x_${A}_riskLevel`, kind: 'string' },
    ])
    expect(await attributesOf(asB, 'Task')).toEqual(before)
  })

  it('the extended field can actually be written, and an unknown one still cannot', async () => {
    // 只出现在目录里不算数——本体校验是写入前跑的，
    // 扩展没接进那条路径的话，字段"看得见但写不进去"
    await extend(asA, 'Task', [{ name: `x_${A}_costCentre`, kind: 'string' }])

    const ok = await app.inject({
      method: 'POST',
      url: '/v1/resources',
      headers: asA,
      payload: {
        type: 'Task',
        workspace: 'ws',
        attributes: { title: 't', [`x_${A}_costCentre`]: 'CC-1' },
      },
    })
    expect(ok.statusCode).toBe(201)
    expect(ok.json().attributes[`x_${A}_costCentre`]).toBe('CC-1')

    // 没扩过的字段照旧被拒——扩展是加一个口子，不是把闸门拆了
    const bad = await app.inject({
      method: 'POST',
      url: '/v1/resources',
      headers: asA,
      payload: { type: 'Task', workspace: 'ws', attributes: { title: 't', x_alpha_nope: 'x' } },
    })
    expect(bad.statusCode).toBe(422)
  })

  it("another tenant cannot write the field even though it exists somewhere", async () => {
    await extend(asA, 'Task', [{ name: `x_${A}_costCentre`, kind: 'string' }])
    const res = await app.inject({
      method: 'POST',
      url: '/v1/resources',
      headers: asB,
      payload: {
        type: 'Task',
        workspace: 'ws',
        attributes: { title: 't', [`x_${A}_costCentre`]: 'CC-1' },
      },
    })
    expect(res.statusCode).toBe(422)
  })

  it('refuses a field that is not namespaced', async () => {
    // 命名空间是"隔离"的那一半：两个租户各自加一个 owner 字段的话，
    // 平台哪天想加一个同名的平台字段就再也加不了了
    const res = await extend(asA, 'Task', [{ name: 'costCentre', kind: 'string' }])
    expect(res.statusCode).toBe(422)
    expect(res.json().message).toMatch(/x_/)
  })

  it('refuses a required field', async () => {
    // 必填会让这个租户**已有的**数据在下次写入时全部被拒，
    // 而报出来的错是"缺少必填属性"，没人会想到那是一次扩展造成的
    const res = await extend(asA, 'Task', [
      { name: `x_${A}_costCentre`, kind: 'string', required: true },
    ])
    expect(res.statusCode).toBe(422)
  })

  it('refuses an unknown base type instead of storing a definition nobody will read', async () => {
    const res = await extend(asA, 'Wormhole', [{ name: `x_${A}_f`, kind: 'string' }])
    expect(res.statusCode).toBe(422)
  })

  it('validates a second PUT against the base, not against its own previous version', async () => {
    // 拿扩展过的注册表去判的话，第二次 PUT 会把自己上一次加的字段
    // 当成"已存在的属性"而拒绝
    await extend(asA, 'Task', [{ name: `x_${A}_a`, kind: 'string' }])
    const again = await extend(asA, 'Task', [
      { name: `x_${A}_a`, kind: 'string' },
      { name: `x_${A}_b`, kind: 'string' },
    ])
    expect(again.statusCode).toBe(200)
    expect(await attributesOf(asA, 'Task')).toEqual(
      expect.arrayContaining([`x_${A}_a`, `x_${A}_b`]),
    )
  })

  it('removing an extension takes the field out of the form but leaves the data alone', async () => {
    await extend(asA, 'Task', [{ name: `x_${A}_costCentre`, kind: 'string' }])
    const created = await app.inject({
      method: 'POST',
      url: '/v1/resources',
      headers: asA,
      payload: {
        type: 'Task',
        workspace: 'ws',
        attributes: { title: 't', [`x_${A}_costCentre`]: 'CC-1' },
      },
    })
    const id = created.json().id as string

    const del = await app.inject({
      method: 'DELETE',
      url: '/v1/ontology/extensions/Task',
      headers: asA,
    })
    expect(del.statusCode).toBe(204)
    expect(await attributesOf(asA, 'Task')).not.toContain(`x_${A}_costCentre`)

    // 撤一份定义不该顺手改掉一批业务数据
    const still = await app.inject({ method: 'GET', url: `/v1/resources/${id}`, headers: asA })
    expect(still.json().attributes[`x_${A}_costCentre`]).toBe('CC-1')
  })

  it('deleting an extension that is not there is a 404', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/v1/ontology/extensions/Task',
      headers: asA,
    })
    expect(res.statusCode).toBe(404)
  })

  it('needs write permission to extend, read permission to look', async () => {
    const asGuest = { ...asA, 'x-principal': 'user://carol', 'x-roles': 'Guest' }
    expect((await extend(asGuest, 'Task', [{ name: `x_${A}_f`, kind: 'string' }])).statusCode).toBe(403)

    const list = await app.inject({ method: 'GET', url: '/v1/ontology/extensions', headers: asGuest })
    expect(list.statusCode).toBe(200)
  })
})
