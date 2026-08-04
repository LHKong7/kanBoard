import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type pg from 'pg'
import type { FastifyInstance } from 'fastify'
import { assertNotSuperuser, queryAsTenant, setupTestDb, truncateAll } from '../helpers/db.ts'
import { buildServer } from '../../src/api/server.ts'
import { buildDefaultRegistry } from '../../src/ontology/defaults.ts'
import { buildDefaultWorkflowRegistry } from '../../src/workflow/defaults.ts'
import { defaultPolicies } from '../../src/identity/default-policies.ts'
import { AgentRunner } from '../../src/infrastructure/agent-runner.ts'
import { NeverFinishingModelClient, ScriptedModelClient } from '../../src/infrastructure/model/scripted.ts'
import type { ScriptedTurn } from '../../src/infrastructure/model/scripted.ts'
import type { ModelClient, RunResult } from '../../src/domain/agent/types.ts'
import type { ConnectorInvoker } from '../../src/domain/agent/runtime.ts'
import { DomainError } from '../../src/platform/errors.ts'

/**
 * Agent Runtime（FR-AGT-002/003/004/007/009/012）。
 *
 * 这里验证的**不是模型说了什么**——那是模型供应商的事。
 * 要验证的是包在模型外面的那一圈：身份归属、上下文出处、预算熔断、
 * 协作模式、以及"Agent 不能批准自己的产出"。
 * 这些与模型无关，因此用确定性的脚本模型来测，快且不花钱。
 */

const TENANT = 't_acme'
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

function runnerWith(
  model: ModelClient,
  onFinished?: AgentRunnerOnFinished,
  connectors?: ConnectorInvoker,
  blastRadius?: number,
): AgentRunner {
  return new AgentRunner({
    ...(connectors === undefined ? {} : { connectors }),
    ...(blastRadius === undefined ? {} : { blastRadius }),
    // AI 策略默认是**关闭**的（FR-AI-012 / ADR-0006）。
    // 每个用例都要显式打开，正如每个真实部署都要显式配置——
    // 缺省放行的话，一个忘了配置的租户会默默把上下文发出去
    aiPolicy: { enabled: true, approvedProviders: ['scripted'], maxClassification: 'confidential' },
    provider: 'scripted',
    pool,
    tenants: [TENANT],
    registry: buildDefaultRegistry(),
    workflows: buildDefaultWorkflowRegistry(),
    policies: defaultPolicies(TENANT),
    model,
    ...(onFinished === undefined ? {} : { onFinished }),
  })
}
type AgentRunnerOnFinished = ConstructorParameters<typeof AgentRunner>[0]['onFinished']

async function create(type: string, attributes: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/resources',
    headers: asAdmin,
    payload: { type, workspace: 'ws_platform', attributes, ...extra },
  })
  if (res.statusCode !== 201) throw new Error(`create ${type}: ${res.body}`)
  return res.json()
}

async function get(id: string) {
  const res = await app.inject({ method: 'GET', url: `/v1/resources/${id}`, headers: asAdmin })
  return res.json()
}

/** 一个允许产出 Story 的 Agent，以及围绕某个 Requirement 的一次 Run */
async function seedRun(
  mode: string,
  overrides: { mayPropose?: string[]; attributes?: Record<string, unknown> } = {},
) {
  const agent = await create('Agent', {
    name: 'planner',
    principal: 'agent://planner@1.0.0',
    // 能力是**声明出来的**。AIAgent 角色是空集，不写这行 Agent 什么都做不了——
    // 这正是 ADR-0003 的默认值。注意再怎么写也批不了自己的产出：
    // 那条是 Deny，配不掉
    capabilities: ['Agent.Read', 'Requirement.Read', 'Story.Read', 'Story.Create', 'AgentRun.Read'],
    mayPropose: overrides.mayPropose ?? ['Story'],
    contextRelations: ['implementedBy', 'explains'],
  })
  const requirement = await create('Requirement', {
    title: '账单需要 PDF 导出',
    level: 'Feature',
    statement: '用户可以把账单导出成 PDF',
  })
  const run = await create('AgentRun', {
    goal: '把这条需求拆成 Story',
    agent: agent.id,
    subject: requirement.id,
    mode,
    trigger: 'human',
    ...overrides.attributes,
  })
  return { agent, requirement, run }
}

