import { decide } from '../../identity/pdp.ts'
import type { Capability, Decision, Policy, ResourceRef, SubjectProfile } from '../../identity/types.ts'
import type { OntologyRegistry } from '../../ontology/registry.ts'
import type { Clock } from '../../platform/clock.ts'
import {
  ApprovalRequiredError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '../../platform/errors.ts'
import { newRelationId, newResourceId } from '../../platform/id.ts'
import {
  relationCreated,
  resourceCreated,
  resourceDeleted,
  resourceStatusChanged,
  resourceUpdated,
} from '../events.ts'
import type {
  AuditSink,
  EventSink,
  Page,
  PageResult,
  PathHit,
  RelationRepository,
  ResourceFilter,
  ResourceRepository,
  TraverseHit,
} from './ports.ts'
import { diffResource, VISIBILITIES } from './resource.ts'
import type { CreateResourceInput, Resource, UpdateResourceInput, Visibility } from './resource.ts'
import type { RelationInstance, RelationOrigin } from '../../ontology/types.ts'

/**
 * 调用者身份。人与 Agent 使用同一个结构——
 * 这是 ADR-0002 的硬性要求：不存在 Agent 专用路径，也就不该有 Agent 专用的调用者类型。
 */
export type Caller = {
  subject: SubjectProfile
  /** Agent 代表用户执行时的委派来源 */
  delegator?: SubjectProfile | undefined
  runId?: string | undefined
  traceId?: string | undefined
  mfa?: boolean | undefined
}

export type ServiceDeps = {
  registry: OntologyRegistry
  resources: ResourceRepository
  relations: RelationRepository
  events: EventSink
  audit: AuditSink
  policies: readonly Policy[]
  clock: Clock
}

export class ResourceService {
  readonly #deps: ServiceDeps

  constructor(deps: ServiceDeps) {
    this.#deps = deps
  }

  // ───────────────────────── 授权 ─────────────────────────

  /**
   * 所有读写的唯一入口。
   *
   * 注意它返回 void 而不是 boolean：调用方无法"忘记检查返回值"，
   * 不通过就抛异常。这是刻意的——授权检查不应该有静默失败的可能。
   */
  async #authorize(
    caller: Caller,
    action: Capability,
    resource: ResourceRef,
    resourceOwner?: string,
    resourceType?: string,
  ): Promise<void> {
    const now = this.#deps.clock.now()
    const decision = decide(
      {
        subject: caller.subject,
        action,
        resource,
        delegator: caller.delegator,
        context: {
          resourceOwner,
          mfa: caller.mfa,
          onBehalfOf: caller.delegator?.principal,
          runId: caller.runId,
          now,
        },
      },
      this.#deps.policies,
    )

    // 审计先于抛错：被拒绝的尝试恰恰是最需要记录的（FR-IAM-013）
    await this.#deps.audit.record({
      tenant: resource.tenant,
      subject: caller.subject.principal,
      onBehalfOf: caller.delegator?.principal ?? null,
      action,
      resourceId: resource.id ?? null,
      resourceType: resourceType ?? resource.type ?? null,
      decision,
      runRef: caller.runId ?? null,
      occurredAt: now,
      traceId: caller.traceId ?? null,
    })

    throwIfNotAllowed(decision)
  }

  // ───────────────────────── 写 ─────────────────────────

  async create(caller: Caller, input: CreateResourceInput): Promise<Resource> {
    const def = this.#deps.registry.entityType(input.type)
    const tenant = caller.subject.tenant

    await this.#authorize(
      caller,
      `${input.type}.Create`,
      { tenant, workspace: input.workspace, project: input.project ?? undefined, type: input.type },
      undefined,
      input.type,
    )

    const attributes = this.#deps.registry.validateAttributes(input.type, input.attributes ?? {})
    const visibility = assertVisibility(input.visibility ?? 'workspace')
    const now = this.#deps.clock.now()

    const resource: Resource = {
      id: newResourceId(input.type),
      type: input.type,
      ontologyVersion: def.version,
      tenant,
      workspace: input.workspace,
      project: input.project ?? null,
      owner: input.owner ?? caller.subject.principal,
      createdBy: caller.subject.principal,
      createdAt: now,
      updatedAt: now,
      // 状态机由 Workflow Engine 在 M1 接管；此前用本体声明的初始状态占位
      status: input.status ?? 'Draft',
      lifecycle: def.lifecycle ?? null,
      version: 1,
      labels: input.labels ?? [],
      attributes,
      visibility,
      deletedAt: null,
    }

    await this.#deps.resources.insert(resource)
    await this.#deps.resources.appendHistory({
      resourceId: resource.id,
      version: 1,
      changedBy: caller.subject.principal,
      onBehalfOf: caller.delegator?.principal ?? null,
      changedAt: now,
      runRef: caller.runId ?? null,
      changes: [{ path: '(created)', from: null, to: resource.type }],
      reason: null,
      traceId: caller.traceId ?? null,
    })
    await this.#deps.events.emit(
      resourceCreated({
        tenant,
        resourceId: resource.id,
        resourceType: resource.type,
        createdBy: caller.subject.principal,
        occurredAt: now,
        traceId: caller.traceId ?? null,
      }),
    )

    return resource
  }

  async update(caller: Caller, id: string, input: UpdateResourceInput): Promise<Resource> {
    const existing = await this.#requireLive(id)

    await this.#authorize(
      caller,
      `${existing.type}.Update`,
      {
        tenant: existing.tenant,
        workspace: existing.workspace,
        project: existing.project ?? undefined,
        id: existing.id,
        type: existing.type,
      },
      existing.owner,
      existing.type,
    )

    if (existing.version !== input.expectedVersion) {
      throw new ConflictError(id, input.expectedVersion, existing.version)
    }

    // attributes 是整体替换而非合并：合并语义下无法表达"删除一个属性"
    const attributes =
      input.attributes === undefined
        ? existing.attributes
        : this.#deps.registry.validateAttributes(existing.type, input.attributes)

    const now = this.#deps.clock.now()
    const next: Resource = {
      ...existing,
      status: input.status ?? existing.status,
      labels: input.labels ?? existing.labels,
      attributes,
      visibility: input.visibility === undefined ? existing.visibility : assertVisibility(input.visibility),
      owner: input.owner ?? existing.owner,
      version: existing.version + 1,
      updatedAt: now,
    }

    const changes = diffResource(existing, next)
    if (changes.length === 0) {
      // 无实际变化就不推进版本号，否则并发写会因为无意义的版本漂移而互相冲突
      return existing
    }

    const updated = await this.#deps.resources.update(next, input.expectedVersion)
    if (!updated) {
      // 读取之后、更新之前被人抢先——重新读一次给出准确的实际版本
      const current = await this.#deps.resources.findById(id)
      throw new ConflictError(id, input.expectedVersion, current?.version ?? -1)
    }

    await this.#deps.resources.appendHistory({
      resourceId: id,
      version: next.version,
      changedBy: caller.subject.principal,
      onBehalfOf: caller.delegator?.principal ?? null,
      changedAt: now,
      runRef: caller.runId ?? null,
      changes,
      reason: input.reason ?? null,
      traceId: caller.traceId ?? null,
    })

    await this.#deps.events.emit(
      resourceUpdated({
        tenant: existing.tenant,
        resourceId: id,
        resourceType: existing.type,
        version: next.version,
        changedPaths: changes.map((c) => c.path),
        changedBy: caller.subject.principal,
        occurredAt: now,
        traceId: caller.traceId ?? null,
      }),
    )

    if (existing.status !== next.status) {
      await this.#deps.events.emit(
        resourceStatusChanged({
          tenant: existing.tenant,
          resourceId: id,
          resourceType: existing.type,
          from: existing.status,
          to: next.status,
          changedBy: caller.subject.principal,
          occurredAt: now,
          traceId: caller.traceId ?? null,
        }),
      )
    }

    return next
  }

  /** 软删除（FR-RES-004）。历史与关系都保留，只是不再出现在默认查询中。 */
  async softDelete(caller: Caller, id: string, expectedVersion: number): Promise<void> {
    const existing = await this.#requireLive(id)

    await this.#authorize(
      caller,
      `${existing.type}.Delete`,
      {
        tenant: existing.tenant,
        workspace: existing.workspace,
        project: existing.project ?? undefined,
        id: existing.id,
        type: existing.type,
      },
      existing.owner,
      existing.type,
    )

    if (existing.version !== expectedVersion) {
      throw new ConflictError(id, expectedVersion, existing.version)
    }

    const now = this.#deps.clock.now()
    const next: Resource = { ...existing, deletedAt: now, updatedAt: now, version: existing.version + 1 }

    const ok = await this.#deps.resources.update(next, expectedVersion)
    if (!ok) {
      const current = await this.#deps.resources.findById(id)
      throw new ConflictError(id, expectedVersion, current?.version ?? -1)
    }

    await this.#deps.resources.appendHistory({
      resourceId: id,
      version: next.version,
      changedBy: caller.subject.principal,
      onBehalfOf: caller.delegator?.principal ?? null,
      changedAt: now,
      runRef: caller.runId ?? null,
      changes: [{ path: 'deletedAt', from: null, to: now.toISOString() }],
      reason: null,
      traceId: caller.traceId ?? null,
    })

    await this.#deps.events.emit(
      resourceDeleted({
        tenant: existing.tenant,
        resourceId: id,
        resourceType: existing.type,
        deletedBy: caller.subject.principal,
        occurredAt: now,
        traceId: caller.traceId ?? null,
      }),
    )
  }

  // ───────────────────────── 读 ─────────────────────────

  async get(caller: Caller, id: string): Promise<Resource> {
    const resource = await this.#deps.resources.findById(id)
    // 跨租户与不存在返回同一个错误：不泄漏"这个 id 在别处存在"
    if (resource === null || resource.tenant !== caller.subject.tenant) {
      throw new NotFoundError(id)
    }

    await this.#authorize(
      caller,
      `${resource.type}.Read`,
      {
        tenant: resource.tenant,
        workspace: resource.workspace,
        project: resource.project ?? undefined,
        id: resource.id,
        type: resource.type,
      },
      resource.owner,
      resource.type,
    )

    return resource
  }

  async query(caller: Caller, filter: ResourceFilter, page: Page): Promise<PageResult<Resource>> {
    const type = filter.type
    await this.#authorize(
      caller,
      type === undefined ? 'Resource.Read' : `${type}.Read`,
      { tenant: caller.subject.tenant, workspace: filter.workspace, project: filter.project, type },
      undefined,
      type,
    )
    return this.#deps.resources.query(filter, page)
  }

  async history(caller: Caller, id: string, page: Page): Promise<PageResult<import('./resource.ts').HistoryEntry>> {
    const resource = await this.get(caller, id)
    return this.#deps.resources.history(resource.id, page)
  }

  // ───────────────────────── 关系 ─────────────────────────

  async relate(
    caller: Caller,
    args: {
      type: string
      fromId: string
      toId: string
      confidence?: number | undefined
      origin?: RelationOrigin | undefined
    },
  ): Promise<RelationInstance> {
    const from = await this.#requireLive(args.fromId)
    const to = await this.#requireLive(args.toId)

    await this.#authorize(
      caller,
      `${from.type}.Update`,
      {
        tenant: from.tenant,
        workspace: from.workspace,
        project: from.project ?? undefined,
        id: from.id,
        type: from.type,
      },
      from.owner,
      from.type,
    )

    this.#deps.registry.validateRelation(args.type, from.type, to.type)

    const origin: RelationOrigin =
      args.origin ??
      (caller.subject.principal.startsWith('agent://')
        ? (`agent:${caller.subject.principal.slice('agent://'.length)}` as RelationOrigin)
        : 'human')

    // Agent 推断的关系必须带置信度（FR-ONT-006），否则无法区分"确定"和"猜的"
    if (origin.startsWith('agent:') && args.confidence === undefined) {
      throw new ValidationError('agent-inferred relations must declare a confidence value', {
        field: 'confidence',
      })
    }

    const now = this.#deps.clock.now()
    const relation: RelationInstance = {
      id: newRelationId(),
      tenant: from.tenant,
      type: args.type,
      fromId: from.id,
      toId: to.id,
      createdBy: origin,
      createdAt: now,
      confidence: args.confidence ?? null,
      // Agent 建立的关系默认为"待确认"，人工/系统建立的直接生效
      confirmed: origin.startsWith('agent:') ? null : true,
    }

    await this.#deps.relations.insert(relation)
    await this.#deps.events.emit(
      relationCreated({
        tenant: from.tenant,
        relationId: relation.id,
        relationType: relation.type,
        fromId: relation.fromId,
        toId: relation.toId,
        createdBy: origin,
        occurredAt: now,
        traceId: caller.traceId ?? null,
      }),
    )

    return relation
  }

  async relationsOf(
    caller: Caller,
    id: string,
    direction: 'out' | 'in' | 'both',
    type?: string,
  ): Promise<RelationInstance[]> {
    await this.get(caller, id)
    return this.#deps.relations.listFor(id, direction, type)
  }

  async traverse(
    caller: Caller,
    spec: { start: string; follow: readonly string[]; maxDepth: number; direction: 'out' | 'in' | 'both' },
  ): Promise<TraverseHit[]> {
    await this.get(caller, spec.start)
    for (const relType of spec.follow) {
      this.#deps.registry.relationType(relType)
    }
    if (spec.maxDepth < 1 || spec.maxDepth > 10) {
      throw new ValidationError('maxDepth must be between 1 and 10', { field: 'maxDepth' })
    }
    return this.#deps.relations.traverse(spec)
  }

  async shortestPath(caller: Caller, from: string, to: string, maxDepth: number): Promise<PathHit | null> {
    await this.get(caller, from)
    await this.get(caller, to)
    if (maxDepth < 1 || maxDepth > 10) {
      throw new ValidationError('maxDepth must be between 1 and 10', { field: 'maxDepth' })
    }
    return this.#deps.relations.shortestPath(from, to, maxDepth)
  }

  // ───────────────────────── 内部 ─────────────────────────

  async #requireLive(id: string): Promise<Resource> {
    const resource = await this.#deps.resources.findById(id)
    if (resource === null || resource.deletedAt !== null) {
      throw new NotFoundError(id)
    }
    return resource
  }
}

function throwIfNotAllowed(decision: Decision): void {
  if (decision.effect === 'Allow') return
  if (decision.effect === 'Ask') {
    throw new ApprovalRequiredError(decision.reason, { matchedPolicy: decision.matchedPolicy ?? null })
  }
  throw new ForbiddenError(decision.reason, { matchedPolicy: decision.matchedPolicy ?? null })
}

function assertVisibility(value: string): Visibility {
  if (!VISIBILITIES.includes(value as Visibility)) {
    throw new ValidationError(`invalid visibility: ${value}`, { allowed: VISIBILITIES })
  }
  return value as Visibility
}
