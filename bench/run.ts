import pg from 'pg'
import type { InjectOptions } from 'fastify'
import { buildServer } from '../src/api/server.ts'
import { buildDefaultRegistry } from '../src/ontology/defaults.ts'
import { buildDefaultWorkflowRegistry } from '../src/workflow/defaults.ts'
import { defaultPolicies } from '../src/identity/default-policies.ts'
import { createPool } from '../src/infrastructure/db/client.ts'

/**
 * NFR-PERF 基线测量。
 *
 * 两条原则：
 *
 * 1. **走真实 HTTP 路径**。NFR 说的是"Resource 单体读取 P95 < 150ms"，
 *    指的是用户等待的时间，不是一条 SQL 的时间。直接测 SQL 会得到一个
 *    好看但无意义的数字——它把认证、授权、序列化全都省掉了。
 * 2. **以应用角色连接**，RLS 生效。用超级用户测等于测了一个生产里不存在的系统。
 */

const TENANT = 'default'
const HEADERS = {
  'content-type': 'application/json',
  'x-principal': 'user://alice',
  'x-tenant': TENANT,
  'x-roles': 'Admin',
  'x-capabilities': '',
}

type Scenario = {
  id: string
  label: string
  target: string
  targetMs: number | null
  /** 每次迭代发一个请求；返回 HTTP 状态用于校验 */
  request: (i: number) => Promise<number>
}

type Result = {
  id: string
  label: string
  target: string
  targetMs: number | null
  n: number
  p50: number
  p95: number
  p99: number
  max: number
  errors: number
  firstError: string | null
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
  return sorted[index] ?? 0
}