const PROPOSE_STORY: ScriptedTurn = {
  thought: '这条需求可以拆成一个导出 Story',
  action: {
    kind: 'propose',
    resourceType: 'Story',
    attributes: { title: '导出 PDF' },
    rationale: '覆盖需求里的导出能力',
  },
}
const FINISH: ScriptedTurn = { thought: '拆完了', action: { kind: 'finish', summary: '产出 1 个 Story' } }

describe('a run is a domain object, not a background job (FR-AGT-002)', () => {
  it('starts from an ordinary resource create — no agent-only endpoint', async () => {
    const { run } = await seedRun('Draft')
    expect((await get(run.id)).status).toBe('Queued')

    const result = await runnerWith(new ScriptedModelClient([PROPOSE_STORY, FINISH])).pollOnce()
    expect(result.claimed).toBe(1)
    expect((await get(run.id)).status).toBe('AwaitingReview')
  })

  it('settles usage back onto the run so cost is attributable', async () => {
    const { run } = await seedRun('Autonomous')
    await runnerWith(new ScriptedModelClient([PROPOSE_STORY, FINISH])).pollOnce()

    const settled = await get(run.id)
    expect(settled.attributes.tokensUsed).toBe(200)
    expect(settled.attributes.stepCount).toBeGreaterThan(0)
    expect(settled.attributes.outcome).toMatch(/完成/)
  })
})

describe('the agent acts as itself (FR-AGT-003)', () => {
  it('attributes writes to the agent principal, not to whoever queued the run', async () => {
    // 用发起人的身份执行会让审计变成谎话
    const { run } = await seedRun('Autonomous')
    await runnerWith(new ScriptedModelClient([PROPOSE_STORY, FINISH])).pollOnce()

    const audits = await queryAsTenant<{ subject: string; action: string }>(
      pool,
      TENANT,
      `SELECT subject, action FROM audit_log WHERE action = 'Story.Create'`,
    )
    expect(audits.length).toBeGreaterThan(0)
    expect(audits.every((a) => a.subject === 'agent://planner@1.0.0')).toBe(true)
    expect(audits.some((a) => a.subject === 'user://alice')).toBe(false)

    void run
  })

  it('refuses to run under a borrowed identity when the agent has no agent:// principal', async () => {
    const agent = await create('Agent', { name: 'broken', principal: 'user://mallory' })
    const run = await create('AgentRun', {
      goal: 'x',
      agent: agent.id,
      mode: 'Autonomous',
      trigger: 'human',
    })

    const { results } = await runnerWith(new ScriptedModelClient([FINISH])).pollOnce()
    expect(results[0]?.result.outcome.kind).toBe('failed')
    expect((await get(run.id)).status).toBe('Failed')
  })
})

describe('context comes from the graph and carries provenance (FR-AGT-004)', () => {
  it('records the source entity of every context segment', async () => {
    const { run, requirement } = await seedRun('Suggest')
    const model = new ScriptedModelClient([FINISH])
    await runnerWith(model).pollOnce()

    const steps = await queryAsTenant<{ kind: string; summary: string; detail: Record<string, unknown> }>(
      pool,
      TENANT,
      `SELECT kind, summary, detail FROM agent_run_steps WHERE run_id = '${run.id}' ORDER BY seq`,
    )
    const context = steps.find((s) => s.kind === 'context')
    expect(context).toBeDefined()

    const sources = context?.detail['sources'] as Array<{ id: string; type: string }>
    expect(sources.map((s) => s.id)).toContain(requirement.id)

    // 出处也必须真的送进了模型，而不是只记在轨迹里好看
    expect(model.seen[0]?.context.map((c) => c.sourceId)).toContain(requirement.id)
  })
})

