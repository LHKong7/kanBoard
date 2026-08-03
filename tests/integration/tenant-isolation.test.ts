import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type pg from 'pg'
import { sql } from 'kysely'
import { assertNotSuperuser, setupTestDb, truncateAll } from '../helpers/db.ts'
import { createDb, withTenant } from '../../src/infrastructure/db/client.ts'
import type { Db } from '../../src/infrastructure/db/client.ts'

/**
 * ADR-0005 的核心验收项。
 *
 * 这些用例存在的唯一理由，是证明**应用层写错了也不会泄漏**。
 * 因此它们刻意使用不带 tenant 条件的裸查询——那正是我们担心的那种代码。
 */

let pool: pg.Pool
let db: Db

beforeAll(async () => {
  pool = await setupTestDb()
  await assertNotSuperuser(pool)
  db = createDb(pool)
  await seedTwoTenants()
})

afterAll(async () => {
  await pool.end()
})

async function seedTwoTenants(): Promise<void> {
  await truncateAll(pool)
  for (const [tenant, id] of [
    ['t_alpha', 'task_01J0000000000000000000ALFA'],
    ['t_beta', 'task_01J0000000000000000000BETA'],
  ] as const) {
    await withTenant(db, tenant, async (trx) => {
      await trx
        .insertInto('resources')
        .values({
          id,
          tenant,
          type: 'Task',
          ontology_version: '1.0.0',
          workspace: 'ws1',
          project: null,
          owner: `user://${tenant}`,
          created_by: `user://${tenant}`,
          created_at: new Date(),
          updated_at: new Date(),
          status: 'Todo',
          lifecycle: 'task-default',
          version: 1,
          labels: [],
          attributes: JSON.stringify({ title: `task for ${tenant}` }),
          visibility: 'workspace',
          deleted_at: null,
        })
        .execute()
    })
  }
}

describe('tenant isolation is enforced by the database, not the application', () => {
  it('a bare SELECT with no tenant predicate returns only the current tenant rows', async () => {
    const alpha = await withTenant(db, 't_alpha', async (trx) =>
      // 注意：没有 .where('tenant', ...) —— 这是刻意的
      trx.selectFrom('resources').select(['id', 'tenant']).execute(),
    )
    expect(alpha).toHaveLength(1)
    expect(alpha[0]?.tenant).toBe('t_alpha')

    const beta = await withTenant(db, 't_beta', async (trx) =>
      trx.selectFrom('resources').select(['id', 'tenant']).execute(),
    )
    expect(beta).toHaveLength(1)
    expect(beta[0]?.tenant).toBe('t_beta')
  })

  it('fetching another tenant row by its exact primary key returns nothing', async () => {
    const rows = await withTenant(db, 't_alpha', async (trx) =>
      trx
        .selectFrom('resources')
        .selectAll()
        .where('id', '=', 'task_01J0000000000000000000BETA')
        .execute(),
    )
    expect(rows).toHaveLength(0)
  })

  it('a query with no tenant context set sees nothing at all', async () => {
    // 不经过 withTenant：projectos.tenant 未设置，RLS 策略比较 NULL，无行匹配。
    // 失败方式是"查不到"而不是"查到全部"——这是刻意选择的方向。
    const rows = await db.selectFrom('resources').selectAll().execute()
    expect(rows).toHaveLength(0)
  })

  it('writing a row belonging to another tenant is rejected by WITH CHECK', async () => {
    await expect(
      withTenant(db, 't_alpha', async (trx) => {
        await trx
          .insertInto('resources')
          .values({
            id: 'task_01J0000000000000000000EVIL',
            tenant: 't_beta',
            type: 'Task',
            ontology_version: '1.0.0',
            workspace: 'ws1',
            project: null,
            owner: 'user://attacker',
            created_by: 'user://attacker',
            created_at: new Date(),
            updated_at: new Date(),
            status: 'Todo',
            lifecycle: null,
            version: 1,
            labels: [],
            attributes: JSON.stringify({ title: 'planted' }),
            visibility: 'workspace',
            deleted_at: null,
          })
          .execute()
      }),
    ).rejects.toThrow(/row-level security/i)
  })

  it('updating another tenant row affects nothing', async () => {
    const updated = await withTenant(db, 't_alpha', async (trx) =>
      trx
        .updateTable('resources')
        .set({ status: 'Hijacked' })
        .where('id', '=', 'task_01J0000000000000000000BETA')
        .executeTakeFirst(),
    )
    expect(updated.numUpdatedRows).toBe(0n)

    const stillTodo = await withTenant(db, 't_beta', async (trx) =>
      trx.selectFrom('resources').select('status').where('id', '=', 'task_01J0000000000000000000BETA').executeTakeFirst(),
    )
    expect(stillTodo?.status).toBe('Todo')
  })

  it('deleting another tenant row affects nothing', async () => {
    const deleted = await withTenant(db, 't_alpha', async (trx) =>
      trx.deleteFrom('resources').where('id', '=', 'task_01J0000000000000000000BETA').executeTakeFirst(),
    )
    expect(deleted.numDeletedRows).toBe(0n)
  })

  it('the tenant context does not survive the transaction that set it', async () => {
    // SET LOCAL 随事务结束回退。若误用 SET，连接归还池后
    // 下一个请求会带着上一个租户的身份——这是连接池下最隐蔽的越权路径。
    await withTenant(db, 't_beta', async (trx) => {
      const rows = await trx.selectFrom('resources').selectAll().execute()
      expect(rows).toHaveLength(1)
    })

    // 断言安全属性本身，而不是 GUC 的字面值：
    // 事务外的裸查询必须看不到任何东西。
    const afterwards = await db.selectFrom('resources').selectAll().execute()
    expect(afterwards).toHaveLength(0)

    const setting = await sql<{ tenant: string | null }>`select current_tenant() as tenant`.execute(db)
    expect(setting.rows[0]?.tenant ?? null).toBeNull()
  })

  it('every resource-bearing table has RLS enabled and forced', async () => {
    // 新增表时忘记开 RLS 是最容易犯的错。这条用例让它在 CI 里就暴露。
    const { rows } = await pool.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `SELECT relname, relrowsecurity, relforcerowsecurity
       FROM pg_class
       WHERE relname IN ('resources','relations','resource_history','outbox_events','audit_log','grants')`,
    )
    expect(rows).toHaveLength(6)
    for (const row of rows) {
      expect(row.relrowsecurity, `${row.relname} has RLS disabled`).toBe(true)
      expect(row.relforcerowsecurity, `${row.relname} does not FORCE RLS`).toBe(true)
    }
  })
})
