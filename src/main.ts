import { buildDefaultRegistry } from './ontology/defaults.ts'
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

const applied = await migrate(connectionString)
if (applied.length > 0) {
  console.log(`migrations applied: ${applied.join(', ')}`)
}

const pool = createPool({ connectionString })
const app = buildServer({
  pool,
  registry: buildDefaultRegistry(),
  policies: defaultPolicies(tenant),
})

const shutdown = async (signal: string): Promise<void> => {
  console.log(`${signal} received, shutting down`)
  await app.close()
  await pool.end()
  process.exit(0)
}

process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))

await app.listen({ port, host: '0.0.0.0' })
console.log(`ProjectOS listening on :${port} (tenant=${tenant})`)
