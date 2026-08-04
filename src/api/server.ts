import Fastify from 'fastify'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { ZodError } from 'zod'
import type { ZodIssue } from 'zod'
import type pg from 'pg'
import { createDb, withTenant } from '../infrastructure/db/client.ts'
import type { Db } from '../infrastructure/db/client.ts'
import { PgResourceRepository } from '../infrastructure/resource-repository.pg.ts'
import { PgRelationRepository } from '../infrastructure/relation-repository.pg.ts'
import { BufferedAuditSink, flushAudit, PgOutbox } from '../infrastructure/outbox.pg.ts'
import { ResourceService } from '../domain/resource/service.ts'
import type { Caller } from '../domain/resource/service.ts'
import type { OntologyRegistry } from '../ontology/registry.ts'
import type { WorkflowRegistry } from '../workflow/engine.ts'
import type { Policy } from '../identity/types.ts'
import { systemClock } from '../platform/clock.ts'
import type { Clock } from '../platform/clock.ts'
import { DomainError } from '../platform/errors.ts'
import { newTraceId } from '../platform/id.ts'
import { parseDelegator, parseSubject } from './auth.ts'
import {
  createResourceSchema,
  pathSchema,
  querySchema,
  queryParamsSchema,
  confirmRelationSchema,
  relateSchema,
  relationDirectionSchema,
  resourceIdSchema,
  transitionSchema,
  traverseSchema,
  updateResourceSchema,
} from './schemas.ts'
import { toWire } from './serialize.ts'
import { registerStatic } from './static.ts'

export type ServerDeps = {
  pool: pg.Pool
  registry: OntologyRegistry
  workflows: WorkflowRegistry
  policies: readonly Policy[]
  clock?: Clock
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
  app.addHook('onRequest', async (request) => {
    if (!request.url.startsWith('/v1/')) return
    const subject = parseSubject(request.headers)
    callers.set(request, {
      subject,
      delegator: parseDelegator(request.headers, subject.tenant),
      traceId: firstHeader(request.headers['x-trace-id']) ?? newTraceId(),
      runId: firstHeader(request.headers['x-run-id']),
      mfa: firstHeader(request.headers['x-mfa']) === 'true',
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

    try {
      return await withTenant(db, subject.tenant, async (trx: Db) => {
        const service = new ResourceService({
          registry: deps.registry,
          workflows: deps.workflows,
          resources: new PgResourceRepository(trx, subject.tenant),
          relations: new PgRelationRepository(trx, subject.tenant),
          events: new PgOutbox(trx),
          audit,
          policies: deps.policies,
          clock,
        })
        return fn(service, caller)
      })
    } finally {
      // 独立事务落盘：业务事务回滚时（尤其是授权被拒），审计不能跟着消失。
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

  // 生命周期定义。UI 靠它渲染看板的列，而不是把状态硬编码在前端。
  app.get('/v1/workflows', async () => ({ items: deps.workflows.all() }))

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

    if (action === 'path') {
      const body = pathSchema.parse(request.body)
      const path = await inTenant(request, (service, caller) =>
        service.shortestPath(caller, body.from, body.to, body.maxDepth),
      )
      return { path }
    }

    return reply.status(404).send({ error: 'not_found', message: `unknown custom method: ${action}` })
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
        message: 'request body failed validation',
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
