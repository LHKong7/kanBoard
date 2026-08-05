import { describe, expect, it } from 'vitest'
import {
  BrowserConnector,
  browserConnectorSpec,
  SESSION_TTL_MS,
} from '../src/infrastructure/connectors/browser.ts'
import type { CallInput } from '../src/domain/connector/types.ts'

/**
 * Browser Connector 里**不需要浏览器**的那一半。
 *
 * 真正开 Chromium 的端到端用例在 tests/ui/browser-connector.test.ts
 * （用 Node 内置 runner，理由见 tests/ui/README.md）。
 * 这里测的是声明与前置判断——它们决定了一次调用**会不会走到浏览器**，
 * 而那正是最该被快速、确定性地钉住的部分。
 */

const call = (operation: string, params: Record<string, unknown> = {}): CallInput => ({
  connectorId: 'browser',
  operation,
  target: 'http://127.0.0.1:1/x',
  params,
})

describe('the browser connector declares its limits (FR-CON-009/010)', () => {
  it('publishes the domain allow-list as its allowed targets', () => {
    const spec = browserConnectorSpec({ allowedDomains: ['*.example.com'] })
    expect(spec.allowedTargets).toEqual(['*.example.com'])
  })

  it('treats an empty allow-list as "nothing", which the gateway then refuses', () => {
    // 漏配的白名单应当让连接器不可用，而不是全开
    expect(browserConnectorSpec({ allowedDomains: [] }).allowedTargets).toHaveLength(0)
  })

  it('marks submit as requiring human confirmation, in the declaration', () => {
    // 支付 / 下单 / 删除都走 submit。靠 kind === 'action' 的默认值也能拦住，
    // 但显式写出来才让"我们决定让机器自己按这个按钮"必须是一次看得见的改动
    const spec = browserConnectorSpec({ allowedDomains: ['x'] })
    const submit = spec.operations.find((o) => o.name === 'submit')
    expect(submit?.requiresConfirmation).toBe(true)
  })

  it('classifies page content as confidential so the gateway masks it', () => {
    // 页面上可能有任何东西。按低分级声明的话，
    // 一段带着邮箱和手机号的页面会原样进 Agent 上下文
    const spec = browserConnectorSpec({ allowedDomains: ['x'] })
    expect(spec.operations.every((o) => o.returns === 'confidential')).toBe(true)
  })

  it('retries at most once, because browser actions are not idempotent', () => {
    // 重试一次点击可能就是下了两单
    expect(browserConnectorSpec({ allowedDomains: ['x'] }).limits.maxRetries).toBe(1)
  })

  it('bounds the session lifetime', () => {
    // 一个不过期的登录态上下文，等于把一份长期凭据挂在进程里
    expect(SESSION_TTL_MS).toBeGreaterThan(0)
    expect(SESSION_TTL_MS).toBeLessThanOrEqual(30 * 60 * 1000)
  })
})

describe('action scope is checked before the browser is ever opened', () => {
  const connector = (scope: 'read-only' | 'interact' | 'full') =>
    new BrowserConnector({ allowedDomains: ['127.0.0.1'], scope })

  it('read-only refuses to click', async () => {
    // 只有域名白名单的话，一个被允许读取的站点同样可以被点击
    await expect(connector('read-only').execute(call('click', { selector: '#x' }), null)).rejects.toThrow(
      /outside this browser session's "read-only" scope/,
    )
  })

  it('interact refuses to submit', async () => {
    await expect(connector('interact').execute(call('submit', { selector: '#x' }), null)).rejects.toThrow(
      /"interact" scope/,
    )
  })

  it('defaults to read-only when no scope is declared', async () => {
    // 缺省必须是最小的那一侧
    const c = new BrowserConnector({ allowedDomains: ['127.0.0.1'] })
    await expect(c.execute(call('fill', { selector: '#x' }), null)).rejects.toThrow(/"read-only"/)
  })

  it('names what the scope does allow', async () => {
    // "超出范围"四个字会让人去猜；把允许的列出来才能改对
    try {
      await connector('read-only').execute(call('submit', { selector: '#x' }), null)
      expect.unreachable('should have thrown')
    } catch (error) {
      const details = (error as { details: { allowed: string[] } }).details
      expect(details.allowed).toEqual(['read'])
    }
  })

  it('refuses a click with no selector before opening anything', async () => {
    await expect(connector('interact').execute(call('click'), null)).rejects.toThrow(
      /requires a "selector" param/,
    )
  })

  it('refuses an already-cancelled call without launching', async () => {
    const aborter = new AbortController()
    aborter.abort()
    await expect(connector('read-only').execute(call('read'), null, aborter.signal)).rejects.toThrow(
      /cancelled/,
    )
  })
})
