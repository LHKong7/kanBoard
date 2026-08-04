import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createHmac } from 'node:crypto'
import { McpConnector } from '../src/infrastructure/connectors/mcp.ts'
import {
  GITHUB_SOURCE,
  translate,
  verifySignature,
} from '../src/infrastructure/external-events.ts'
import { ConnectorGateway } from '../src/domain/connector/gateway.ts'
import { systemClock } from '../src/platform/clock.ts'
import type { AuditRecord, AuditSink } from '../src/domain/resource/ports.ts'
import type { Caller } from '../src/domain/resource/service.ts'

/**
 * MCP Connector（FR-CON-008：接入任意 MCP Server 作为 Tool）。
 *
 * 跑的是**完整的协议往返**，对面是 tests/fixtures/mcp-server.mjs 里
 * 一个真实的 stdio MCP server。用假 transport 的话，
 * 分帧、id 匹配、通知跳过、错误映射这几处恰恰最容易错又完全测不到。
 *
 * "任意 server"这句话的代价是这一组的主题：server 是别人写的代码，
 * 它的声明来自系统外面，所以每个默认值都必须倒向保守一侧。
 */

const audit: AuditRecord[] = []
const sink: AuditSink = { async record(entry) { audit.push(entry) } }

const caller = {
  subject: {
    principal: 'agent://researcher@1.0.0',
    tenant: 't',
    roles: [],
    capabilities: ['Connector.docs.*'],
  },
} as unknown as Caller

let connector: McpConnector

beforeAll(async () => {
  connector = await McpConnector.connect({
    id: 'docs',
    title: '文档 MCP',
    command: process.execPath,
    args: ['tests/fixtures/mcp-server.mjs'],
    // 白名单只放两个。`delete_everything` 被 server 声明了，但这里不放行
    allowedTools: ['search_docs', 'write_file'],
    timeoutMs: 10_000,
  })
})

afterAll(async () => {
  await connector?.close()
})

function gateway(c: McpConnector = connector): ConnectorGateway {
  return new ConnectorGateway({
    connectors: [c],
    audit: sink,
    secrets: { async get() { return null } },
    callLog: { async find() { return null }, async save() {} },
    policies: [
      { id: 'pol-mcp', effect: 'Allow', subject: '*', action: 'Connector.docs.*', scope: { kind: 'any' } },
    ],
    clock: systemClock,
  })
}

describe('an MCP server becomes a set of tools (FR-CON-008)', () => {
  it('discovers the tools the server declares', () => {
    const names = connector.discovered.map((o) => o.name)
    expect(names).toContain('search_docs')
    expect(names).toContain('write_file')
  })

  it('calls a tool and returns its content', async () => {
    const result = await gateway().invoke(caller, {
      connectorId: 'docs',
      operation: 'search_docs',
      target: 'search_docs',
      params: { q: '状态机' },
    })
    expect(JSON.stringify(result.data)).toContain('状态机')
  })

  it('skips notifications rather than mistaking them for replies', async () => {
    // server 在 initialize 之后发了一条 notifications/initialized。
    // 把它当成回复的话，后面每一次调用拿到的都是上一次的结果
    const first = await gateway().invoke(caller, {
      connectorId: 'docs',
      operation: 'search_docs',
      target: 'search_docs',
      params: { q: '第一次' },
    })
    const second = await gateway().invoke(caller, {
      connectorId: 'docs',
      operation: 'search_docs',
      target: 'search_docs',
      params: { q: '第二次' },
    })
    expect(JSON.stringify(first.data)).toContain('第一次')
    expect(JSON.stringify(second.data)).toContain('第二次')
  })
})

describe('an unfamiliar server gets conservative defaults', () => {
  it('treats a tool with no readOnlyHint as an action', () => {
    // 反过来的话，一个 server 只要不声明就能拿到"不需要人工确认"的待遇，
    // 而那份声明来自系统外面
    const write = connector.discovered.find((o) => o.name === 'write_file')
    expect(write?.kind).toBe('action')
  })

  it('treats an explicitly read-only tool as a read', () => {
    expect(connector.discovered.find((o) => o.name === 'search_docs')?.kind).toBe('read')
  })

  it('classifies every tool result as confidential', () => {
    // 外部 server 返回的内容可能包含任何东西
    expect(connector.discovered.every((o) => o.returns === 'confidential')).toBe(true)
  })

  it('refuses a tool the server declared but the allow-list omits', async () => {
    // server 声明了 delete_everything，白名单里没有它
    await expect(
      gateway().invoke(caller, {
        connectorId: 'docs',
        operation: 'delete_everything',
        target: 'delete_everything',
        params: {},
        idempotencyKey: 'k1',
        confirmationToken: 'yes',
      }),
    ).rejects.toThrow(/not allowed|allow/i)
  })

  it('requires human confirmation before a mutating tool runs (FR-CON-010)', async () => {
    await expect(
      gateway().invoke(caller, {
        connectorId: 'docs',
        operation: 'write_file',
        target: 'write_file',
        params: { path: 'a.txt' },
        idempotencyKey: 'k2',
      }),
    ).rejects.toThrow(/requires human confirmation/)
  })

  it('runs the mutating tool once confirmed', async () => {
    const result = await gateway().invoke(caller, {
      connectorId: 'docs',
      operation: 'write_file',
      target: 'write_file',
      params: { path: 'a.txt' },
      idempotencyKey: 'k3',
      confirmationToken: 'human-said-yes',
    })
    expect(JSON.stringify(result.data)).toContain('written')
  })

  it('treats an empty allow-list as "no tools", not "all tools"', async () => {
    const locked = await McpConnector.connect({
      id: 'docs',
      title: 'x',
      command: process.execPath,
      args: ['tests/fixtures/mcp-server.mjs'],
      allowedTools: [],
    })
    try {
      await expect(
        gateway(locked).invoke(caller, {
          connectorId: 'docs',
          operation: 'search_docs',
          target: 'search_docs',
          params: {},
        }),
      ).rejects.toThrow()
    } finally {
      await locked.close()
    }
  })
})

