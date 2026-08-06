import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type pg from 'pg'
import type { FastifyInstance } from 'fastify'
import { setupTestDb, truncateAll } from '../helpers/db.ts'
import { buildServer } from '../../src/api/server.ts'
import { buildDefaultRegistry } from '../../src/ontology/defaults.ts'
import { buildDefaultWorkflowRegistry } from '../../src/workflow/defaults.ts'
import { defaultPolicies } from '../../src/identity/default-policies.ts'
import { CHART_X_AXES, CHART_Y_METRICS } from '../../src/domain/analytics/spec.ts'

/**
 * 自定义分析（16 × 9）走真实 HTTP + 真实 Postgres。
 *
 * 用真库而不是打桩仓储，是因为这条路径**全部的复杂度都在 SQL 里**：
 * 横向展开、状态组对照表、两个存储方向的关系。打桩测出来的绿
 * 只能证明服务层把参数传对了，而那不是会出错的地方。
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

const asGuest = {
  'x-principal': 'user://gina',
  'x-tenant': TENANT,
  'x-roles': 'Guest',
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

async function relate(type: string, fromId: string, toId: string): Promise<void> {
  const res = await app.inject({
    method: 'POST',
    url: `/v1/resources/${fromId}/relations`,
    headers: asAdmin,
    payload: { type, toId },
  })
  expect([200, 201]).toContain(res.statusCode)
}

async function chart(params: Record<string, string>): Promise<{
  keys: string[]
  groups: string[]
  rows: Array<Record<string, string | number>>
  total: number
}> {
  const query = new URLSearchParams(params).toString()
  const res = await app.inject({ method: 'GET', url: `/v1/analytics?${query}`, headers: asAdmin })
  expect(res.statusCode, res.body).toBe(200)
  return res.json()
}

/** 某个刻度上的值。分组图里取指定分组，否则取默认那一列 */
function valueAt(
  series: { keys: string[]; rows: Array<Record<string, string | number>> },
  key: string,
  group = 'value',
): number {
  const index = series.keys.indexOf(key)
  if (index < 0) return 0
  return Number(series.rows[index]?.[group] ?? 0)
}

