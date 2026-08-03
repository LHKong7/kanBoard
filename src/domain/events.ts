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
