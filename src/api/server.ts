import { serviceIn } from '../infrastructure/service-factory.ts'
import Fastify from 'fastify'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { ZodError } from 'zod'
import type { ZodIssue } from 'zod'
import type pg from 'pg'
import { createDb, withTenant } from '../infrastructure/db/client.ts'
import type { Db } from '../infrastructure/db/client.ts'
import { PgResourceRepository } from '../infrastructure/resource-repository.pg.ts'
import { PgRelationRepository } from '../infrastructure/relation-repository.pg.ts'
import { BufferedAuditSink, flushAudit, PgOutbox, BufferedApprovalSink, flushApprovals } from '../infrastructure/outbox.pg.ts'
import { ResourceService } from '../domain/resource/service.ts'
import type { Caller } from '../domain/resource/service.ts'
import type { OntologyRegistry } from '../ontology/registry.ts'
import type { WorkflowRegistry } from '../workflow/engine.ts'
import type { Policy } from '../identity/types.ts'
import { systemClock } from '../platform/clock.ts'
import type { Clock } from '../platform/clock.ts'
import { DomainError } from '../platform/errors.ts'
import { newTraceId } from '../platform/id.ts'
import { translate } from '../infrastructure/external-events.ts'
import type { ExternalSource } from '../infrastructure/external-events.ts'
import { parseDelegator, parseSubject } from './auth.ts'
import {
  createResourceSchema,
  pathSchema,
  querySchema,
  queryParamsSchema,
  metricIdSchema,
  lifecycleSchema,
  metricScopeSchema,
  metricBreakdownSchema,
  automationRateSchema,
  askSchema,
  confirmRelationSchema,
  healthParamsSchema,
  relateSchema,
  relationDirectionSchema,
  resourceIdSchema,
  transitionSchema,
  traverseSchema,
  updateResourceSchema,
} from './schemas.ts'
import { DashboardService } from '../domain/dashboard/service.ts'
import { PgLifecycleStore } from '../infrastructure/lifecycle-store.pg.ts'
import type { ReloadingWorkflowRegistry } from '../infrastructure/lifecycle-store.pg.ts'
import { toWire } from './serialize.ts'
import { registerStatic } from './static.ts'

export type ServerDeps = {
  pool: pg.Pool
  registry: OntologyRegistry
  workflows: WorkflowRegistry
  /**
   * 可热加载的状态机注册表（FR-WF-001）。
   *
   * 给了就用它——每次请求取当前定义，改完不用重启。
   * 不给就退回静态的 `workflows`，测试与内嵌场景照旧。
   */
  lifecycles?: ReloadingWorkflowRegistry
  policies: readonly Policy[]
  clock?: Clock
  /** 外部事件来源（FR-WF-006）。不配就没有入站端点可用 */
  externalSources?: readonly ExternalSource[]
  /** 外部事件归属的租户。外部系统不知道租户是什么 */
  tenant?: string
}

/**
 * 请求 → 调用者。
 *
 * 用 WeakMap 而不是 Fastify 装饰器 + 模块增强：少一层机制，
 * 且"钩子没跑过就取不到"这件事直接体现在类型上（get 返回 undefined），
 * 不需要一个假的初始值来占位。
 */
const callers = new WeakMap<FastifyRequest, Caller>()

/**
 * 统一 Resource API（ADR-0002）。
 *
 * 端点是按**动作**而非按类型组织的：`/v1/resources` 承载所有 EntityType。
 * 新增一种类型不需要新增路由——这正是统一模型的收益兑现处。
 *
 * 也没有任何 `/v1/agents/...` 的写入端点：Agent 和人走同一条路径，
 * 权限差异完全由 PDP 决定，而不是由端点决定。
 */
