/**
 * 领域错误。
 *
 * 每个错误都携带 HTTP 状态与机器可读的 `code`，API 层直接映射，
 * 领域层因此不需要知道 HTTP 的存在。
 */
export class DomainError extends Error {
  readonly code: string
  readonly status: number
  readonly details: unknown

  constructor(code: string, message: string, status: number, details?: unknown) {
    super(message)
    this.name = 'DomainError'
    this.code = code
    this.status = status
    this.details = details ?? null
  }
}

/** 本体校验失败：字段级错误（FR-ONT-002 要求返回字段级原因） */
export class ValidationError extends DomainError {
  constructor(message: string, details?: unknown) {
    super('validation_failed', message, 422, details)
    this.name = 'ValidationError'
  }
}

/** 资源不存在——跨租户访问也走这里，不泄漏"存在但无权" */
export class NotFoundError extends DomainError {
  constructor(id: string) {
    super('not_found', `resource ${id} not found`, 404)
    this.name = 'NotFoundError'
  }
}

/** 乐观锁冲突（FR-RES-003） */
export class ConflictError extends DomainError {
  constructor(id: string, expected: number, actual: number) {
    super(
      'version_conflict',
      `resource ${id} was modified: expected version ${expected}, found ${actual}`,
      409,
      { expected, actual },
    )
    this.name = 'ConflictError'
  }
}

/** 授权拒绝（FR-IAM-002） */
export class ForbiddenError extends DomainError {
  constructor(reason: string, details?: unknown) {
    super('forbidden', reason, 403, details)
    this.name = 'ForbiddenError'
  }
}

/** 需要人工确认才能继续（FR-IAM-009 的 Ask 策略） */
export class ApprovalRequiredError extends DomainError {
  constructor(reason: string, details?: unknown) {
    super('approval_required', reason, 428, details)
    this.name = 'ApprovalRequiredError'
  }
}

/** 状态迁移非法（FR-WF-003 要求返回可读原因） */
export class TransitionError extends DomainError {
  constructor(message: string, details?: unknown) {
    super('illegal_transition', message, 409, details)
    this.name = 'TransitionError'
  }
}