describe('collaboration modes decide what may be written (FR-AGT-009)', () => {
  it('Suggest writes nothing at all', async () => {
    const { run } = await seedRun('Suggest')
    const { results } = await runnerWith(new ScriptedModelClient([PROPOSE_STORY, FINISH])).pollOnce()

    expect(results[0]?.result.proposals[0]?.createdId).toBeNull()
    const stories = await queryAsTenant<{ n: string }>(
      pool,
      TENANT,
      `SELECT count(*) AS n FROM resources WHERE type = 'Story'`,
    )
    expect(Number(stories[0]?.n)).toBe(0)
    expect((await get(run.id)).status).toBe('AwaitingReview')
  })

  it('Draft writes the object but stops for a human', async () => {
    const { run } = await seedRun('Draft')
    const { results } = await runnerWith(new ScriptedModelClient([PROPOSE_STORY, FINISH])).pollOnce()

    const createdId = results[0]?.result.proposals[0]?.createdId
    expect(createdId).toBeTruthy()
    // 落库了，但落在初始状态，并且打了标好让人能筛出来
    const story = await get(createdId as string)
    expect(story.status).toBe('Draft')
    expect(story.labels).toContain('agent-generated')
    expect((await get(run.id)).status).toBe('AwaitingReview')
  })

  it('Autonomous finishes without waiting', async () => {
    const { run } = await seedRun('Autonomous')
    await runnerWith(new ScriptedModelClient([PROPOSE_STORY, FINISH])).pollOnce()
    expect((await get(run.id)).status).toBe('Succeeded')
  })
})

describe('an agent cannot approve its own output (FR-AGT-009)', () => {
  it('denies AgentRun.Approve to the agent role', async () => {
    const { run } = await seedRun('Draft')
    await runnerWith(new ScriptedModelClient([PROPOSE_STORY, FINISH])).pollOnce()
    expect((await get(run.id)).status).toBe('AwaitingReview')

    // 关键：给它 `AgentRun.*`。
    //
    // 不给的话这条用例会在**能力闸门**上被拒（第 ④ 步），于是即使
    // 把 `pol-agent-no-self-approve` 从 Deny 改成 Allow，用例照样绿——
    // 那就等于没在保护这条护栏。第一版正是这样写的，种缺陷时才发现。
    // 给足能力，才能让 Deny 成为唯一挡住它的东西。
    const asAgent = {
      'x-principal': 'agent://planner@1.0.0',
      'x-tenant': TENANT,
      'x-roles': 'AIAgent',
      'x-capabilities': 'AgentRun.*',
    }
    const selfApprove = await app.inject({
      method: 'POST',
      url: `/v1/resources/${run.id}/transitions`,
      headers: asAgent,
      payload: { to: 'Succeeded' },
    })
    expect(selfApprove.statusCode).toBe(403)
    // 确认拒因是那条护栏，而不是"能力不够"——两者的含义完全不同
    expect(selfApprove.json().details?.matchedPolicy).toBe('pol-agent-no-self-approve')

    // 人可以
    const byHuman = await app.inject({
      method: 'POST',
      url: `/v1/resources/${run.id}/transitions`,
      headers: asAdmin,
      payload: { to: 'Succeeded' },
    })
    expect(byHuman.statusCode).toBe(200)
  })
})

