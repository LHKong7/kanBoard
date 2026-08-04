import { describe, expect, it, vi } from 'vitest'
import { ConnectorGateway, isAllowed } from '../src/domain/connector/gateway.ts'
import { maskByClassification, maskValue } from '../src/domain/connector/masking.ts'
import { DEFAULT_LIMITS } from '../src/domain/connector/types.ts'
import type {
  CallInput,
  CallLogRepository,
  CallRecord,
  Connector,
  ConnectorSpec,
  SecretProvider,
} from '../src/domain/connector/types.ts'
import type { AuditRecord, AuditSink } from '../src/domain/resource/ports.ts'
import type { Caller } from '../src/domain/resource/service.ts'
import type { Policy } from '../src/identity/types.ts'
import { DomainError } from '../src/platform/errors.ts'

/**
 * Connector 网关（FR-CON-001..005 / 009..012）。
 *
 * 这些保证只有在**唯一入口**上才成立，所以这组用例的价值不在于
 * "调用能成功"，而在于每一条保证都真的挡得住对应的那种事故。
 */

const TENANT = 't_acme'

const caller = (principal = 'agent://coder@1.0.0', capabilities: string[] = ['Connector.*']): Caller => ({
  subject: { principal: principal as `agent://${string}`, tenant: TENANT, roles: ['AIAgent'], capabilities },
  traceId: 'tr_test',
})

const allowAll: Policy[] = [
  { id: 'pol-test-connector', effect: 'Allow', subject: '*', action: 'Connector.*', scope: { kind: 'tenant', tenant: TENANT } },
]

class MemoryCallLog implements CallLogRepository {
  readonly records: CallRecord[] = []
  async find(connectorId: string, operation: string, key: string): Promise<CallRecord | null> {
    return this.records.find(
      (r) => r.connectorId === connectorId && r.operation === operation && r.idempotencyKey === key,
    ) ?? null
  }
  async save(record: CallRecord): Promise<void> {
    this.records.push(record)
  }
}

class MemoryAudit implements AuditSink {
  readonly entries: AuditRecord[] = []
  async record(entry: AuditRecord): Promise<void> {
    this.entries.push(entry)
  }
}

const secrets: SecretProvider = { async get(ref) { return ref === 'GITHUB' ? 'ghp_supersecret' : null } }

/** 一个可编程的假 Connector：记录收到的凭据，可被指定失败若干次 */
function fakeConnector(overrides: Partial<ConnectorSpec> = {}, behaviour: {
  failTimes?: number
  failStatus?: number
  result?: unknown
} = {}): Connector & { calls: number; sawSecret: string | null } {
  let failures = behaviour.failTimes ?? 0
  const self = {
    calls: 0,
    sawSecret: null as string | null,
    spec: {
      id: 'fake',
      title: 'Fake',
      allowedTargets: ['api.github.com'],
      credentialRef: 'GITHUB',
      limits: DEFAULT_LIMITS,
      operations: [
        { name: 'getIssue', kind: 'read', description: 'r', returns: 'internal' },
        { name: 'createPr', kind: 'write', description: 'w', returns: 'internal' },
        { name: 'mergePr', kind: 'action', description: 'irreversible', returns: 'internal' },
        { name: 'getUser', kind: 'read', description: 'pii', returns: 'pii' },
      ],
      ...overrides,
    } as ConnectorSpec,
    async execute(_input: CallInput, secret: string | null): Promise<unknown> {
      self.calls++
      self.sawSecret = secret
      if (failures > 0) {
        failures--
        throw new DomainError('upstream', 'boom', behaviour.failStatus ?? 500)
      }
      return behaviour.result ?? { id: 42 }
    },
  }
  return self
}