describe('failures are reported as failures', () => {
  it('surfaces a protocol error rather than returning it as data', async () => {
    await expect(
      connector.execute(
        { connectorId: 'docs', operation: 'nope', target: 'nope', params: {} },
        null,
      ),
    ).rejects.toThrow(/unknown tool/)
  })

  it('turns an isError result into a thrown error', async () => {
    // MCP 用 isError 表示工具**自己**失败了。当成成功返回的话，
    // Agent 会把一段错误信息当作结果继续推理下去
    await expect(
      connector.execute(
        { connectorId: 'docs', operation: 'failing_tool', target: 'failing_tool', params: {} },
        null,
      ),
    ).rejects.toThrow(/reported an error/)
  })

  it('refuses to call once the server has exited', async () => {
    const doomed = await McpConnector.connect({
      id: 'docs',
      title: 'x',
      command: process.execPath,
      args: ['tests/fixtures/mcp-server.mjs'],
      allowedTools: ['search_docs'],
    })
    await doomed.close()
    await expect(
      doomed.execute(
        { connectorId: 'docs', operation: 'search_docs', target: 'search_docs', params: {} },
        null,
      ),
    ).rejects.toThrow(/not running/)
  })

  it('does not start a call that was already cancelled', async () => {
    const aborter = new AbortController()
    aborter.abort()
    await expect(
      connector.execute(
        { connectorId: 'docs', operation: 'search_docs', target: 'search_docs', params: {} },
        null,
        aborter.signal,
      ),
    ).rejects.toThrow(/cancelled/)
  })
})

/**
 * 入站翻译的纯函数部分（FR-WF-006）。
 *
 * 端到端那条链在 tests/integration/external-events.test.ts。
 * 这里单独钉的是**翻译规则本身**——它决定了一条外部消息会变成什么，
 * 而那正是接第二个来源时最容易改错的地方。
 */
describe('external event translation (FR-WF-006)', () => {
  const secret = 's3cr3t'
  const sign = (body: string) =>
    `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`

  const source = GITHUB_SOURCE(secret)
  const run = (body: string, over: Record<string, unknown> = {}) =>
    translate({
      source,
      tenant: 't',
      rawBody: body,
      headers: { 'x-github-event': 'pull_request' },
      signature: sign(body),
      now: new Date('2026-08-01T00:00:00Z'),
      ...over,
    })

  const body = (over: Record<string, unknown> = {}) =>
    JSON.stringify({
      action: 'closed',
      pull_request: {
        number: 1,
        title: 'fix (task_01J0000000000000000000ABCD)',
        body: '',
        head: { ref: 'x' },
        ...over,
      },
    })

  it('joins the header and the payload into one event name', () => {
    // GitHub 把类型放 header、子类型放载荷。写成声明而不是 if 分支，
    // 接第二个来源时改的是配置
    expect(run(body()).payload['event']).toBe('pull_request.closed')
  })

  it('derives the resource type from the id prefix', () => {
    // 外部系统不知道我们的类型体系，也不该知道
    expect(run(body()).resourceType).toBe('Task')
  })

  it('rejects a body that is not JSON', () => {
    const raw = 'not json'
    expect(() =>
      translate({
        source,
        tenant: 't',
        rawBody: raw,
        headers: { 'x-github-event': 'pull_request' },
        signature: sign(raw),
        now: new Date(),
      }),
    ).toThrow(/not valid JSON/)
  })

  it('rejects when the event name cannot be determined', () => {
    const raw = JSON.stringify({ pull_request: { title: 'task_01J0000000000000000000ABCD' } })
    expect(() =>
      translate({
        source,
        tenant: 't',
        rawBody: raw,
        headers: {},
        signature: sign(raw),
        now: new Date(),
      }),
    ).toThrow(/event name/)
  })

  it('compares signatures in constant time, and length-mismatches are just false', () => {
    // 长度不等时 timingSafeEqual 会抛。抛出去的话，一个短签名
    // 会变成 500 而不是 401——而 500 看起来像我们的 bug，不像有人在试探
    expect(verifySignature(secret, 'x', 'sha256=short')).toBe(false)
    expect(verifySignature(secret, 'x', sign('x'))).toBe(true)
  })

  it('searches each declared field in order', () => {
    // 标题里没有就去分支名里找。少一个回退，人就得改自己的习惯来迁就系统
    const raw = body({ title: '没有单号', head: { ref: 'feature/task_01J0000000000000000000BCDE' } })
    expect(run(raw).resourceId).toBe('task_01J0000000000000000000BCDE')
  })
})