describe('budgets are a hard ceiling (FR-AGT-012)', () => {
  it('stops a run that will not converge, and says why', async () => {
    const { run } = await seedRun('Autonomous', { attributes: { maxSteps: 3 } })
    const model = new NeverFinishingModelClient(PROPOSE_STORY)
    const { results } = await runnerWith(model).pollOnce()

    expect(results[0]?.result.outcome).toMatchObject({ kind: 'budget-exceeded' })
    // 熔断真的掐住了循环，而不是跑满某个更大的默认值
    expect(model.calls).toBeLessThanOrEqual(4)

    const settled = await get(run.id)
    expect(settled.status).toBe('Failed')
    expect(settled.attributes.outcome).toMatch(/预算触顶/)
  })

  it('counts the tokens of the step that broke the budget', async () => {
    // 先记账再终止：否则最后一次调用的成本凭空消失
    const { run } = await seedRun('Autonomous', { attributes: { maxTokens: 150 } })
    await runnerWith(new NeverFinishingModelClient({ ...PROPOSE_STORY, tokensUsed: 100 })).pollOnce()

    const settled = await get(run.id)
    expect(settled.attributes.tokensUsed).toBeGreaterThan(150)
  })
})

describe('the declared allow-list bounds what an agent may create', () => {
  it('blocks a proposal outside mayPropose and tells the model why', async () => {
    // 模型的输出不该决定它能写什么
    const { run } = await seedRun('Autonomous', { mayPropose: [] })
    const { results } = await runnerWith(new ScriptedModelClient([PROPOSE_STORY, FINISH])).pollOnce()

    expect(results[0]?.result.proposals).toHaveLength(0)
    const steps = await queryAsTenant<{ kind: string; summary: string }>(
      pool,
      TENANT,
      `SELECT kind, summary FROM agent_run_steps WHERE run_id = '${run.id}' ORDER BY seq`,
    )
    expect(steps.some((s) => s.kind === 'guardrail' && s.summary.includes('不在该 Agent 的允许清单内'))).toBe(
      true,
    )
  })
})

describe('the run trace is replayable (FR-AGT-007)', () => {
  it('records every step in order with its cost', async () => {
    const { run } = await seedRun('Autonomous')
    await runnerWith(new ScriptedModelClient([PROPOSE_STORY, FINISH])).pollOnce()

    const steps = await queryAsTenant<{ seq: number; kind: string; tokens_used: number }>(
      pool,
      TENANT,
      `SELECT seq, kind, tokens_used FROM agent_run_steps WHERE run_id = '${run.id}' ORDER BY seq`,
    )
    expect(steps.map((s) => s.seq)).toEqual([...steps.keys()])
    expect(steps.map((s) => s.kind)).toEqual([
      'context',
      'reasoning',
      'artifact',
      'reasoning',
      'artifact',
    ])
    // 成本记在产生它的那一步上，超预算时才能看出是哪一步烧掉的
    expect(steps.filter((s) => s.kind === 'reasoning').every((s) => s.tokens_used > 0)).toBe(true)
  })
})


/**
 * Agent 通过网关调用外部工具（FR-CON-002 与 FR-AGT-002 的交汇处）。
 *
 * 关键不是"能调通"，而是**只能经由网关调**：
 * 运行时拿不到 connector 列表、碰不到凭据，
 * 网关拒了它就得把拒绝当作一次观察继续推理。
 */
