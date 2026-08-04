import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type pg from 'pg'
import type { FastifyInstance } from 'fastify'
import { assertNotSuperuser, queryAsTenant, setupTestDb, truncateAll } from '../helpers/db.ts'
import { buildServer } from '../../src/api/server.ts'
import { buildDefaultRegistry } from '../../src/ontology/defaults.ts'
import { buildDefaultWorkflowRegistry } from '../../src/workflow/defaults.ts'
import { defaultPolicies } from '../../src/identity/default-policies.ts'
import { AgentRunner } from '../../src/infrastructure/agent-runner.ts'
import { ScriptedModelClient } from '../../src/infrastructure/model/scripted.ts'
import type { ScriptedTurn } from '../../src/infrastructure/model/scripted.ts'
import { EPISODIC_MAX_TTL_MS, WorkingMemory } from '../../src/domain/agent/memory.ts'

/**
 * 四级 Memory（FR-AGT-005 / FR-AGT-006，口径见 docs/prd/05-agent-runtime.md §3.3）。
 *
 * | 类型       | 作用域              | 生命周期        | 存储             |
 * | ---------- | ------------------- | --------------- | ---------------- |
 * | Working    | 单次 Run            | Run 结束即释放  | 内存             |
 * | Episodic   | Agent × Project     | 可配置 TTL      | 关系库           |
 * | Semantic   | Project / Workspace | 长期            | **Knowledge BC** |
 * | Procedural | Agent               | 长期            | Agent / Skill    |
 *
 * FR-AGT-006 是一条**否定式**要求：「不存在 Agent 私有的项目级长期知识存储」。
 * 否定式要求没有一个会失败的时刻，只会在某天有人图省事时悄悄破掉，
 * 所以这一组里有几条是直接冲着数据库约束去的。
 */

const TENANT = 't_acme'
const asAdmin = {
  'x-principal': 'user://alice',
  'x-tenant': TENANT,
  'x-roles': 'Admin',
  'x-capabilities': '',
}

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

async function create(type: string, attributes: Record<string, unknown>) {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/resources',
    headers: asAdmin,
    payload: { type, workspace: 'ws_platform', attributes },
  })
  if (res.statusCode !== 201) throw new Error(`create ${type}: ${res.body}`)
  return res.json()
}

const FINISH: ScriptedTurn = {
  thought: '想清楚了',
  action: { kind: 'finish', summary: '这条需求可以拆成两个 Story' },
}

async function seedAndRun(goal = '拆分需求'): Promise<{ agentPrincipal: string }> {
  const agent = await create('Agent', {
    name: 'planner',
    principal: 'agent://planner@1.0.0',
    capabilities: ['Agent.Read', 'Requirement.Read', 'AgentRun.Read'],
    mayPropose: [],
    contextRelations: ['implementedBy'],
  })
  const requirement = await create('Requirement', {
    title: '账单导出',
    level: 'Feature',
    statement: 's',
  })
  await create('AgentRun', {
    goal,
    agent: agent.id,
    subject: requirement.id,
    mode: 'Suggest',
    trigger: 'human',
  })
  await new AgentRunner({
    pool,
    tenants: [TENANT],
    registry: buildDefaultRegistry(),
    workflows: buildDefaultWorkflowRegistry(),
    policies: defaultPolicies(TENANT),
    model: new ScriptedModelClient([FINISH]),
  }).pollOnce()
  return { agentPrincipal: 'agent://planner@1.0.0' }
}

const memoryRows = () =>
  queryAsTenant<{ agent: string; key: string; kind: string; expires_at: Date }>(
    pool,
    TENANT,
    'SELECT agent, key, kind, expires_at FROM agent_memories',
  )

describe('Working Memory is released when the run ends (FR-AGT-005)', () => {
  it('holds nothing after the run, because it was never persisted', async () => {
    await seedAndRun()
    // Working Memory 是个局部变量。"Run 结束即释放"不是一条清理逻辑，
    // 而是**它压根没有存储**——所以这条断言查的是"库里没有它"
    const rows = await memoryRows()
    expect(rows.every((r) => !r.key.startsWith('working:'))).toBe(true)
  })

  it('is a plain in-memory object with no store behind it', () => {
    const working = new WorkingMemory()
    working.put('a', 1)
    expect(working.get('a')).toBe(1)
    expect(working.size).toBe(1)
    // 没有任何方法能把它写出去。加一个的那天，它就不再是 working memory 了
    expect(Object.keys(working)).not.toContain('store')
  })
})

