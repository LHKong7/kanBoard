import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type pg from 'pg'
import type { FastifyInstance } from 'fastify'
import { setupTestDb } from '../helpers/db.ts'
import { buildServer } from '../../src/api/server.ts'
import { buildDefaultRegistry } from '../../src/ontology/defaults.ts'
import { buildDefaultWorkflowRegistry } from '../../src/workflow/defaults.ts'
import { defaultPolicies } from '../../src/identity/default-policies.ts'

/**
 * 端点清单（FR-RES-011：Agent 与人共用同一 API，无旁路端点）。
 *
 * 这条需求的验收标准原文是「端点清单审查通过」——**一次人工审查**。
 * 人工审查有个众所周知的性质：第一次做得很认真，然后就不做了。
 * 而"无旁路端点"恰恰是那种一旦破了就再也补不回来的性质：
 * 第一条 `/v1/agents/:id/run` 加进去之后，第二条就没有理由拒绝了。
 *
 * 所以把它变成机器做的事。清单写死在这里：加一条路由就会红，
 * 那时必须回答"人也走这条路吗"，然后**有意识地**改这份清单。
 */

const TENANT = 't_acme'
let pool: pg.Pool
let app: FastifyInstance

beforeAll(async () => {
  pool = await setupTestDb()
  app = buildServer({
    pool,
    registry: buildDefaultRegistry(),
    workflows: buildDefaultWorkflowRegistry(),
    policies: defaultPolicies(TENANT),
  })
  await app.ready()
})

afterAll(async () => {
  await app.close()
  await pool.end()
})

/**
 * 全部业务端点。
 *
 * 注意里面**没有一条**是给 Agent 的：Agent 要跑一次任务，
 * 走的是 `POST /v1/resources` 建一个 AgentRun——和人建任何对象
 * 完全同一条路径，因此权限、审计、租户隔离一次实现即可。
 */
const EXPECTED = [
  'GET /',
  'GET /app.js',
  'GET /health',
  'GET /index.html',
  'GET /style.css',
  'GET /v1/metrics',
  'GET /v1/metrics/:id',
  'GET /v1/metrics/:id/items',
  'GET /v1/metrics:automation-rate',
  'GET /v1/ontology/entity-types',
  'GET /v1/ontology/relation-types',
  'GET /v1/resources',
  'GET /v1/resources/:id',
  'GET /v1/resources/:id/history',
  'GET /v1/resources/:id/relations',
  'GET /v1/resources/:id/transitions',
  'GET /v1/workflows',
  'POST /v1/graph:action',
  'POST /v1/relations/:id/confirmation',
  'POST /v1/resources',
  'POST /v1/resources/:id/relations',
  'POST /v1/resources/:id/transitions',
  'POST /v1/resources:action',
  // 外部事件入站（FR-WF-006）。**不在 /v1 下，也不带主体身份**——
  // GitHub 不会带 x-principal，它的身份是签名。
  //
  // 这不构成 FR-RES-011 说的"旁路端点"：它不让任何主体做主 API 做不到的事，
  // 它做的是把外部系统的一条消息翻译成一个领域事件，
  // 之后走的是和内部事件完全同一条路。
  'POST /events/:source',
  'PUT /v1/workflows/:id',
  'DELETE /v1/relations/:id',
  'DELETE /v1/resources/:id',
  'PATCH /v1/resources/:id',
]

/** 从 Fastify 的路由树里读出实际清单 */
function actualRoutes(instance: FastifyInstance): string[] {
  const tree = instance.printRoutes({ commonPrefix: false })
  const out: string[] = []
  const stack: string[] = []

  for (const line of tree.split('\n')) {
    if (line.trim() === '') continue
    // 树形前缀的字符数决定层级；每层 4 个字符
    const marker = line.search(/[^│├└─\s]/)
    if (marker < 0) continue
    const depth = Math.floor(marker / 4)
    const rest = line.slice(marker)
    const match = /^(.*?)\s*\(([A-Z, ]+)\)\s*$/.exec(rest)
    const segment = match === null ? rest.trim() : (match[1] ?? '').trim()

    stack.length = depth
    stack[depth] = segment

    if (match !== null) {
      const path = stack.slice(0, depth + 1).join('')
      for (const method of (match[2] ?? '').split(',').map((m) => m.trim())) {
        // HEAD 是 Fastify 给每条 GET 自动加的，不是单独设计的端点
        if (method === 'HEAD' || method === '') continue
        out.push(`${method} ${path.replace(/\/$/, '') || '/'}`)
      }
    }
  }
  return out
}

describe('endpoint inventory (FR-RES-011)', () => {
  it('matches the reviewed list exactly', () => {
    // 排序后比较：路由的注册顺序不该影响这条断言
    expect(actualRoutes(app).sort()).toEqual([...EXPECTED].sort())
  })

  it('has no agent-only endpoint', () => {
    // 就算清单被人更新了，这一条仍然拦得住最典型的那种旁路。
    // Agent 发起一次执行的方式是 POST /v1/resources 建一个 AgentRun
    const suspicious = actualRoutes(app).filter((route) =>
      /\/(agents?|bots?|internal|admin)\b/i.test(route),
    )
    expect(suspicious).toEqual([])
  })

  it('reads a real route tree, not an empty one', () => {
    // 解析器写坏时 actualRoutes 会返回空数组，
    // 于是上面两条断言都会"通过"——一个测了个寂寞的测试套件
    expect(actualRoutes(app).length).toBeGreaterThan(20)
  })
})
