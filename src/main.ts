import { buildDefaultRegistry } from './ontology/defaults.ts'
import { buildDefaultWorkflowRegistry, DEFAULT_LIFECYCLES } from './workflow/defaults.ts'
import { ReloadingWorkflowRegistry } from './infrastructure/lifecycle-store.pg.ts'
import { DEFAULT_AUTOMATION_RULES } from './workflow/automation.ts'
import { OutboxPoller } from './infrastructure/poller.ts'
import { SlaSweeper } from './infrastructure/sla-sweeper.pg.ts'
import { ArchiveSweeper } from './infrastructure/archive-sweeper.pg.ts'
import { archiveActions } from './infrastructure/archive-actions.ts'
import { slaNotifier } from './infrastructure/sla-notifier.ts'
import { summarise, sweepOntologyHealth } from './infrastructure/ontology-health.pg.ts'
import { sweepOverdueRuns } from './infrastructure/process-sweeper.ts'
import { RELEASE_PROCESS } from './workflow/release-process.ts'
import { AgentRunner } from './infrastructure/agent-runner.ts'
import { ScriptedModelClient } from './infrastructure/model/scripted.ts'
import { createPiModelClient, modelPolicyFromEnv } from './infrastructure/model/pi.ts'
import type { AiPolicy, DataClassification } from './domain/agent/egress.ts'
import type { ModelClient } from './domain/agent/types.ts'
import { defaultPolicies } from './identity/default-policies.ts'
import { createPool } from './infrastructure/db/client.ts'
import { migrate } from './infrastructure/db/migrate.ts'
import { buildServer } from './api/server.ts'

const connectionString = process.env['DATABASE_URL']
if (connectionString === undefined) {
  console.error('DATABASE_URL is not set')
  process.exit(1)
}

// v1 以单租户模式运行（ADR-0005）：tenant 恒为 default，用户界面上不出现租户概念。
// 数据模型自始带 tenant，将来要做 SaaS 时打开租户注册即可，不用重建表。
const tenant = process.env['PROJECTOS_TENANT'] ?? 'default'
const port = Number(process.env['PORT'] ?? 3000)

/**
 * 迁移用的连接与应用用的连接是分开的。
 *
 * 建表需要 DDL 权限，跑业务不需要。用同一个连接串意味着 API 进程常驻着
 * 一个能 `DROP TABLE` 的身份——RLS 的 `FORCE` 挡得住 owner 绕过读写，
 * 挡不住一次 DDL。测试夹具（tests/helpers/db.ts）一直是分开的，
 * 只有生产入口没分；自用第一天就绊在这里
 * （docs/dogfooding-log.md #4）：以非特权角色启动直接起不来。
 *
 * 不设 `MIGRATE_DATABASE_URL` 就退回 `DATABASE_URL`，本地开发照旧一条命令跑通。
 */
const migrateUrl = process.env['MIGRATE_DATABASE_URL'] ?? connectionString

if (process.env['PROJECTOS_SKIP_MIGRATE'] === 'true') {
  console.log('migrations skipped (PROJECTOS_SKIP_MIGRATE=true)')
} else {
  const applied = await migrate(migrateUrl)
  if (applied.length > 0) {
    console.log(`migrations applied: ${applied.join(', ')}`)
  }
}

const pool = createPool({ connectionString })
const registry = buildDefaultRegistry()
const workflows = buildDefaultWorkflowRegistry()
const policies = defaultPolicies(tenant)

/**
 * 可热加载的状态机（FR-WF-001）。
 *
 * 库里的定义覆盖同名内置定义；库里没有的，内置的继续生效。
 * TTL 决定多进程部署时其余进程最迟多久跟上——写入进程立刻生效。
 */
const lifecycles = new ReloadingWorkflowRegistry({
  pool,
  tenant,
  builtins: DEFAULT_LIFECYCLES,
  ttlMs: Number(process.env['PROJECTOS_LIFECYCLE_TTL_MS'] ?? 5_000),
})

/**
 * 可编排的流程（FR-WF-010）。
 *
 * 显式一张清单，不是自动扫目录：一个流程会推进状态、调外部系统，
 * 哪些流程可以被启动应该是有人决定过的事。
 */
const PROCESSES = [RELEASE_PROCESS]

const app = buildServer({ pool, registry, workflows, lifecycles, policies, processes: PROCESSES })