function gatewayFor(connector: Connector, extra: Partial<ConstructorParameters<typeof ConnectorGateway>[0]> = {}) {
  const audit = new MemoryAudit()
  const callLog = new MemoryCallLog()
  const gateway = new ConnectorGateway({
    connectors: [connector],
    secrets,
    callLog,
    audit,
    policies: allowAll,
    clock: { now: () => new Date('2026-08-04T00:00:00Z') },
    ...extra,
  })
  return { gateway, audit, callLog }
}

const call = (over: Partial<CallInput> = {}): CallInput => ({
  connectorId: 'fake',
  operation: 'getIssue',
  target: 'https://api.github.com/repos/x/y',
  params: {},
  ...over,
})

describe('every call is authorized and audited (FR-CON-003)', () => {
  it('records the decision whether it allows or denies', async () => {
    const connector = fakeConnector()
    const { gateway, audit } = gatewayFor(connector)
    await gateway.invoke(caller(), call())

    expect(audit.entries).toHaveLength(1)
    expect(audit.entries[0]?.action).toBe('Connector.fake.getIssue')
    expect(audit.entries[0]?.decision.effect).toBe('Allow')
    expect(audit.entries[0]?.subject).toBe('agent://coder@1.0.0')
  })

  it('audits the denial too, and does not touch the external system', async () => {
    // 被拒的外部调用恰恰是最该留痕的
    const connector = fakeConnector()
    const { gateway, audit } = gatewayFor(connector, { policies: [] })

    await expect(gateway.invoke(caller(), call())).rejects.toThrow(/deny by default|no policy/i)
    expect(connector.calls).toBe(0)
    expect(audit.entries[0]?.decision.effect).toBe('Deny')
  })

  it('names the capability per connector and operation, so it can be granted separately', async () => {
    // "谁能让 Agent 合并 PR"要能单独授予与收回
    const connector = fakeConnector()
    const { gateway } = gatewayFor(connector, {
      policies: [
        { id: 'read-only', effect: 'Allow', subject: '*', action: 'Connector.fake.getIssue', scope: { kind: 'tenant', tenant: TENANT } },
      ],
    })
    await expect(gateway.invoke(caller(), call())).resolves.toBeTruthy()
    await expect(
      gateway.invoke(caller(), call({ operation: 'createPr', idempotencyKey: 'k1' })),
    ).rejects.toThrow(/forbidden|no policy/i)
  })
})

describe('targets are bounded by an allow-list (FR-CON-009)', () => {
  it('refuses a target outside the list and says what is allowed', async () => {
    const connector = fakeConnector()
    const onThrottled = vi.fn()
    const { gateway } = gatewayFor(connector, { onThrottled })

    await expect(
      gateway.invoke(caller(), call({ target: 'https://evil.example.com/steal' })),
    ).rejects.toThrow(/not in the allow-list/)
    expect(connector.calls).toBe(0)
    expect(onThrottled).toHaveBeenCalled()
  })

  it('treats an empty allow-list as "nothing", not as "anything"', async () => {
    // 漏配的白名单应当让 Connector 不可用，而不是全开
    const connector = fakeConnector({ allowedTargets: [] })
    const { gateway } = gatewayFor(connector)
    await expect(gateway.invoke(caller(), call())).rejects.toThrow(/not in the allow-list/)
  })

  it('supports subdomain wildcards but not arbitrary patterns', () => {
    expect(isAllowed(['*.example.com'], 'https://api.example.com/x')).toBe(true)
    expect(isAllowed(['*.example.com'], 'https://example.com/x')).toBe(false)
    // 一条写错的正则可以悄悄放开整个互联网，所以根本不支持正则
    expect(isAllowed(['.*'], 'https://evil.com')).toBe(false)
  })
})

