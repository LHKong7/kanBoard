import { readdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import pg from 'pg'

/**
 * 迁移执行器。
 *
 * 刻意保持朴素：按文件名顺序执行、记录已应用的版本、每个迁移一个事务。
 * 迁移不该是需要调试的东西。
 */

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations')

export async function migrate(connectionString: string): Promise<string[]> {
  const client = new pg.Client({ connectionString })
  await client.connect()
  const applied: string[] = []

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name       TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `)

    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort()
    const { rows } = await client.query<{ name: string }>('SELECT name FROM schema_migrations')
    const done = new Set(rows.map((r) => r.name))

    for (const file of files) {
      if (done.has(file)) continue
      const sqlText = await readFile(join(MIGRATIONS_DIR, file), 'utf8')
      await client.query('BEGIN')
      try {
        await client.query(sqlText)
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file])
        await client.query('COMMIT')
        applied.push(file)
      } catch (error) {
        await client.query('ROLLBACK')
        throw new Error(`migration ${file} failed: ${String(error)}`, { cause: error })
      }
    }
  } finally {
    await client.end()
  }

  return applied
}

const entry = process.argv[1]
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  const url = process.env['DATABASE_URL']
  if (url === undefined) {
    console.error('DATABASE_URL is not set')
    process.exit(1)
  }
  const applied = await migrate(url)
  console.log(applied.length > 0 ? `applied: ${applied.join(', ')}` : 'already up to date')
}
