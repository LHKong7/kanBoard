import { decide } from '../../identity/pdp.ts'
import type { Capability, Policy } from '../../identity/types.ts'
import { DomainError } from '../../platform/errors.ts'
import type { Clock } from '../../platform/clock.ts'
import type { AuditSink } from '../resource/ports.ts'
import type { Caller } from '../resource/service.ts'
import { maskByClassification } from './masking.ts'
import type {
  CallInput,
  CallLogRepository,
  CallResult,
  Connector,
  OperationSpec,
  SecretProvider,
} from './types.ts'

/**
 * Connector 网关（FR-CON-001..005 / 009..012）。
 *
 * 外部世界的唯一入口。所有的保证都装在这一处，因为它们**只有在唯一入口上
 * 才可能成立**——放两个入口，第二个迟早会漏掉其中一条。
 *
 * 每次调用依次经过：
 *
 *   ① 找到 Connector 与操作声明
 *   ② PDP 授权 + 审计（无论放行还是拒绝都留痕）
 *   ③ 目标白名单（越界即拒并告警）
 *   ④ 人工确认（不可逆操作）
 *   ⑤ 幂等（命中则直接返回上次结果，不碰外部系统）
 *   ⑥ 熔断与限流
 *   ⑦ 注入凭据 → 调用 → 指数退避重试
 *   ⑧ 按数据分级脱敏后返回
 *
 * 顺序不是随意的：授权在最前（未授权的调用连"这个 target 存不存在"
 * 都不该知道），脱敏在最后（凭据与 PII 绝不能因为中途抛错而漏出去）。
 */

export type GatewayDeps = {
  connectors: readonly Connector[]
  secrets: SecretProvider
  callLog: CallLogRepository
  audit: AuditSink
  policies: readonly Policy[]
  clock: Clock
  /** 需要人工确认时，校验凭证是否有效 */
  verifyConfirmation?: (token: string, input: CallInput) => boolean
  /** 观测钩子：限流与熔断的触发要能被监控到 */
  onThrottled?: (connectorId: string, reason: string) => void
}

type BreakerState = { failures: number; openUntil: number }

export class ConnectorGateway {
  readonly #deps: GatewayDeps
  readonly #breakers = new Map<string, BreakerState>()
  readonly #calls = new Map<string, number[]>()

  constructor(deps: GatewayDeps) {
    this.#deps = deps
  }