describe('irreversible actions need a human (FR-CON-010)', () => {
  it('blocks an action operation with no confirmation', async () => {
    const connector = fakeConnector()
    const { gateway } = gatewayFor(connector)
    await expect(
      gateway.invoke(caller(), call({ operation: 'mergePr', idempotencyKey: 'k1' })),
    ).rejects.toThrow(/requires human confirmation/)
    expect(connector.calls).toBe(0)
  })

  it('proceeds once confirmed', async () => {
    const connector = fakeConnector()
    const { gateway } = gatewayFor(connector)
    const res = await gateway.invoke(
      caller(),
      call({ operation: 'mergePr', idempotencyKey: 'k1', confirmationToken: 'approved-by-alice' }),
    )
    expect(res.ok).toBe(true)
    expect(connector.calls).toBe(1)
  })

  it('defaults action operations to requiring confirmation without anyone opting in', async () => {
    // 想让机器自己按下这个按钮，必须在声明里显式写 false——
    // 那应该是一次看得见的决定，不是一个默认值
    const connector = fakeConnector()
    const merge = connector.spec.operations.find((o) => o.name === 'mergePr')
    expect(merge?.requiresConfirmation).toBeUndefined()
    expect(merge?.kind).toBe('action')
  })
})

describe('writes are idempotent (FR-CON-004)', () => {
  it('refuses a mutating call with no idempotency key', async () => {
    const connector = fakeConnector()
    const { gateway } = gatewayFor(connector)
    await expect(gateway.invoke(caller(), call({ operation: 'createPr' }))).rejects.toThrow(
      /requires an idempotencyKey/,
    )
  })

  it('replays the first result instead of calling the external system twice', async () => {
    // 没有这条，一次超时重试就会创建两个 PR
    const connector = fakeConnector()
    const { gateway } = gatewayFor(connector)
    const input = call({ operation: 'createPr', idempotencyKey: 'pr-42' })

    const first = await gateway.invoke(caller(), input)
    const second = await gateway.invoke(caller(), input)

    expect(first.replayed).toBe(false)
    expect(second.replayed).toBe(true)
    expect(second.data).toEqual(first.data)
    expect(connector.calls).toBe(1)
  })

  it('scopes the key to one operation, not globally', async () => {
    // 两个操作恰好用了同一个键，不该互相吞掉
    const connector = fakeConnector()
    const { gateway } = gatewayFor(connector)
    await gateway.invoke(caller(), call({ operation: 'createPr', idempotencyKey: 'same' }))
    await gateway.invoke(
      caller(),
      call({ operation: 'mergePr', idempotencyKey: 'same', confirmationToken: 'ok' }),
    )
    expect(connector.calls).toBe(2)
  })

  it('does not require a key for reads', async () => {
    const connector = fakeConnector()
    const { gateway } = gatewayFor(connector)
    await gateway.invoke(caller(), call())
    await gateway.invoke(caller(), call())
    expect(connector.calls).toBe(2)
  })
})

describe('retry, rate limit and circuit break (FR-CON-005)', () => {
  it('retries a 5xx with backoff and eventually succeeds', async () => {
    const connector = fakeConnector({}, { failTimes: 2, failStatus: 503 })
    const { gateway } = gatewayFor(connector)
    const res = await gateway.invoke(caller(), call())
    expect(res.attempts).toBe(3)
  })

  it('does not retry a 4xx', async () => {
    // 把 4xx 也重试一遍，等于用三倍流量撞同一堵墙
    const connector = fakeConnector({}, { failTimes: 99, failStatus: 400 })
    const { gateway } = gatewayFor(connector)
    await expect(gateway.invoke(caller(), call())).rejects.toThrow(/connector fake failed/)
    expect(connector.calls).toBe(1)
  })

  it('opens the circuit after repeated failure and stops calling out', async () => {
    const connector = fakeConnector(
      { limits: { ...DEFAULT_LIMITS, maxRetries: 0, breakAfterFailures: 2 } },
      { failTimes: 99, failStatus: 500 },
    )
    const { gateway } = gatewayFor(connector)

    await expect(gateway.invoke(caller(), call())).rejects.toThrow()
    await expect(gateway.invoke(caller(), call())).rejects.toThrow()
    const before = connector.calls

    await expect(gateway.invoke(caller(), call())).rejects.toThrow(/circuit-broken/)
    // 熔断后不再打外部系统——这才是熔断的意义
    expect(connector.calls).toBe(before)
  })

  it('rate limits per connector', async () => {
    const connector = fakeConnector({ limits: { ...DEFAULT_LIMITS, perMinute: 2 } })
    const onThrottled = vi.fn()
    const { gateway } = gatewayFor(connector, { onThrottled })

    await gateway.invoke(caller(), call())
    await gateway.invoke(caller(), call())
    await expect(gateway.invoke(caller(), call())).rejects.toThrow(/exceeded 2\/min/)
    expect(onThrottled).toHaveBeenCalledWith('fake', 'rate limit')
  })
})

