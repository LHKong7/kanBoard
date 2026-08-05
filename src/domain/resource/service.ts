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
import type { Guard, GuardContext, Lifecycle, RelatedRef } from '../../workflow/types.ts'
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
import { MAX_PAGE_SIZE } from './ports.ts'
import type {
  AuditSink,
  EventSink,
  GroupCount,
  GroupableField,
  Page,
  PageResult,
  PathHit,
  PendingApprovalSink,
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
  /**
   * 人工确认凭证（FR-IAM-009）。
   *
   * 被 Ask 挡下之后，调用方拿着批准了的 Approval id 重试。
   * 放在 Caller 上而不是每个方法的参数里：授权只有一个收口，
   * 凭证也该只在那一处被检查——分散到各个端点必然漏掉几个。
   */
  approvalId?: string | undefined
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
  /** 人工确认的有效期（FR-IAM-009）。缺省 24 小时 */
  approvalTtlMs?: number
  /** 挂起单的缓冲。由调用方在独立事务里落盘——业务事务会回滚 */
  approvals?: PendingApprovalSink
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

    if (decision.effect === 'Ask') {
      await this.#handleAsk(caller, action, resource, decision, now)
      return
    }
    throwIfNotAllowed(decision)
  }

  /**
   * 策略判定为 Ask 时的处理（FR-IAM-009）。
   *
   * 三条路：
   *   ① 带着一个**已批准且未过期**的 Approval → 放行。
   *   ② 带着一个不合格的（不存在 / 不匹配 / 已过期 / 未批准）→ 拒绝，说清楚是哪一种。
   *   ③ 什么都没带 → 建一条 Pending 挂起，428 里把 id 给回去。
   *
   * 过期在**使用时**判，而不是靠一个定时任务把状态刷成 Expired。
   * 靠任务的话，任务停掉的那几天里过期的批准照样能用——
   * 一个安静失效的护栏。任务只负责让"没人管的确认"在界面上看得见。
   */
  async #handleAsk(
    caller: Caller,
    action: Capability,
    resource: ResourceRef,
    decision: Decision,
    now: Date,
  ): Promise<void> {
    if (caller.approvalId !== undefined) {
      const approval = await this.#deps.resources.findById(caller.approvalId)
      const reason = approvalProblem(approval, action, resource, now)
      if (reason === null) return
      throw new ForbiddenError(`approval ${caller.approvalId} cannot authorise this: ${reason}`, {
        matchedPolicy: decision.matchedPolicy ?? null,
        approvalId: caller.approvalId,
      })
    }

    const ttlMs = this.#deps.approvalTtlMs ?? DEFAULT_APPROVAL_TTL_MS
    const pending: Resource = {
      id: newResourceId('Approval'),
      tenant: resource.tenant,
      type: 'Approval',
      ontologyVersion: this.#deps.registry.entityType('Approval').version,
      workspace: resource.workspace ?? 'default',
      project: resource.project ?? null,
      owner: caller.subject.principal,
      createdBy: caller.subject.principal,
      createdAt: now,
      updatedAt: now,
      status: 'Pending',
      lifecycle: 'approval-default',
      version: 1,
      labels: ['pending-approval'],
      attributes: {
        action,
        requestedBy: caller.subject.principal,
        ...(resource.id === undefined ? {} : { targetId: resource.id }),
        ...(decision.matchedPolicy == null ? {} : { matchedPolicy: decision.matchedPolicy }),
        expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
      },
      visibility: 'workspace',
      deletedAt: null,
    }
    // 交给缓冲，不直接落库：马上要抛 428，事务会回滚，
    // 写在这个事务里的挂起单会跟着消失——于是"系统说要审批，
    // 但审批列表里什么都没有"。也不走 create()：那会再授权一次，
    // 而我们正处在授权中间
    this.#deps.approvals?.record(pending)

    throw new ApprovalRequiredError(decision.reason, {
      matchedPolicy: decision.matchedPolicy ?? null,
      approvalId: pending.id,
      expiresInMs: ttlMs,
    })
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
    const ctx = await this.#guardContext(existing, lifecycle)

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
    const ctx = await this.#guardContext(resource, lifecycle)
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

  /**
   * 求和 / 求平均。**和 `query` 用同一次授权**——
   * 少了这一步，指标就成了一条绕过权限的旁路：
   * 看不到某个项目的人，照样能从它的成本总额里推出信息。
   */
  async aggregate(
    caller: Caller,
    filter: ResourceFilter,
    fn: 'sum' | 'avg',
    attribute: string,
  ): Promise<{ value: number; counted: number }> {
    const type = filter.type
    await this.#authorize(
      caller,
      type === undefined ? 'Resource.Read' : `${type}.Read`,
      { tenant: caller.subject.tenant, workspace: filter.workspace, project: filter.project, type },
      undefined,
      type,
    )
    return this.#deps.resources.aggregate(filter, fn, attribute)
  }

  /**
   * 接受一条提议：把它变成真正的对象（FR-AI-001）。
   *
   * 两步在**同一次调用**里完成——先创建目标对象，再把提议迁到 Accepted。
   * 反过来（先迁移再创建）的话，创建失败会留下一条"已接受但什么也没有"的提议，
   * 而那种状态没有任何地方能看出不对。
   *
   * 创建走的是普通的 `create`，所以本体校验、权限、审计、事件一个不少：
   * **Agent 提议的对象和人建的对象没有区别**，只是多了一步谁来点头。
   */
  async acceptProposal(caller: Caller, proposalId: string): Promise<Resource> {
    const proposal = await this.#requireLive(proposalId)
    if (proposal.type !== 'Proposal') {
      throw new ValidationError(`${proposalId} is not a Proposal`, { type: proposal.type })
    }
    if (proposal.status !== 'Pending') {
      // **老实说：删掉这个检查，所有用例照样绿**（试过）。
      // 重复接受时下面的乐观锁会撞上版本冲突，整个请求事务回滚，
      // 第二个对象不会留下来——正确性由事务保证，不由这一行。
      //
      // 留着是为了错误信息：撞版本号得到的是"有人同时改了它"，
      // 而真实情况是"这条已经决定过了"。两者要采取的行动完全不同。
      throw new ConflictError(proposalId, 0, proposal.version)
    }

    const resourceType = String(proposal.attributes['resourceType'] ?? '')
    const draft = proposal.attributes['draft']
    const attributes =
      typeof draft === 'object' && draft !== null ? (draft as Record<string, unknown>) : {}

    const created = await this.create(caller, {
      type: resourceType,
      workspace: proposal.workspace,
      project: proposal.project,
      attributes,
      // 出处留在标签上：事后要能问出"这批对象里有多少是 Agent 提的"
      labels: ['agent-generated'],
    })

    const withId = await this.update(caller, proposalId, {
      expectedVersion: proposal.version,
      attributes: { ...proposal.attributes, materialisedId: created.id },
      reason: `accepted proposal → ${created.id}`,
    })
    await this.transition(caller, proposalId, 'Accepted', {
      expectedVersion: withId.version,
      reason: 'proposal accepted',
    })
    return created
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
    await this.#assertNoCycle(args.type, from.id, to.id)

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
      /**
       * 跟哪些关系类型走。**不传 = 本体里声明的全部。**
       *
       * 这个默认值不是图省事。要展开"一个对象周围的关系图"，调用方
       * 只能把 28 个关系名全列出来——而请求体的 `follow` 上限是 10，
       * 于是他会截断，而截断掉的恰好是 `decomposedInto` 这种最该跟的。
       * 一张少了 18 种关系的图不会报错，只会**看起来是全的**。
       * 「全部」这个意图必须能直接表达，而不是让每个调用方去枚举。
       */
      follow?: readonly string[] | undefined
      maxDepth: number
      direction: 'out' | 'in' | 'both'
      limit: number
    },
  ): Promise<TraverseResult> {
    return this.#traverse(caller, spec)
  }

  /**
   * 关系图（FR-ONT-012）：节点 + 它们**之间**的边。
   *
   * 和 `traverse` 的区别在于 `traverse` 只回答"能走到谁"。画一张图还需要
   * 两样它给不了的东西：节点上写什么（标题在 attributes 里，遍历不返回），
   * 以及节点彼此怎么连（见 `edgesAmong`）。
   *
   * 节点走 `query({ids})` 取回，于是**可见性与权限跟列表页完全同一条路径**——
   * 看不到的对象不会因为"它在图上"就被看到。
   */
  async subgraph(
    caller: Caller,
    spec: {
      start: string
      follow?: readonly string[] | undefined
      maxDepth: number
      direction: 'out' | 'in' | 'both'
      limit: number
    },
  ): Promise<{
    nodes: readonly { resource: Resource; depth: number }[]
    edges: readonly RelationInstance[]
    truncated: boolean
  }> {
    // 上界压到仓储那一层的分页硬顶之下。`query` 内部把 size 夹到 200，
    // 传更大的节点集进去会**被静默截掉**——而那时 truncated 是 false，
    // 图看起来完整。宁可在这里少走几步，也不要给一张骗人的全图
    const limit = Math.min(spec.limit, GRAPH_NODE_MAX - 1)
    const walked = await this.#traverse(caller, { ...spec, limit })
    // 起点自己不在 traverse 结果里（它只回 depth > 0），但它是这张图的圆心
    const depthOf = new Map<string, number>([[spec.start, 0]])
    for (const hit of walked.hits) depthOf.set(hit.id, hit.depth)

    const found = await this.query(caller, { ids: [...depthOf.keys()] }, { size: depthOf.size })
    const nodes = found.items.map((resource) => ({
      resource,
      depth: depthOf.get(resource.id) ?? 0,
    }))
    // 边只在**真正取回来的**节点之间找，而不是在遍历命中的 id 之间。
    //
    // 两者会不一致，今天就有一个口子：起点是无条件加进去的（`get` 读得到
    // 软删除的对象），但 `query` 不会把它返回。拿命中 id 去查边的话，
    // 图上会出现一条一端悬空的连线——**那条线本身就说出了"这里还有个东西"**。
    const visible = new Set(nodes.map((n) => n.resource.id))
    const edges = await this.#deps.relations.edgesAmong([...visible])
    return { nodes, edges, truncated: walked.truncated }
  }

  async #traverse(
    caller: Caller,
    spec: {
      start: string
      follow?: readonly string[] | undefined
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

    const follow = spec.follow ?? this.#deps.registry.relationTypes().map((r) => r.name)

    // 与 relationsOf 同一个道理：沿 `implementedBy` 走时，
    // 存成 `implements` 的边也必须能走通，否则遍历结果取决于当初是从哪一头建的关系。
    const inverses = follow.map((t) => this.#deps.registry.relationType(t).inverse)

    const followOut =
      spec.direction === 'out' ? follow
      : spec.direction === 'in' ? inverses
      : [...follow, ...inverses]

    const followIn =
      spec.direction === 'out' ? inverses
      : spec.direction === 'in' ? follow
      : [...follow, ...inverses]

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

  /**
   * 标了 `acyclic` 的关系不允许成环（FR-DOM-005）。
   *
   * 判法是可达性：加 from → to 之前，先看从 `to` 出发能不能走回 `from`。
   * 能走回去，这条边就会闭合一个环。
   *
   * 沿关系向前走 = 出边走 `type`，入边走它的逆关系。一条边只存一行，
   * 所以"A blocks B"可能是以 `blockedBy` 从 B 存过来的——
   * 只查出边的话，从另一头建的依赖全部看不见，判环会漏掉一半。
   */
  async #assertNoCycle(type: string, fromId: string, toId: string): Promise<void> {
    const def = this.#deps.registry.relationType(type)
    if (def.acyclic !== true) return

    // 自环不需要遍历也能判，而且遍历判不出来（起点本来就在结果里）
    if (fromId === toId) {
      throw new ValidationError(`"${type}" cannot point an object at itself`, {
        field: 'toId',
        relation: type,
      })
    }

    const reachable = await this.#deps.relations.traverse({
      start: toId,
      followOut: [type],
      followIn: [def.inverse],
      maxDepth: MAX_CYCLE_DEPTH,
      limit: MAX_TRAVERSE_LIMIT,
    })

    const hit = reachable.hits.find((h) => h.id === fromId)
    if (hit !== undefined) {
      throw new ValidationError(
        `adding this "${type}" would create a cycle: ${toId} already reaches ${fromId}`,
        // 把路径给出来。只说"会成环"的话，使用者得自己在图里找是哪几条边
        { field: 'toId', relation: type, path: hit.path },
      )
    }

    if (reachable.truncated) {
      // 遍历被截断时**不能说"没有环"**——只是没找到。
      // 放过去的代价是一个悄悄成环的依赖图，症状是几件事互相等待，
      // 没有人能看出为什么。拒绝是响的，而且罕见
      throw new ValidationError(
        `cannot verify that this "${type}" is acyclic: the graph beyond ${toId} exceeds the traversal limit`,
        { field: 'toId', relation: type, limit: MAX_TRAVERSE_LIMIT },
      )
    }
  }

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
  async #guardContext(resource: Resource, lifecycle?: Lifecycle): Promise<GuardContext> {
    const relations = await this.#deps.relations.listFor(resource.id, 'both')
    const outgoing = new Set<string>()
    const incoming = new Set<string>()
    /** `type:direction` → 对面的 id 集合 */
    const neighbours = new Map<string, Set<string>>()

    for (const relation of relations) {
      // 被人工否决的关系不算数——它和不存在是一个意思
      if (relation.confirmed === false) continue
      if (relation.fromId === resource.id) {
        outgoing.add(relation.type)
        addTo(neighbours, `${relation.type}:out`, relation.toId)
      }
      if (relation.toId === resource.id) {
        incoming.add(relation.type)
        addTo(neighbours, `${relation.type}:in`, relation.fromId)
      }
    }

    const ctx: GuardContext = {
      attributes: resource.attributes,
      owner: resource.owner,
      outgoingRelationTypes: outgoing,
      incomingRelationTypes: incoming,
    }

    // 只在这台状态机真的用到 allRelatedIn 时才去查邻居的状态。
    // 无条件查的话，每展开一次抽屉都会多发一轮查询，
    // 而绝大多数状态机根本不需要这个信息
    const wanted = lifecycle === undefined ? [] : relationKeysNeedingStatus(lifecycle)
    if (wanted.length === 0) return ctx

    const ids = [...new Set(wanted.flatMap((key) => [...(neighbours.get(key) ?? [])]))]
    const related = new Map<string, readonly RelatedRef[]>()
    // 键必须**全部**建出来，哪怕一条边都没有：
    // 守卫读不到键会当成"装配漏了"而拒绝，那是给漏装配准备的信号，
    // 不该被"这个对象暂时没有关联"触发
    for (const key of wanted) related.set(key, [])
    if (ids.length === 0) return { ...ctx, related }

    const page = await this.#deps.resources.query({ ids }, { size: Math.min(ids.length, 200) })
    const byId = new Map(page.items.map((r) => [r.id, r]))
    for (const key of wanted) {
      const refs: RelatedRef[] = []
      for (const id of neighbours.get(key) ?? []) {
        const target = byId.get(id)
        if (target !== undefined) refs.push({ id: target.id, type: target.type, status: target.status })
      }
      related.set(key, refs)
    }
    return { ...ctx, related }
  }

  async #requireLive(id: string): Promise<Resource> {
    const resource = await this.#deps.resources.findById(id)
    if (resource === null || resource.deletedAt !== null) {
      throw new NotFoundError(id)
    }
    return resource
  }
}