/**
 * Poller 进程角色（ADR-0008）。
 *
 * `PROJECTOS_ROLE=api` 时不启动它——生产环境应当把 api 与 poller 分开部署，
 * 这样后台积压不会影响请求时延。默认 `all` 是为了本地开发起一个进程就能跑通。
 */
const role = process.env['PROJECTOS_ROLE'] ?? 'all'
const poller =
  role === 'api'
    ? null
    : new OutboxPoller({ pool, registry, workflows, policies, rules: DEFAULT_AUTOMATION_RULES, tenants: [tenant] })

/**
 * SLA 巡检（FR-WF-002）。跟 poller 同一个进程角色。
 *
 * 间隔默认 1 分钟。它决定的是**检测延迟的上界**——一条 5 天的 SLA
 * 晚一分钟报出来没有任何影响，而把间隔调到秒级只会让数据库白干活。
 *
 * 设成 0 可以关掉。关掉是一个显式的选择，而不是"忘了启动"：
 * 启动时会打印它有没有在跑，因为一个悄悄没起来的告警巡检
 * 表现出来就是"这个系统从来不告警"，而那看起来像一切正常。
 */
const sweepIntervalMs = Number(process.env['PROJECTOS_SLA_SWEEP_MS'] ?? 60_000)
const sweeper =
  role === 'api' || sweepIntervalMs <= 0
    ? null
    : new SlaSweeper({
        pool,
        tenants: [tenant],
        workflows,
        onBreach: slaNotifier({ pool, registry, workflows, policies }),
      })
let sweepTimer: NodeJS.Timeout | null = null

/**
 * 自动归档 / 自动关闭巡检（project-management-guide §2.6）。
 *
 * 默认一小时一次。这两条规则的时间尺度是**月**，分钟级地扫一遍
 * 只是把库占住，而结论一小时内不会变。
 *
 * 它对没配 `archiveInMonths` / `closeInMonths` 的项目**什么都不做**，
 * 所以默认开着是安全的：不配置就等于没开启这个功能。
 */
const archiveIntervalMs = Number(process.env['PROJECTOS_ARCHIVE_SWEEP_MS'] ?? 60 * 60 * 1000)
const archiveSweeper =
  role === 'api' || archiveIntervalMs <= 0
    ? null
    : new ArchiveSweeper({
        pool,
        tenants: [tenant],
        workflows,
        ...archiveActions({ pool, registry, workflows, policies }),
      })
let archiveTimer: NodeJS.Timeout | null = null

/**
 * 本体一致性巡检（FR-ONT-010 验收标准：**每日报告**）。
 *
 * 默认一天一次。这类问题（孤儿、断链、环）是**慢慢积累**出来的，
 * 分钟级地扫一遍全租户只是把库占住，而结论一天都不会变。
 *
 * 和 SLA 巡检同一个约定：设成 0 显式关掉，启动时说清楚它在不在跑——
 * 一个悄悄没起来的巡检表现出来就是"这个系统的数据一直很干净"。
 */
const healthIntervalMs = Number(process.env['PROJECTOS_HEALTH_SWEEP_MS'] ?? 24 * 60 * 60 * 1000)
let healthTimer: NodeJS.Timeout | null = null

/**
 * 等人等过头了的流程实例（FR-WF-010 的"超时"那一档）。
 *
 * 默认一分钟一次。它决定的是**超时被兑现的延迟上界**——
 * 一个 24 小时的人工节点晚一分钟超时没有任何影响，
 * 而不跑这个巡检的后果是那个实例永远挂着，攥着一个已冻结的 Release。
 */
const processSweepMs = Number(process.env['PROJECTOS_PROCESS_SWEEP_MS'] ?? 60_000)
let processTimer: NodeJS.Timeout | null = null

/**
 * Agent Runner（ADR-0008 的第三种进程角色）。
 *
 * 三种模型底座：
 *
 * | PROJECTOS_MODEL | 是什么 | 用在哪 |
 * | --- | --- | --- |
 * | `none`（缺省） | 不启动 runner | 没配模型的部署 |
 * | `scripted` | 确定性回复，不出网 | 验证链路本身是不是通的 |
 * | `pi` | 经 pi 接真实供应商（ADR-0013） | 真正干活 |
 *
 * 缺省是 `none` 而不是某个"看起来能跑"的假实现：后者会安静地产出
 * 一堆无意义的草稿，而草稿是会被人当真的。
 */
const modelKind = process.env['PROJECTOS_MODEL'] ?? 'none'

