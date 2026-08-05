import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type pg from 'pg'
import type { FastifyInstance } from 'fastify'
import { assertNotSuperuser, setupTestDb, truncateAll } from '../helpers/db.ts'
import { buildServer } from '../../src/api/server.ts'
import { buildDefaultRegistry } from '../../src/ontology/defaults.ts'
import { buildDefaultWorkflowRegistry } from '../../src/workflow/defaults.ts'
import { defaultPolicies } from '../../src/identity/default-policies.ts'
import { GitHubConnector, summarizeRuns } from '../../src/infrastructure/connectors/github.ts'
import { ConnectorGateway } from '../../src/domain/connector/gateway.ts'
import { systemClock } from '../../src/platform/clock.ts'
import { CI_BLOCK_PREFIX, CI_STATUS_ATTR, decideWriteBack } from '../../src/domain/execution/ci.ts'
import type { AuditRecord, AuditSink } from '../../src/domain/resource/ports.ts'
import type { Caller } from '../../src/domain/resource/service.ts'

/**
 * GitHub Connector（FR-CON-006）。
 *
 * 验收标准是「可创建 PR、读取 CI 状态并回写 Task」，三段分别是这么验的：
 *
 *   创建 PR    → 本地 HTTP 服务器逐字断言请求的方法、路径、头、报文。
 *                这一段**不需要 GitHub 在场**：请求构造对不对是离线可判定的，
 *                而它恰恰最容易写错、又最难从 404 里看出来。
 *   读 CI 状态 → 报文用的是 **真实抓下来的** GitHub Actions 响应
 *                （tests/fixtures/github/actions-runs.json，本仓库自己的 CI）。
 *                自己编一份 fixture 等于把"我以为它长这样"当成事实来测。
 *   回写 Task  → 真数据库、真生命周期守卫、真审计。这一段完全没有外部依赖。
 *
 * **诚实地说清楚这一组没有覆盖什么**：github.com 会不会接受这些请求。
 * 拿不到产品自己的凭据，这一条就验不了。它和 MCP（对面是真 server）、
 * Browser（对面是真 Chromium）不是同一个成色，别当成一样的。
 */

const TENANT = 'default'
const REPO = 'lhkong7/kanboard'
const TOKEN = 'ghp_not_a_real_token'

const asAdmin = {
  'x-principal': 'user://alice',
  'x-tenant': TENANT,
  'x-roles': 'Admin',
  'x-capabilities': '',
}

/** 本地假 GitHub 记下每一次请求，让断言能落在**请求**而不只是响应上 */
type Seen = { method: string; url: string; headers: Record<string, unknown>; body: string }

let pool: pg.Pool
let app: FastifyInstance
let fake: Server
let baseUrl: string
let seen: Seen[] = []
let runsFixture: string
/** 下一次请求返回什么。默认返回真实 fixture */
let respond: ((req: Seen) => { status: number; body: string }) | null = null

const audit: AuditRecord[] = []
const sink: AuditSink = { async record(entry) { audit.push(entry) } }

const agentCaller = {
  subject: {
    principal: 'agent://ci-watcher@1.0.0',
    tenant: TENANT,
    roles: [],
    capabilities: ['Connector.github.*'],
  },
} as unknown as Caller