describe('Episodic Memory survives the run and expires (FR-AGT-005)', () => {
  it('records the run conclusion under the agent and project', async () => {
    const { agentPrincipal } = await seedAndRun('拆分账单需求')
    const rows = await memoryRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.agent).toBe(agentPrincipal)
    expect(rows[0]?.key).toContain('拆分账单需求')
  })

  it('always carries an expiry', async () => {
    await seedAndRun()
    const rows = await memoryRows()
    expect(rows[0]?.expires_at).toBeInstanceOf(Date)
    expect(rows[0]!.expires_at.getTime()).toBeGreaterThan(Date.now())
  })

  it('updates rather than accumulates under the same key', async () => {
    // 同一个 key 反复写会把一段经历攒成几十条，召回时全是重复内容
    await seedAndRun('同一个目标')
    await seedAndRun('同一个目标')
    const rows = await memoryRows()
    expect(rows.filter((r) => r.key.includes('同一个目标'))).toHaveLength(1)
  })
})

/**
 * FR-AGT-006：不存在 Agent 私有的项目级长期知识存储。
 *
 * 这三条直接打在数据库约束上。做成"应该"是守不住的——
 * 某天有人赶时间，往这张表里塞一条长期知识，没有任何东西会响。
 */
describe('there is no agent-private long-term store (FR-AGT-006)', () => {
  it('the memory table physically cannot hold semantic memory', async () => {
    await expect(
      queryAsTenant(
        pool,
        TENANT,
        `INSERT INTO agent_memories (id, tenant, agent, project, kind, key, value, created_at, expires_at)
         VALUES ('mem_x', '${TENANT}', 'agent://x@1', NULL, 'semantic', 'k', '{}'::jsonb,
                 now(), now() + interval '1 day')`,
      ),
    ).rejects.toThrow(/agent_memories_episodic_only/)
  })

  it('rejects a TTL long enough to be permanent storage', async () => {
    // 没有上界的 TTL 等于长期存储，上面那条约束就被绕过去了
    await expect(
      queryAsTenant(
        pool,
        TENANT,
        `INSERT INTO agent_memories (id, tenant, agent, project, kind, key, value, created_at, expires_at)
         VALUES ('mem_y', '${TENANT}', 'agent://x@1', NULL, 'episodic', 'k', '{}'::jsonb,
                 now(), now() + interval '100 years')`,
      ),
    ).rejects.toThrow(/agent_memories_bounded_ttl/)
  })

  it('rejects an expiry in the past, which would be a no-op row', async () => {
    await expect(
      queryAsTenant(
        pool,
        TENANT,
        `INSERT INTO agent_memories (id, tenant, agent, project, kind, key, value, created_at, expires_at)
         VALUES ('mem_z', '${TENANT}', 'agent://x@1', NULL, 'episodic', 'k', '{}'::jsonb,
                 now(), now() - interval '1 day')`,
      ),
    ).rejects.toThrow(/agent_memories_forward_ttl/)
  })

  it('keeps the ceiling well under anything that reads as permanent', () => {
    // 90 天是"可配置 TTL"的上界。调到几年就等于把这条需求作废了
    expect(EPISODIC_MAX_TTL_MS).toBeLessThanOrEqual(90 * 24 * 60 * 60 * 1000)
  })

  it('semantic memory becomes an ordinary Knowledge object', async () => {
    // Agent 学到的东西和人写的知识走同一条路径：同一套权限、
    // 同一份审计、同样要有来源。没有私有捷径
    const source = await create('Task', { title: '排查登录超时' })
    const knowledge = await create('Knowledge', {
      title: '登录超时来自连接池耗尽',
      body: '并发超过 200 时连接池排队，表现为登录超时。',
    })
    const rel = await app.inject({
      method: 'POST',
      url: `/v1/resources/${knowledge.id}/relations`,
      headers: asAdmin,
      payload: { type: 'derivedFrom', toId: source.id },
    })
    expect(rel.statusCode).toBe(201)

    // 它就在普通的资源列表里，任何有权限的人都看得到
    const listed = await app.inject({
      method: 'GET',
      url: '/v1/resources?type=Knowledge',
      headers: asAdmin,
    })
    expect(listed.json().items).toHaveLength(1)
    // 而 Agent 的私有存储里一条都没有
    expect(await memoryRows()).toHaveLength(0)
  })
})

describe('Procedural Memory is the declaration itself (FR-AGT-005)', () => {
  it('is not stored a second time', async () => {
    // 另存一份会和声明漂移，而漂移之后没人知道运行时按哪份在跑
    await seedAndRun()
    const rows = await memoryRows()
    expect(rows.every((r) => !r.key.startsWith('procedural:'))).toBe(true)

    // 它读的是 Agent 资源上的属性
    const agents = await app.inject({
      method: 'GET',
      url: '/v1/resources?type=Agent',
      headers: asAdmin,
    })
    const agent = (agents.json().items as { attributes: Record<string, unknown> }[])[0]
    expect(agent?.attributes['contextRelations']).toEqual(['implementedBy'])
  })
})