/**
 * 租户级 AI 策略（FR-AI-012/014，决策见 ADR-0006）。
 *
 * v1 单租户（ADR-0005），所以这几项从环境变量读；开放多租户时它们
 * 变成租户上的配置，`AgentRuntime` 那一侧一个字都不用改。
 *
 * **`PROJECTOS_MODEL=none` 就是 FR-AI-012 的那个开关**：没有底座，
 * 什么都出不去。所以配了底座即视为 enabled，而不是再要一个独立开关——
 * 一个必须同时打开两处才生效的配置，实际效果是第二处永远忘了打开。
 *
 * 供应商白名单**不从路由推导**。推导出来的白名单恒等于路由，
 * 于是"这一档到底发给谁"就再没有第二个人核对过——一个永远通过的
 * 检查和没有检查是一回事。它是一份独立配置，路由必须是它的子集。
 */
const approvedProviders = (process.env['PROJECTOS_AI_PROVIDERS'] ?? '')
  .split(',')
  .map((p) => p.trim())
  .filter((p) => p !== '')

const maxClassification = readMaxClassification(process.env['PROJECTOS_AI_MAX_CLASSIFICATION'])

let model: ModelClient | null = null
let modelProvider = 'unconfigured'
let aiPolicy: AiPolicy = { enabled: false, approvedProviders: [], maxClassification }

if (role !== 'api' && role !== 'poller' && modelKind !== 'none') {
  if (modelKind === 'pi') {
    const client = await createPiModelClient({
      policy: modelPolicyFromEnv(),
      approvedProviders,
    })
    /**
     * 出境审计记的是**一个**供应商（ADR-0006 的字段表），而档位是每个
     * Agent 各自声明的。三档指向三家的话，这里挑哪一个写进审计都是错的。
     *
     * 所以宁可不让它起来。`client.providerFor(tier)` 已经备好了，
     * 等 `RuntimeDeps.provider` 改成按档位取值时，这道限制就可以拆掉。
     */
    if (client.providers.length > 1) {
      throw new Error(
        `PROJECTOS_MODEL=pi currently needs every tier on one provider, got: ${client.providers.join(', ')}. ` +
          'The egress audit records one provider per run (ADR-0006).',
      )
    }
    model = client
    modelProvider = client.providers[0] ?? 'unconfigured'
    aiPolicy = { enabled: true, approvedProviders, maxClassification }
  } else if (modelKind === 'scripted') {
    model = new ScriptedModelClient([
      { thought: '（确定性模型：不做实际推理）', action: { kind: 'finish', summary: '未接入真实模型' } },
    ])
    // 确定性实现不出网，所以"批准"它不是一个数据出境决定。但它仍然要
    // 有名字、仍然要过白名单——否则本地跑通的那条链路与生产跑的那条
    // 在出境这一段上是两回事，而那正是最不该只在生产上第一次执行的一段
    modelProvider = 'scripted'
    aiPolicy = { enabled: true, approvedProviders: [modelProvider], maxClassification }
  } else {
    throw new Error(`unknown PROJECTOS_MODEL="${modelKind}" (expected: none | scripted | pi)`)
  }
}

const runner =
  model === null
    ? null
    : new AgentRunner({
        pool,
        registry,
        workflows,
        policies,
        tenants: [tenant],
        model,
        aiPolicy,
        provider: modelProvider,
      })

if (runner === null && role !== 'api' && role !== 'poller') {
  console.log(
    'agent runner disabled: no model configured ' +
      '(set PROJECTOS_MODEL=pi with PROJECTOS_AI_PROVIDERS, or =scripted for a dry run)',
  )
}

/**
 * 允许出境的最高分级。
 *
 * 刻意只认到 `confidential`——ADR-0006 的缺省值。再往上（pii / secret）
 * 不是一个环境变量该决定的事：`prepareEgress` 无论如何都会脱敏 PII、
 * 无论如何都不放 secret 出去，而把上限写成它们只会让人以为可以。
 */
function readMaxClassification(raw: string | undefined): DataClassification {
  const allowed: readonly DataClassification[] = ['public', 'internal', 'confidential']
  if (raw === undefined || raw.trim() === '') return 'confidential'
  const value = raw.trim() as DataClassification
  if (!allowed.includes(value)) {
    throw new Error(
      `PROJECTOS_AI_MAX_CLASSIFICATION must be one of ${allowed.join(' | ')}, got "${raw}"`,
    )
  }
  return value
}