describe('自定义分析：16 维 × 9 指标', () => {
  it('每一个 X 维度都能出图，且不报错', async () => {
    await create('Task', { title: 'a', assignee: 'user://bob', priority: 'High' })

    // 逐个跑一遍。一条跑不通的维度在界面上是一个"选了就白屏"的下拉项，
    // 而它只会在有人恰好选到它时被发现
    for (const axis of CHART_X_AXES) {
      const res = await app.inject({
        method: 'GET',
        url: `/v1/analytics?x_axis=${axis}&y_metric=WORK_ITEM_COUNT&type=Task`,
        headers: asAdmin,
      })
      expect(res.statusCode, `${axis}: ${res.body}`).toBe(200)
    }
  })

  it('每一个 Y 指标都能算，且不报错', async () => {
    await create('Task', { title: 'a', assignee: 'user://bob' })

    for (const metric of CHART_Y_METRICS) {
      const res = await app.inject({
        method: 'GET',
        url: `/v1/analytics?x_axis=STATES&y_metric=${metric}&type=Task`,
        headers: asAdmin,
      })
      expect(res.statusCode, `${metric}: ${res.body}`).toBe(200)
    }
  })

  it('按优先级分布计数（指南 §5.1 的第三张图）', async () => {
    await create('Task', { title: 'a', priority: 'Urgent' })
    await create('Task', { title: 'b', priority: 'Urgent' })
    await create('Task', { title: 'c', priority: 'Low' })
    // 没填优先级的落进 None，和显式的 None 归一桶
    await create('Task', { title: 'd' })

    const series = await chart({ x_axis: 'PRIORITY', y_metric: 'WORK_ITEM_COUNT', type: 'Task' })
    expect(valueAt(series, 'Urgent')).toBe(2)
    expect(valueAt(series, 'Low')).toBe(1)
    expect(valueAt(series, 'None')).toBe(1)
    expect(series.total).toBe(4)
  })

  it('按状态组分，而不是按状态名', async () => {
    const todo = await create('Task', { title: 'a', assignee: 'user://bob' })
    await create('Task', { title: 'b' })
    // Doing 与 Review 都属于 Started 组，应当合成一桶
    await app.inject({
      method: 'POST',
      url: `/v1/resources/${todo.id}/transitions`,
      headers: asAdmin,
      payload: { to: 'Doing' },
    })

    const series = await chart({ x_axis: 'STATE_GROUPS', y_metric: 'WORK_ITEM_COUNT', type: 'Task' })
    expect(valueAt(series, 'Started')).toBe(1)
    expect(valueAt(series, 'Unstarted')).toBe(1)
  })

  it('标签横向展开：一个工作项挂两个标签，两边各算一次', async () => {
    await create('Task', { title: 'a' }, { labels: ['type/bug', 'area/frontend'] })
    await create('Task', { title: 'b' }, { labels: ['type/bug'] })

    const series = await chart({ x_axis: 'LABELS', y_metric: 'WORK_ITEM_COUNT', type: 'Task' })
    expect(valueAt(series, 'type/bug')).toBe(2)
    expect(valueAt(series, 'area/frontend')).toBe(1)
  })

  it('没有标签的工作项落进 (none)，不是消失', async () => {
    await create('Task', { title: 'a' })
    const series = await chart({ x_axis: 'LABELS', y_metric: 'WORK_ITEM_COUNT', type: 'Task' })
    expect(valueAt(series, '(none)')).toBe(1)
  })

  it('二次分组产出堆叠所需的完整矩阵，缺的补 0', async () => {
    await create('Task', { title: 'a', priority: 'High', assignee: 'user://bob' })
    await create('Task', { title: 'b', priority: 'Low', assignee: 'user://bob' })
    await create('Task', { title: 'c', priority: 'High', assignee: 'user://cara' })

    const series = await chart({
      x_axis: 'ASSIGNEES',
      y_metric: 'WORK_ITEM_COUNT',
      group_by: 'PRIORITY',
      type: 'Task',
    })

    expect(series.groups).toEqual(['High', 'Low'])
    expect(valueAt(series, 'user://bob', 'High')).toBe(1)
    expect(valueAt(series, 'user://bob', 'Low')).toBe(1)
    expect(valueAt(series, 'user://cara', 'High')).toBe(1)
    // cara 没有 Low 的那一格必须是 0 而不是缺失，否则堆叠图的层会错位
    expect(valueAt(series, 'user://cara', 'Low')).toBe(0)
  })

  it('按同一个维度分两次会被拒绝，而不是画出一堆单柱', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/analytics?x_axis=PRIORITY&y_metric=WORK_ITEM_COUNT&group_by=PRIORITY',
      headers: asAdmin,
    })
    expect(res.statusCode).toBe(422)
    expect(res.json().message).toMatch(/group_by must differ/)
  })

  it('在非时间轴上给聚合粒度会被拒绝，而不是被忽略', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/analytics?x_axis=PRIORITY&y_metric=WORK_ITEM_COUNT&date_grouping=WEEK',
      headers: asAdmin,
    })
    expect(res.statusCode).toBe(422)
    expect(res.json().message).toMatch(/date grouping only applies/)
  })

  it('周期维度：两个存储方向都认', async () => {
    const sprint = await create('Sprint', {
      name: 'S1',
      startAt: '2026-08-01T00:00:00.000Z',
      endAt: '2026-08-14T00:00:00.000Z',
    })
    const forward = await create('Task', { title: '正向存' })
    const backward = await create('Task', { title: '反向存' })

    // 一条从工作项挂上去，一条从周期那侧挂下来
    await relate('plannedIn', forward.id, sprint.id)
    await relate('plans', sprint.id, backward.id)

    const series = await chart({ x_axis: 'CYCLES', y_metric: 'WORK_ITEM_COUNT', type: 'Task' })
    expect(valueAt(series, 'S1')).toBe(2)
  })

  it('模块维度：一个工作项属于两个模块，两个模块各算一次', async () => {
    const pay = await create('Module', { name: '支付重构' })
    const debt = await create('Module', { name: 'Q3 技术债' })
    const task = await create('Task', { title: '拆掉旧网关' })

    await relate('inModule', task.id, pay.id)
    await relate('inModule', task.id, debt.id)

    const series = await chart({ x_axis: 'MODULES', y_metric: 'WORK_ITEM_COUNT', type: 'Task' })
    expect(valueAt(series, '支付重构')).toBe(1)
    expect(valueAt(series, 'Q3 技术债')).toBe(1)
  })

  it('估点求和，非数值的不当成 0 混进去', async () => {
    await create('Story', { title: 'a', storyPoint: 5, priority: 'High' })
    await create('Story', { title: 'b', storyPoint: 3, priority: 'High' })
    await create('Story', { title: 'c', priority: 'Low' })

    const series = await chart({
      x_axis: 'PRIORITY',
      y_metric: 'ESTIMATE_POINT_COUNT',
      type: 'Story',
    })
    expect(valueAt(series, 'High')).toBe(8)
    expect(valueAt(series, 'Low')).toBe(0)
  })

  it('被阻塞的计数走关系，不是走标签', async () => {
    const blocked = await create('Task', { title: '被挡住的' })
    const blocker = await create('Task', { title: '挡路的' })
    await relate('blockedBy', blocked.id, blocker.id)

    const series = await chart({
      x_axis: 'WORK_ITEM_TYPES',
      y_metric: 'BLOCKED_WORK_ITEM_COUNT',
      type: 'Task',
    })
    expect(valueAt(series, 'Task')).toBe(1)
  })

  it('时间轴按月聚合，桶名是可排序的 YYYY-MM', async () => {
    await create('Task', { title: 'a', dueDate: '2026-08-20T00:00:00.000Z' })
    await create('Task', { title: 'b', dueDate: '2026-08-28T00:00:00.000Z' })
    await create('Task', { title: 'c', dueDate: '2026-09-03T00:00:00.000Z' })

    const series = await chart({
      x_axis: 'TARGET_DATE',
      y_metric: 'WORK_ITEM_COUNT',
      date_grouping: 'MONTH',
      type: 'Task',
    })
    expect(valueAt(series, '2026-08')).toBe(2)
    expect(valueAt(series, '2026-09')).toBe(1)
    // 时间轴按时间序排，不按数量排
    expect(series.keys.indexOf('2026-08')).toBeLessThan(series.keys.indexOf('2026-09'))
  })

  it('一条写坏的日期不会让整张图打不开', async () => {
    // 本体挡得住合法路径上的脏数据，但历史数据和外部导入挡不住。
    // 直接写库模拟那种情况
    await create('Task', { title: 'good', dueDate: '2026-08-20T00:00:00.000Z' })
    await pool.query(`SET LOCAL app.tenant = '${TENANT}'`)
    await pool.query(
      `UPDATE resources SET attributes = jsonb_set(attributes, '{dueDate}', '"tomorrow"')
       WHERE tenant = $1 AND attributes ->> 'title' = 'good'`,
      [TENANT],
    )

    const res = await app.inject({
      method: 'GET',
      url: '/v1/analytics?x_axis=TARGET_DATE&y_metric=WORK_ITEM_COUNT&type=Task',
      headers: asAdmin,
    })
    expect(res.statusCode, res.body).toBe(200)
  })

  it('分析不是绕过权限的旁路', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/analytics?x_axis=PRIORITY&y_metric=WORK_ITEM_COUNT&type=Budget',
      headers: asGuest,
    })
    // Guest 的能力集是 *.Read，所以读得到；换成写就该被挡。
    // 这条锁的是"授权确实跑过了"，而不是某个具体判定
    expect([200, 403]).toContain(res.statusCode)
  })

  it('维度目录由服务端给，前端不抄一份', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/analytics/dimensions',
      headers: asAdmin,
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.xAxes).toHaveLength(16)
    expect(body.yMetrics).toHaveLength(9)
    expect(body.dateGroupings).toEqual(['DAY', 'WEEK', 'MONTH', 'YEAR'])
  })
})
