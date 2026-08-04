import type { DataClassification } from '../../ontology/types.ts'

/**
 * Connector 统一契约（FR-CON-001）。
 *
 * 外部系统只能经由这里进入系统。这不是"为了整齐"，而是因为
 * 有一整组保证只有在**唯一入口**上才可能成立：
 *
 *   FR-CON-003  每次调用都过 PDP 并审计
 *   FR-CON-004  写操作幂等
 *   FR-CON-005  限流、退避重试、熔断
 *   FR-CON-011  凭据由 Secret Manager 注入，不进 Agent 上下文
 *   FR-CON-012  按数据分级脱敏
 *
 * 只要允许某个 Agent 直接 `fetch` 一次外部 API，上面五条就同时失效——
 * 而且是**静默**失效：没有报错，只是那一次调用没有审计、没有限流、
 * 凭据可能被写进了 prompt。所以 FR-CON-002 的措辞是"无法绕过"，
 * 不是"不应绕过"。
 */

/** 五类操作。刻意很窄：能力集合越小，越容易说清"这个 Connector 能做什么" */
export type OperationKind =
  | 'read'
  /** 有副作用，需要幂等键 */
  | 'write'
  /** 拉取一批变更（对账、增量同步） */
  | 'observe'
  /** 订阅推送（webhook 注册） */
  | 'subscribe'
  /** 不可逆或高风险的动作（合并、发布、支付、删除） */
  | 'action'

export type OperationSpec = {
  name: string
  kind: OperationKind
  description: string
  /**
   * 这次调用的产出里最高的数据分级（FR-CON-012）。
   * 网关据此决定进 Agent 上下文前要不要脱敏。
   */
  returns: DataClassification
  /**
   * 需要人工确认才能执行（FR-CON-010）。
   *
   * `action` 类默认为真——不可逆操作永远要人。
   * 想关掉必须在声明里显式写 false，让"我们决定让机器自己按下这个按钮"
   * 成为一次看得见的决定，而不是一个默认值。
   */
  requiresConfirmation?: boolean
}

export type ConnectorSpec = {
  id: string
  title: string
  operations: readonly OperationSpec[]
  /**
   * 允许访问的目标范围（FR-CON-009）。
   * 对 Browser 是域名白名单，对 REST 是 host 白名单。
   * **空数组表示不允许任何外部访问**，不是"不限制"——
   * 一个漏配的白名单应当让 Connector 不可用，而不是全开。
   */
  allowedTargets: readonly string[]
  /** 凭据在 Secret Manager 里的名字。网关按它取，调用方永远拿不到值 */
  credentialRef?: string
  limits: RateLimits
}

export type RateLimits = {
  /** 每分钟最多几次 */
  perMinute: number
  /** 失败重试次数（不含首次） */
  maxRetries: number
  /** 连续失败多少次后熔断 */
  breakAfterFailures: number
  /** 熔断持续多久 */
  breakForMs: number
}

export const DEFAULT_LIMITS: RateLimits = {
  perMinute: 60,
  maxRetries: 3,
  breakAfterFailures: 5,
  breakForMs: 30_000,
}

export type CallInput = {
  connectorId: string
  operation: string
  /** 调用目标，用于白名单校验（URL / repo / 域名） */
  target: string
  params: Record<string, unknown>
  /**
   * 幂等键（FR-CON-004）。write / action 必填。
   *
   * 重复投递同一个键不会产生第二个对象——网关返回第一次的结果。
   * 没有它，一次超时重试就会创建两个 PR。
   */
  idempotencyKey?: string
  /**
   * 人工确认凭证。需要确认的操作缺了它就拒（FR-CON-010）。
   */
  confirmationToken?: string
}

export type CallResult = {
  ok: boolean
  /** 已按分级脱敏后的数据，可以安全进入 Agent 上下文 */
  data: unknown
  /** 是否命中了幂等记录（即这次没有真的调用外部系统） */
  replayed: boolean
  attempts: number
}

/**
 * 外部系统适配器。
 *
 * 注意签名里**没有凭据**：凭据由网关注入到 `secret` 参数，
 * 适配器用完即弃，不得存下来、不得放进返回值。
 */
export interface Connector {
  readonly spec: ConnectorSpec
  /**
   * `signal` 必须被适配器传给它底层的 HTTP 客户端（FR-ARCH-011）。
   *
   * 只在网关这一层查信号是不够的：一次挂住的外部请求可以卡上几分钟，
   * 而验收标准要求取消在 5 秒内生效。信号必须一路传到真正等待的地方。
   */
  execute(input: CallInput, secret: string | null, signal?: AbortSignal): Promise<unknown>
}

/**
 * 凭据来源（FR-CON-011）。
 *
 * 做成端口是为了让"凭据从哪来"成为部署配置而不是代码常量。
 * 实现必须保证：取到的值只在一次调用的生命周期里存在，
 * 不写日志、不进审计详情、不进 Agent 上下文。
 */
export interface SecretProvider {
  get(ref: string): Promise<string | null>
}

/** 幂等记录的存储（FR-CON-004） */
export interface CallLogRepository {
  /** 查已有记录；命中说明这次是重复投递 */
  find(connectorId: string, operation: string, idempotencyKey: string): Promise<CallRecord | null>
  save(record: CallRecord): Promise<void>
}

export type CallRecord = {
  tenant: string
  connectorId: string
  operation: string
  idempotencyKey: string
  subject: string
  result: unknown
  occurredAt: Date
}