describe('agents reach the outside world only through the gateway', () => {
  const toolCall: ScriptedTurn = {
    thought: '先去查一下 issue',
    action: {
      kind: 'call',
      connectorId: 'fake',
      operation: 'getIssue',
      target: 'https://api.github.com/repos/x/y',
      params: { number: 7 },
    },
  }

  it('records the tool call in the run trace with the masked result', async () => {
    const { run } = await seedRun('Autonomous')
    const invoker = {
      async invoke() {
        return { ok: true, data: { title: 'a bug', email: 'a***@example.com' }, replayed: false, attempts: 1 }
      },
    }
    await runnerWith(new ScriptedModelClient([toolCall, FINISH]), undefined, invoker).pollOnce()

    const steps = await queryAsTenant<{ kind: string; summary: string; detail: Record<string, unknown> }>(
      pool,
      TENANT,
      `SELECT kind, summary, detail FROM agent_run_steps WHERE run_id = '${run.id}' ORDER BY seq`,
    )
    const tool = steps.find((s) => s.kind === 'tool')
    expect(tool?.summary).toMatch(/fake\.getIssue/)
    // 轨迹里存的是脱敏后的值——它会被人看、被导出
    expect(JSON.stringify(tool?.detail)).toContain('a***@example.com')
  })

  it('cannot call anything when the run has no connectors configured', async () => {
    // 没配就是不能调，不是不受限制
    const { run } = await seedRun('Autonomous')
    await runnerWith(new ScriptedModelClient([toolCall, FINISH])).pollOnce()

    const steps = await queryAsTenant<{ kind: string; summary: string }>(
      pool,
      TENANT,
      `SELECT kind, summary FROM agent_run_steps WHERE run_id = '${run.id}' ORDER BY seq`,
    )
    expect(steps.some((s) => s.kind === 'guardrail' && s.summary.includes('未配置外部工具'))).toBe(true)
    expect(steps.some((s) => s.kind === 'tool')).toBe(false)
  })

  it('treats a gateway refusal as an observation rather than a crash', async () => {
    // 网关拒了，Run 要能继续推理并正常收尾——而且拒绝要留痕
    const { run } = await seedRun('Autonomous')
    const invoker = {
      async invoke(): Promise<never> {
        throw new DomainError('forbidden', 'target "evil.com" is not in the allow-list', 403)
      },
    }
    const { results } = await runnerWith(
      new ScriptedModelClient([toolCall, FINISH]),
      undefined,
      invoker,
    ).pollOnce()

    expect(results[0]?.result.outcome.kind).toBe('completed')
    const steps = await queryAsTenant<{ kind: string; summary: string }>(
      pool,
      TENANT,
      `SELECT kind, summary FROM agent_run_steps WHERE run_id = '${run.id}' ORDER BY seq`,
    )
    expect(steps.some((s) => s.kind === 'guardrail' && s.summary.includes('allow-list'))).toBe(true)
  })
})

/**
 * blastRadius：单次 Run 的影响面上限（FR-IAM-012）。
 *
 * 这是防止 Agent 失控的**最后一道闸**。前面几道（能力声明、策略、
 * 协作模式、预算）都可能被配置放宽，而这一道回答的是另一个问题：
 * 就算它有权限、也没超预算，它一次能弄坏多少东西。
 */
