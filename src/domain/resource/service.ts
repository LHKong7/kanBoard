import { decide } from '../../identity/pdp.ts'
import type { Capability, Decision, Policy, ResourceRef, SubjectProfile } from '../../identity/types.ts'
import type { OntologyRegistry } from '../../ontology/registry.ts'
import {
  applyActions,
  assertValidInitialStatus,
  availableTransitions,
  resolveTransition,
} from '../../workflow/engine.ts'
import type { AvailableTransition, WorkflowRegistry } from '../../workflow/engine.ts'
import type { GuardContext } from '../../workflow/types.ts'
import type { Clock } from '../../platform/clock.ts'
import {
  ApprovalRequiredError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  TransitionError,
  ValidationError,
} from '../../platform/errors.ts'
import { newRelationId, newResourceId } from '../../platform/id.ts'
import {
  relationCreated,
  relationRemoved,
  resourceCreated,
  resourceDeleted,
  resourceStatusChanged,
  resourceUpdated,
} from '../events.ts'
import type {
  AuditSink,
  EventSink,
  GroupCount,
  GroupableField,
  Page,
  PageResult,
  PathHit,
  RelationRepository,
  ResourceFilter,
  ResourceRepository,
  TraverseResult,
} from './ports.ts'
import { diffResource, VISIBILITIES } from './resource.ts'
import type { CreateResourceInput, Resource, UpdateResourceInput, Visibility } from './resource.ts'
import type { RelationInstance, RelationOrigin } from '../../ontology/types.ts'

/**
 * 「项目装着这个对象」这条边的类型，以及容器的实体类型。
 *
 * 写成常量而不是散在各处的字面量：这两个名字是 `project` 标量字段与图之间
 * 唯一的连接点，改名时必须一处改完。
 */
const CONTAINS = 'contains'
const PROJECT_TYPE = 'Project'

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
  /**
   * 自动化触发链的深度。
   *
   * 由自动化执行器设置，随它发出的事件传递下去（W3 防环）。
   * 人发起的操作没有这个字段——人不会以机器速度制造环。
   */
  automationDepth?: number | undefined
}