export function buildServer(deps: ServerDeps): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: 4 * 1024 * 1024 })
  const db = createDb(deps.pool)
  const clock = deps.clock ?? systemClock

  /**
   * 认证先于一切。
   *
   * 放在 onRequest 而不是各个处理器里，是为了保证顺序：
   * 未认证的调用者不该先收到 400 的 schema 报错——那等于把请求体的结构
   * 免费告诉了没有身份的人。认证失败就是 401，什么都不透露。
   */
  /**
   * 留住原始报文，**只对 `/events`**（FR-WF-006）。
   *
   * 验签必须对原始字节做。拿解析后的对象重新序列化去验的话，
   * 键序或空白只要差一点签名就对不上，而那种失败看起来像"密钥配错了"，
   * 能让人查上半天。
   *
   * 只对入站事件留：给每个请求都挂一份报文副本，是拿全站的内存
   * 去换一个只有一条路径需要的东西。
   */
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (request, body, done) => {
    const raw = body as string
    if (request.url.startsWith('/events')) {
      ;(request as { rawBody?: string }).rawBody = raw
    }
    if (raw === '') return done(null, undefined)
    try {
      done(null, JSON.parse(raw))
    } catch (error) {
      done(error as Error, undefined)
    }
  })

  app.addHook('onRequest', async (request) => {
    if (!request.url.startsWith('/v1/')) return
    const subject = parseSubject(request.headers)
    callers.set(request, {
      subject,
      delegator: parseDelegator(request.headers, subject.tenant),
      traceId: firstHeader(request.headers['x-trace-id']) ?? newTraceId(),
      runId: firstHeader(request.headers['x-run-id']),
      mfa: firstHeader(request.headers['x-mfa']) === 'true',
      // 人工确认凭证（FR-IAM-009）。被 Ask 挡下之后，
      // 调用方拿着批准了的 Approval id 原样重发这个请求
      approvalId: firstHeader(request.headers['x-approval']),
    })
  })

  /** 在租户事务中构造服务并执行——每个请求一个事务，租户上下文随事务结束自动回收 */
  async function inTenant<T>(
    request: FastifyRequest,
    fn: (service: ResourceService, caller: Caller) => Promise<T>,
  ): Promise<T> {
    const caller = callers.get(request)
    if (caller === undefined) {
      // 到不了这里：onRequest 钩子覆盖了所有 /v1 路由。留着是为了让类型收窄有据可依。
      throw new DomainError('unauthenticated', 'identity was not resolved for this request', 401)
    }
    const subject = caller.subject
    const audit = new BufferedAuditSink()
    const approvals = new BufferedApprovalSink()
    // 每个请求取一次当前状态机定义：改了流程，下一个请求就按新的走
    const activeWorkflows = deps.lifecycles === undefined
      ? deps.workflows
      : await deps.lifecycles.current()

    try {
      return await withTenant(db, subject.tenant, async (trx: Db) => {
        const service = serviceIn(trx, subject.tenant, {
          registry: deps.registry,
          workflows: activeWorkflows,
          policies: deps.policies,
          audit,
          approvals,
          clock,
        })
        return fn(service, caller)
      })
    } finally {
      // 独立事务落盘：业务事务回滚时（尤其是授权被拒），
      // 审计和待审批的挂起单都不能跟着消失。
      const pending = approvals.drain()
      if (pending.length > 0) {
        try {
          await withTenant(db, subject.tenant, (trx: Db) =>
            flushApprovals(trx, subject.tenant, pending),
          )
        } catch (error) {
          app.log.error({ err: error, pending: pending.length }, 'failed to persist approvals')
        }
      }
      const entries = audit.drain()
      try {
        await withTenant(db, subject.tenant, (trx: Db) => flushAudit(trx, entries))
      } catch (error) {
        // 不让审计写入失败掩盖掉原始错误。
        // TODO(M1)：落地本地持久缓冲，让审计具备"不可丢失"的强度而不只是尽力而为。
        app.log.error({ err: error, entries: entries.length }, 'failed to flush audit records')
      }
    }
  }

  // ── 本体：类型目录是公开可读的，UI 靠它渲染 ────────────────
  app.get('/v1/ontology/entity-types', async () => ({
    items: deps.registry.entityTypes(),
  }))

  app.get('/v1/ontology/relation-types', async () => ({
    items: deps.registry.relationTypes(),
  }))

  /**
   * 本体一致性巡检（FR-ONT-010）。
   *
   * 验收标准是「每日报告，问题对象可在 UI 中筛选」。这条端点是
   * 报告本身；每日那一半在 main.ts（定时跑一次并把结论打出来），
   * 筛选那一半在界面上（`affectedIds` 直接喂给看板的检索）。
   */
  app.get('/v1/ontology/health', async (request) => {
    const q = healthParamsSchema.parse(request.query ?? {})
    const result = await inTenant(request, (service, caller) =>
      service.ontologyHealth(caller, { maxResources: q.maxResources, maxRelations: q.maxRelations }),
    )
    return {
      findings: result.report.findings,
      scanned: result.report.scanned,
      affectedIds: result.report.affectedIds,
      // 扫不完必须说。一份"0 个问题"的报告要是只扫了前一万个对象，
      // 它比没有报告更坏——它会让人不再去看
      complete: result.complete,
    }
  })

  /**
   * 带出处的问答（FR-ONT-011 / FR-RES-009）。
   *
   * 响应里 `sourceIds` 是**可点击跳转**的那一份——两条需求的验收标准
   * 落的都是这里。`passages` 里每一段也各自带着自己的来源，
   * 因为一个答案里的两句话可能来自不同的对象，只给一个总的来源列表
   * 等于让人自己去猜哪句话对应哪一条。
   */
  app.get('/v1/search:answer', async (request) => {
    const q = askSchema.parse(request.query ?? {})
    const result = await inTenant(request, (service, caller) =>
      service.answerQuestion(caller, { question: q.q, limit: q.limit, near: q.near, type: q.type }),
    )
    return {
      passages: result.passages,
      sourceIds: result.sourceIds,
      // 答不出来是一个**正确的答案**，不是失败。它必须和"答出来了"
      // 一样明确地表示出来，否则调用方只能靠 passages 为空去猜
      grounded: result.grounded,
      candidates: result.candidates,
    }
  })

  // 生命周期定义。UI 靠它渲染看板的列，而不是把状态硬编码在前端。
  app.get('/v1/workflows', async () => {
    const registry = deps.lifecycles === undefined ? deps.workflows : await deps.lifecycles.current()
    return { items: registry.all() }
  })

  /**
   * 改一台状态机（FR-WF-001）。
   *
   * 校验在写入时做，非法定义根本存不进去——存进去之后，
   * 损害要等到下一次有人试图迁移才出现，那时故障点离原因已经很远。
   */
  app.put('/v1/workflows/:id', async (request, reply) => {
    if (deps.lifecycles === undefined) {
      return reply.status(501).send({
        error: 'not_configured',
        message: 'this deployment runs with static lifecycles; no store is configured',
      })
    }
    const id = (request.params as { id: string }).id
    const body = lifecycleSchema.parse(request.body)
    if (body.id !== id) {
      return reply.status(400).send({
        error: 'invalid_request',
        message: `body declares lifecycle "${body.id}" but the path says "${id}"`,
      })
    }

    const caller = callers.get(request)
    if (caller === undefined) throw new DomainError('unauthenticated', 'no identity', 401)

    // 改流程是一次高权限操作：它一次性改变所有该类型对象的可用动作
    if (!caller.subject.roles.includes('Admin')) {
      throw new DomainError('forbidden', 'changing a lifecycle requires the Admin role', 403)
    }

    const revision = await withTenant(db, caller.subject.tenant, (trx: Db) =>
      new PgLifecycleStore(trx, caller.subject.tenant).put(
        body as unknown as import('../workflow/types.ts').Lifecycle,
        caller.subject.principal,
        clock,
      ),
    )
    // 同进程立刻生效；别的进程按 TTL 跟上
    deps.lifecycles.invalidate()
    return reply.status(200).send({ id: body.id, revision })
  })

  // ── Resource CRUD ────────────────────────────────────────
  app.post('/v1/resources', async (request, reply) => {
    const body = createResourceSchema.parse(request.body)
    const resource = await inTenant(request, (service, caller) =>
      service.create(caller, {
        type: body.type,
        workspace: body.workspace,
        project: body.project ?? null,
        owner: body.owner,
        status: body.status,
        labels: body.labels,
        attributes: body.attributes,
        visibility: body.visibility,
      }),
    )
    return reply.status(201).send(toWire(resource))
  })

  app.get('/v1/resources/:id', async (request, reply) => {
    const id = resourceIdSchema.parse((request.params as { id: string }).id)
    const resource = await inTenant(request, (service, caller) => service.get(caller, id))
    // ETag 用版本号：客户端可以直接把它回填到 If-Match
    return reply.header('etag', `"${resource.version}"`).send(toWire(resource))
  })

  app.patch('/v1/resources/:id', async (request, reply) => {
    const id = resourceIdSchema.parse((request.params as { id: string }).id)
    const body = updateResourceSchema.parse(withIfMatch(request))
    const resource = await inTenant(request, (service, caller) =>
      service.update(caller, id, {
        expectedVersion: body.expectedVersion,
        status: body.status,
        labels: body.labels,
        attributes: body.attributes,
        visibility: body.visibility,
        owner: body.owner,
        reason: body.reason,
      }),
    )
    return reply.header('etag', `"${resource.version}"`).send(toWire(resource))
  })

  app.delete('/v1/resources/:id', async (request, reply) => {
    const id = resourceIdSchema.parse((request.params as { id: string }).id)
    const version = Number(firstHeader(request.headers['if-match'])?.replace(/"/g, '') ?? NaN)
    if (!Number.isInteger(version) || version < 1) {
      throw new DomainError('precondition_required', 'If-Match header with the current version is required', 428)
    }
    await inTenant(request, (service, caller) => service.softDelete(caller, id, version))
    return reply.status(204).send()
  })

  // ── 生命周期 ─────────────────────────────────────────────
  app.get('/v1/resources/:id/transitions', async (request) => {
    const id = resourceIdSchema.parse((request.params as { id: string }).id)
    const items = await inTenant(request, (service, caller) => service.transitionsOf(caller, id))
    return { items }
  })

  /**
   * 接受一条提议，把它变成真正的对象（FR-AI-001）。
   *
   * 用子资源而不是 `:accept` 自定义方法：`:` 形式会和已有的
   * `/v1/resources/:id` 参数路由撞在一起（Fastify 会把两者并成一个
   * `:id|:id\:accept` 的节点）。而这个形状本来就有先例——
   * `/v1/relations/:id/confirmation` 也是"一次人的决定带来一个后果"。
   *
   * 不做成 `POST …/transitions {to:'Accepted'}`，是因为它不只是迁移：
   * 它**创建了另一个对象**，而迁移接口的契约里没有这回事。
   * 拒绝倒确实只是迁移，所以拒绝没有对应端点。
   */
  app.post('/v1/resources/:id/acceptance', async (request, reply) => {
    const id = resourceIdSchema.parse((request.params as { id: string }).id)
    const created = await inTenant(request, (service, caller) => service.acceptProposal(caller, id))
    return reply.status(201).send(toWire(created))
  })

  app.post('/v1/resources/:id/transitions', async (request, reply) => {
    const id = resourceIdSchema.parse((request.params as { id: string }).id)
    const body = transitionSchema.parse(withIfMatch(request, 'expectedVersion'))
    const resource = await inTenant(request, (service, caller) =>
      service.transition(caller, id, body.to, {
        expectedVersion: body.expectedVersion,
        reason: body.reason,
      }),
    )
    return reply.header('etag', `"${resource.version}"`).send(toWire(resource))
  })

  // AIP 风格的自定义方法（`resource:verb`）。
  //
  // Fastify 的路由器把 `:query` 解析成路径参数，所以不能逐个注册
  // `/v1/resources:query`、`/v1/graph:traverse`——它们会归一成同一条路由而冲突。
  // 这里注册一条参数路由再显式分发：未知的自定义方法返回 404，
  // 而不是静默落到某个碰巧注册在前的处理器上。
  app.post('/v1/resources:action', async (request, reply) => {
    const action = customMethod(request)
    if (action !== 'query') {
      return reply.status(404).send({ error: 'not_found', message: `unknown custom method: ${action}` })
    }
    const body = querySchema.parse(request.body ?? {})
    const result = await inTenant(request, (service, caller) =>
      service.query(
        caller,
        {
          type: body.type,
          workspace: body.filter?.workspace,
          project: body.filter?.project,
          owner: body.filter?.owner,
          status: body.filter?.status,
          labels: body.filter?.labels,
          attributes: body.filter?.attributes,
          includeDeleted: body.filter?.includeDeleted,
          text: body.filter?.text,
        },
        { size: body.page?.size ?? 50, cursor: body.page?.cursor },
      ),
    )
    return { items: result.items.map(toWire), nextCursor: result.nextCursor }
  })

  /**
   * 可分享的读路径（docs/dogfooding-log.md #5）。
   *
   * 和 `POST :query` 共用同一个 `service.query`，只是把参数从请求体挪到查询串——
   * 这样一个看板视图才有 URL。共用一条实现，两者的行为不可能分叉。
   */
  app.get('/v1/resources', async (request) => {
    const q = queryParamsSchema.parse(request.query ?? {})
    const result = await inTenant(request, (service, caller) =>
      service.query(
        caller,
        {
          type: q.type,
          workspace: q.workspace,
          project: q.project,
          owner: q.owner,
          status: q.status,
          labels: q.labels,
          text: q.text,
          includeDeleted: q.includeDeleted === 'true',
        },
        { size: q.size ?? 50, cursor: q.cursor },
      ),
    )
    return { items: result.items.map(toWire), nextCursor: result.nextCursor }
  })

  // ── Dashboard 指标（FR-DASH-005/006/010/011） ─────────────
  //
  // 注意这里**只有 GET**。指标没有写路径，不是"暂时还没做"，
  // 而是设计如此：指标是算出来的，因此系统里不存在人工填报入口。
  app.get('/v1/metrics', async (request) => {
    const items = await inTenant(request, async (service, caller) => {
      // 目录本身也要认证过才给：指标名会泄漏这个系统在盯什么
      void caller
      return new DashboardService(service).catalogue()
    })
    return { items }
  })

  /**
   * 北极星指标（FR-DASH-015）。
   *
   * 单独一条路径而不是混进 `/v1/metrics/:id`：它的形状不一样——
   * 有分级分布、有口径版本、有"还可能变"的临时计数。
   * 硬套进通用指标模型只会让那个模型变成什么都能装的容器。
   */
  app.get('/v1/metrics:automation-rate', async (request) => {
    const q = automationRateSchema.parse(request.query ?? {})
    const summary = await inTenant(request, async (service, caller) => {
      const registry = deps.lifecycles === undefined ? deps.workflows : await deps.lifecycles.current()
      return new DashboardService(service, registry).automationRate(
        caller,
        { project: q.project, workspace: q.workspace },
        {
          period: {
            from: q.from === undefined ? undefined : new Date(q.from),
            to: q.to === undefined ? undefined : new Date(q.to),
          },
        },
      )
    })
    return {
      ...summary,
      // 明细一起给：北极星指标必须能下钻到"是哪些工作项"，
      // 否则它只是一个没人能验证的数字
      items: summary.items.map((i) => ({
        id: i.id,
        type: i.type,
        title: i.title,
        level: i.level,
        editRatio: i.editRatio,
        agent: i.agent,
        provisional: i.provisional,
        reworked: i.reworked,
        acceptedAt: i.acceptedAt.toISOString(),
      })),
    }
  })

  app.get('/v1/metrics/:id', async (request) => {
    const params = metricIdSchema.parse(request.params)
    const q = metricScopeSchema.parse(request.query ?? {})
    const value = await inTenant(request, (service, caller) =>
      new DashboardService(service).value(caller, params.id, q),
    )
    return { ...value, computedAt: value.computedAt.toISOString() }
  })

  /** 下钻：和指标共用 filter，因此条数天然一致（FR-DASH-006） */
  app.get('/v1/metrics/:id/items', async (request) => {
    const params = metricIdSchema.parse(request.params)
    const q = metricBreakdownSchema.parse(request.query ?? {})
    const result = await inTenant(request, (service, caller) =>
      new DashboardService(service).breakdown(
        caller,
        params.id,
        { project: q.project, workspace: q.workspace },
        { size: q.size ?? 50, cursor: q.cursor },
        q.group,
      ),
    )
    return { items: result.items.map(toWire), nextCursor: result.nextCursor }
  })

  app.get('/v1/resources/:id/history', async (request) => {
    const id = resourceIdSchema.parse((request.params as { id: string }).id)
    const query = request.query as { size?: string; cursor?: string }
    const result = await inTenant(request, (service, caller) =>
      service.history(caller, id, {
        size: query.size === undefined ? 50 : Number(query.size),
        cursor: query.cursor,
      }),
    )
    return {
      items: result.items.map((h) => ({
        ...h,
        changedAt: h.changedAt.toISOString(),
      })),
      nextCursor: result.nextCursor,
    }
  })

  // ── 关系与图 ──────────────────────────────────────────────
  app.get('/v1/resources/:id/relations', async (request) => {
    const id = resourceIdSchema.parse((request.params as { id: string }).id)
    const query = request.query as { direction?: string; type?: string }
    const direction = relationDirectionSchema.parse(query.direction ?? 'out')
    const items = await inTenant(request, (service, caller) =>
      service.relationsOf(caller, id, direction, query.type),
    )
    return { items: items.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })) }
  })

  app.post('/v1/resources/:id/relations', async (request, reply) => {
    const fromId = resourceIdSchema.parse((request.params as { id: string }).id)
    const body = relateSchema.parse(request.body)
    const relation = await inTenant(request, (service, caller) =>
      service.relate(caller, {
        type: body.type,
        fromId,
        toId: body.toId,
        confidence: body.confidence,
      }),
    )
    return reply.status(201).send({ ...relation, createdAt: relation.createdAt.toISOString() })
  })

  app.delete('/v1/relations/:id', async (request, reply) => {
    const id = (request.params as { id: string }).id
    await inTenant(request, (service, caller) => service.unrelate(caller, id))
    return reply.status(204).send()
  })

  // 确认 / 否决 Agent 推断的关系（FR-ONT-006）
  app.post('/v1/relations/:id/confirmation', async (request) => {
    const id = (request.params as { id: string }).id
    const body = confirmRelationSchema.parse(request.body)
    const relation = await inTenant(request, (service, caller) =>
      service.confirmRelation(caller, id, body.confirmed),
    )
    return { ...relation, createdAt: relation.createdAt.toISOString() }
  })

  app.post('/v1/graph:action', async (request, reply) => {
    const action = customMethod(request)

    if (action === 'traverse') {
      const body = traverseSchema.parse(request.body)
      const result = await inTenant(request, (service, caller) =>
        service.traverse(caller, {
          start: body.start,
          follow: body.follow,
          maxDepth: body.maxDepth,
          direction: body.direction,
          limit: body.limit,
        }),
      )
      // truncated 必须出现在响应里：被截断而调用方不知道，
      // 比慢一点严重得多——他会以为自己拿到了全部
      return { items: result.hits, truncated: result.truncated }
    }

    // 关系图（FR-ONT-012）：节点带完整对象，外加它们**之间**的边。
    // 和 :traverse 分成两条而不是给它加参数——一个只回 id 的遍历
    // 和一张要画出来的图，负载差着一个数量级，上界也不该是同一个
    if (action === 'subgraph') {
      const body = traverseSchema.parse(request.body)
      const graph = await inTenant(request, (service, caller) =>
        service.subgraph(caller, {
          start: body.start,
          follow: body.follow,
          maxDepth: body.maxDepth,
          direction: body.direction,
          limit: body.limit,
        }),
      )
      return {
        nodes: graph.nodes.map((n) => ({ ...toWire(n.resource), depth: n.depth })),
        edges: graph.edges.map((e) => ({ ...e, createdAt: e.createdAt.toISOString() })),
        truncated: graph.truncated,
      }
    }

    if (action === 'path') {
      const body = pathSchema.parse(request.body)
      const path = await inTenant(request, (service, caller) =>
        service.shortestPath(caller, body.from, body.to, body.maxDepth),
      )
      return { path }
    }

    return reply.status(404).send({ error: 'not_found', message: `unknown custom method: ${action}` })
  })

  /**
   * 外部事件入站（FR-WF-006）。
   *
   * **不走 `/v1` 的身份钩子**：GitHub 不会带 `x-principal`。
   * 它的身份是**签名**——共享密钥证明了这个报文来自那个来源。
   * 强行套用主体认证只会逼所有人配一个假身份头，
   * 而那时真正的认证（验签）反倒可能被当成可选的。
   *
   * 翻译完就进 outbox，之后与内部事件走同一条路：
   * 同一个自动化引擎、同样的防环深度、同样的留痕。
   */
  app.post('/events/:source', async (request, reply) => {
    const sourceId = (request.params as { source: string }).source
    const source = deps.externalSources?.find((s) => s.id === sourceId)
    if (source === undefined) {
      // 列出已配置的来源：拼错一个名字时，光说"没找到"要人去翻配置
      throw new DomainError('not_found', `unknown event source: ${sourceId}`, 404, {
        known: (deps.externalSources ?? []).map((s) => s.id),
      })
    }

    const event = translate({
      source,
      tenant: deps.tenant ?? 'default',
      // 验签必须对**原始字节**做。用解析后的对象重新序列化去验，
      // 键序或空白只要差一点签名就对不上，而那种失败看起来像"密钥配错了"
      rawBody: (request as { rawBody?: string }).rawBody ?? '',
      headers: request.headers as Record<string, string | undefined>,
      signature: firstHeader(request.headers['x-signature-256']),
      now: clock.now(),
      traceId: firstHeader(request.headers['x-trace-id']) ?? newTraceId(),
    })

    await withTenant(db, event.tenant, (trx: Db) => new PgOutbox(trx).emit(event))
    // 202 而不是 200：事件收下了，自动化还没跑。
    // 回 200 会让调用方以为副作用已经发生了
    return reply.status(202).send({ accepted: true, event: event.payload['event'], subject: event.resourceId })
  })

  app.get('/health', async () => ({ status: 'ok' }))

  // 看板 UI。onRequest 的认证钩子只作用于 /v1，静态资源不需要身份——
  // 页面本身不含任何数据，数据全部由它带着身份头去 /v1 取。
  registerStatic(app)

  // ── 错误映射 ─────────────────────────────────────────────
  app.setErrorHandler((error: unknown, _request: FastifyRequest, reply: FastifyReply) => {
    if (error instanceof ZodError) {
      return reply.status(400).send({
        error: 'invalid_request',
        // 不说"body"：同一个处理器也接住查询串的校验错误，
        // 而"request body failed validation"会把人送去检查一个根本没有的请求体。
        // 具体位置在 details 的 path 里
        message: 'request failed validation',
        details: error.issues.flatMap(issueDetails),
      })
    }
    if (error instanceof DomainError) {
      return reply.status(error.status).send({
        error: error.code,
        message: error.message,
        details: error.details,
      })
    }
    const message = error instanceof Error ? error.message : String(error)
    return reply.status(500).send({ error: 'internal_error', message })
  })

  return app
}