describe('credentials never reach the caller (FR-CON-011)', () => {
  it('injects the secret into the adapter and keeps it out of the result', async () => {
    const connector = fakeConnector()
    const { gateway, audit } = gatewayFor(connector)
    const res = await gateway.invoke(caller(), call())

    expect(connector.sawSecret).toBe('ghp_supersecret')
    expect(JSON.stringify(res)).not.toContain('ghp_supersecret')
    expect(JSON.stringify(audit.entries)).not.toContain('ghp_supersecret')
  })

  it('masks credential-looking fields even on a non-sensitive operation', async () => {
    // 一个叫 apiKey 的字段绝不该原样流出去，不管这次调用的分级是什么
    const connector = fakeConnector({}, { result: { name: 'ok', apiKey: 'sk-live-123', nested: { token: 'abc' } } })
    const { gateway } = gatewayFor(connector)
    const res = await gateway.invoke(caller(), call())

    expect(JSON.stringify(res.data)).not.toContain('sk-live-123')
    expect(JSON.stringify(res.data)).not.toContain('abc')
    expect((res.data as { name: string }).name).toBe('ok')
  })
})

describe('data classification masking (FR-CON-012)', () => {
  it('masks PII but keeps its shape so the agent can still reason', async () => {
    const connector = fakeConnector({}, { result: { email: 'alice@example.com', phone: '+86 138 0000 1234' } })
    const { gateway } = gatewayFor(connector)
    const res = await gateway.invoke(caller(), call({ operation: 'getUser' }))

    const data = res.data as { email: string; phone: string }
    expect(data.email).toBe('a***@example.com')
    expect(data.phone).toBe('***1234')
  })

  it('drops secret-classified payloads wholesale', () => {
    // secret 级没有"部分可见"的安全说法
    expect(maskByClassification({ anything: 'here' }, 'secret')).toBe('[redacted:secret]')
  })

  it('leaves ordinary data alone', () => {
    const value = { title: 'Fix the build', count: 3 }
    expect(maskByClassification(value, 'internal')).toEqual(value)
  })

  it('keeps enough of a value to be recognisable', () => {
    expect(maskValue('alice@example.com')).toBe('a***@example.com')
    expect(maskValue('ab')).toBe('***')
    expect(maskValue('a-long-secret-value')).toBe('a-***')
  })
})

describe('the catalogue describes what is callable', () => {
  it('lists operations with their kind and confirmation requirement', async () => {
    const connector = fakeConnector()
    const { gateway } = gatewayFor(connector)
    const [entry] = gateway.catalogue()
    expect(entry?.id).toBe('fake')
    expect(entry?.operations.map((o) => o.name)).toContain('mergePr')
  })

  it('404s an unknown connector or operation, listing what exists', async () => {
    const connector = fakeConnector()
    const { gateway } = gatewayFor(connector)
    await expect(gateway.invoke(caller(), call({ connectorId: 'nope' }))).rejects.toThrow(
      /unknown connector/,
    )
    await expect(gateway.invoke(caller(), call({ operation: 'nope' }))).rejects.toThrow(
      /has no operation/,
    )
  })
})