export type ServiceDeps = {
  registry: OntologyRegistry
  workflows: WorkflowRegistry
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

  /**
   * 发出领域事件，并盖上自动化链路深度。
   *
   * 深度必须随事件传播，否则 AutomationRunner 的防环闸永远读到 0，
   * 一条环形规则就能无限展开——闸门在那里但从不落下。
   */
  async #emit(caller: Caller, event: import('../events.ts').DomainEvent): Promise<void> {
    const stamped =
      caller.automationDepth === undefined
        ? event
        : { ...event, payload: { ...event.payload, automationDepth: caller.automationDepth } }
    await this.#deps.events.emit(stamped)
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

    // project 落库前先确认它真的指向一个活着的 Project，并且本体允许把这种类型装进去。
    // 不查的话，`project` 可以指向任何字符串——包括一个根本不存在的 id，
    // 而接口照样回 201（docs/dogfooding-log.md #6）。
    const container = input.project == null ? null : await this.#requireContainer(input.project, input.type)

    // 初始状态由生命周期决定。允许调用方指定，但必须是该状态机声明过的状态——
    // 否则对象一出生就在一个流程到不了的地方。
    const lifecycle = def.lifecycle === undefined ? null : this.#deps.workflows.byId(def.lifecycle)
    let status: string
    if (lifecycle === null) {
      status = input.status ?? 'Draft'
    } else if (input.status === undefined) {
      status = lifecycle.initial
    } else {
      assertValidInitialStatus(lifecycle, input.status)
      status = input.status
    }

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
      status,
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
    await this.#emit(
      caller,
      resourceCreated({
        tenant,
        resourceId: resource.id,
        resourceType: resource.type,
        createdBy: caller.subject.principal,
        occurredAt: now,
        traceId: caller.traceId ?? null,
      }),
    )

    if (container !== null) {
      await this.#linkToProject(caller, container, resource, now)
    }

    return resource
  }

  /**
   * 建立 Project --contains--> resource 的边。
   *
   * 为什么 `create` 要自动建这条边：`project` 字段和 `contains` 边是**同一个事实的两种存储**。
   * 只写字段不建边，对象在图里就是不可达的——自用时 26 个对象声称属于某个项目，
   * 却没有一条边指向它们，而系统一声没吭（docs/dogfooding-log.md #6）。
   * 靠调用方记得补边是行不通的：我自己写导入脚本时就漏了 Knowledge 那一类。
   * 让服务层维持这个不变式，图就是"构造出来就完整"，而不是"靠纪律保持完整"。
   *
   * 这里**不再单独做一次授权**：调用方已经通过了 `<Type>.Create` 且被允许指定 project，
   * 而这条边就是"放进这个项目"这件事本身。再查一次 `Project.Update` 会让
   * "能在项目里建任务但不能改项目"的人凭空建不了任务——两次判定表达的是同一个意图。
   */
  async #linkToProject(
    caller: Caller,
    container: Resource,
    resource: Resource,
    now: Date,
  ): Promise<void> {
    const relation: RelationInstance = {
      id: newRelationId(),
      tenant: resource.tenant,
      type: CONTAINS,
      fromId: container.id,
      toId: resource.id,
      createdBy: 'system',
      createdAt: now,
      confidence: null,
      confirmed: true,
    }
    const { relation: persisted, created } = await this.#deps.relations.insert(relation)
    // 边本来就在（比如导入脚本已经手工建过）就不再发一次事件——
    // 否则同一条边会重复触发下游自动化
    if (!created) return
    await this.#emit(
      caller,
      relationCreated({
        tenant: resource.tenant,
        relationId: persisted.id,
        relationType: persisted.type,
        fromId: persisted.fromId,
        toId: persisted.toId,
        createdBy: persisted.createdBy,
        occurredAt: now,
        traceId: caller.traceId ?? null,
      }),
    )
  }

  /**
   * 确认 `project` 指向一个活着的 Project，且本体允许它装下这种类型。
   *
   * 类型不在 `contains` 的值域里就直接拒绝，而不是"存字段但不建边"——
   * 后者正是产生半连接对象的做法。要让 Project 装下新类型，改本体，
   * 不要在这里开特例（ADR-0001）。
   */
  async #requireContainer(projectId: string, childType: string): Promise<Resource> {
    const container = await this.#deps.resources.findById(projectId)
    if (container === null || container.deletedAt !== null) {
      throw new ValidationError(`project ${projectId} does not exist`, { field: 'project' })
    }
    if (container.type !== PROJECT_TYPE) {
      throw new ValidationError(
        `project must reference a ${PROJECT_TYPE}, but ${projectId} is a ${container.type}`,
        { field: 'project' },
      )
    }
    // 复用本体的定义域/值域校验：报错文案与手工建关系时完全一致
    this.#deps.registry.validateRelation(CONTAINS, container.type, childType)
    return container
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

    // 有生命周期的对象，状态只能通过 :transition 改。
    //
    // 留一个"PATCH 也能改 status"的口子，等于状态机形同虚设——
    // 只要有一条路径能绕过守卫，守卫就只是建议。
    if (input.status !== undefined && input.status !== existing.status) {
      if (existing.lifecycle !== null && this.#deps.workflows.byId(existing.lifecycle) !== null) {
        throw new TransitionError(
          `status of ${existing.type} is governed by lifecycle "${existing.lifecycle}"; use the transition endpoint instead of a direct update`,
          { current: existing.status, requested: input.status, lifecycle: existing.lifecycle },
        )
      }
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

    await this.#emit(
      caller,
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
      await this.#emit(
        caller,
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

  // ───────────────────────── 生命周期 ─────────────────────────

  /**
   * 状态迁移（FR-WF-002/003/004）。
   *
   * 顺序是有讲究的：先解析迁移（拿到它需要什么权限），再授权。
   * 反过来的话就得对所有迁移用同一个笼统的权限，
   * "谁能把需求置为 Approved" 这种区分就没法表达了。
   */
  async transition(
    caller: Caller,
    id: string,
    to: string,
    options: { expectedVersion?: number | undefined; reason?: string | undefined } = {},
  ): Promise<Resource> {
    const existing = await this.#requireLive(id)
    const lifecycle = this.#lifecycleOf(existing)
    const ctx = await this.#guardContext(existing)

    const resolved = resolveTransition(lifecycle, existing.type, existing.status, to, ctx)

    await this.#authorize(
      caller,
      resolved.capability,
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

    if (options.expectedVersion !== undefined && options.expectedVersion !== existing.version) {
      throw new ConflictError(id, options.expectedVersion, existing.version)
    }

    const now = this.#deps.clock.now()
    const attributes = applyActions(existing.attributes, resolved.actions, now)

    // 副作用可能写入本体未声明的字段（如 startedAt）。走一次校验，
    // 让"状态机想记录的东西"和"本体允许记录的东西"必须一致——
    // 不一致时是本体该补字段，而不是让它悄悄绕过校验。
    const validated = this.#deps.registry.validateAttributes(existing.type, attributes)

    const next: Resource = {
      ...existing,
      status: resolved.to,
      attributes: validated,
      version: existing.version + 1,
      updatedAt: now,
    }

    const changes = diffResource(existing, next)
    const ok = await this.#deps.resources.update(next, existing.version)
    if (!ok) {
      const current = await this.#deps.resources.findById(id)
      throw new ConflictError(id, existing.version, current?.version ?? -1)
    }

    await this.#deps.resources.appendHistory({
      resourceId: id,
      version: next.version,
      changedBy: caller.subject.principal,
      onBehalfOf: caller.delegator?.principal ?? null,
      changedAt: now,
      runRef: caller.runId ?? null,
      changes,
      reason: options.reason ?? null,
      traceId: caller.traceId ?? null,
    })

    await this.#emit(
      caller,
      resourceStatusChanged({
        tenant: existing.tenant,
        resourceId: id,
        resourceType: existing.type,
        from: existing.status,
        to: resolved.to,
        changedBy: caller.subject.principal,
        occurredAt: now,
        traceId: caller.traceId ?? null,
      }),
    )

    return next
  }

  /**
   * 当前可用的迁移，**已按权限过滤**（FR-RES-008）。
   *
   * 无权限的迁移根本不出现在列表里，而不是列出来再在点击时报错。
   * 同时保留未就绪的迁移并附上原因——用户需要知道"下一步差什么"。
   */
  async transitionsOf(caller: Caller, id: string): Promise<AvailableTransition[]> {
    const resource = await this.get(caller, id)
    const lifecycle = this.#lifecycleOf(resource)
    const ctx = await this.#guardContext(resource)
    const all = availableTransitions(lifecycle, resource.type, resource.status, ctx)

    const permitted: AvailableTransition[] = []
    for (const candidate of all) {
      const decision = decide(
        {
          subject: caller.subject,
          action: candidate.capability,
          resource: {
            tenant: resource.tenant,
            workspace: resource.workspace,
            project: resource.project ?? undefined,
            id: resource.id,
            type: resource.type,
          },
          delegator: caller.delegator,
          context: { resourceOwner: resource.owner, mfa: caller.mfa, now: this.#deps.clock.now() },
        },
        this.#deps.policies,
      )
      // Ask 也列出：它是"需要人工确认"，不是"不能做"
      if (decision.effect !== 'Deny') permitted.push(candidate)
    }
    return permitted
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

    await this.#emit(
      caller,
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

  /**
   * 分组计数（FR-DASH-005）。
   *
   * 与 `query` 走**同一次授权**：指标看得到的范围，和列表看得到的范围
   * 必须是同一个，否则 Dashboard 会变成一条绕过权限的旁路——
   * "看不到明细但能看到条数"本身就是信息泄漏。
   */
  async countGrouped(
    caller: Caller,
    filter: ResourceFilter,
    groupBy: GroupableField,
  ): Promise<GroupCount[]> {
    const type = filter.type
    await this.#authorize(
      caller,
      type === undefined ? 'Resource.Read' : `${type}.Read`,
      { tenant: caller.subject.tenant, workspace: filter.workspace, project: filter.project, type },
      undefined,
      type,
    )
    return this.#deps.resources.countGrouped(filter, groupBy)
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

    // 返回的是**库里那一条**。这条边已经存在时，把刚构造的对象原样返回
    // 等于给调用方一个不存在的 id（docs/dogfooding-log.md #8）
    const { relation: persisted, created } = await this.#deps.relations.insert(relation)
    if (created) {
      await this.#emit(
        caller,
        relationCreated({
          tenant: from.tenant,
          relationId: persisted.id,
          relationType: persisted.type,
          fromId: persisted.fromId,
          toId: persisted.toId,
          createdBy: persisted.createdBy,
          occurredAt: now,
          traceId: caller.traceId ?? null,
        }),
      )
    }

    return persisted
  }

  /**
   * 查询关系，**逆关系视为等价**（FR-ONT-003）。
   *
   * 一条边只存一行。查 `partOf` 时，存储为 `decomposedInto` 且指向本节点的边
   * 在语义上就是本节点的 `partOf` 出边——不做这层解析，
   * "逆关系"就只是本体里的一句声明，查询时并不成立。
   *
   * 返回时翻转成**请求的方向**，让调用方看到的形状和存储方向无关。
   */
  /**
   * 删除一条关系。
   *
   * 授权按**起点对象**的 Update 权限判定：关系是起点对象的一部分。
   * 用一个单独的 `Relation.Delete` 能力会让权限模型多一层，
   * 而实际上"能不能改这个 Task"和"能不能改它的关系"从来是同一个问题。
   */
  async unrelate(caller: Caller, relationId: string): Promise<void> {
    const relation = await this.#deps.relations.findById(relationId)
    if (relation === null || relation.tenant !== caller.subject.tenant) {
      throw new NotFoundError(relationId)
    }

    const from = await this.#requireLive(relation.fromId)
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

    const removed = await this.#deps.relations.remove(relationId)
    if (!removed) throw new NotFoundError(relationId)

    const now = this.#deps.clock.now()
    await this.#emit(
      caller,
      relationRemoved({
        tenant: from.tenant,
        relationId,
        relationType: relation.type,
        fromId: relation.fromId,
        toId: relation.toId,
        removedBy: caller.subject.principal,
        occurredAt: now,
        traceId: caller.traceId ?? null,
      }),
    )
  }

  /**
   * 确认或否决一条 Agent 推断的关系（FR-ONT-006）。
   *
   * 否决后这条边不参与遍历，也不满足守卫——等同于不存在，但保留记录：
   * 被否决的推断是训练与评估的负样本，直接删掉就丢了。
   */
  async confirmRelation(caller: Caller, relationId: string, confirmed: boolean): Promise<RelationInstance> {
    const relation = await this.#deps.relations.findById(relationId)
    if (relation === null || relation.tenant !== caller.subject.tenant) {
      throw new NotFoundError(relationId)
    }
    if (!relation.createdBy.startsWith('agent:')) {
      throw new ValidationError('only agent-inferred relations need confirmation', {
        createdBy: relation.createdBy,
      })
    }

    const from = await this.#requireLive(relation.fromId)
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

    const ok = await this.#deps.relations.setConfirmed(relationId, confirmed)
    if (!ok) throw new NotFoundError(relationId)
    return { ...relation, confirmed }
  }

  async relationsOf(
    caller: Caller,
    id: string,
    direction: 'out' | 'in' | 'both',
    type?: string,
  ): Promise<RelationInstance[]> {
    await this.get(caller, id)

    // 不指定类型时按存储原样返回：把每条边同时以正名和逆名列出会重复一倍
    if (type === undefined) {
      return this.#deps.relations.listFor(id, direction)
    }

    const def = this.#deps.registry.relationType(type)
    const found: RelationInstance[] = []

    if (direction === 'out' || direction === 'both') {
      found.push(...(await this.#deps.relations.listFor(id, 'out', type)))
      found.push(
        ...(await this.#deps.relations.listFor(id, 'in', def.inverse)).map((r) => flipRelation(r, type)),
      )
    }
    if (direction === 'in' || direction === 'both') {
      found.push(...(await this.#deps.relations.listFor(id, 'in', type)))
      found.push(
        ...(await this.#deps.relations.listFor(id, 'out', def.inverse)).map((r) => flipRelation(r, type)),
      )
    }
    return found
  }

  async traverse(
    caller: Caller,
    spec: {
      start: string
      follow: readonly string[]
      maxDepth: number
      direction: 'out' | 'in' | 'both'
      limit: number
    },
  ): Promise<TraverseResult> {
    await this.get(caller, spec.start)
    if (spec.maxDepth < 1 || spec.maxDepth > 10) {
      throw new ValidationError('maxDepth must be between 1 and 10', { field: 'maxDepth' })
    }
    if (spec.limit < 1 || spec.limit > MAX_TRAVERSE_LIMIT) {
      throw new ValidationError(`limit must be between 1 and ${MAX_TRAVERSE_LIMIT}`, { field: 'limit' })
    }

    // 与 relationsOf 同一个道理：沿 `implementedBy` 走时，
    // 存成 `implements` 的边也必须能走通，否则遍历结果取决于当初是从哪一头建的关系。
    const inverses = spec.follow.map((t) => this.#deps.registry.relationType(t).inverse)

    const followOut =
      spec.direction === 'out' ? spec.follow
      : spec.direction === 'in' ? inverses
      : [...spec.follow, ...inverses]

    const followIn =
      spec.direction === 'out' ? inverses
      : spec.direction === 'in' ? spec.follow
      : [...spec.follow, ...inverses]

    return this.#deps.relations.traverse({
      start: spec.start,
      followOut: [...new Set(followOut)],
      followIn: [...new Set(followIn)],
      maxDepth: spec.maxDepth,
      limit: spec.limit,
    })
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

  #lifecycleOf(resource: Resource) {
    const lifecycle = resource.lifecycle === null ? null : this.#deps.workflows.byId(resource.lifecycle)
    if (lifecycle === null) {
      throw new TransitionError(`${resource.type} has no lifecycle; its status is not workflow-governed`, {
        type: resource.type,
      })
    }
    return lifecycle
  }

  /** 装配守卫求值所需的上下文。关系类型在这里被收成集合，工作流层因此不必接触仓储。 */
  async #guardContext(resource: Resource): Promise<GuardContext> {
    const relations = await this.#deps.relations.listFor(resource.id, 'both')
    const outgoing = new Set<string>()
    const incoming = new Set<string>()
    for (const relation of relations) {
      // 被人工否决的关系不算数——它和不存在是一个意思
      if (relation.confirmed === false) continue
      if (relation.fromId === resource.id) outgoing.add(relation.type)
      if (relation.toId === resource.id) incoming.add(relation.type)
    }
    return {
      attributes: resource.attributes,
      owner: resource.owner,
      outgoingRelationTypes: outgoing,
      incomingRelationTypes: incoming,
    }
  }

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

/**
 * 单次遍历返回的节点数硬上限。
 *
 * 压测数据：一个 Project 的全后代是 10,100 个节点、1.12MB 响应，
 * 单请求 300ms，并发 8 时 P95 961ms——Node 单事件循环上，
 * 序列化这么大的响应会把其他请求一起拖慢。
 * 上限的意义不是"让这个查询变快"，而是让它**有上界**。
 */
export const MAX_TRAVERSE_LIMIT = 5000

/** 把一条边翻转成请求方向的样子，使"正反向查询等价"在返回值上字面成立 */
function flipRelation(relation: RelationInstance, asType: string): RelationInstance {
  return { ...relation, type: asType, fromId: relation.toId, toId: relation.fromId }
}

function assertVisibility(value: string): Visibility {
  if (!VISIBILITIES.includes(value as Visibility)) {
    throw new ValidationError(`invalid visibility: ${value}`, { allowed: VISIBILITIES })
  }
  return value as Visibility
}
