import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
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
import { planCandidates } from '../../src/domain/ai/sprint-planner.ts'
import { applyPlan, undoPlan } from '../../src/domain/ai/sprint-apply.ts'
import type { SprintApplication } from '../../src/domain/ai/sprint-apply.ts'
import type { BacklogTask } from '../../src/domain/ai/sprint-planner.ts'
import type { Caller, ResourceService } from '../../src/domain/resource/service.ts'

/**
 * 一键应用与撤销（FR-AI-004 验收标准的后半句）。
 *
 * **"一键撤销"是这条需求里真正有分量的部分。** 没有它，一份候选方案
 * 就不是"可以试试的方案"，而是一次要开会决定的变更——而要开会决定的东西，
 * 没有人会为了比较两个候选而各试一遍。**撤销的成本决定了尝试的意愿。**
 *
 * 跑在真库上，走普通的 create / relate：本体校验、权限、审计一个不少。
 */

const TENANT = 'default'
const WS = 'ws_platform'
let pool: pg.Pool
let app: FastifyInstance

const asAdmin = {
  'x-principal': 'user://alice',
  'x-tenant': TENANT,
  'x-roles': 'Admin',
  'x-capabilities': '',
}

const caller: Caller = {
  subject: { principal: 'user://alice', tenant: TENANT, roles: ['Admin'], capabilities: [] },
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

async function inTx<T>(fn: (service: ResourceService) => Promise<T>): Promise<T> {
  const db = createDb(pool)
  const audit = new BufferedAuditSink()
  try {
    return await withTenant(db, TENANT, (trx) =>
      fn(
        serviceIn(trx, TENANT, {
          registry: buildDefaultRegistry(),
          workflows: buildDefaultWorkflowRegistry(),
          policies: defaultPolicies(TENANT),
          audit,
          clock: systemClock,
        }),
      ),
    )
  } finally {
    const entries = audit.drain()
    if (entries.length > 0) await withTenant(db, TENANT, (trx) => flushAudit(trx, entries))
  }
}

/** 建三个真任务，返回排程器用的 backlog */
async function seedBacklog(): Promise<BacklogTask[]> {
  return inTx(async (service) => {
    const made: BacklogTask[] = []
    const specs = [
      { title: '打通导出接口', points: 3, priority: 5 },
      { title: '导出 UI', points: 5, priority: 9 },
      { title: '导出文档', points: 2, priority: 1 },
    ]
    for (const [i, spec] of specs.entries()) {
      const task = await service.create(caller, {
        type: 'Task',
        workspace: WS,
        attributes: { title: spec.title, assignee: 'user://bob' },
      })
      made.push({
        id: task.id,
        points: spec.points,
        priority: spec.priority,
        // 第二个依赖第一个
        ...(i === 1 && made[0] !== undefined ? { dependsOn: [made[0].id] } : {}),
      })
    }
    return made
  })
}

const SPRINT = { name: 'Sprint 12', startAt: '2026-08-10T00:00:00Z', endAt: '2026-08-24T00:00:00Z' }

async function plannedTaskIds(sprintId: string): Promise<string[]> {
  const res = await app.inject({
    method: 'GET',
    url: `/v1/resources/${sprintId}/relations?direction=in`,
    headers: asAdmin,
  })
  return (res.json().items as { type: string; fromId: string }[])
    .filter((r) => r.type === 'plannedIn')
    .map((r) => r.fromId)
}

describe('applying a candidate plan (FR-AI-004)', () => {
  it('creates the sprint and links every planned task', async () => {
    const backlog = await seedBacklog()
    const { candidates } = planCandidates(backlog, 10, ['value-first'])
    const plan = candidates[0]!.plan

    const applied = await inTx((s) => applyPlan(s, caller, plan, { workspace: WS, sprint: SPRINT }))

    expect(applied.sprintCreated).toBe(true)
    expect(applied.relationIds).toHaveLength(plan.taskIds.length)
    expect((await plannedTaskIds(applied.sprintId)).sort()).toEqual([...plan.taskIds].sort())
  })

  it('records the capacity the plan was built against', async () => {
    // 方案是一次性的，Sprint 会活很久。"当时按多少容量排的"
    // 是事后复盘要问的第一个问题
    const backlog = await seedBacklog()
    const plan = planCandidates(backlog, 7, ['value-first']).candidates[0]!.plan
    const applied = await inTx((s) => applyPlan(s, caller, plan, { workspace: WS, sprint: SPRINT }))

    const sprint = await app.inject({
      method: 'GET',
      url: `/v1/resources/${applied.sprintId}`,
      headers: asAdmin,
    })
    expect(sprint.json().attributes.capacity).toBe(7)
    expect(sprint.json().labels).toContain('agent-planned')
  })

  it('can plan into a sprint that already exists', async () => {
    const backlog = await seedBacklog()
    const existing = await inTx((s) =>
      s.create(caller, { type: 'Sprint', workspace: WS, attributes: SPRINT }),
    )
    const plan = planCandidates(backlog, 10, ['value-first']).candidates[0]!.plan

    const applied = await inTx((s) =>
      applyPlan(s, caller, plan, { workspace: WS, sprintId: existing.id }),
    )
    expect(applied.sprintCreated).toBe(false)
    expect(applied.sprintId).toBe(existing.id)
  })
})

describe('undoing it (FR-AI-004)', () => {
  const applyOne = async (): Promise<{ applied: SprintApplication; count: number }> => {
    const backlog = await seedBacklog()
    const plan = planCandidates(backlog, 10, ['value-first']).candidates[0]!.plan
    const applied = await inTx((s) => applyPlan(s, caller, plan, { workspace: WS, sprint: SPRINT }))
    return { applied, count: plan.taskIds.length }
  }

  it('removes every link it made', async () => {
    const { applied, count } = await applyOne()
    const result = await inTx((s) => undoPlan(s, caller, applied))

    expect(result.removed).toBe(count)
    expect(await plannedTaskIds(applied.sprintId)).toEqual([])
  })

  it('removes the sprint it created', async () => {
    const { applied } = await applyOne()
    const result = await inTx((s) => undoPlan(s, caller, applied))
    expect(result.sprintDeleted).toBe(true)

    // 软删除：它不再出现在清单里，也不能再被改。
    // **按 id 直接读仍然读得到**——那是这个系统有意的选择
    // （删掉的东西还读得到，否则挂在它上面的审计与事件就没法被读懂），
    // 所以这里断言的是清单，不是 404
    const listed = await app.inject({
      method: 'GET',
      url: '/v1/resources?type=Sprint',
      headers: asAdmin,
    })
    expect(listed.json().items).toHaveLength(0)
  })

  it('leaves a pre-existing sprint alone', async () => {
    // 把别人的迭代删掉不是撤销，是破坏
    const backlog = await seedBacklog()
    const existing = await inTx((s) =>
      s.create(caller, { type: 'Sprint', workspace: WS, attributes: SPRINT }),
    )
    const plan = planCandidates(backlog, 10, ['value-first']).candidates[0]!.plan
    const applied = await inTx((s) =>
      applyPlan(s, caller, plan, { workspace: WS, sprintId: existing.id }),
    )

    const result = await inTx((s) => undoPlan(s, caller, applied))
    expect(result.sprintDeleted).toBe(false)
    const still = await app.inject({
      method: 'GET',
      url: `/v1/resources/${existing.id}`,
      headers: asAdmin,
    })
    expect(still.statusCode).toBe(200)
    // 任务确实撤出来了
    expect(await plannedTaskIds(existing.id)).toEqual([])
  })

  it('does not touch the tasks themselves', async () => {
    // 撤销的是"排期这个决定"，不是任务。删掉任务的话，
    // 一次试用候选方案会毁掉真实的工作项
    const { applied } = await applyOne()
    await inTx((s) => undoPlan(s, caller, applied))

    const tasks = await app.inject({ method: 'GET', url: '/v1/resources?type=Task', headers: asAdmin })
    expect(tasks.json().items).toHaveLength(3)
  })

  it('is idempotent — clicking undo twice is not an error', async () => {
    // 第二下报错会让人以为第一下没成功
    const { applied } = await applyOne()
    await inTx((s) => undoPlan(s, caller, applied))
    const second = await inTx((s) => undoPlan(s, caller, applied))
    expect(second.removed).toBe(0)
  })

  it('undoes by an explicit list, not by "whatever changed recently"', async () => {
    // 按时间回滚会连带撤掉别人在这中间做的改动，而那种错误发生时
    // 没有任何提示——你以为你只撤销了自己那一步。
    //
    // 用一个**已有的** Sprint：新建的那种撤销时会被一起删掉，
    // 那样这条断言测的就是"删了 Sprint 之后关系还在不在"，不是它想测的东西
    const backlog = await seedBacklog()
    const existing = await inTx((s) =>
      s.create(caller, { type: 'Sprint', workspace: WS, attributes: SPRINT }),
    )
    // 只排一个，留一个给"别人"
    const plan = planCandidates(backlog, 3, ['quick-wins']).candidates[0]!.plan
    const applied = await inTx((s) =>
      applyPlan(s, caller, plan, { workspace: WS, sprintId: existing.id }),
    )

    const outsider = backlog.find((t) => !plan.taskIds.includes(t.id))
    expect(outsider).toBeDefined()
    await inTx((s) =>
      s.relate(caller, { type: 'plannedIn', fromId: outsider!.id, toId: existing.id }),
    )

    await inTx((s) => undoPlan(s, caller, applied))
    // 手工那条还在——撤销只撤自己建的
    expect(await plannedTaskIds(existing.id)).toEqual([outsider!.id])
  })
})

describe('a failed apply does not leave half a plan behind', () => {
  it('rolls back the links it already made', async () => {
    // 半应用是最坏的结果：一半任务排进去了，调用方拿到一个异常，
    // 而它手里没有那半截的清单，**撤不掉**
    const backlog = await seedBacklog()
    const plan = planCandidates(backlog, 10, ['value-first']).candidates[0]!.plan
    // 混进一个不存在的任务 id，让中途失败
    const broken = { ...plan, taskIds: [...plan.taskIds, 'task_01JQQQQQQQQQQQQQQQQQQQQQQQ'] }

    // 断言的是 applyPlan **自己主动**撤干净了，而不是靠事务回滚——
    // 生产里 apply 未必和调用方共享一个事务
    let leftovers: { sprints: number; links: number } | null = null
    await expect(
      inTx(async (s) => {
        try {
          return await applyPlan(s, caller, broken, { workspace: WS, sprint: SPRINT })
        } catch (error) {
          const sprints = await s.query(caller, { type: 'Sprint' }, { size: 10 })
          const links = sprints.items[0] === undefined
            ? []
            : await s.relationsOf(caller, sprints.items[0].id, 'in')
          leftovers = { sprints: sprints.items.length, links: links.length }
          throw error
        }
      }),
    ).rejects.toThrow()

    // Sprint 被自己删掉了，一条 plannedIn 都没留下
    expect(leftovers).toEqual({ sprints: 0, links: 0 })
  })
})
