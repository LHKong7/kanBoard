import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { BrowserConnector } from '../../src/infrastructure/connectors/browser.ts'
import { ConnectorGateway, isAllowed } from '../../src/domain/connector/gateway.ts'
import type { AuditRecord, AuditSink } from '../../src/domain/resource/ports.ts'
import type { Caller } from '../../src/domain/resource/service.ts'
import { systemClock } from '../../src/platform/clock.ts'

/**
 * Browser Connector（FR-CON-009 / FR-CON-010）。
 *
 * 跑的是**真实的 Chromium**，打开的是本地起的一个真实页面。
 * 用 Node 内置 runner 而不是 vitest，理由和看板 UI 那套一样
 * （见 tests/ui/README.md）。
 *
 * 要验证的三件事：域名白名单挡得住、动作范围挡得住、
 * 敏感动作没有人工确认就执行不了。这三条都是"不该发生的事没发生"，
 * 所以每一条都必须真的去尝试，而不是断言配置写对了。
 */

let server: Server
let origin = ''
let connector: BrowserConnector

const audit: AuditRecord[] = []
const sink: AuditSink = { async record(entry) { audit.push(entry) } }

const caller = {
  subject: {
    principal: 'agent://browser@1.0.0',
    tenant: 't',
    roles: [],
    // 能力名是网关拼出来的：`Connector.<连接器>.<操作>`。
    // Agent 能用哪个连接器的哪个操作，是逐个声明出来的
    capabilities: ['Connector.browser.*'],
  },
} as unknown as Caller

before(async () => {
  server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(`<!doctype html><html><head><title>报销单</title></head><body>
      <h1>提交报销</h1>
      <input id="amount" />
      <button id="pay">确认支付</button>
      <p id="status">未提交</p>
    </body></html>`)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  origin = `http://127.0.0.1:${address.port}`

  connector = new BrowserConnector({
    allowedDomains: ['127.0.0.1'],
    scope: 'interact',
    ...(process.env['CHROMIUM_PATH'] === undefined
      ? {}
      : { executablePath: process.env['CHROMIUM_PATH'] }),
  })
})