beforeAll(async () => {
  runsFixture = await readFile('tests/fixtures/github/actions-runs.json', 'utf8')

  fake = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => (body += String(chunk)))
    req.on('end', () => {
      const record: Seen = {
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers as Record<string, unknown>,
        body,
      }
      seen.push(record)
      const custom = respond?.(record)
      if (custom !== undefined) {
        res.writeHead(custom.status, { 'content-type': 'application/json' })
        res.end(custom.body)
        return
      }
      if (record.url.includes('/actions/runs')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(runsFixture)
        return
      }
      res.writeHead(201, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ number: 7, html_url: 'https://github.com/x/y/pull/7' }))
    })
  })
  await new Promise<void>((resolve) => fake.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`

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
  await new Promise<void>((resolve) => fake.close(() => resolve()))
})

beforeEach(async () => {
  await truncateAll(pool)
  seen = []
  audit.length = 0
  respond = null
})

function gateway(allowedRepos: readonly string[] = [REPO]): ConnectorGateway {
  return new ConnectorGateway({
    connectors: [new GitHubConnector({ allowedRepos, baseUrl, timeoutMs: 5_000 })],
    audit: sink,
    secrets: { async get(ref) { return ref === 'github.token' ? TOKEN : null } },
    callLog: { async find() { return null }, async save() {} },
    policies: [
      { id: 'pol-gh', effect: 'Allow', subject: '*', action: 'Connector.github.*', scope: { kind: 'any' } },
    ],
    clock: systemClock,
  })
}

// ── 创建 PR ──────────────────────────────────────────────────
describe('creating a pull request (FR-CON-006)', () => {
  it('sends the request GitHub actually documents', async () => {
    await gateway().invoke(agentCaller, {
      connectorId: 'github',
      operation: 'createPullRequest',
      target: REPO,
      params: { title: '修复导出', head: 'fix/export', base: 'main', body: '正文' },
      idempotencyKey: 'pr-1',
      confirmationToken: 'human-said-yes',
    })

    const req = seen.at(-1)
    expect(req?.method).toBe('POST')
    expect(req?.url).toBe(`/repos/${REPO}/pulls`)
    // 版本头：不写的话 GitHub 换默认版本时我们会静默地跟着换
    expect(req?.headers['x-github-api-version']).toBe('2022-11-28')
    expect(req?.headers['accept']).toBe('application/vnd.github+json')
    expect(JSON.parse(req?.body ?? '{}')).toMatchObject({
      title: '修复导出',
      head: 'fix/export',
      base: 'main',
    })
  })

  it('injects the credential from the secret provider, never from the caller', async () => {
    await gateway().invoke(agentCaller, {
      connectorId: 'github',
      operation: 'createPullRequest',
      target: REPO,
      params: { title: 't', head: 'h', base: 'main' },
      idempotencyKey: 'pr-2',
      confirmationToken: 'yes',
    })
    expect(seen.at(-1)?.headers['authorization']).toBe(`Bearer ${TOKEN}`)
    // 凭据不得进审计详情（FR-CON-011）
    expect(JSON.stringify(audit)).not.toContain(TOKEN)
  })

  it('refuses without human confirmation — a PR is visible to a roomful of people', async () => {
    await expect(
      gateway().invoke(agentCaller, {
        connectorId: 'github',
        operation: 'createPullRequest',
        target: REPO,
        params: { title: 't', head: 'h', base: 'main' },
        idempotencyKey: 'pr-3',
      }),
    ).rejects.toThrow(/confirmation/i)
    // 拒绝必须发生在**发出请求之前**
    expect(seen).toHaveLength(0)
  })

  it('refuses a repo outside the allow-list', async () => {
    await expect(
      gateway().invoke(agentCaller, {
        connectorId: 'github',
        operation: 'createPullRequest',
        target: 'someone-else/private',
        params: { title: 't', head: 'h', base: 'main' },
        idempotencyKey: 'pr-4',
        confirmationToken: 'yes',
      }),
    ).rejects.toThrow(/allow-list/)
    expect(seen).toHaveLength(0)
  })

  it('scopes by repo, not by host — api.github.com would authorize every repo at once', async () => {
    // 这条是这个连接器最重要的一个决定。白名单按 host 的话，
    // "允许访问 api.github.com" 等于把账号下每个仓库都授权出去了
    const spec = new GitHubConnector({ allowedRepos: [REPO] }).spec
    expect(spec.allowedTargets).toEqual([REPO])
    expect(spec.allowedTargets).not.toContain('api.github.com')
  })
})

// ── 读 CI 状态 ───────────────────────────────────────────────
describe('reading CI status from a real GitHub payload (FR-CON-006)', () => {
  it('asks only for the commit in question', async () => {
    await gateway().invoke(agentCaller, {
      connectorId: 'github',
      operation: 'readChecks',
      target: REPO,
      params: { sha: 'b1d41acb55624b640a2fc2b11c5bb66904139635' },
    })
    // 拉全部再筛的话，活跃仓库里"我关心的那个 commit"会越翻越靠后
    expect(seen.at(-1)?.url).toContain('head_sha=b1d41acb55624b640a2fc2b11c5bb66904139635')
    expect(seen.at(-1)?.method).toBe('GET')
  })

  it('reads the fixture captured from this repository\'s own CI', async () => {
    const result = await gateway().invoke(agentCaller, {
      connectorId: 'github',
      operation: 'readChecks',
      target: REPO,
      params: { sha: 'b1d41acb55624b640a2fc2b11c5bb66904139635' },
    })
    const status = result.data as { verdict: string; failing: { name: string }[]; total: number }
    // fixture 里有一条 failure、一条 success、一条 in_progress
    expect(status.total).toBe(3)
    expect(status.verdict).toBe('failing')
    expect(status.failing).toHaveLength(1)
    expect(status.failing[0]?.name).toBe('CI')
  })
})

describe('collapsing nine GitHub conclusions into three (FR-CON-006)', () => {
  const run = (status: string, conclusion: string | null, name = 'CI') => ({
    id: 1, name, head_sha: 'abc', status, conclusion,
  })

  it('treats an unknown conclusion as failure, not success', () => {
    // 白名单而不是黑名单：GitHub 将来加一种结论时，**误报比漏报安全**
    const out = summarizeRuns('abc', [run('completed', 'startup_failure')])
    expect(out.verdict).toBe('failing')
  })

  it('does not count neutral or skipped as failures', () => {
    expect(summarizeRuns('abc', [run('completed', 'neutral'), run('completed', 'skipped')]).verdict)
      .toBe('passing')
  })

  it('reports failing even while another run is still going', () => {
    // 反过来的话，一个总有任务在排队的仓库永远等不到"失败"
    const out = summarizeRuns('abc', [run('completed', 'failure'), run('in_progress', null)])
    expect(out.verdict).toBe('failing')
  })

  it('separates "still running" from "ran and did not pass"', () => {
    expect(summarizeRuns('abc', [run('in_progress', null)]).verdict).toBe('pending')
  })

  it('names which runs failed, so a human has somewhere to go', () => {
    const out = summarizeRuns('abc', [run('completed', 'failure', 'lint'), run('completed', 'timed_out', 'e2e')])
    expect(out.failing.map((f) => f.name)).toEqual(['lint', 'e2e'])
  })
})

// ── 回写 Task ────────────────────────────────────────────────
describe('writing CI status back to a Task (FR-CON-006)', () => {
  async function makeTask(to = 'Doing'): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/resources',
      headers: asAdmin,
      payload: { type: 'Task', workspace: 'ws', attributes: { title: 't', assignee: 'user://bob' } },
    })
    const id = res.json().id as string
    if (to !== 'Todo') {
      await app.inject({
        method: 'POST',
        url: `/v1/resources/${id}/transitions`,
        headers: asAdmin,
        payload: { to: 'Doing' },
      })
    }
    return id
  }

  async function readTask(id: string) {
    const res = await app.inject({ method: 'GET', url: `/v1/resources/${id}`, headers: asAdmin })
    return res.json() as { status: string; attributes: Record<string, unknown> }
  }

  /**
   * 应用一次回写。走的是**普通的**更新与迁移端点——
   * CI 触发的改动和人点出来的没有区别。
   *
   * 属性**先写，再迁移**，而且是两次调用：迁移端点的 body 是 strict 的，
   * 只收 `to` / `reason` / `expectedVersion`。这不是不方便，是顺序本来就该这样：
   * `Blocked` 的守卫要求 blockReason **已经在那儿**。
   * 反过来先迁移再补原因的话，中间那一瞬间存在一个"没有原因的阻塞任务"——
   * 而守卫的存在就是为了让那个状态不可能出现。
   */
  async function apply(id: string, decision: ReturnType<typeof decideWriteBack>) {
    // 先读一次拿版本号，再带 If-Match 写回。
    // 不带的话 API 直接 400——**这是对的**：一次 CI 回写和一个人的编辑撞上时，
    // 该输的是 CI。它随时可以重算，人打的字丢了就没了
    const before = await app.inject({ method: 'GET', url: `/v1/resources/${id}`, headers: asAdmin })
    const current = (before.json() as { attributes: Record<string, unknown> }).attributes
    const patch = await app.inject({
      method: 'PATCH',
      url: `/v1/resources/${id}`,
      headers: { ...asAdmin, 'if-match': before.headers['etag'] as string },
      // attributes 是**整体替换**而非合并（service.update 里有说明：
      // 合并语义下没法表达"删除一个属性"）。所以回写必须读-改-写。
      // 只发 `{ciStatus}` 的话，title 缺失会被本体校验拦下——
      // 但 assignee、blockReason 这些**非必填**的会被静默抹掉
      payload: { attributes: { ...current, ...decision.attributes } },
    })
    // 断言而不是忽略：这一步默默失败的话，后面的迁移会因为
    // "缺少 blockReason" 而失败，而报出来的原因指向的是错误的地方
    expect(patch.statusCode, patch.body).toBeLessThan(300)
    if (decision.kind === 'annotate') return patch

    const moved = await app.inject({
      method: 'POST',
      url: `/v1/resources/${id}/transitions`,
      headers: asAdmin,
      payload: { to: decision.to, reason: 'CI 回写' },
    })
    expect(moved.statusCode, moved.body).toBeLessThan(300)
    return moved
  }

  it('blocks a task in progress when CI is red, and says why', async () => {
    const id = await makeTask()
    const decision = decideWriteBack(
      { sha: 'deadbeef', verdict: 'failing', failing: [{ name: 'lint', url: 'u' }], total: 1 },
      { status: 'Doing' },
    )
    const res = await apply(id, decision)
    expect(res.statusCode).toBeLessThan(300)

    const task = await readTask(id)
    expect(task.status).toBe('Blocked')
    // Blocked 的生命周期守卫要求 blockReason。CI 恰好知道原因，
    // 所以这里是**让守卫成立**，不是绕开守卫。
    //
    // 断言**具体是哪个 run**，不只是"含 CI 两个字"。
    // 原来那条弱断言放过了一个变异：把原因换成一句光秃秃的
    // 「CI 失败：」照样通过——而那对着手修的人一点用都没有
    expect(String(task.attributes['blockReason'])).toContain('lint')
    expect(task.attributes[CI_STATUS_ATTR]).toBe('failing')
  })

  it('does not reopen a finished task just because CI went red', async () => {
    // 重开是一次有代价的决定（ADR-0012 把它记成一条显式的边）。
    // 一次 CI 抖动不足以做这个决定
    const decision = decideWriteBack(
      { sha: 'deadbeef', verdict: 'failing', failing: [], total: 1 },
      { status: 'Done' },
    )
    expect(decision.kind).toBe('annotate')
  })

  it('does not advance a task just because CI went green', async () => {
    // CI 通过只说明代码能编译能跑测试，不说明这个任务做完了。
    // 自动推进会让"完成"这个信号变得不可信
    const decision = decideWriteBack(
      { sha: 'cafe', verdict: 'passing', failing: [], total: 2 },
      { status: 'Doing' },
    )
    expect(decision.kind).toBe('annotate')
    expect(decision.attributes[CI_STATUS_ATTR]).toBe('passing')
  })

  it('unblocks only the block it caused itself', async () => {
    const mine = decideWriteBack(
      { sha: 'cafe', verdict: 'passing', failing: [], total: 1 },
      { status: 'Blocked', blockReason: `${CI_BLOCK_PREFIX}CI` },
    )
    expect(mine).toMatchObject({ kind: 'transition', to: 'Doing' })

    // 一个因为"等第三方接口"被人挂起的任务，不该因为 CI 变绿就被放回去。
    // 只看状态是 Blocked 就解除，等于让 CI 推翻一个它读都没读过的决定
    const theirs = decideWriteBack(
      { sha: 'cafe', verdict: 'passing', failing: [], total: 1 },
      { status: 'Blocked', blockReason: '等支付网关联调' },
    )
    expect(theirs.kind).toBe('annotate')
  })

  it('records "still running" without touching the status', async () => {
    const id = await makeTask()
    const decision = decideWriteBack(
      { sha: 'feed', verdict: 'pending', failing: [], total: 1 },
      { status: 'Doing' },
    )
    await apply(id, decision)
    const task = await readTask(id)
    // "还没结果"不是一种结果。据此改状态会让任务在每次 push 后抖一下
    expect(task.status).toBe('Doing')
    expect(task.attributes[CI_STATUS_ATTR]).toBe('pending')
  })
})

// ── 失败与边界 ───────────────────────────────────────────────
describe('failure modes say what actually happened', () => {
  it('rejects a malformed repo before it becomes a confusing 404', async () => {
    await expect(
      gateway(['not-a-repo']).invoke(agentCaller, {
        connectorId: 'github',
        operation: 'readChecks',
        target: 'not-a-repo',
        params: { sha: 'abc' },
      }),
    ).rejects.toThrow(/owner\/repo/)
  })

  it('surfaces GitHub\'s own error body instead of a bare status code', async () => {
    respond = () => ({ status: 422, body: JSON.stringify({ message: 'No commits between main and fix' }) })
    await expect(
      gateway().invoke(agentCaller, {
        connectorId: 'github',
        operation: 'createPullRequest',
        target: REPO,
        params: { title: 't', head: 'h', base: 'main' },
        idempotencyKey: 'pr-err',
        confirmationToken: 'yes',
      }),
    ).rejects.toThrow(/422/)
  })

  it('stops on a cancellation signal without calling out', async () => {
    const controller = new AbortController()
    controller.abort()
    const connector = new GitHubConnector({ allowedRepos: [REPO], baseUrl })
    await expect(
      connector.execute(
        { connectorId: 'github', operation: 'readChecks', target: REPO, params: { sha: 'abc' } },
        TOKEN,
        controller.signal,
      ),
    ).rejects.toThrow(/cancel/i)
    expect(seen).toHaveLength(0)
  })

  it('cancels a request already in flight, and says it was cancelled (FR-ARCH-011)', async () => {
    // 上面那条只覆盖"出发前就已经取消"。真正难的是**已经在等**的那次——
    // 而验收标准要的正是这个：取消在 5 秒内生效。
    //
    // 这里区分的是错误的**种类**：一次被取消的调用报成 `unavailable`，
    // 看起来就像 GitHub 挂了，于是会被重试、会进熔断计数、会有人去查 GitHub 状态页
    // 一个**不回话**的服务器。假 GitHub 会立刻回，测不出"还在等"的那一刻。
    // 用数组存住响应对象：TS 看不到回调执行，直接给闭包变量赋值会被窄化成 null
    const held: ServerResponse[] = []
    const slow = createServer((_req, res) => {
      held.push(res)
    })
    await new Promise<void>((resolve) => slow.listen(0, '127.0.0.1', resolve))
    const slowUrl = `http://127.0.0.1:${(slow.address() as AddressInfo).port}`

    const controller = new AbortController()
    const connector = new GitHubConnector({ allowedRepos: [REPO], baseUrl: slowUrl })
    const pending = connector.execute(
      { connectorId: 'github', operation: 'readChecks', target: REPO, params: { sha: 'abc' } },
      TOKEN,
      controller.signal,
    )
    // 等请求真的发出去了再取消
    await new Promise((resolve) => setTimeout(resolve, 50))
    controller.abort()

    await expect(pending).rejects.toThrow(/cancel/i)
    for (const res of held) res.end('{}')
    await new Promise<void>((resolve) => slow.close(() => resolve()))
  })

  it('requires the params it cannot invent', async () => {
    await expect(
      gateway().invoke(agentCaller, {
        connectorId: 'github',
        operation: 'createPullRequest',
        target: REPO,
        params: { title: 't', base: 'main' },
        idempotencyKey: 'pr-missing',
        confirmationToken: 'yes',
      }),
    ).rejects.toThrow(/head/)
    expect(seen).toHaveLength(0)
  })
})