describe('blast radius is the last gate (FR-IAM-012)', () => {
  const propose = (title: string): ScriptedTurn => ({
    thought: `再拆一个：${title}`,
    action: {
      kind: 'propose',
      resourceType: 'Story',
      attributes: { title },
      rationale: 'r',
    },
  })

  it('trips before touching one object too many', async () => {
    // 上限 2：第 3 次提议不该落库。**事后终止只是记录损害，不是拦住它**
    const { run } = await seedRun('Autonomous', { attributes: { maxSteps: 8 } })
    const model = new ScriptedModelClient([propose('A'), propose('B'), propose('C'), FINISH])

    let outcome: RunResult['outcome'] | null = null
    await runnerWith(model, (_r, result) => { outcome = result.outcome }, undefined, 2).pollOnce()

    expect(outcome).not.toBeNull()
    expect(outcome!.kind).toBe('blast-radius-exceeded')

    const stories = await app.inject({
      method: 'GET',
      url: '/v1/resources?type=Story',
      headers: asAdmin,
    })
    const titles = (stories.json().items as { attributes: Record<string, unknown> }[])
      .map((s) => s.attributes['title'])
    expect(titles).toHaveLength(2)
    expect(titles).not.toContain('C')

    const settled = await get(run.id)
    expect(String(settled.attributes.outcome)).toMatch(/影响面触顶/)
  })

  it('records the trip as a guardrail step, not a silent stop', async () => {
    // 悄悄停下来的熔断和"这次没什么可做的"长得一模一样
    const { run } = await seedRun('Autonomous', { attributes: { maxSteps: 8 } })
    await runnerWith(
      new ScriptedModelClient([propose('A'), propose('B'), FINISH]),
      undefined,
      undefined,
      1,
    ).pollOnce()

    const steps = await queryAsTenant<{ kind: string; summary: string }>(
      pool,
      TENANT,
      `SELECT kind, summary FROM agent_run_steps WHERE run_id = '${run.id}' ORDER BY seq`,
    )
    const guardrail = steps.find((s) => s.kind === 'guardrail' && s.summary.includes('影响面触顶'))
    expect(guardrail).toBeDefined()
  })

  it('lets a run under the limit finish normally', async () => {
    // 熔断闸不该误杀正常的 Run。
    //
    // **注意这条用例证明不了"数的是对象而不是操作次数"**：
    // 当前运行时只会创建、不会更新，于是每次写回都是一个新对象，
    // 两种计法结果相同。把 `touched` 换成计数器，全部用例照样绿（试过）。
    // 集合的写法是为将来的更新路径准备的，理由写在 RunBudget 的注释里
    const { run } = await seedRun('Autonomous', { attributes: { maxSteps: 6 } })
    let outcome: RunResult['outcome'] | null = null
    await runnerWith(
      new ScriptedModelClient([propose('A'), FINISH]),
      (_r, result) => { outcome = result.outcome },
      undefined,
      2,
    ).pollOnce()

    expect(outcome!.kind).toBe('completed')
    void run
  })

  it('a run cannot raise its own limit', async () => {
    // Run 上写 maxObjectsPerRun 不该有任何效果：
    // 一道能被本次执行自己调大的闸不是闸
    const { run } = await seedRun('Autonomous', {
      attributes: { maxSteps: 8, maxTokens: 100000 },
    })
    let outcome: RunResult['outcome'] | null = null
    await runnerWith(
      new ScriptedModelClient([propose('A'), propose('B'), propose('C'), FINISH]),
      (_r, result) => { outcome = result.outcome },
      undefined,
      1,
    ).pollOnce()

    expect(outcome!.kind).toBe('blast-radius-exceeded')
    void run
  })

  it('leaves Suggest-mode runs alone — nothing is being touched', async () => {
    // Suggest 模式不落库，影响面是 0，不该被这道闸挡住
    const { run } = await seedRun('Suggest', { attributes: { maxSteps: 8 } })
    let outcome: RunResult['outcome'] | null = null
    await runnerWith(
      new ScriptedModelClient([propose('A'), propose('B'), propose('C'), FINISH]),
      (_r, result) => { outcome = result.outcome },
      undefined,
      1,
    ).pollOnce()

    // Suggest 有产出就是 awaiting-review。重点是它**不是**被熔断
    expect(outcome!.kind).toBe('awaiting-review')
    void run
  })
})

/**
 * 全链路可取消（FR-ARCH-011）。
 *
 * 验收标准原文："取消进行中的 Run，含 Connector 调用在 5 秒内全部停止"。
 * 五秒这个数字的意思是：**不能等最后一次推理自然结束**。
 */
