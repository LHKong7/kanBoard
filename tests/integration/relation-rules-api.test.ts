import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type pg from 'pg'
import type { FastifyInstance } from 'fastify'
import { assertNotSuperuser, queryAsTenant, setupTestDb, truncateAll } from '../helpers/db.ts'
import { buildServer } from '../../src/api/server.ts'
import { buildDefaultRegistry } from '../../src/ontology/defaults.ts'
import { buildDefaultWorkflowRegistry } from '../../src/workflow/defaults.ts'
import { defaultPolicies } from '../../src/identity/default-policies.ts'

/**
 * 自动关系建立规则接进产品之后（FR-ONT-008）。
 *
 * 验收标准：**规则可增删改，变更即时生效。**
 *
 * 判定本身（`edgesFor`）在 tests/relation-rules.test.ts 里测过。
 * 这里测的是那三个动词和"即时"：写一条规则，下一次写入就该按它走，
 * 中间没有重启、没有缓存过期、没有任何要等的东西。
 */

const TENANT = 't_rules'
const asAdmin = { 'x-principal': 'user://alice', 'x-tenant': TENANT, 'x-roles': 'Admin', 'x-capabilities': '' }
const asMember = { 'x-principal': 'user://bob', 'x-tenant': TENANT, 'x-roles': 'RD', 'x-capabilities': '' }

let pool: pg.Pool
let app: FastifyInstance

beforeAll(async () => {
  pool = await setupTestDb()
  await assertNotSuperuser(pool)
  app = buildServer({
    pool,
    registry: buildDefaultRegistry(),
    workflows: buildDefaultWorkflowRegistry(),
    policies: [
      ...defaultPolicies(TENANT),
      // 只影响 user://dave：他改 Task 需要人工确认。
      // 用来验证"规则建边时撞上一个需要人点头的判定"会怎么样
      {
        id: 'pol-dave-ask',
        effect: 'Ask' as const,
        subject: 'user://dave',
        action: 'Task.Update' as const,
        scope: { kind: 'tenant' as const, tenant: TENANT },
        description: 'dave 改 Task 需要人工确认',
      },
    ],
  })
  await app.ready()
})

afterAll(async () => {
  await app.close()
  await pool.end()
})

beforeEach(async () => {
  // truncateAll 是查出表名来清的，relation_rules 自动包含在内
  await truncateAll(pool)
})

async function create(type: string, attributes: Record<string, unknown>): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/resources',
    headers: asAdmin,
    payload: { type, workspace: 'ws_rules', attributes },
  })
  expect(res.statusCode).toBe(201)
  return res.json().id as string
}

async function putRule(id: string, rule: Record<string, unknown>, headers = asAdmin) {
  return app.inject({
    method: 'PUT',
    url: `/v1/ontology/relation-rules/${id}`,
    headers,
    payload: rule,
  })
}

/** "任务描述里提到哪个 Story，就把它挂上去" */
const BLOCKS_BY_ID = {
  relationType: 'blockedBy',
  subjectType: 'Task',
  locator: { kind: 'idInAttribute', attribute: 'description' },
  confidence: 0.6,
}

async function relationsOf(id: string): Promise<
  { id: string; type: string; toId: string; createdBy: string; confidence: number | null; confirmed: boolean | null }[]
> {
  const res = await app.inject({
    method: 'GET',
    url: `/v1/resources/${id}/relations?direction=out`,
    headers: asAdmin,
  })
  expect(res.statusCode).toBe(200)
  return res.json().items
}