const shutdown = async (signal: string): Promise<void> => {
  console.log(`${signal} received, shutting down`)
  poller?.stop()
  if (archiveTimer !== null) clearInterval(archiveTimer)
  runner?.stop()
  if (sweepTimer !== null) clearInterval(sweepTimer)
  if (healthTimer !== null) clearInterval(healthTimer)
  if (processTimer !== null) clearInterval(processTimer)
  await app.close()
  await pool.end()
  process.exit(0)
}

process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))

if (role !== 'poller') {
  await app.listen({ port, host: '0.0.0.0' })
  console.log(`ProjectOS listening on :${port} (tenant=${tenant}, role=${role})`)
}

if (poller !== null) {
  console.log(`outbox poller started (${DEFAULT_AUTOMATION_RULES.length} automation rules)`)
  void poller.run()
}

if (runner !== null) {
  console.log(`agent runner started (model=${modelKind}, provider=${modelProvider})`)
  void runner.run()
}

if (sweeper !== null) {
  console.log(`sla sweeper started (every ${Math.round(sweepIntervalMs / 1000)}s)`)
  sweepTimer = setInterval(() => {
    // 巡检失败不该把进程带走，但必须说出来：
    // 一个安静停掉的告警巡检看起来和"没有任何超时"一模一样
    void sweeper.sweepOnce().catch((error: unknown) => console.error('[sla] sweep failed:', error))
  }, sweepIntervalMs)
  sweepTimer.unref()
} else if (role !== 'api') {
  console.log('sla sweeper disabled (PROJECTOS_SLA_SWEEP_MS=0)')
}

if (archiveSweeper !== null) {
  console.log(`archive sweeper started (every ${Math.round(archiveIntervalMs / 60_000)}m)`)
  archiveTimer = setInterval(() => {
    void archiveSweeper
      .sweepOnce()
      .then((outcomes) => {
        for (const outcome of outcomes) {
          // 归了几条、关了几条、几条没动成——三个数都说出来。
          // 只报成功数的话，"我开了自动关闭但 Backlog 没变小"查不出原因
          console.log(
            `[archive] ${outcome.projectId}: archived=${outcome.archived.length} closed=${outcome.closed.length} skipped=${outcome.skipped.length}`,
          )
          for (const skip of outcome.skipped) console.warn(`[archive] skipped ${skip.id}: ${skip.reason}`)
        }
      })
      .catch((error: unknown) => console.error('[archive] sweep failed:', error))
  }, archiveIntervalMs)
  archiveTimer.unref()
} else if (role !== 'api') {
  console.log('archive sweeper disabled (PROJECTOS_ARCHIVE_SWEEP_MS=0)')
}

if (role !== 'api' && healthIntervalMs > 0) {
  const runHealth = (): void => {
    void sweepOntologyHealth({ pool, registry, workflows, policies }, tenant)
      .then((result) => console.log(`[ontology-health] ${summarise(result)}`))
      // 巡检失败不该把进程带走，但必须说出来——一个安静停掉的巡检
      // 和"数据一直很干净"长得一模一样
      .catch((error: unknown) => console.error('[ontology-health] sweep failed:', error))
  }
  console.log(`ontology health sweep started (every ${Math.round(healthIntervalMs / 3_600_000)}h)`)
  // 先跑一次再进入周期。等满一天才出第一份报告的话，
  // 一个刚上线就有问题的租户要等到第二天才知道
  runHealth()
  healthTimer = setInterval(runHealth, healthIntervalMs)
  healthTimer.unref()
} else if (role !== 'api') {
  console.log('ontology health sweep disabled (PROJECTOS_HEALTH_SWEEP_MS=0)')
}

if (role !== 'api' && processSweepMs > 0) {
  console.log(`process timeout sweep started (every ${Math.round(processSweepMs / 1000)}s)`)
  processTimer = setInterval(() => {
    void sweepOverdueRuns({ pool, registry, workflows, policies, processes: PROCESSES }, tenant)
      .then((driven) => {
        // 只在真的推动了什么的时候说话。每分钟打一行"没有超时的实例"
        // 会把日志淹掉，而淹掉的日志和没有日志是一回事
        for (const run of driven) console.log(`[process] ${run.id} timed out → ${run.status}`)
      })
      .catch((error: unknown) => console.error('[process] sweep failed:', error))
  }, processSweepMs)
  processTimer.unref()
} else if (role !== 'api') {
  console.log('process timeout sweep disabled (PROJECTOS_PROCESS_SWEEP_MS=0)')
}