/** 允许用 If-Match 头代替 body 里的 expectedVersion，两者都可以 */
function withIfMatch(request: FastifyRequest, field = 'expectedVersion'): unknown {
  const body = (request.body ?? {}) as Record<string, unknown>
  if (body[field] !== undefined) return body
  const raw = firstHeader(request.headers['if-match'])
  if (raw === undefined) return body
  return { ...body, [field]: Number(raw.replace(/"/g, '')) }
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0]
  return value
}

/**
 * 取出自定义方法名。
 *
 * 路由参数捕获到的值带着前导冒号（`:query`），这里剥掉它。
 * 不是 `:` 开头说明 URL 形如 `/v1/resourcesXYZ`，返回原值让上面的分发拒绝掉。
 */
function customMethod(request: FastifyRequest): string {
  const raw = (request.params as { action?: string }).action ?? ''
  return raw.startsWith(':') ? raw.slice(1) : raw
}

/**
 * 把一条 Zod 问题渲染成客户端能直接定位的形式。
 *
 * `unrecognized_keys` 的 `path` 指向**容器**而不是多余的那个字段，
 * 顶层多写一个字段时 path 就是空数组。照直渲染的话客户端拿到的是
 * `{path: "", message: "Unrecognized key(s)…"}`——知道错了，不知道错在哪。
 * 字段名在 `issue.keys` 里，每个多余字段拆成一条，
 * 客户端就能像处理其他校验错误一样按 path 定位。
 */
function issueDetails(issue: ZodIssue): Array<{ path: string; message: string }> {
  const base = issue.path.join('.')
  if (issue.code !== 'unrecognized_keys') {
    return [{ path: base, message: issue.message }]
  }
  return issue.keys.map((key) => ({
    path: base === '' ? key : `${base}.${key}`,
    message: 'unrecognized field',
  }))
}