  /** 目录：Agent 与 UI 据此知道有哪些工具可用 */
  catalogue(): Array<{ id: string; title: string; operations: readonly OperationSpec[] }> {
    return this.#deps.connectors.map((c) => ({
      id: c.spec.id,
      title: c.spec.title,
      operations: c.spec.operations,
    }))
  }

  async invoke(caller: Caller, input: CallInput, signal?: AbortSignal): Promise<CallResult> {
    const connector = this.#deps.connectors.find((c) => c.spec.id === input.connectorId)
    if (connector === undefined) {
      throw new DomainError('not_found', `unknown connector: ${input.connectorId}`, 404, {
        known: this.#deps.connectors.map((c) => c.spec.id),
      })
    }
    const op = connector.spec.operations.find((o) => o.name === input.operation)
    if (op === undefined) {
      throw new DomainError(
        'not_found',
        `connector ${input.connectorId} has no operation "${input.operation}"`,
        404,
        { known: connector.spec.operations.map((o) => o.name) },
      )
    }

    // ② 授权 + 审计。能力名带上 Connector 与操作，
    //    于是"谁能让 Agent 合并 PR"是一条可以单独授予/收回的权限
    const action = `Connector.${connector.spec.id}.${op.name}` as Capability
    await this.#authorize(caller, action, input)

    // ③ 白名单。空清单 = 不允许任何目标，不是"不限制"
    if (!isAllowed(connector.spec.allowedTargets, input.target)) {
      this.#deps.onThrottled?.(connector.spec.id, `target out of scope: ${input.target}`)
      throw new DomainError(
        'forbidden',
        `target "${input.target}" is not in the allow-list for connector ${connector.spec.id}`,
        403,
        { allowed: connector.spec.allowedTargets },
      )
    }

    // ④ 人工确认。action 类默认需要，要关必须显式写 false
    const needsConfirmation = op.requiresConfirmation ?? op.kind === 'action'
    if (needsConfirmation) {
      const token = input.confirmationToken
      const valid =
        token !== undefined && (this.#deps.verifyConfirmation?.(token, input) ?? token.length > 0)
      if (!valid) {
        throw new DomainError(
          'confirmation_required',
          `operation ${op.name} is irreversible and requires human confirmation`,
          428,
          { connector: connector.spec.id, operation: op.name },
        )
      }
    }

    // ⑤ 幂等。写与动作必须带键——一次超时重试就会创建两个 PR
    const mutating = op.kind === 'write' || op.kind === 'action'
    if (mutating && (input.idempotencyKey ?? '') === '') {
      throw new DomainError(
        'validation_failed',
        `operation ${op.name} changes external state and requires an idempotencyKey`,
        422,
        { field: 'idempotencyKey' },
      )
    }
    if (mutating && input.idempotencyKey !== undefined) {
      const seen = await this.#deps.callLog.find(
        connector.spec.id,
        op.name,
        input.idempotencyKey,
      )
      if (seen !== null) {
        // 重放：**不碰外部系统**，返回第一次的结果
        return { ok: true, data: maskByClassification(seen.result, op.returns), replayed: true, attempts: 0 }
      }
    }

    // ⑥ 熔断与限流
    this.#assertClosed(connector.spec.id)
    this.#assertUnderRate(connector.spec.id, connector.spec.limits.perMinute)

    // ⑦ 注入凭据并调用。凭据只在这一段存在
    const secret =
      connector.spec.credentialRef === undefined
        ? null
        : await this.#deps.secrets.get(connector.spec.credentialRef)

    const { data, attempts } = await this.#callWithRetry(connector, input, secret, signal)

    if (mutating && input.idempotencyKey !== undefined) {
      await this.#deps.callLog.save({
        tenant: caller.subject.tenant,
        connectorId: connector.spec.id,
        operation: op.name,
        idempotencyKey: input.idempotencyKey,
        subject: caller.subject.principal,
        result: data,
        occurredAt: this.#deps.clock.now(),
      })
    }

    // ⑧ 脱敏在最后一步，且作用于**返回给调用方的值**
    return { ok: true, data: maskByClassification(data, op.returns), replayed: false, attempts }
  }

  async #authorize(caller: Caller, action: Capability, input: CallInput): Promise<void> {
    const now = this.#deps.clock.now()
    const decision = decide(
      {
        subject: caller.subject,
        action,
        resource: { tenant: caller.subject.tenant },
        delegator: caller.delegator,
        context: { mfa: caller.mfa, onBehalfOf: caller.delegator?.principal, runId: caller.runId, now },
      },
      this.#deps.policies,
    )

    // 先审计再抛：被拒的外部调用恰恰是最该留痕的
    await this.#deps.audit.record({
      tenant: caller.subject.tenant,
      subject: caller.subject.principal,
      onBehalfOf: caller.delegator?.principal ?? null,
      action,
      // 记 target 而不是完整 params：params 里可能有敏感值，
      // 而"谁对哪个目标做了什么"已经足够回答审计要回答的问题
      resourceId: input.target,
      resourceType: 'Connector',
      decision,
      runRef: caller.runId ?? null,
      occurredAt: now,
      traceId: caller.traceId ?? null,
    })

    if (decision.effect !== 'Allow') {
      throw new DomainError('forbidden', decision.reason, 403, {
        matchedPolicy: decision.matchedPolicy,
      })
    }
  }

  #assertClosed(connectorId: string): void {
    const breaker = this.#breakers.get(connectorId)
    if (breaker === undefined) return
    if (breaker.openUntil > this.#deps.clock.now().getTime()) {
      this.#deps.onThrottled?.(connectorId, 'circuit open')
      throw new DomainError(
        'unavailable',
        `connector ${connectorId} is circuit-broken after ${breaker.failures} consecutive failures`,
        503,
      )
    }
  }

  #assertUnderRate(connectorId: string, perMinute: number): void {
    const now = this.#deps.clock.now().getTime()
    const window = (this.#calls.get(connectorId) ?? []).filter((t) => now - t < 60_000)
    if (window.length >= perMinute) {
      this.#deps.onThrottled?.(connectorId, 'rate limit')
      throw new DomainError('rate_limited', `connector ${connectorId} exceeded ${perMinute}/min`, 429)
    }
    window.push(now)
    this.#calls.set(connectorId, window)
  }

  /**
   * 指数退避重试（FR-CON-005）。
   *
   * 只重试**可能是瞬时的**失败。把 4xx 也重试一遍，等于用三倍的流量
   * 去撞同一堵墙，而且会把限流撞得更死。
   */
  async #callWithRetry(
    connector: Connector,
    input: CallInput,
    secret: string | null,
    signal?: AbortSignal,
  ): Promise<{ data: unknown; attempts: number }> {
    const { maxRetries, breakAfterFailures, breakForMs } = connector.spec.limits
    let lastError: unknown

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      // 取消之后不再重试。退避重试最长能拖好几秒，
      // 而"取消了还在重试"正是取消看起来没生效的样子
      if (signal?.aborted === true) {
        throw new DomainError('cancelled', 'call cancelled before completing', 499, {
          connector: connector.spec.id,
          attempts: attempt,
        })
      }
      try {
        const data = await connector.execute(input, secret, signal)
        this.#breakers.delete(connector.spec.id)
        return { data, attempts: attempt + 1 }
      } catch (error) {
        lastError = error
        if (!isRetryable(error)) break
        if (attempt < maxRetries) await sleep(2 ** attempt * 100)
      }
    }

    const breaker = this.#breakers.get(connector.spec.id) ?? { failures: 0, openUntil: 0 }
    breaker.failures++
    if (breaker.failures >= breakAfterFailures) {
      breaker.openUntil = this.#deps.clock.now().getTime() + breakForMs
      this.#deps.onThrottled?.(connector.spec.id, `circuit opened after ${breaker.failures} failures`)
    }
    this.#breakers.set(connector.spec.id, breaker)

    throw new DomainError(
      'connector_failed',
      `connector ${connector.spec.id} failed: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
      502,
    )
  }
}

/**
 * 目标是否在白名单内。
 *
 * 支持 `*.example.com` 形式的子域通配。**不做**任意正则：
 * 一条写错的正则可以悄悄放开整个互联网，而没人看得出来。
 */
export function isAllowed(allowed: readonly string[], target: string): boolean {
  const host = hostOf(target)
  return allowed.some((pattern) => {
    if (pattern === host) return true
    if (pattern.startsWith('*.')) {
      const suffix = pattern.slice(1) // '.example.com'
      return host.endsWith(suffix) && host.length > suffix.length
    }
    return false
  })
}

function hostOf(target: string): string {
  try {
    return new URL(target).host
  } catch {
    // 不是 URL 就按原样比（repo 名、队列名之类）
    return target
  }
}

/** 值得重试的：网络抖动与服务端错误。4xx 是我们自己的问题，重试没用 */
function isRetryable(error: unknown): boolean {
  if (error instanceof DomainError) return error.status >= 500 || error.status === 429
  const status = (error as { status?: number })?.status
  if (typeof status === 'number') return status >= 500 || status === 429
  return true
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
