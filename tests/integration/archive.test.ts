import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type pg from 'pg'
import type { FastifyInstance } from 'fastify'
import { queryAsTenant, setupTestDb, truncateAll } from '../helpers/db.ts'
import { buildServer } from '../../src/api/server.ts'
import { buildDefaultRegistry } from '../../src/ontology/defaults.ts'
import { buildDefaultWorkflowRegistry } from '../../src/workflow/defaults.ts'
import { defaultPolicies } from '../../src/identity/default-policies.ts'
import { ArchiveSweeper } from '../../src/infrastructure/archive-sweeper.pg.ts'

/**
 * 归档与自动归档 / 自动关闭（project-management-guide §2.6）。
 *
 * 这份用例盯的核心是**归档与状态正交**：一个归档掉的 Done 任务
 * 仍然是 Done，指标照常算它，只是日常列表不显示。
 * 把归档做成一个状态的话，每台状态机都要加一个 Archived，
 * 而完成率的分母会因此凭空变化。
 */

const TENANT = 'default'
let pool: pg.Pool
let app: FastifyInstance

const asAdmin = {
  'x-principal': 'user://alice',
  'x-tenant': TENANT,
  'x-roles': 'Admin',
  'content-type': 'application/json',
}

beforeAll(async () => {
  pool = await setupTestDb()
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

async function create(
  type: string,
  attributes: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): Promise<{ id: string; version: number }> {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/resources',
    headers: asAdmin,
    payload: { type, workspace: 'ws', attributes, ...extra },
  })
  expect(res.statusCode, res.body).toBe(201)
  return res.json()
}

async function listIds(params = ''): Promise<string[]> {
  const res = await app.inject({
    method: 'GET',
    url: `/v1/resources?type=Task${params}`,
    headers: asAdmin,
  })
  expect(res.statusCode, res.body).toBe(200)
  return res.json().items.map((r: { id: string }) => r.id)
}

async function archive(id: string): Promise<number> {
  const res = await app.inject({ method: 'POST', url: `/v1/resources/${id}/archive`, headers: asAdmin })
  return res.statusCode
}

async function transition(id: string, to: string): Promise<number> {
  const res = await app.inject({
    method: 'POST',
    url: `/v1/resources/${id}/transitions`,
    headers: asAdmin,
    payload: { to },
  })
  return res.statusCode
}

