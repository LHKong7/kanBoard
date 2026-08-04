import { buildDefaultRegistry } from './ontology/defaults.ts'
import { buildDefaultWorkflowRegistry } from './workflow/defaults.ts'
import { DEFAULT_AUTOMATION_RULES } from './workflow/automation.ts'
import { OutboxPoller } from './infrastructure/poller.ts'
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

const app = buildServer({ pool, registry, workflows, policies })

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

const shutdown = async (signal: string): Promise<void> => {
  console.log(`${signal} received, shutting down`)
  poller?.stop()
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
