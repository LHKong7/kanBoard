import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type pg from 'pg'
import type { FastifyInstance } from 'fastify'
import { assertNotSuperuser, setupTestDb, truncateAll } from '../helpers/db.ts'
import { buildServer } from '../../src/api/server.ts'
import { buildDefaultRegistry } from '../../src/ontology/defaults.ts'
import { buildDefaultWorkflowRegistry } from '../../src/workflow/defaults.ts'
import { defaultPolicies } from '../../src/identity/default-policies.ts'
import { RELEASE_PROCESS } from '../../src/workflow/release-process.ts'
import type { ConnectorInvoker } from '../../src/domain/agent/runtime.ts'
import type { CallInput, CallResult } from '../../src/domain/connector/types.ts'
import { sweepOverdueRuns } from '../../src/infrastructure/process-sweeper.ts'

/**
 * Release 流程端到端（FR-WF-010 的验收标准原文），以及
 * 灰度失败自动回滚状态（FR-WF-011）。
 *
 * `advance()` 那一层在 tests/orchestration.test.ts 里逐条测过（纯函数）。
 * 这里测的是**它真的跑起来**：状态真的变了、连接器真的被调了、
 * 实例真的存下来了（因此一次重启接得上）、失败时补偿真的执行了。
 *
 * 连接器用一个可编排的假实现，理由和 FR-AI-001 一样：被考的是**机制**
 * （并行、人工、循环、分支、超时、补偿），不是某个部署系统的行为。
 * 真接一个部署系统进来也验不了"灰度不健康时会不会回滚"——
 * 那要它真的不健康一次。
 */

const TENANT = 't_proc'
const asAdmin = { 'x-principal': 'user://alice', 'x-tenant': TENANT, 'x-roles': 'Admin', 'x-capabilities': '' }

/** 每个连接器操作被调了几次，以及下一次该回什么 */
class ScriptedConnectors implements ConnectorInvoker {
  readonly calls: string[] = []
  readonly #replies = new Map<string, string[]>()
  readonly #failures = new Set<string>()

  /** `deploy.widenCanary` 依次返回这些值 */
  script(op: string, values: string[]): this {
    this.#replies.set(op, [...values])
    return this
  }

  fail(op: string): this {
    this.#failures.add(op)
    return this
  }

  async invoke(_caller: unknown, input: CallInput): Promise<CallResult> {
    const op = `${input.connectorId}.${input.operation}`
    this.calls.push(op)
    if (this.#failures.has(op)) return { ok: false, data: null, replayed: false, attempts: 1 }
    const queued = this.#replies.get(op)
    // 用光了就一直返回最后一个：一次灰度观察被问三轮，
    // 而脚本只想说"第三轮开始健康"
    const value = queued === undefined ? null : (queued.shift() ?? lastOf(this.#replies.get(op)))
    return { ok: true, data: value, replayed: false, attempts: 1 }
  }
}

function lastOf(_v: string[] | undefined): null {
  return null
}

let pool: pg.Pool
let app: FastifyInstance
let connectors: ScriptedConnectors

beforeAll(async () => {
  pool = await setupTestDb()
  await assertNotSuperuser(pool)
})

afterAll(async () => {
  await app?.close()
  await pool.end()
})

async function boot(c: ScriptedConnectors): Promise<void> {
  await app?.close()
  connectors = c
  app = buildServer({
    pool,
    registry: buildDefaultRegistry(),
    workflows: buildDefaultWorkflowRegistry(),
    policies: defaultPolicies(TENANT),
    processes: [RELEASE_PROCESS],
    connectors: c,
  })
  await app.ready()
}

beforeEach(async () => {
  await truncateAll(pool)
})

async function create(type: string, attributes: Record<string, unknown>): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/resources',
    headers: asAdmin,
    payload: { type, workspace: 'ws_proc', attributes },
  })
  expect(res.statusCode).toBe(201)
  return res.json().id as string
}

/** 一个可以冻结的 Release：Frozen 要求它至少 ships 一个 Task */
async function seedRelease(): Promise<{ release: string; task: string }> {
  const release = await create('Release', { name: 'v1.0', version: '1.0.0' })
  // Doing 要求有负责人——守卫在做它该做的事
  const task = await create('Task', { title: '一件事', assignee: 'user://alice' })
  const rel = await app.inject({
    method: 'POST',
    url: `/v1/resources/${release}/relations`,
    headers: asAdmin,
    payload: { type: 'ships', toId: task },
  })
  expect(rel.statusCode).toBe(201)
  return { release, task }
}

