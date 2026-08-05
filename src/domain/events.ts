/**
 * 领域事件。
 *
 * 事件与业务写入同事务落 outbox（FR-RES-006），由 poller 发布。
 * 跨限界上下文的一切交互都走事件——原则 P2.2 禁止直接写别人的聚合。
 */

export type DomainEvent = {
  type: DomainEventType
  tenant: string
  resourceId: string
  resourceType: string
  payload: Record<string, unknown>
  occurredAt: Date
  traceId: string | null
}

export type DomainEventType =
  | 'ResourceCreated'
  | 'ResourceUpdated'
  | 'ResourceDeleted'
  | 'ResourceStatusChanged'
  | 'RelationCreated'
  | 'RelationRemoved'
  /** 一条规则想建的边没建成（FR-ONT-008）。安静跳过等于这条规则不存在 */
  | 'RelationRuleSkipped'
  /**
   * 外部系统送进来的事件（FR-WF-006：GitHub / CI / Kafka）。
   *
   * 只有一种类型，不是每个来源一种：来源与事件名放在 payload 里，
   * 自动化规则按它们匹配。每接一个系统就往这个联合里加一个成员的话，
   * 领域层会开始认识 GitHub——而它不该知道外面有谁。
   */
  | 'ExternalEvent'

export function resourceCreated(args: {
  tenant: string
  resourceId: string
  resourceType: string
  createdBy: string
  occurredAt: Date
  traceId?: string | null
}): DomainEvent {
  return {
    type: 'ResourceCreated',
    tenant: args.tenant,
    resourceId: args.resourceId,
    resourceType: args.resourceType,
    payload: { createdBy: args.createdBy },
    occurredAt: args.occurredAt,
    traceId: args.traceId ?? null,
  }
}

export function resourceUpdated(args: {
  tenant: string
  resourceId: string
  resourceType: string
  version: number
  changedPaths: readonly string[]
  changedBy: string
  occurredAt: Date
  traceId?: string | null
}): DomainEvent {
  return {
    type: 'ResourceUpdated',
    tenant: args.tenant,
    resourceId: args.resourceId,
    resourceType: args.resourceType,
    payload: {
      version: args.version,
      changedPaths: [...args.changedPaths],
      changedBy: args.changedBy,
    },
    occurredAt: args.occurredAt,
    traceId: args.traceId ?? null,
  }
}

/**
 * 状态变化单独发一个事件。
 *
 * 订阅方大多只关心状态流转（"Task 完成了"），
 * 让它们去 ResourceUpdated 的 changedPaths 里筛选既啰嗦又容易漏。
 */
export function resourceStatusChanged(args: {
  tenant: string
  resourceId: string
  resourceType: string
  from: string
  to: string
  changedBy: string
  occurredAt: Date
  traceId?: string | null
}): DomainEvent {
  return {
    type: 'ResourceStatusChanged',
    tenant: args.tenant,
    resourceId: args.resourceId,
    resourceType: args.resourceType,
    payload: { from: args.from, to: args.to, changedBy: args.changedBy },
    occurredAt: args.occurredAt,
    traceId: args.traceId ?? null,
  }
}

export function resourceDeleted(args: {
  tenant: string
  resourceId: string
  resourceType: string
  deletedBy: string
  occurredAt: Date
  traceId?: string | null
}): DomainEvent {
  return {
    type: 'ResourceDeleted',
    tenant: args.tenant,
    resourceId: args.resourceId,
    resourceType: args.resourceType,
    payload: { deletedBy: args.deletedBy },
    occurredAt: args.occurredAt,
    traceId: args.traceId ?? null,
  }
}

export function relationRemoved(args: {
  tenant: string
  relationId: string
  relationType: string
  fromId: string
  toId: string
  removedBy: string
  occurredAt: Date
  traceId?: string | null
}): DomainEvent {
  return {
    type: 'RelationRemoved',
    tenant: args.tenant,
    // 以 fromId 为主体：订阅方关心的是"这个对象少了一条关系"
    resourceId: args.fromId,
    resourceType: 'Relation',
    payload: {
      relationId: args.relationId,
      relationType: args.relationType,
      fromId: args.fromId,
      toId: args.toId,
      removedBy: args.removedBy,
    },
    occurredAt: args.occurredAt,
    traceId: args.traceId ?? null,
  }
}

/**
 * 一条规则想建的边**没建成**（FR-ONT-008）。
 *
 * 为什么这要是一个事件，而不是一句 catch 里的注释：规则跑在别人的写入
 * 路径上，它失败了不该把那次写入带走（用户只是改了个标题）。
 * 但**安静地跳过等于这条规则根本不存在**——而配规则的人会以为它在生效。
 * 走 outbox 之后，"这条规则一直没建成过任何边"变成一个查得出来的事实。
 */
export function relationRuleSkipped(args: {
  tenant: string
  ruleId: string
  relationType: string
  fromId: string
  toId: string
  reason: string
  occurredAt: Date
  traceId?: string | null
}): DomainEvent {
  return {
    type: 'RelationRuleSkipped',
    tenant: args.tenant,
    resourceId: args.fromId,
    resourceType: 'Relation',
    payload: {
      ruleId: args.ruleId,
      relationType: args.relationType,
      fromId: args.fromId,
      toId: args.toId,
      reason: args.reason,
    },
    occurredAt: args.occurredAt,
    traceId: args.traceId ?? null,
  }
}

export function relationCreated(args: {
  tenant: string
  relationId: string
  relationType: string
  fromId: string
  toId: string
  createdBy: string
  occurredAt: Date
  traceId?: string | null
}): DomainEvent {
  return {
    type: 'RelationCreated',
    tenant: args.tenant,
    resourceId: args.fromId,
    resourceType: 'Relation',
    payload: {
      relationId: args.relationId,
      relationType: args.relationType,
      fromId: args.fromId,
      toId: args.toId,
      createdBy: args.createdBy,
    },
    occurredAt: args.occurredAt,
    traceId: args.traceId ?? null,
  }
}


/**
 * 外部事件（FR-WF-006）。
 *
 * `resourceId` 是**被这件事影响的本地对象**，由入站翻译层从外部载荷里认出来。
 * 认不出来就不该发这个事件——一个不知道在说谁的事件，
 * 自动化引擎除了记一笔什么也做不了。
 */
export function externalEvent(args: {
  tenant: string
  /** 来源系统，如 'github' */
  source: string
  /** 外部事件名，如 'pull_request.closed' */
  event: string
  /** 关联到的本地对象 */
  resourceId: string
  resourceType: string
  /** 已经过筛选的外部载荷片段。**不放原始报文**——里面可能有凭据 */
  detail: Record<string, unknown>
  occurredAt: Date
  traceId?: string | null
}): DomainEvent {
  return {
    type: 'ExternalEvent',
    tenant: args.tenant,
    resourceId: args.resourceId,
    resourceType: args.resourceType,
    payload: { source: args.source, event: args.event, ...args.detail },
    occurredAt: args.occurredAt,
    traceId: args.traceId ?? null,
  }
}
