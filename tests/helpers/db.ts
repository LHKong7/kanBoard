import pg from 'pg'
import { migrate } from '../../src/infrastructure/db/migrate.ts'
import { createPool } from '../../src/infrastructure/db/client.ts'

/**
 * 测试数据库。
 *
 * 关键决定：集成测试**以非超级用户连接**。
 * 超级用户会绕过 RLS，用它跑测试等于把租户隔离的验证全部作废——
 * 测试会通过，生产会泄漏。
 */

const ADMIN_URL =
  process.env['TEST_ADMIN_DATABASE_URL'] ?? 'postgresql://postgres@127.0.0.1:55432/postgres'

const DB_NAME = process.env['TEST_DB_NAME'] ?? 'projectos_test'

function appUrl(): string {
  const base = new URL(ADMIN_URL)
  return `postgresql://projectos_test_app@${base.hostname}:${base.port}/${DB_NAME}`
}

export function adminUrl(): string {
  const base = new URL(ADMIN_URL)
  return `postgresql://${base.username || 'postgres'}@${base.hostname}:${base.port}/${DB_NAME}`
}

/** 重建测试库并迁移；返回一个**受 RLS 约束**的连接池 */
export async function setupTestDb(): Promise<pg.Pool> {
  const admin = new pg.Client({ connectionString: ADMIN_URL })
  await admin.connect()
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`)
    await admin.query(`CREATE DATABASE ${DB_NAME}`)
  } finally {
    await admin.end()
  }

  await migrate(adminUrl())

  // 应用角色：无 SUPERUSER、无 BYPASSRLS、非表 owner
  const owner = new pg.Client({ connectionString: adminUrl() })
  await owner.connect()
  try {
    await owner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'projectos_test_app') THEN
          CREATE ROLE projectos_test_app LOGIN;
        END IF;
      END
      $$;
    `)
    await owner.query('GRANT projectos_app TO projectos_test_app')
    await owner.query(`GRANT USAGE ON SCHEMA public TO projectos_test_app`)
    await owner.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO projectos_test_app`)
  } finally {
    await owner.end()
  }

  return createPool({ connectionString: appUrl() })
}

/** 确认连接确实不具备绕过 RLS 的能力——否则后面所有隔离断言都不成立 */
export async function assertNotSuperuser(pool: pg.Pool): Promise<void> {
  const { rows } = await pool.query<{ super: boolean; bypass: boolean }>(
    `SELECT rolsuper AS super, rolbypassrls AS bypass FROM pg_roles WHERE rolname = current_user`,
  )
  const row = rows[0]
  if (row === undefined) throw new Error('cannot determine current role')
  if (row.super || row.bypass) {
    throw new Error(
      'test connection can bypass RLS; tenant isolation assertions would be meaningless',
    )
  }
}

/**
 * 在租户上下文中执行一条原始 SQL，用于测试直接检查表内容。
 *
 * 必须开事务：`SET LOCAL` 在事务外是空操作，
 * 于是 RLS 看到的租户仍是 NULL，查询静默返回空集——
 * 一个只在测试里出现、且看起来像"功能没实现"的陷阱。
 */
export async function queryAsTenant<T extends pg.QueryResultRow>(
  pool: pg.Pool,
  tenant: string,
  sqlText: string,
): Promise<T[]> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query('SELECT set_config($1, $2, true)', ['projectos.tenant', tenant])
    const result = await client.query<T>(sqlText)
    await client.query('COMMIT')
    return result.rows
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

export async function truncateAll(pool: pg.Pool): Promise<void> {
  const admin = new pg.Client({ connectionString: adminUrl() })
  await admin.connect()
  try {
    // 表名**查出来**而不是写死一份清单。
    //
    // 写死的清单会悄悄过期：加了 `lifecycles` 之后忘了往这里补一行，
    // 于是上一个用例写的定义留到了下一个用例——症状是
    // "单跑绿、一起跑红"，而且看起来像被测代码有问题。
    // 这类清单必须自己维护自己。
    //
    // 用管理员连接：应用角色受 FORCE RLS 约束，
    // 没有租户上下文时 DELETE 一行也删不掉（而且不报错）。
    const { rows } = await admin.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables
       WHERE schemaname = 'public' AND tablename <> 'schema_migrations'`,
    )
    if (rows.length === 0) return
    const tables = rows.map((r) => `"${r.tablename}"`).join(', ')
    await admin.query(`TRUNCATE ${tables} CASCADE`)
  } finally {
    await admin.end()
  }
}
