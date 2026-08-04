import { buildDefaultRegistry } from './ontology/defaults.ts'
import { buildDefaultWorkflowRegistry, DEFAULT_LIFECYCLES } from './workflow/defaults.ts'
import { ReloadingWorkflowRegistry } from './infrastructure/lifecycle-store.pg.ts'
import { DEFAULT_AUTOMATION_RULES } from './workflow/automation.ts'
import { OutboxPoller } from './infrastructure/poller.ts'
import { SlaSweeper } from './infrastructure/sla-sweeper.pg.ts'
import { slaNotifier } from './infrastructure/sla-notifier.ts'
import { AgentRunner } from './infrastructure/agent-runner.ts'
import { ScriptedModelClient } from './infrastructure/model/scripted.ts'
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

const app = buildServer({ pool, registry, workflows, lifecycles, policies })

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
 * Agent Runner（ADR-0008 的第三种进程角色）。
 *
 * 模型客户端目前只有确定性实现：真实供应商的适配器要凭据，
 * 而**没有凭据时应当明确地什么都不做**，不该退回到某个"看起来能跑"的假实现，
 * 否则线上会安静地产出一堆无意义的草稿。所以这里的默认是
 * 不启动 runner——想在本地跑通链路时用 PROJECTOS_MODEL=scripted 显式打开。
 */
const modelKind = process.env['PROJECTOS_MODEL'] ?? 'none'
const runner =
  role === 'api' || role === 'poller' || modelKind === 'none'
    ? null
    : new AgentRunner({
        pool,
        registry,
        workflows,
        policies,
        tenants: [tenant],
        model: new ScriptedModelClient([
          { thought: '（确定性模型：不做实际推理）', action: { kind: 'finish', summary: '未接入真实模型' } },
        ]),
      })

if (modelKind === 'none' && role !== 'api' && role !== 'poller') {
  console.log('agent runner disabled: no model configured (set PROJECTOS_MODEL=scripted for a dry run)')
}

const shutdown = async (signal: string): Promise<void> => {
  console.log(`${signal} received, shutting down`)
  poller?.stop()
  runner?.stop()
  if (sweepTimer !== null) clearInterval(sweepTimer)
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
  console.log(`agent runner started (model=${modelKind})`)
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
