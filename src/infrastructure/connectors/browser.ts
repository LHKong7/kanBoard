import type { Browser, BrowserContext } from 'playwright'
import { DomainError } from '../../platform/errors.ts'
import type { CallInput, Connector, ConnectorSpec } from '../../domain/connector/types.ts'
import type { Clock } from '../../platform/clock.ts'
import { systemClock } from '../../platform/clock.ts'

/**
 * Browser Connector（FR-CON-009 / FR-CON-010）。
 *
 * 这是**唯一**一个 Agent 能操作真实浏览器的入口，而它本身不做授权判断：
 * 域名白名单、人工确认、限流、重试、审计、脱敏全部由 ConnectorGateway
 * 在调用它之前完成。适配器只负责"把动作做出来"。
 *
 * 这个分工是刻意的。适配器会越写越多（GitHub、Jira、MCP…），
 * 每个都自己判一遍权限的话，第三个就会漏掉一条，
 * 而漏掉的表现是"这个连接器好像没有限制"——没人会去查一个能用的东西。
 *
 * 浏览器会话有 **TTL**（FR-CON-009 明确要求）：
 * 一个不过期的登录态浏览器上下文，等于把一份长期凭据挂在进程里。
 */

/** 会话存活多久。到期后下一次调用会开一个全新的、干净的上下文 */
export const SESSION_TTL_MS = 5 * 60 * 1000

/**
 * 动作范围（FR-CON-009 的"动作范围"）。
 *
 * 白名单管的是"能去哪个域名"，这里管的是"到了之后能做什么"。
 * 两者缺一不可：只有域名白名单的话，一个被允许读取的站点
 * 同样可以被点击、被提交表单。
 */
export type BrowserActionScope = 'read-only' | 'interact' | 'full'

const SCOPE_ALLOWS: Record<BrowserActionScope, readonly string[]> = {
  'read-only': ['read'],
  interact: ['read', 'click', 'fill'],
  full: ['read', 'click', 'fill', 'submit'],
}

export type BrowserConnectorOptions = {
  /** 域名白名单。**空数组表示不允许任何访问**，不是"不限制" */
  allowedDomains: readonly string[]
  scope?: BrowserActionScope
  ttlMs?: number
  clock?: Clock
  /** 容器里以 root 跑时 Chromium 的沙箱起不来。只影响测试环境 */
  executablePath?: string
}

export function browserConnectorSpec(options: BrowserConnectorOptions): ConnectorSpec {
  return {
    id: 'browser',
    title: '浏览器',
    allowedTargets: options.allowedDomains,
    operations: [
      {
        name: 'read',
        kind: 'read',
        description: '打开页面并取回可见文本',
        // 页面内容可能包含任何东西。按 confidential 处理，
        // 让网关在进入 Agent 上下文前脱敏
        returns: 'confidential',
      },
      {
        name: 'click',
        kind: 'action',
        description: '点击一个元素',
        returns: 'confidential',
      },
      {
        name: 'fill',
        kind: 'action',
        description: '在输入框里填值',
        returns: 'confidential',
      },
      {
        name: 'submit',
        kind: 'action',
        description: '提交表单。支付、下单、删除都会走到这里',
        returns: 'confidential',
        // 显式写出来而不是靠 kind === 'action' 的默认值：
        // 这一条是 FR-CON-010 点名的那类动作，值得在声明里看得见
        requiresConfirmation: true,
      },
    ],
    // 重试只给 1 次：浏览器动作大多不幂等，重试一次点击可能就是下了两单。
    // 熔断阈值给得低，因为浏览器失败通常意味着页面变了，多试无益
    limits: { perMinute: 30, maxRetries: 1, breakAfterFailures: 5, breakForMs: 60_000 },
  }
}

/**
 * 真实浏览器实现。
 *
 * 惰性启动：没有 Agent 用到浏览器时，不该有一个 Chromium 进程挂在那里。
 */
