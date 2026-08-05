import { Kysely, PostgresDialect, sql } from 'kysely'
import pg from 'pg'
import type { Database } from './schema.ts'

/**
 * 数据库连接与**租户会话**。
 *
 * 这里是 ADR-0005 落地的关键：每个事务开始时 `SET LOCAL projectos.tenant`，
 * RLS 策略读取它来过滤行。`SET LOCAL` 而不是 `SET`——会话变量必须随事务结束自动回退，
 * 否则连接池复用时会把上一个租户的身份带给下一个请求。
 */

export type DbConfig = {
  connectionString: string
  max?: number
  statementTimeoutMs?: number
}

export function createPool(config: DbConfig): pg.Pool {
  return new pg.Pool({
    connectionString: config.connectionString,
    max: config.max ?? 10,
    // 兜底，防止单条慢查询占住连接
    statement_timeout: config.statementTimeoutMs ?? 15_000,
  })
}

export function createDb(pool: pg.Pool): Kysely<Database> {
  return new Kysely<Database>({
    dialect: new PostgresDialect({ pool }),
  })
}

export type Db = Kysely<Database>

/**
 * 在指定租户的上下文中执行一个事务。
 *
 * 所有业务读写都必须走这里。直接用 db 而不设租户，RLS 会让查询返回空集——
 * 这是刻意的失败方式：宁可查不到，也不能查到别人的。
 */
export async function withTenant<T>(
  db: Db,
  tenant: string,
  fn: (trx: Db) => Promise<T>,
): Promise<T> {
  assertSafeTenant(tenant)
  return db.transaction().execute(async (trx) => {
    // set_config 的第三个参数 true = LOCAL，作用域限于当前事务
    await sql`select set_config('projectos.tenant', ${tenant}, true)`.execute(trx)
    return fn(trx)
  })
}

/**
 * tenant 值会进入 set_config。虽然它是参数化传入的，
 * 但仍然限制字符集：租户标识不该出现奇怪字符，越早拒绝越好。
 */
function assertSafeTenant(tenant: string): void {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(tenant)) {
    throw new Error(`invalid tenant identifier: ${JSON.stringify(tenant)}`)
  }
}