async function measure(scenario: Scenario, iterations: number, concurrency: number): Promise<Result> {
  // 预热：首次查询要付解析计划、填缓冲池的成本，把它算进 P95 是不诚实的。
  //
  // 索引从 `iterations` 之后取：有副作用的场景（状态迁移）若和测量阶段
  // 用同一批对象，测量时会撞上"已经迁移过"而收到 409——
  // 前一版就是这样，20 次预热正好污染了前 20 次测量。
  for (let i = 0; i < 20; i++) await scenario.request(iterations + i)

  const durations: number[] = []
  let errors = 0
  let next = 0
  let firstError: string | null = null

  async function worker(): Promise<void> {
    for (;;) {
      const i = next++
      if (i >= iterations) return
      const started = performance.now()
      try {
        const status = await scenario.request(i)
        const elapsed = performance.now() - started
        if (status >= 400) {
          errors++
          if (firstError === null) firstError = `HTTP ${status}`
        } else {
          durations.push(elapsed)
        }
      } catch (error) {
        errors++
        if (firstError === null) firstError = error instanceof Error ? error.message : String(error)
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, worker))

  const sorted = durations.slice().sort((a, b) => a - b)
  return {
    id: scenario.id,
    label: scenario.label,
    target: scenario.target,
    targetMs: scenario.targetMs,
    n: durations.length,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: sorted[sorted.length - 1] ?? 0,
    errors,
    firstError,
  }
}

export async function runBenchmark(options: {
  connectionString: string
  iterations?: number
  concurrency?: number
}): Promise<Result[]> {
  const iterations = options.iterations ?? 300
  const concurrency = options.concurrency ?? 8

  const pool = createPool({ connectionString: options.connectionString, max: 16 })
  const app = buildServer({
    pool,
    registry: buildDefaultRegistry(),
    workflows: buildDefaultWorkflowRegistry(),
    policies: defaultPolicies(TENANT),
  })
  await app.ready()

  // 取一批真实 id：随机猜 id 会命中不存在的行，测出来的是 404 的速度。
  //
  // 取样连接用的是同一个应用角色，因此**也受 RLS 约束**——必须先设租户，
  // 否则查出来是空的。改用超级用户取样倒是能绕过去，
  // 但那样基准的准备阶段就跑在一个生产里不存在的权限下了。
  const admin = new pg.Client({ connectionString: options.connectionString })
  await admin.connect()
  await admin.query(`SELECT set_config('projectos.tenant', $1, false)`, [TENANT])
  const sample = async (type: string, limit: number): Promise<string[]> => {
    const { rows } = await admin.query<{ id: string }>(
      `SELECT id FROM resources TABLESAMPLE SYSTEM (2) WHERE type = $1 LIMIT $2`,
      [type, limit],
    )
    if (rows.length >= limit) return rows.map((r) => r.id)
    // 小表上 TABLESAMPLE 可能取不满，退回顺序取
    const fallback = await admin.query<{ id: string }>(
      `SELECT id FROM resources WHERE type = $1 LIMIT $2`,
      [type, limit],
    )
    return fallback.rows.map((r) => r.id)
  }

  const taskIds = await sample('Task', 2000)
  const projectIds = await sample('Project', 50)
  const storyIds = await sample('Story', 500)
  await admin.end()

  // 空数组时直接报错：`xs[i % 0]` 是 undefined，拼进 URL 会变成
  // 一个必然 400 的请求，而那个 400 看起来像"接口有问题"，不像"取样没取到"
  const pick = <T>(xs: readonly T[], i: number): T => {
    const value = xs[i % xs.length]
    if (value === undefined) throw new Error('sample set is empty; benchmark cannot run')
    return value
  }

  for (const [label, ids] of [
    ['Task', taskIds],
    ['Project', projectIds],
    ['Story', storyIds],
  ] as const) {
    if (ids.length === 0) throw new Error(`no ${label} ids sampled; is the dataset seeded?`)
  }
  console.log(
    `  sampled ${taskIds.length} tasks / ${projectIds.length} projects / ${storyIds.length} stories\n`,
  )

  // 用 InjectOptions 而不是 Parameters<typeof app.inject>[0]：
  // inject 是重载的，Parameters<> 只会取到最后一个重载（无参的 Chain），
  // 于是这里的形参被推成 undefined，整段 bench 的类型检查静默失效
  const inject = async (init: InjectOptions): Promise<number> => {
    const res = await app.inject(init)
    return res.statusCode
  }

  const scenarios: Scenario[] = [
    {
      id: 'NFR-PERF-001',
      label: '单体读取 GET /v1/resources/:id',
      target: 'P95 < 150ms',
      targetMs: 150,
      request: (i) => inject({ method: 'GET', url: `/v1/resources/${pick(taskIds, i)}`, headers: HEADERS }),
    },
    {
      id: 'NFR-PERF-002',
      label: '列表查询 type=Task, size=50',
      target: 'P95 < 400ms',
      targetMs: 400,
      request: () =>
        inject({
          method: 'POST',
          url: '/v1/resources:query',
          headers: HEADERS,
          payload: { type: 'Task', page: { size: 50 } },
        }),
    },
    {
      id: 'NFR-PERF-002b',
      label: '列表查询 + attributes 过滤（GIN）',
      target: 'P95 < 400ms',
      targetMs: 400,
      request: (i) =>
        inject({
          method: 'POST',
          url: '/v1/resources:query',
          headers: HEADERS,
          payload: {
            type: 'Task',
            filter: { attributes: { assignee: `user://dev${i % 50}` } },
            page: { size: 50 },
          },
        }),
    },
    {
      id: 'NFR-PERF-002c',
      label: '列表查询 游标翻页（第 5 页）',
      target: 'P95 < 400ms',
      targetMs: 400,
      request: (i) =>
        inject({
          method: 'POST',
          url: '/v1/resources:query',
          headers: HEADERS,
          payload: { type: 'Task', page: { size: 50, cursor: pick(taskIds, i) } },
        }),
    },
    {
      id: 'NFR-PERF-002d',
      label: '检索 窄查询（中文 + 唯一编号，trigram 命中少量行）',
      target: 'P95 < 400ms',
      targetMs: 400,
      request: (i) =>
        inject({
          method: 'POST',
          url: '/v1/resources:query',
          headers: HEADERS,
          // '编号 <n>' 在语料里唯一。这是搜索框最常见的用法：找一个特定的东西
          payload: {
            type: 'Requirement',
            filter: { text: `编号 ${1 + (i % 10000)}` },
            page: { size: 50 },
          },
        }),
    },
    {
      id: 'NFR-PERF-002e',
      label: '检索 宽查询（中文短语命中约 1/4 语料）',
      target: 'P95 < 400ms',
      targetMs: 400,
      request: (i) =>
        inject({
          method: 'POST',
          url: '/v1/resources:query',
          headers: HEADERS,
          // 最坏的现实情况：命中面很大，但仍要按 id 倒序取前 50 条。
          // trigram 位图扫描要先把命中集合收齐再排序——这条是检索的上界
          payload: {
            type: 'Requirement',
            filter: { text: ['状态机可配置', '多租户隔离', '权限模型', '图查询遍历'][i % 4] },
            page: { size: 50 },
          },
        }),
    },
    {
      id: 'NFR-PERF-002f',
      label: '检索 短词（2 字，走不了 trigram，靠 type 索引收窄）',
      target: 'P95 < 400ms',
      targetMs: 400,
      request: (i) =>
        inject({
          method: 'POST',
          url: '/v1/resources:query',
          headers: HEADERS,
          // 中文两字词是最常见的输入之一，值得有个数字。
          //
          // 注意它**不是**"改回 ILIKE 就会变红"的护栏：带 type 过滤时
          // ILIKE 实测 14ms，同样远在 400ms 之内，这条照样绿。
          // 短查询选 strpos 的真正理由记在 002_search.sql 与仓储层的注释里，
          // 靠的是那份 2×2 实测，不是靠这条基准。
          payload: {
            type: 'Requirement',
            filter: { text: ['状态', '租户', '权限', '图谱'][i % 4] },
            page: { size: 50 },
          },
        }),
    },
    {
      id: 'NFR-PERF-003',
      label: '图遍历 深度 5，稠密含环（blockedBy）',
      target: 'P95 < 500ms',
      targetMs: 500,
      request: (i) =>
        inject({
          method: 'POST',
          url: '/v1/graph:traverse',
          headers: HEADERS,
          payload: {
            start: pick(taskIds, i),
            follow: ['blockedBy'],
            maxDepth: 5,
            direction: 'out',
            limit: 500,
          },
        }),
    },
    {
      id: 'NFR-PERF-003b',
      label: '图遍历 深度 3，Story→Task（含逆关系解析）',
      target: 'P95 < 500ms',
      targetMs: 500,
      request: (i) =>
        inject({
          method: 'POST',
          url: '/v1/graph:traverse',
          headers: HEADERS,
          payload: {
            start: pick(storyIds, i),
            follow: ['decomposedInto'],
            maxDepth: 3,
            direction: 'out',
            limit: 500,
          },
        }),
    },
    {
      id: 'NFR-PERF-003c',
      label: '图遍历 深度 5，Project 全后代（扇出最大）',
      target: 'P95 < 500ms',
      targetMs: 500,
      request: (i) =>
        inject({
          method: 'POST',
          url: '/v1/graph:traverse',
          headers: HEADERS,
          payload: {
            start: pick(projectIds, i),
            follow: ['contains', 'implementedBy', 'decomposedInto'],
            maxDepth: 5,
            direction: 'out',
            limit: 500,
          },
        }),
    },
    {
      id: 'NFR-PERF-004',
      label: '状态迁移 Todo→Doing（PDP + 守卫 + 历史 + 事件）',
      target: 'P95 < 300ms',
      targetMs: 300,
      // 每次用一个不同的 Task：同一个对象只能迁移一次，重复调用测的是被拒绝的路径
      request: (i) =>
        inject({
          method: 'POST',
          url: `/v1/resources/${pick(taskIds, i)}/transitions`,
          headers: HEADERS,
          payload: { to: 'Doing' },
        }),
    },
  ]

  const results: Result[] = []
  for (const scenario of scenarios) {
    process.stdout.write(`  ${scenario.id.padEnd(16)} ${scenario.label} … `)
    const result = await measure(scenario, iterations, concurrency)
    results.push(result)
    console.log(
      result.errors > 0 || result.n === 0
        ? `❌ ${result.errors} 次失败 / ${result.n} 次成功  ${result.firstError ?? ''}`
        : `P95 ${result.p95.toFixed(1)}ms  (n=${result.n})`,
    )
  }

  await app.close()
  await pool.end()
  return results
}

/**
 * 判定。
 *
 * 有错误就不给"达标"——哪怕成功那部分很快。
 * 前一版只统计成功请求的耗时，于是一个全部超时的场景
 * 得到空数组、百分位算出 0ms、被判为"达标"。
 * 一个在全面失败时报告成功的基准，比没有基准更危险。
 */
function verdict(result: Result): string {
  if (result.n === 0) return '⛔ 无有效样本'
  if (result.errors > 0) return `⛔ ${result.errors} 次失败`
  if (result.targetMs === null) return '—'
  return result.p95 <= result.targetMs ? '✅ 达标' : '❌ 未达标'
}

export function formatMarkdown(results: Result[], meta: Record<string, string>): string {
  const lines: string[] = []
  lines.push('| 指标 | 场景 | 目标 | n | 失败 | P50 | P95 | P99 | max | 结论 |')
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |')
  for (const r of results) {
    const cell = (ms: number): string => (r.n === 0 ? '—' : `${ms.toFixed(1)}ms`)
    lines.push(
      `| ${r.id} | ${r.label} | ${r.target} | ${r.n} | ${r.errors} | ${cell(r.p50)} | ` +
        `**${cell(r.p95)}** | ${cell(r.p99)} | ${cell(r.max)} | ${verdict(r)} |`,
    )
  }
  lines.push('')
  lines.push('测量条件：')
  for (const [key, value] of Object.entries(meta)) lines.push(`- ${key}：${value}`)
  return lines.join('\n')
}

const entry = process.argv[1]
if (entry !== undefined && import.meta.url.endsWith(entry.split('/').slice(-2).join('/'))) {
  const url = process.env['BENCH_DATABASE_URL']
  if (url === undefined) {
    console.error('BENCH_DATABASE_URL is not set')
    process.exit(1)
  }
  const iterations = Number(process.env['BENCH_ITERATIONS'] ?? 300)
  const concurrency = Number(process.env['BENCH_CONCURRENCY'] ?? 8)

  console.log(`benchmark: ${iterations} iterations × ${concurrency} concurrent\n`)
  const results = await runBenchmark({ connectionString: url, iterations, concurrency })

  console.log(
    '\n' +
      formatMarkdown(results, {
        并发: String(concurrency),
        每场景请求数: String(iterations),
        Node: process.version,
      }),
  )

  const broken = results.filter((r) => r.errors > 0 || r.n === 0)
  const missed = results.filter(
    (r) => r.errors === 0 && r.n > 0 && r.targetMs !== null && r.p95 > r.targetMs,
  )
  if (broken.length > 0) {
    console.log(`\n有失败请求 ${broken.length} 项：`)
    for (const r of broken) console.log(`  ${r.id}  ${r.errors} 次失败  ${r.firstError ?? ''}`)
  }
  if (missed.length > 0) {
    console.log(`\n未达标 ${missed.length} 项：${missed.map((r) => r.id).join(', ')}`)
  }
  // 非零退出码：基准要能进 CI，而 CI 只看退出码
  if (broken.length > 0 || missed.length > 0) process.exitCode = 1
}
