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
import {
  createActionItems,
  draftWithProvenance,
  splitIntoStories,
} from '../../src/domain/ai/authoring.ts'
import { UNVERIFIED_MARK } from '../../src/domain/ai/capabilities.ts'
import type { Caller, ResourceService } from '../../src/domain/resource/service.ts'

/**
 * AI 产出落成对象的三条路径（FR-AI-002 / 007 / 010）。
 *
 * 三条需求的验收标准都是**机制**，不是模型输出的质量：
 * 覆盖率与未覆盖项、无出处内容的标注、行动项一键创建并关联负责人。
 * 所以它们和 FR-AI-001 同类，验证方式也一样——被验的是机制，
 * 生成的内容好不好是另一个问题，而且是这一层管不了的问题。
 *
 * 跑在真库上，走普通的 `service.create`：本体校验、权限、审计一个不少。
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

async function count(type: string): Promise<number> {
  const res = await app.inject({ method: 'GET', url: `/v1/resources?type=${type}`, headers: asAdmin })
  return (res.json().items as unknown[]).length
}

// ── FR-AI-002 ────────────────────────────────────────────────
describe('splitting a requirement into stories (FR-AI-002)', () => {
  const ACCEPTANCES = [
    { id: 'acc_1', given: '有账单', when: '点击导出', then: '得到一份 PDF 文件' },
    { id: 'acc_2', given: '有账单', when: '点击导出', then: '金额与账单一致' },
    { id: 'acc_3', given: '导出失败', when: '重试', then: '显示明确的失败原因' },
  ]

  async function requirement(): Promise<string> {
    return inTx(async (s) => {
      const r = await s.create(caller, {
        type: 'Requirement',
        workspace: WS,
        attributes: { title: '账单导出', level: 'Feature', statement: '用户可以导出账单' },
      })
      return r.id
    })
  }

  it('creates the stories and links them back to the requirement', async () => {
    const requirementId = await requirement()
    const result = await inTx((s) =>
      splitIntoStories(s, caller, {
        requirementId,
        acceptances: ACCEPTANCES,
        candidates: [
          { title: '导出账单为 PDF 文件' },
          { title: '校验导出金额与账单一致' },
          { title: '导出失败时显示失败原因' },
        ],
        workspace: WS,
      }),
    )

    expect(result.coverage.ok).toBe(true)
    expect(result.storyIds).toHaveLength(3)
    expect(await count('Story')).toBe(3)

    // 挂回去了——"这个需求拆成了什么"是评审时问的第一个问题
    const linked = await app.inject({
      method: 'GET',
      url: `/v1/resources/${requirementId}/relations?direction=in`,
      headers: asAdmin,
    })
    expect((linked.json().items as { type: string }[]).filter((r) => r.type === 'implements')).toHaveLength(3)
  })

  it('creates nothing when coverage falls short, and names what was missed', async () => {
    // 建一半再说"覆盖率只有 60%"，等于把这堆残留物留给了使用者
    const requirementId = await requirement()
    const result = await inTx((s) =>
      splitIntoStories(s, caller, {
        requirementId,
        acceptances: ACCEPTANCES,
        candidates: [{ title: '导出账单为 PDF 文件' }, { title: '校验金额与账单一致' }],
        workspace: WS,
      }),
    )

    expect(result.coverage.ok).toBe(false)
    expect(result.storyIds).toEqual([])
    expect(await count('Story')).toBe(0)
    // 验收标准原文：未覆盖项显式列出
    expect(result.uncovered).toHaveLength(1)
    expect(result.uncovered[0]).toContain('acc_3')
  })

  it('holds the bar at 95%, not "most of them"', async () => {
    const requirementId = await requirement()
    const result = await inTx((s) =>
      splitIntoStories(s, caller, {
        requirementId,
        acceptances: ACCEPTANCES,
        candidates: [{ title: '导出账单为 PDF 文件' }, { title: '校验金额与账单一致' }],
        workspace: WS,
      }),
    )
    expect(result.coverage.rate).toBeLessThan(0.95)
  })

  it('marks what it produced as agent-generated', async () => {
    const requirementId = await requirement()
    await inTx((s) =>
      splitIntoStories(s, caller, {
        requirementId,
        acceptances: [ACCEPTANCES[0]!],
        candidates: [{ title: '导出账单为 PDF 文件' }],
        workspace: WS,
      }),
    )
    const stories = await app.inject({ method: 'GET', url: '/v1/resources?type=Story', headers: asAdmin })
    expect((stories.json().items as { labels: string[] }[])[0]?.labels).toContain('agent-generated')
  })
})

// ── FR-AI-007 ────────────────────────────────────────────────
describe('drafting a document with provenance (FR-AI-007)', () => {
  it('marks the unsourced statements and stores the marked text', async () => {
    const task = await inTx((s) =>
      s.create(caller, { type: 'Task', workspace: WS, attributes: { title: '导出实现' } }),
    )
    const result = await inTx((s) =>
      draftWithProvenance(s, caller, {
        title: '账单导出 PRD',
        claims: [
          { text: '导出功能已上线', sourceIds: [task.id] },
          { text: '用户希望支持批量导出', sourceIds: [] },
        ],
        workspace: WS,
      }),
    )

    expect(result.unverified).toBe(1)
    expect(result.body).toContain(`${UNVERIFIED_MARK}用户希望支持批量导出`)
    // 有出处的不加标记，否则标记就没有信息量了
    expect(result.body.startsWith(UNVERIFIED_MARK)).toBe(false)

    const stored = await app.inject({
      method: 'GET',
      url: `/v1/resources/${result.knowledgeId}`,
      headers: asAdmin,
    })
    expect(stored.json().attributes.body).toContain(UNVERIFIED_MARK)
  })

  it('keeps the unsourced sentence rather than deleting it', async () => {
    // 删掉会让文档读起来完整而实际上缺了内容
    const result = await inTx((s) =>
      draftWithProvenance(s, caller, {
        title: 'PRD',
        claims: [{ text: '用户希望支持批量导出', sourceIds: [] }],
        workspace: WS,
      }),
    )
    expect(result.body).toContain('用户希望支持批量导出')
  })

  it('builds the provenance edges the Knowledge invariant will ask for', async () => {
    // Knowledge 想进 Published 本来就要求 derivedFrom（FR-DOM-008）。
    // 在这里建好，是让这份文档从一开始就满足系统自己的不变量
    const task = await inTx((s) =>
      s.create(caller, { type: 'Task', workspace: WS, attributes: { title: '导出实现' } }),
    )
    const result = await inTx((s) =>
      draftWithProvenance(s, caller, {
        title: 'PRD',
        claims: [{ text: '导出功能已上线', sourceIds: [task.id] }],
        workspace: WS,
      }),
    )

    const transitions = await app.inject({
      method: 'GET',
      url: `/v1/resources/${result.knowledgeId}/transitions`,
      headers: asAdmin,
    })
    const published = (transitions.json().items as { to: string; ready: boolean }[]).find(
      (t) => t.to === 'Published',
    )
    expect(published?.ready).toBe(true)
  })

  it('a fully sourced draft carries no marks at all', async () => {
    const task = await inTx((s) =>
      s.create(caller, { type: 'Task', workspace: WS, attributes: { title: 't' } }),
    )
    const result = await inTx((s) =>
      draftWithProvenance(s, caller, {
        title: 'PRD',
        claims: [{ text: '导出功能已上线', sourceIds: [task.id] }],
        workspace: WS,
      }),
    )
    expect(result.unverified).toBe(0)
    expect(result.body).not.toContain(UNVERIFIED_MARK)
  })
})

// ── FR-AI-010 ────────────────────────────────────────────────
describe('turning meeting action items into tasks (FR-AI-010)', () => {
  it('creates a task per action item, with its owner attached', async () => {
    const result = await inTx((s) =>
      createActionItems(s, caller, {
        items: [
          { text: '补一份回归用例', assignee: 'user://bob' },
          { text: '联系供应商确认交期', assignee: 'user://carol' },
        ],
        workspace: WS,
        meetingRef: '2026-08-04 周会',
      }),
    )

    expect(result.taskIds).toHaveLength(2)
    const tasks = await app.inject({ method: 'GET', url: '/v1/resources?type=Task', headers: asAdmin })
    const items = tasks.json().items as { attributes: Record<string, unknown>; labels: string[] }[]
    expect(items.map((t) => t.attributes['assignee']).sort()).toEqual(['user://bob', 'user://carol'])
    expect(items[0]?.labels).toContain('from-meeting')
  })

  it('refuses "we should do X" with nobody attached', async () => {
    // 那不是行动项，是一句感想。允许它落库的话，
    // 任务列表会迅速长满没人负责的条目
    const result = await inTx((s) =>
      createActionItems(s, caller, {
        items: [
          { text: '补一份回归用例', assignee: 'user://bob' },
          { text: '我们应该多写点测试', assignee: null },
        ],
        workspace: WS,
      }),
    )
    expect(result.taskIds).toHaveLength(1)
    expect(await count('Task')).toBe(1)
  })

  it('hands the rejected ones back instead of dropping them', async () => {
    // 那句话在会上是有人说过的，使用者可能只是想补一个负责人。
    // 悄悄扔掉的话，他会以为系统没听见
    const result = await inTx((s) =>
      createActionItems(s, caller, {
        items: [{ text: '我们应该多写点测试', assignee: null }],
        workspace: WS,
      }),
    )
    expect(result.skipped.join()).toContain('多写点测试')
    expect(result.verdict.ok).toBe(false)
  })

  it('treats an empty assignee the same as none', async () => {
    const result = await inTx((s) =>
      createActionItems(s, caller, { items: [{ text: 'x', assignee: '' }], workspace: WS }),
    )
    expect(result.taskIds).toEqual([])
    expect(await count('Task')).toBe(0)
  })
})