export class BrowserConnector implements Connector {
  readonly spec: ConnectorSpec
  readonly #options: BrowserConnectorOptions
  #browser: Browser | null = null
  #context: BrowserContext | null = null
  #openedAt = 0

  constructor(options: BrowserConnectorOptions) {
    this.#options = options
    this.spec = browserConnectorSpec(options)
  }

  async execute(input: CallInput, _secret: string | null, signal?: AbortSignal): Promise<unknown> {
    // 动作范围（FR-CON-009）。白名单管"去哪"，这里管"做什么"
    const scope = this.#options.scope ?? 'read-only'
    if (!SCOPE_ALLOWS[scope].includes(input.operation)) {
      throw new DomainError(
        'forbidden',
        `operation "${input.operation}" is outside this browser session's "${scope}" scope`,
        403,
        { scope, allowed: SCOPE_ALLOWS[scope] },
      )
    }

    if (signal?.aborted === true) {
      throw new DomainError('cancelled', 'browser call cancelled before starting', 499)
    }

    // 参数校验放在开浏览器**之前**。放在后面的话，一个少写了 selector 的调用
    // 会先花几百毫秒拉起 Chromium，再报一个本来立刻就能报的错——
    // 而在限流与熔断的计数里，它和一次真实失败长得一模一样
    const selector = input.operation === 'read' ? '' : selectorOf(input)

    const context = await this.#session()
    const page = await context.newPage()
    try {
      await page.goto(input.target, { waitUntil: 'domcontentloaded', timeout: 15_000 })

      switch (input.operation) {
        case 'read': {
          const title = await page.title()
          const text = (await page.locator('body').innerText()).slice(0, 20_000)
          return { url: page.url(), title, text }
        }
        case 'click': {
          await page.click(selector, { timeout: 10_000 })
          return { url: page.url(), clicked: selector }
        }
        case 'fill': {
          await page.fill(selector, String(input.params['value'] ?? ''), { timeout: 10_000 })
          return { url: page.url(), filled: selector }
        }
        case 'submit': {
          await page.click(selector, { timeout: 10_000 })
          await page.waitForLoadState('domcontentloaded')
          return { url: page.url(), submitted: true }
        }
        default:
          throw new DomainError('not_found', `unknown browser operation: ${input.operation}`, 404)
      }
    } finally {
      await page.close()
    }
  }

  /** 到期就换一个全新的上下文。旧的连同它的 cookie 一起丢掉 */
  async #session(): Promise<BrowserContext> {
    const now = (this.#options.clock ?? systemClock).now().getTime()
    const ttl = this.#options.ttlMs ?? SESSION_TTL_MS

    if (this.#context !== null && now - this.#openedAt < ttl) return this.#context

    // 过期的上下文必须**真的关掉**，不是丢掉引用了事：
    // 留着的话，那份登录态还在内存里，而且进程会慢慢攒出几十个上下文
    await this.#context?.close()

    if (this.#browser === null) {
      // 动态 import：只有真的要开浏览器时才把 playwright 加载进来。
      // 顶层 import 的话，只跑 API 的进程也会在启动时载入浏览器绑定——
      // 为一个它永远不会用到的能力付启动时间和内存
      const { chromium } = await import('playwright')
      this.#browser = await chromium.launch({
        args: ['--no-sandbox', '--disable-dev-shm-usage'],
        ...(this.#options.executablePath === undefined
          ? {}
          : { executablePath: this.#options.executablePath }),
      })
    }
    this.#context = await this.#browser.newContext()
    this.#openedAt = now
    return this.#context
  }

  /** 关停时调用。不关的话 Chromium 进程会活得比 Node 还久 */
  async close(): Promise<void> {
    await this.#context?.close()
    await this.#browser?.close()
    this.#context = null
    this.#browser = null
  }
}

function selectorOf(input: CallInput): string {
  const selector = input.params['selector']
  if (typeof selector !== 'string' || selector === '') {
    throw new DomainError('validation_failed', `${input.operation} requires a "selector" param`, 422, {
      field: 'selector',
    })
  }
  return selector
}