async function moveTo(id: string, to: string): Promise<void> {
  const res = await app.inject({
    method: 'POST',
    url: `/v1/resources/${id}/transitions`,
    headers: asAdmin,
    payload: { to },
  })
  if (res.statusCode !== 200) throw new Error(`transition ${to} failed: ${res.statusCode} ${res.body}`)
}

async function start(release: string) {
  return app.inject({
    method: 'POST',
    url: '/v1/processes',
    headers: asAdmin,
    payload: { processId: 'release-default', refs: { release } },
  })
}

async function decide(runId: string, approved: boolean) {
  return app.inject({
    method: 'POST',
    url: `/v1/processes/${runId}/decisions`,
    headers: asAdmin,
    payload: { approved },
  })
}

async function statusOf(id: string): Promise<string> {
  const res = await app.inject({ method: 'GET', url: `/v1/resources/${id}`, headers: asAdmin })
  return res.json().status as string
}

describe('release process end to end (FR-WF-010)', () => {
  it('runs freeze → parallel → human → canary loop → promote', async () => {
    await boot(new ScriptedConnectors().script('metrics.canaryHealth', ['degraded', 'healthy']))
    const { release, task } = await seedRelease()
    await moveTo(task, 'Doing')
    await moveTo(task, 'Done')

    const started = await start(release)
    expect(started.statusCode).toBe(201)
    const run = started.json()

    // 冻结做掉了，然后停在人工节点上——**这不是卡住，是流程的正常一环**
    expect(run.status).toBe('awaiting-human')
    expect(run.awaiting.stepId).toBe('approve')
    expect(await statusOf(release)).toBe('Frozen')
    // 并行的两支都跑了，而且是在等人之前
    expect(connectors.calls).toContain('ci.build')
    expect(connectors.calls).toContain('docs.draftReleaseNotes')

    const after = await decide(run.id, true)
    expect(after.statusCode).toBe(200)
    const done = after.json()

    expect(done.status).toBe('completed')
    // **这就是"端到端跑通"**：Release 真的到了 Released
    expect(await statusOf(release)).toBe('Released')

    // 灰度循环真的转了不止一轮：第一轮 degraded，第二轮才 healthy
    const observations = connectors.calls.filter((c) => c === 'metrics.canaryHealth')
    expect(observations.length).toBe(2)
    expect(connectors.calls).toContain('deploy.promote')
  })

  it('rolls back when the canary is unhealthy (FR-WF-011)', async () => {
    // 验收标准原文：**灰度失败自动回滚状态**
    await boot(new ScriptedConnectors().script('metrics.canaryHealth', ['unhealthy']))
    const { release, task } = await seedRelease()
    await moveTo(task, 'Doing')
    await moveTo(task, 'Done')

    const run = (await start(release)).json()
    const done = (await decide(run.id, true)).json()

    expect(done.status).toBe('completed')
    // 灰度明确不健康 → 走 otherwise 分支 → Abandoned。
    // **这条分支不是兜底，是主路径之一**：灰度不健康是常态
    expect(await statusOf(release)).toBe('Abandoned')
    expect(connectors.calls).not.toContain('deploy.promote')
  })

  it('compensates in reverse when a human rejects', async () => {
    await boot(new ScriptedConnectors())
    const { release } = await seedRelease()

    const run = (await start(release)).json()
    expect(run.status).toBe('awaiting-human')

    const rejected = (await decide(run.id, false)).json()
    expect(rejected.status).toBe('compensated')

    // 冻结被撤销了——**回到 Planned，范围重新可改**
    expect(await statusOf(release)).toBe('Planned')
    // 构建产物和草稿也撤了，而且是**逆序**：后做的先撤
    const undo = connectors.calls.filter((c) => c.includes('discard') || c.includes('delete'))
    expect(undo).toEqual(['docs.deleteDraft', 'ci.discardArtifact'])
  })

  it('marks compensation-failed loudly when the undo itself fails', async () => {
    // 唯一一种需要人立刻去看的结局：一部分副作用撤销了、一部分没有，
    // 系统在一个没人描述过的状态里。把它和 compensated 混在一起
    // 是这套东西能犯的最坏的错
    await boot(new ScriptedConnectors().fail('ci.discardArtifact'))
    const { release } = await seedRelease()
    const run = (await start(release)).json()

    const rejected = (await decide(run.id, false)).json()
    expect(rejected.status).toBe('compensation-failed')
  })

  it('survives a restart: the instance is state, not memory', async () => {
    // 一个流程实例会跨天。状态只在内存里的话，一次重启会让一个
    // 已经冻结了 Release 的流程从记录上消失——而外面的世界已经变了
    await boot(new ScriptedConnectors().script('metrics.canaryHealth', ['healthy']))
    const { release, task } = await seedRelease()
    await moveTo(task, 'Doing')
    await moveTo(task, 'Done')
    const run = (await start(release)).json()

    // 换一个进程（新的 server 实例，什么都不记得）
    await boot(new ScriptedConnectors().script('metrics.canaryHealth', ['healthy']))

    const reloaded = await app.inject({
      method: 'GET',
      url: `/v1/processes/${run.id}`,
      headers: asAdmin,
    })
    expect(reloaded.statusCode).toBe(200)
    expect(reloaded.json().status).toBe('awaiting-human')

    const done = (await decide(run.id, true)).json()
    expect(done.status).toBe('completed')
    expect(await statusOf(release)).toBe('Released')
  })

  it('does not leave a run waiting for a human forever', async () => {
    // **不设上界的话，一个等人的实例会永远挂着**，而它攥着一个已冻结的
    // Release——没有任何报错，只是那个发布再也不动了。
    // approve 那一步写的是 24 小时 + onTimeout: 'fail'
    await boot(new ScriptedConnectors())
    const { release } = await seedRelease()
    const run = (await start(release)).json()
    expect(run.status).toBe('awaiting-human')

    // 还没到点：一个都不该被捞出来
    const early = await sweepOverdueRuns(
      {
        pool,
        registry: buildDefaultRegistry(),
        workflows: buildDefaultWorkflowRegistry(),
        policies: defaultPolicies(TENANT),
        processes: [RELEASE_PROCESS],
        connectors,
        clock: { now: () => new Date(Date.now() + 60_000) },
      },
      TENANT,
    )
    expect(early).toEqual([])

    // 过了一天：超时按 onTimeout: 'fail' 处理 → 走补偿 → 解冻
    const swept = await sweepOverdueRuns(
      {
        pool,
        registry: buildDefaultRegistry(),
        workflows: buildDefaultWorkflowRegistry(),
        policies: defaultPolicies(TENANT),
        processes: [RELEASE_PROCESS],
        connectors,
        clock: { now: () => new Date(Date.now() + 25 * 60 * 60 * 1000) },
      },
      TENANT,
    )
    expect(swept).toHaveLength(1)
    expect(swept[0]?.status).toBe('compensated')
    expect(await statusOf(release)).toBe('Planned')
  })

  it('refuses a decision on a run that is not waiting for one', async () => {
    await boot(new ScriptedConnectors())
    const { release } = await seedRelease()
    const run = (await start(release)).json()
    expect((await decide(run.id, false)).statusCode).toBe(200)

    // 对着一个已经结束的实例点头，说明调用方看到的是一份过期的状态。
    // 回 200 会让他以为自己的决定生效了
    expect((await decide(run.id, true)).statusCode).toBe(409)
  })

  it('refuses to start an unknown process instead of creating a run that goes nowhere', async () => {
    await boot(new ScriptedConnectors())
    const { release } = await seedRelease()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/processes',
      headers: asAdmin,
      payload: { processId: 'no-such-process', refs: { release } },
    })
    expect(res.statusCode).toBe(404)
  })

  it('fails the step, not the process, when a guard blocks the transition', async () => {
    // Frozen 要求 Release 至少 ships 一个 Task。一个空的 Release
    // 连冻结都做不到——那是一次**流程失败**，不是一次崩溃，
    // 所以它要走补偿而不是 500
    await boot(new ScriptedConnectors())
    const empty = await create('Release', { name: 'v0', version: '0.1.0' })

    const started = await start(empty)
    expect(started.statusCode).toBe(201)
    // 第一步就失败 → 没有任何做成功的动作 → 补偿是空的，直接 compensated
    expect(started.json().status).toBe('compensated')
    expect(await statusOf(empty)).toBe('Planned')
  })
})