describe('归档', () => {
  it('归档之后从默认列表消失，但仍能单独取到', async () => {
    const kept = await create('Task', { title: '留着的' })
    const gone = await create('Task', { title: '归档的' })

    expect(await archive(gone.id)).toBe(200)
    expect(await listIds()).toEqual([kept.id])

    // 对象还在，不是删除
    const one = await app.inject({
      method: 'GET',
      url: `/v1/resources/${gone.id}`,
      headers: asAdmin,
    })
    expect(one.statusCode).toBe(200)
    expect(one.json().archivedAt).not.toBeNull()
  })

  it('archived=archived 看归档区，archived=all 两种都要', async () => {
    const kept = await create('Task', { title: '留着的' })
    const gone = await create('Task', { title: '归档的' })
    await archive(gone.id)

    expect(await listIds('&archived=archived')).toEqual([gone.id])
    expect((await listIds('&archived=all')).sort()).toEqual([kept.id, gone.id].sort())
  })

  it('归档不改状态 —— 一个归档掉的 Done 仍然是 Done', async () => {
    const task = await create('Task', { title: 'a', assignee: 'user://bob' })
    await transition(task.id, 'Doing')
    await transition(task.id, 'Done')
    await archive(task.id)

    const one = await app.inject({
      method: 'GET',
      url: `/v1/resources/${task.id}`,
      headers: asAdmin,
    })
    expect(one.json().status).toBe('Done')
  })

  it('归档不消耗乐观锁的版本 —— 正在编辑的人不会因此撞车', async () => {
    const task = await create('Task', { title: 'a' })
    await archive(task.id)

    // 拿归档**之前**读到的版本号去保存，仍然应当成功：
    // 那个人改的内容和归档毫无冲突
    const saved = await app.inject({
      method: 'PATCH',
      url: `/v1/resources/${task.id}`,
      headers: asAdmin,
      payload: { expectedVersion: task.version, attributes: { title: '改过的' } },
    })
    expect(saved.statusCode, saved.body).toBe(200)
  })

  it('取消归档把它放回列表', async () => {
    const task = await create('Task', { title: 'a' })
    await archive(task.id)
    expect(await listIds()).toEqual([])

    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/resources/${task.id}/archive`,
      headers: asAdmin,
    })
    expect(res.statusCode).toBe(200)
    expect(await listIds()).toEqual([task.id])
  })

  it('重复归档是幂等的，不写第二条历史', async () => {
    const task = await create('Task', { title: 'a' })
    await archive(task.id)
    await archive(task.id)

    const history = await app.inject({
      method: 'GET',
      url: `/v1/resources/${task.id}/history`,
      headers: asAdmin,
    })
    const entries = history.json().items.filter((e: { reason: string | null }) => e.reason === 'archived')
    expect(entries).toHaveLength(1)
  })

  it('卡在 Blocked 的任务照样能归档 —— 归档不受状态守卫约束', async () => {
    const task = await create('Task', { title: 'a', assignee: 'user://bob', blockReason: '等接口' })
    await transition(task.id, 'Doing')
    expect(await transition(task.id, 'Blocked')).toBe(200)
    expect(await archive(task.id)).toBe(200)
  })
})

describe('自动归档 / 自动关闭', () => {
  /**
   * 把一批对象的 updated_at 往前挪，模拟"N 个月没动过"。
   *
   * 必须走 `queryAsTenant`：应用连接受 FORCE RLS 约束，
   * 没有租户上下文时这条 UPDATE 会**影响 0 行且不报错**——
   * 于是巡检什么都找不到，而用例看起来像是巡检逻辑写错了。
   */
  async function ageBy(ids: string[], months: number): Promise<void> {
    const days = Math.round(months * 30) + 1
    const list = ids.map((id) => `'${id}'`).join(', ')
    await queryAsTenant(
      pool,
      TENANT,
      `UPDATE resources SET updated_at = now() - interval '${days} days' WHERE id IN (${list})`,
    )
  }

  function sweeper(
    archiveFn: (tenant: string, id: string) => Promise<void>,
    closeFn: (tenant: string, id: string, to: string) => Promise<void>,
  ): ArchiveSweeper {
    return new ArchiveSweeper({
      pool,
      tenants: [TENANT],
      workflows: buildDefaultWorkflowRegistry(),
      archive: archiveFn,
      close: closeFn,
    })
  }

  it('已完成且陈旧的被归档；未完成的不动', async () => {
    const project = await create('Project', { key: 'PRJ', name: '项目', archiveInMonths: 1 })
    const done = await create('Task', { title: 'done', assignee: 'user://bob' }, { project: project.id })
    const open = await create('Task', { title: 'open' }, { project: project.id })
    await transition(done.id, 'Doing')
    await transition(done.id, 'Done')
    await ageBy([done.id, open.id], 2)

    const archived: string[] = []
    const outcomes = await sweeper(
      async (_t, id) => {
        archived.push(id)
      },
      async () => {},
    ).sweepOnce()

    expect(archived).toEqual([done.id])
    expect(outcomes[0]?.archived).toEqual([done.id])
  })

  it('不配置就什么都不做 —— 默认不开启', async () => {
    const project = await create('Project', { key: 'PRJ', name: '项目' })
    const done = await create('Task', { title: 'done', assignee: 'user://bob' }, { project: project.id })
    await transition(done.id, 'Doing')
    await transition(done.id, 'Done')
    await ageBy([done.id], 12)

    const outcomes = await sweeper(
      async () => {
        throw new Error('不该被调用')
      },
      async () => {
        throw new Error('不该被调用')
      },
    ).sweepOnce()
    expect(outcomes).toEqual([])
  })

  it('自动关闭去的是状态机里 Cancelled 组的终态，不是写死的名字', async () => {
    const project = await create('Project', { key: 'PRJ', name: '项目', closeInMonths: 3 })
    const zombie = await create('Task', { title: '僵尸需求' }, { project: project.id })
    await ageBy([zombie.id], 4)

    const closed: Array<[string, string]> = []
    await sweeper(
      async () => {},
      async (_t, id, to) => {
        closed.push([id, to])
      },
    ).sweepOnce()

    expect(closed).toEqual([[zombie.id, 'Cancelled']])
  })

  it('还没到期的不动', async () => {
    const project = await create('Project', { key: 'PRJ', name: '项目', closeInMonths: 3 })
    const fresh = await create('Task', { title: '上周提的' }, { project: project.id })
    await ageBy([fresh.id], 1)

    const closed: string[] = []
    await sweeper(
      async () => {},
      async (_t, id) => {
        closed.push(id)
      },
    ).sweepOnce()
    expect(closed).toEqual([])
  })

  it('关不动的记进 skipped，不静默吞掉', async () => {
    const project = await create('Project', { key: 'PRJ', name: '项目', closeInMonths: 1 })
    const stuck = await create('Task', { title: '关不掉的' }, { project: project.id })
    await ageBy([stuck.id], 2)

    const outcomes = await sweeper(
      async () => {},
      async () => {
        throw new Error('guard says no')
      },
    ).sweepOnce()

    expect(outcomes[0]?.skipped).toEqual([{ id: stuck.id, reason: 'guard says no' }])
  })

  it('项目本身不会把自己归档掉', async () => {
    const project = await create('Project', { key: 'PRJ', name: '项目', archiveInMonths: 1 })
    await queryAsTenant(
      pool,
      TENANT,
      `UPDATE resources SET updated_at = now() - interval '400 days' WHERE id = '${project.id}'`,
    )

    const archived: string[] = []
    await sweeper(
      async (_t, id) => {
        archived.push(id)
      },
      async () => {},
    ).sweepOnce()
    expect(archived).not.toContain(project.id)
  })
})