describe('relation rules (FR-ONT-008)', () => {
  it('takes effect on the very next write, with no restart in between', async () => {
    // **这就是"即时生效"**：PUT 返回之后的下一次写入就按新规则走
    const blocker = await create('Task', { title: '前置任务' })
    const before = await create('Task', { title: 'a', description: `依赖 ${blocker}` })
    expect(await relationsOf(before)).toHaveLength(0)

    expect((await putRule('task-blocked-by-id', BLOCKS_BY_ID)).statusCode).toBe(200)

    const after = await create('Task', { title: 'b', description: `依赖 ${blocker}` })
    const edges = await relationsOf(after)
    expect(edges).toHaveLength(1)
    expect(edges[0]).toMatchObject({ type: 'blockedBy', toId: blocker })
  })

  it('builds a suggestion, not a fact', async () => {
    // 图上的边会被守卫读（Release 只装 Done 的 Task、Story 要有验收标准）。
    // 规则建的边直接当成已确认的话，一条随手写的规则就能让一批对象的
    // 状态机行为整个变掉
    const blocker = await create('Task', { title: '前置' })
    await putRule('task-blocked-by-id', BLOCKS_BY_ID)
    const task = await create('Task', { title: 't', description: `见 ${blocker}` })

    const edge = (await relationsOf(task))[0]
    expect(edge?.createdBy).toBe('rule:task-blocked-by-id')
    // 待确认，且带着置信度——两者缺一，这条边就和人工建的边分不开了
    expect(edge?.confirmed).toBeNull()
    expect(edge?.confidence).toBe(0.6)
  })

  it('a rule-built edge can be confirmed or rejected like any other suggestion', async () => {
    const blocker = await create('Task', { title: '前置' })
    await putRule('task-blocked-by-id', BLOCKS_BY_ID)
    const task = await create('Task', { title: 't', description: `见 ${blocker}` })
    const edge = (await relationsOf(task))[0]

    const res = await app.inject({
      method: 'POST',
      url: `/v1/relations/${edge?.id}/confirmation`,
      headers: asAdmin,
      payload: { confirmed: true },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().confirmed).toBe(true)
  })

  it('re-runs on update, because the text it reads is what just changed', async () => {
    // 只在创建时跑的话，"把工单号补进描述里"——最常见的那个动作——
    // 不会有任何反应
    const blocker = await create('Task', { title: '前置' })
    await putRule('task-blocked-by-id', BLOCKS_BY_ID)
    const task = await create('Task', { title: 't' })
    expect(await relationsOf(task)).toHaveLength(0)

    const current = await app.inject({ method: 'GET', url: `/v1/resources/${task}`, headers: asAdmin })
    const patched = await app.inject({
      method: 'PATCH',
      url: `/v1/resources/${task}`,
      headers: asAdmin,
      payload: {
        expectedVersion: current.json().version,
        attributes: { title: 't', description: `补上：${blocker}` },
      },
    })
    expect(patched.statusCode).toBe(200)
    expect(await relationsOf(task)).toHaveLength(1)
  })

  it('a disabled rule builds nothing, and enabling it again works', async () => {
    const blocker = await create('Task', { title: '前置' })
    await putRule('task-blocked-by-id', { ...BLOCKS_BY_ID, enabled: false })
    const off = await create('Task', { title: 't1', description: `见 ${blocker}` })
    expect(await relationsOf(off)).toHaveLength(0)

    // 改一条规则也是即时的
    await putRule('task-blocked-by-id', { ...BLOCKS_BY_ID, enabled: true })
    const on = await create('Task', { title: 't2', description: `见 ${blocker}` })
    expect(await relationsOf(on)).toHaveLength(1)
  })

  it('a deleted rule stops building, immediately', async () => {
    const blocker = await create('Task', { title: '前置' })
    await putRule('task-blocked-by-id', BLOCKS_BY_ID)
    const before = await create('Task', { title: 't1', description: `见 ${blocker}` })
    expect(await relationsOf(before)).toHaveLength(1)

    const del = await app.inject({
      method: 'DELETE',
      url: '/v1/ontology/relation-rules/task-blocked-by-id',
      headers: asAdmin,
    })
    expect(del.statusCode).toBe(204)

    const after = await create('Task', { title: 't2', description: `见 ${blocker}` })
    expect(await relationsOf(after)).toHaveLength(0)
  })

  it('deleting a rule that is not there is a 404, not a cheerful 204', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/v1/ontology/relation-rules/never-existed',
      headers: asAdmin,
    })
    // 回 204 的话，"我删掉了那条规则"和"我删的是个拼错的名字"没有区别
    expect(res.statusCode).toBe(404)
  })

  it('refuses a rule that violates the ontology, at write time', async () => {
    // 触发时才校验的话，一条写错的规则会安静地躺着，直到某天某个对象
    // 恰好命中它，然后在一条和规则毫无关系的调用栈里报错
    const bad = await putRule('wrong-domain', {
      ...BLOCKS_BY_ID,
      // implementedBy 的定义域是 Requirement，不是 Task
      relationType: 'implementedBy',
    })
    expect(bad.statusCode).toBe(422)
    expect(bad.json().message).toMatch(/domain/)

    const unknownAttr = await putRule('no-such-attribute', {
      ...BLOCKS_BY_ID,
      locator: { kind: 'idInAttribute', attribute: 'nowhere' },
    })
    expect(unknownAttr.statusCode).toBe(422)
  })

  it('refuses confidence of 1 — a rule-inferred edge is never certain', async () => {
    const res = await putRule('too-sure', { ...BLOCKS_BY_ID, confidence: 1 })
    expect(res.statusCode).toBe(422)
  })

  it('skips an edge it cannot build instead of failing the write', async () => {
    // 用户只是改了个标题，不该因为某条规则指向一个不存在的 id 而失败
    await putRule('task-blocked-by-id', BLOCKS_BY_ID)
    const res = await app.inject({
      method: 'POST',
      url: '/v1/resources',
      headers: asAdmin,
      payload: {
        type: 'Task',
        workspace: 'ws_rules',
        attributes: { title: 't', description: '见 task_01JZZZZZZZZZZZZZZZZZZZZZZZ' },
      },
    })
    expect(res.statusCode).toBe(201)
    expect(await relationsOf(res.json().id)).toHaveLength(0)
  })

  it('says out loud when a rule could not build its edge', async () => {
    // **安静地跳过等于这条规则根本不存在**，而配规则的人会以为它在生效
    await putRule('task-blocked-by-id', BLOCKS_BY_ID)
    await create('Task', { title: 't', description: '见 task_01JZZZZZZZZZZZZZZZZZZZZZZZ' })

    const events = await queryAsTenant<{ type: string; payload: Record<string, unknown> }>(
      pool,
      TENANT,
      `SELECT event_type AS type, payload FROM outbox_events WHERE event_type = 'RelationRuleSkipped'`,
    )
    expect(events).toHaveLength(1)
    expect(events[0]?.payload).toMatchObject({ ruleId: 'task-blocked-by-id' })
  })

  it('does not swallow a decision that needs a human', async () => {
    // 咽下的那一档刻意只有两种：目标不存在、领域规则不允许。
    // **其它一切都要往上抛**——把它们也咽掉的话，一次真正的故障
    // （数据库挂了、一个需要人点头的判定）会表现为"规则今天没建边"，
    // 而那是查不出来的
    const blocker = await create('Task', { title: '前置' })
    await putRule('task-blocked-by-id', BLOCKS_BY_ID)

    const res = await app.inject({
      method: 'POST',
      url: '/v1/resources',
      headers: { ...asAdmin, 'x-principal': 'user://dave' },
      payload: {
        type: 'Task',
        workspace: 'ws_rules',
        attributes: { title: 't', description: `见 ${blocker}` },
      },
    })
    // 428：这条边要有人点头才能建。**不是 201 加一条边都没有**
    expect(res.statusCode).toBe(428)
    expect(res.json().error).toBe('approval_required')
  })

  it('needs write permission on resources to change a rule', async () => {
    // 规则决定图上会自动出现什么边，而图上的边会被守卫读——
    // 改规则的权限不该比改对象低
    const res = await putRule('task-blocked-by-id', BLOCKS_BY_ID, asMember)
    expect(res.statusCode).toBe(403)

    // 读是另一道更低的闸：看不到规则的话，一条边上写着 `rule:xxx`
    // 而没人查得到 xxx 是什么。Guest 有 `*.Read`，RD 没有——
    // `Resource.Read` 是**不限类型**的读，它比 `Task.Read` 宽
    const list = await app.inject({
      method: 'GET',
      url: '/v1/ontology/relation-rules',
      headers: { ...asAdmin, 'x-principal': 'user://carol', 'x-roles': 'Guest' },
    })
    expect(list.statusCode).toBe(200)

    // 而 RD 连读都不行，因为它的能力集里只有具体类型的读
    const denied = await app.inject({
      method: 'GET',
      url: '/v1/ontology/relation-rules',
      headers: asMember,
    })
    expect(denied.statusCode).toBe(403)
  })

  it('does not leak rules across tenants', async () => {
    await putRule('task-blocked-by-id', BLOCKS_BY_ID)
    const other = await app.inject({
      method: 'GET',
      url: '/v1/ontology/relation-rules',
      headers: { ...asAdmin, 'x-tenant': 't_other' },
    })
    // 别的租户连读都不该被默认策略放行（策略的 scope 是本租户）
    expect(other.statusCode).toBe(403)
  })
})