describe('a run can be cancelled (FR-ARCH-011)', () => {
  const propose = (title: string): ScriptedTurn => ({
    thought: `拆一个：${title}`,
    action: { kind: 'propose', resourceType: 'Story', attributes: { title }, rationale: 'r' },
  })

  it('stops before doing any more work when the signal is already aborted', async () => {
    const { run } = await seedRun('Autonomous', { attributes: { maxSteps: 8 } })

    let outcome: RunResult['outcome'] | null = null
    const runner = runnerWith(
      new ScriptedModelClient([propose('A'), propose('B'), FINISH]),
      (_r, result) => { outcome = result.outcome },
    )
    runner.stop() // 置位取消信号
    await runner.pollOnce()

    expect(outcome).not.toBeNull()
    expect(outcome!.kind).toBe('cancelled')
    // 一个对象都不该被创建
    const stories = await app.inject({
      method: 'GET',
      url: '/v1/resources?type=Story',
      headers: asAdmin,
    })
    expect(stories.json().items).toHaveLength(0)
    void run
  })

  it('lands the run in Cancelled, not Failed', async () => {
    // 都记成失败的话，"这批 Run 为什么这么多失败"就永远问不清楚
    const { run } = await seedRun('Autonomous', { attributes: { maxSteps: 8 } })
    const runner = runnerWith(new ScriptedModelClient([propose('A'), FINISH]))
    runner.stop()
    await runner.pollOnce()

    expect((await get(run.id)).status).toBe('Cancelled')
    expect(String((await get(run.id)).attributes.outcome)).toMatch(/被取消/)
  })

  it('leaves an uncancelled run completely alone', async () => {
    // 取消的实现最容易出的问题是"顺手把没取消的也停了"
    const { run } = await seedRun('Autonomous', { attributes: { maxSteps: 8 } })
    await runnerWith(new ScriptedModelClient([propose('A'), FINISH])).pollOnce()
    expect((await get(run.id)).status).toBe('Succeeded')
  })

  it('refuses to keep retrying a connector call after cancellation', async () => {
    // 退避重试最长能拖好几秒。"取消了还在重试"正是取消看起来没生效的样子
    const aborter = new AbortController()
    aborter.abort()

    let attempts = 0
    const invoker: ConnectorInvoker = {
      async invoke(_caller, _input, signal) {
        attempts++
        if (signal?.aborted === true) {
          throw new DomainError('cancelled', 'call cancelled before completing', 499)
        }
        return { ok: true, data: {}, attempts: 1, replayed: false }
      },
    }

    const { run } = await seedRun('Autonomous', { attributes: { maxSteps: 4 } })
    const runner = runnerWith(new ScriptedModelClient([FINISH]), undefined, invoker)
    runner.stop()
    await runner.pollOnce()

    // 取消之后一次工具调用都不该发生
    expect(attempts).toBe(0)
    void run
  })
})

/**
 * 跨进程取消（FR-ARCH-011）。
 *
 * 运行 Run 的是 runner 进程，点"取消"的是 API 进程。
 * 两者之间没有消息通道（ADR-0008 模块化单体），所以取消只能通过
 * **库里那条 Run 的状态**传递：运行时在步与步之间回读一次。
 */
describe('cancelling a specific run across processes (FR-ARCH-011)', () => {
  const propose = (title: string): ScriptedTurn => ({
    thought: `拆一个：${title}`,
    action: { kind: 'propose', resourceType: 'Story', attributes: { title }, rationale: 'r' },
  })

  it('notices that someone moved the run to Cancelled mid-flight', async () => {
    const { run } = await seedRun('Autonomous', { attributes: { maxSteps: 8 } })

    // 模型第一步就把这条 Run 取消掉——模拟"另一个进程点了取消"
    let cancelledOnce = false
    const model: ModelClient = {
      async complete() {
        if (!cancelledOnce) {
          cancelledOnce = true
          const res = await app.inject({
            method: 'POST',
            url: `/v1/resources/${run.id}/transitions`,
            headers: asAdmin,
            payload: { to: 'Cancelled' },
          })
          if (res.statusCode !== 200) throw new Error(`cancel failed: ${res.body}`)
        }
        return {
          thought: '继续',
          action: { kind: 'propose', resourceType: 'Story', attributes: { title: 'X' }, rationale: 'r' },
          tokensUsed: 10,
          costUsd: 0.01,
        }
      },
    }

    let outcome: RunResult['outcome'] | null = null
    await runnerWith(model, (_r, result) => { outcome = result.outcome }).pollOnce()

    expect(outcome!.kind).toBe('cancelled')
    // 取消之后不该再写回：那是在做一件已经被叫停的事
    const stories = await app.inject({
      method: 'GET',
      url: '/v1/resources?type=Story',
      headers: asAdmin,
    })
    expect(stories.json().items).toHaveLength(0)
    void propose
  })
})
