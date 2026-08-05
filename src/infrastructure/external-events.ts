import { createHmac, timingSafeEqual } from 'node:crypto'
import { DomainError } from '../platform/errors.ts'
import { externalEvent } from '../domain/events.ts'
import type { DomainEvent } from '../domain/events.ts'

/**
 * 外部事件入站（FR-WF-006：GitHub / CI / Kafka 触发自动化）。
 *
 * 这一层只做三件事：**验签、认出说的是哪个本地对象、翻译成领域事件**。
 * 翻译完就丢进 outbox，之后走的是和内部事件完全同一条路——
 * 同一个自动化引擎、同样的防环深度、同样的留痕。
 *
 * 另开一条"外部事件专用的处理链"会省一点事，代价是那条链上的
 * 熔断、留痕、幂等都要重新实现一遍，而重新实现的那份迟早会漏。
 *
 * **载荷是不可信输入。** 它来自系统外面，可能是伪造的、可能带着凭据、
 * 可能大到撑爆内存。所以：先验签再解析、只取声明过的字段、原始报文不落库。
 */

export type ExternalSource = {
  /** 来源 id，如 'github'。出现在 URL 与自动化规则里 */
  id: string
  /** 验签用的共享密钥 */
  secret: string
  /**
   * 事件名从哪儿来。
   *
   * GitHub 把类型放在 header（`x-github-event`），把子类型放在载荷的 `action`
   * 里，于是事件名是两段拼起来的。写成声明而不是 if 分支，
   * 是因为接第二个来源时要改的是配置，不是这段代码。
   */
  eventNameFrom: { header?: string; path?: string; join?: string }
  /**
   * 在这些字段里找 ProjectOS 的对象 id。
   *
   * 人本来就会把工单号写进 PR 标题、分支名、描述里。
   * 与其要求外部系统改流程来配合我们，不如从它们已经在写的地方去认。
   */
  subjectFrom: readonly string[]
  /** 翻译后带进事件的字段。**只有列出来的会带**，原始报文不进系统 */
  detailFrom?: readonly string[]
}

/** ProjectOS 的资源 id 形如 `task_01J…`（ULID） */
const RESOURCE_ID = /\b([a-z][a-z0-9]{1,23}_[0-9A-HJKMNP-TV-Z]{26})\b/

/**
 * 验签（FR-WF-006 的前提）。
 *
 * 用 `timingSafeEqual` 而不是 `===`：字符串比较会在第一个不同的字节上返回，
 * 于是攻击者可以按响应时间一个字节一个字节地把签名试出来。
 * 这条在本地测起来毫无差别，但它是真的。
 */