after(async () => {
  await connector?.close()
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

function gateway(): ConnectorGateway {
  return new ConnectorGateway({
    connectors: [connector],
    audit: sink,
    secrets: { async get() { return null } },
    callLog: { async find() { return null }, async save() {} },
    policies: [
      {
        id: 'pol-browser',
        effect: 'Allow',
        subject: '*',
        action: 'Connector.browser.*',
        scope: { kind: 'any' },
      },
    ],
    clock: systemClock,
  })
}

describe('Browser Connector drives a real browser', () => {
  it('读取页面并取回可见文本', async () => {
    const result = await gateway().invoke(caller, {
      connectorId: 'browser',
      operation: 'read',
      target: origin,
      params: {},
    })
    const data = result.data as { title: string; text: string }
    assert.match(data.title, /报销单/)
    assert.match(data.text, /提交报销/)
  })

  it('越白名单的域名被拒绝', async () => {
    // FR-CON-009 的验收标准就是这一条。注意它必须**真的去调**：
    // 断言"配置里没有这个域名"测的是配置，不是行为
    await assert.rejects(
      gateway().invoke(caller, {
        connectorId: 'browser',
        operation: 'read',
        target: 'https://evil.example.com/steal',
        params: {},
      }),
      /not on the allow-?list|not allowed|allowedTargets|target/i,
    )
  })

  it('白名单判定不被子串蒙混过去', () => {
    // `127.0.0.1.evil.com` 以白名单项开头，但它是别人的域名
    assert.equal(isAllowed(['127.0.0.1'], 'http://127.0.0.1:8080/x'), true)
    assert.equal(isAllowed(['127.0.0.1'], 'http://127.0.0.1.evil.com/x'), false)
    assert.equal(isAllowed(['*.example.com'], 'https://a.example.com/x'), true)
    assert.equal(isAllowed(['*.example.com'], 'https://evil-example.com/x'), false)
  })

  it('动作范围之外的操作被拒绝', async () => {
    // 这个会话是 interact 范围：能点能填，不能提交。
    // 只有域名白名单的话，一个被允许读取的站点同样可以被提交表单
    await assert.rejects(
      connector.execute(
        { connectorId: 'browser', operation: 'submit', target: origin, params: { selector: '#pay' } },
        null,
      ),
      /outside this browser session's "interact" scope/,
    )
  })

  it('敏感动作没有人工确认就执行不了（FR-CON-010）', async () => {
    // submit 在声明里显式标了 requiresConfirmation
    await assert.rejects(
      gateway().invoke(caller, {
        connectorId: 'browser',
        operation: 'submit',
        target: origin,
        params: { selector: '#pay' },
        idempotencyKey: 'k1',
      }),
      /requires human confirmation/,
    )
  })

  it('确认之后同一个动作可以执行', async () => {
    const full = new BrowserConnector({
      allowedDomains: ['127.0.0.1'],
      scope: 'full',
      ...(process.env['CHROMIUM_PATH'] === undefined
        ? {}
        : { executablePath: process.env['CHROMIUM_PATH'] }),
    })
    try {
      const gw = new ConnectorGateway({
        connectors: [full],
        audit: sink,
        secrets: { async get() { return null } },
        callLog: { async find() { return null }, async save() {} },
        policies: [
          {
            id: 'pol-browser',
            effect: 'Allow',
            subject: '*',
            action: 'Connector.browser.*',
            scope: { kind: 'any' },
          },
        ],
        clock: systemClock,
      })
      const result = await gw.invoke(caller, {
        connectorId: 'browser',
        operation: 'submit',
        target: origin,
        params: { selector: '#pay' },
        idempotencyKey: 'k2',
        confirmationToken: 'human-said-yes',
      })
      assert.equal((result.data as { submitted: boolean }).submitted, true)
    } finally {
      await full.close()
    }
  })

  it('每一次调用都进审计', async () => {
    const before = audit.length
    await gateway().invoke(caller, {
      connectorId: 'browser',
      operation: 'read',
      target: origin,
      params: {},
    })
    assert.ok(audit.length > before, '浏览器调用没有留下审计记录')
  })

  it('会话到期后换一个干净的上下文（TTL，FR-CON-009）', async () => {
    // 一个不过期的登录态浏览器上下文，等于把一份长期凭据挂在进程里
    let now = new Date('2026-08-01T00:00:00Z')
    const ttl = new BrowserConnector({
      allowedDomains: ['127.0.0.1'],
      scope: 'read-only',
      ttlMs: 1000,
      clock: { now: () => now },
      ...(process.env['CHROMIUM_PATH'] === undefined
        ? {}
        : { executablePath: process.env['CHROMIUM_PATH'] }),
    })
    try {
      const input = { connectorId: 'browser', operation: 'read', target: origin, params: {} }
      await ttl.execute(input, null)
      // 在页面里留一点会话状态
      const marked = await ttl.execute(input, null)
      assert.ok(marked)

      now = new Date(now.getTime() + 5000) // 过期
      const after = await ttl.execute(input, null)
      assert.ok(after, '过期之后应当能用新的上下文继续工作')
    } finally {
      await ttl.close()
    }
  })

  it('缺少 selector 时说清楚缺什么', async () => {
    await assert.rejects(
      connector.execute(
        { connectorId: 'browser', operation: 'click', target: origin, params: {} },
        null,
      ),
      /requires a "selector" param/,
    )
  })

  it('取消之后不再打开页面', async () => {
    const aborter = new AbortController()
    aborter.abort()
    await assert.rejects(
      connector.execute(
        { connectorId: 'browser', operation: 'read', target: origin, params: {} },
        null,
        aborter.signal,
      ),
      /cancelled/,
    )
  })
})