/**
 * 一次确认的有效期。
 *
 * 24 小时不是随便定的：太短会让跨时区的批准永远赶不上，
 * 太长则失去意义——一张三周前签发的批准还能用，
 * 和没有确认流程差别不大。
 */
export const DEFAULT_APPROVAL_TTL_MS = 24 * 60 * 60 * 1000

/**
 * 这条 Approval 能不能用来放行这次操作。返回 null 表示可以。
 *
 * 每一种不可以都要说清楚是哪一种——"批准无效"这四个字
 * 会让人反复重试同一个已经过期的凭证。
 */
function approvalProblem(
  approval: Resource | null,
  action: Capability,
  resource: ResourceRef,
  now: Date,
): string | null {
  if (approval === null || approval.type !== 'Approval') return 'no such approval'
  if (approval.deletedAt !== null) return 'approval was deleted'
  if (approval.status !== 'Approved') return `approval is ${approval.status}, not Approved`

  // 过期在**使用时**判。靠定时任务把状态刷成 Expired 的话，
  // 任务停掉的那几天里过期的批准照样能用——一个安静失效的护栏
  const expiresAt = approval.attributes['expiresAt']
  if (typeof expiresAt !== 'string') return 'approval has no expiry'
  if (new Date(expiresAt).getTime() <= now.getTime()) return 'approval has expired'

  // 一张批准只对**它被签发时那件事**有效。不比对的话，
  // "批准删除一个测试对象"就能拿去删生产数据
  if (approval.attributes['action'] !== action) {
    return `approval is for "${String(approval.attributes['action'])}", not "${action}"`
  }
  const target = approval.attributes['targetId']
  if (typeof target === 'string' && resource.id !== undefined && target !== resource.id) {
    return `approval is for ${target}, not ${resource.id}`
  }
  return null
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
function addTo(map: Map<string, Set<string>>, key: string, value: string): void {
  const existing = map.get(key)
  if (existing === undefined) map.set(key, new Set([value]))
  else existing.add(value)
}

/**
 * 这台状态机里 `allRelatedIn` 引用到的 `type:direction` 集合。
 *
 * 扫的是**整台状态机**而不是当前这一步：`availableTransitions` 会
 * 一次性求值所有出边的守卫，只装配当前目标状态需要的，
 * 别的出边就会拿到"没装配"而被判失败。
 */
function relationKeysNeedingStatus(lifecycle: Lifecycle): string[] {
  const keys = new Set<string>()
  const walk = (guard: Guard): void => {
    switch (guard.kind) {
      case 'allRelatedIn':
        keys.add(`${guard.type}:${guard.direction}`)
        return
      case 'all':
      case 'any':
        guard.of.forEach(walk)
        return
      case 'not':
        walk(guard.of)
        return
      default:
        return
    }
  }
  for (const state of lifecycle.states) (state.requires ?? []).forEach(walk)
  for (const transition of lifecycle.transitions) {
    if (transition.guard !== undefined) walk(transition.guard)
  }
  return [...keys]
}

export const MAX_TRAVERSE_LIMIT = 5000

/**
 * 一张关系图最多返回多少个节点。
 *
 * 它**等于**一页的上限，不是碰巧一样：图上的节点是用 `query` 一次取回来的，
 * 超过那条线的部分会被静默丢掉，而那时 `truncated` 还是 false——
 * 一张骗人的全图。所以遍历必须先停在这条线以内。
 * 写成引用而不是再抄一个 200，是为了那边改了这边跟着改。
 */
export const GRAPH_NODE_MAX = MAX_PAGE_SIZE

/** 判环时向前看多少层。10 是遍历本身允许的上限 */
const MAX_CYCLE_DEPTH = 10

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