export function verifySignature(secret: string, body: string, signature: string): boolean {
  const expected = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`
  const a = Buffer.from(expected)
  const b = Buffer.from(signature)
  // 长度不同直接判否：timingSafeEqual 长度不等会抛
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

export type InboundEvent = {
  source: ExternalSource
  tenant: string
  /** 原始报文。**验签必须对这个串做**，不是对解析后的对象 */
  rawBody: string
  headers: Record<string, string | undefined>
  signature: string | undefined
  now: Date
  traceId?: string | null
}

/**
 * 把一次入站请求翻译成领域事件。
 *
 * 认不出关联对象时抛 422 而不是发一个 resourceId 为空的事件：
 * 一个不知道在说谁的事件，自动化引擎除了记一笔什么也做不了，
 * 而它会安静地堆在 outbox 里，看起来像"事件收到了"。
 */
export function translate(input: InboundEvent): DomainEvent {
  if (input.signature === undefined || input.signature === '') {
    throw new DomainError('unauthenticated', 'external events must be signed', 401, {
      source: input.source.id,
    })
  }
  if (!verifySignature(input.source.secret, input.rawBody, input.signature)) {
    throw new DomainError('unauthenticated', 'signature does not match', 401, {
      source: input.source.id,
    })
  }

  let payload: Record<string, unknown>
  try {
    payload = JSON.parse(input.rawBody) as Record<string, unknown>
  } catch {
    throw new DomainError('invalid_request', 'external event body is not valid JSON', 400)
  }

  const name = eventName(input.source, payload, input.headers)
  if (name === '') {
    throw new DomainError('invalid_request', 'could not determine the external event name', 400, {
      source: input.source.id,
    })
  }

  const subject = findSubject(input.source.subjectFrom, payload)
  if (subject === null) {
    throw new DomainError(
      'validation_failed',
      `no ProjectOS resource id found in ${JSON.stringify(input.source.subjectFrom)}`,
      422,
      { source: input.source.id, event: name, searched: input.source.subjectFrom },
    )
  }

  return externalEvent({
    tenant: input.tenant,
    source: input.source.id,
    event: name,
    resourceId: subject,
    // 类型从 id 前缀读出来。外部系统不知道我们的类型体系，也不该知道
    resourceType: typeOf(subject),
    detail: pick(payload, input.source.detailFrom ?? []),
    occurredAt: input.now,
    traceId: input.traceId ?? null,
  })
}

function eventName(
  source: ExternalSource,
  payload: Record<string, unknown>,
  headers: Record<string, string | undefined>,
): string {
  const parts: string[] = []
  if (source.eventNameFrom.header !== undefined) {
    const value = headers[source.eventNameFrom.header.toLowerCase()]
    if (value !== undefined && value !== '') parts.push(value)
  }
  if (source.eventNameFrom.path !== undefined) {
    const value = at(payload, source.eventNameFrom.path)
    if (typeof value === 'string' && value !== '') parts.push(value)
  }
  if (source.eventNameFrom.join !== undefined) {
    const value = at(payload, source.eventNameFrom.join)
    if (typeof value === 'string' && value !== '') parts.push(value)
  }
  return parts.join('.')
}

/** 在声明过的字段里找第一个像资源 id 的串 */
function findSubject(paths: readonly string[], payload: Record<string, unknown>): string | null {
  for (const path of paths) {
    const value = at(payload, path)
    if (typeof value !== 'string') continue
    const match = RESOURCE_ID.exec(value)
    if (match?.[1] !== undefined) return match[1]
  }
  return null
}

function typeOf(resourceId: string): string {
  const prefix = resourceId.split('_')[0] ?? ''
  return prefix.charAt(0).toUpperCase() + prefix.slice(1)
}

/** `a.b.c` 取值。数组下标不支持——支持它就得开始定义一门路径语言 */
function at(source: Record<string, unknown>, path: string): unknown {
  let current: unknown = source
  for (const key of path.split('.')) {
    if (typeof current !== 'object' || current === null) return undefined
    current = (current as Record<string, unknown>)[key]
  }
  return current
}

/** 只带声明过的字段进系统。原始报文里可能有 token、邮箱、整棵 diff */
function pick(payload: Record<string, unknown>, paths: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const path of paths) {
    const value = at(payload, path)
    if (value === undefined) continue
    // 值也可能很大（PR 正文、日志）。截断，事件不是存档
    out[path] = typeof value === 'string' ? value.slice(0, 500) : value
  }
  return out
}

/**
 * 内置来源。
 *
 * GitHub 的形状写在这里，是因为它是 PRD 点名的第一个（FR-WF-006）。
 * 接 CI 或 Kafka 时加一条配置即可——这段代码不需要改。
 */
export const GITHUB_SOURCE = (secret: string): ExternalSource => ({
  id: 'github',
  secret,
  // 'pull_request' + '.' + 'closed'
  eventNameFrom: { header: 'x-github-event', join: 'action' },
  // 人会把工单号写进这三个地方中的某一个
  subjectFrom: ['pull_request.title', 'pull_request.head.ref', 'pull_request.body'],
  detailFrom: ['pull_request.number', 'pull_request.merged', 'pull_request.html_url'],
})
