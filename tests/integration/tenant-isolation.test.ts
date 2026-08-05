import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import pg from 'pg'
import { sql } from 'kysely'
import { adminUrl, assertNotSuperuser, queryAsTenant, setupTestDb, truncateAll } from '../helpers/db.ts'
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
          status_since: new Date(),
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
            status_since: new Date(),
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

/**
 * 审计与历史是 append-only（FR-IAM-013）。
 *
 * 001_foundation.sql 里 `audit_log` 上方一直写着「append-only，永不物理删除」，
 * 而同一个文件末尾的授权循环给每张表都授了 UPDATE 和 DELETE——
 * 包括它自己。也就是说这句话此前只是一句话。
 *
 * **应用能改写的审计日志不是审计日志**：它的全部价值来自
 * "发生过的事一定还在里面"。
 */
describe('audit and history cannot be rewritten (FR-IAM-013)', () => {
  const TENANT = 't_alpha'

  async function seedOneAuditRow(): Promise<void> {
    await withTenant(db, TENANT, async (trx) => {
      await trx
        .insertInto('audit_log')
        .values({
          tenant: TENANT,
          subject: 'user://alice',
          action: 'Task.Create',
          decision: 'Allow',
          reason: 'test',
          occurred_at: new Date(),
        })
        .execute()
    })
  }

  it('lets the application append', async () => {
    // 前提：写入本身是通的。不然下面两条"改不了"毫无意义
    await seedOneAuditRow()
    const rows = await queryAsTenant(pool, TENANT, 'SELECT 1 FROM audit_log')
    expect(rows.length).toBeGreaterThan(0)
  })

  it('refuses an UPDATE from the application role', async () => {
    // 第一道：权限。应用角色根本没有 UPDATE
    await seedOneAuditRow()
    await expect(
      queryAsTenant(pool, TENANT, `UPDATE audit_log SET decision = 'Deny'`),
    ).rejects.toThrow(/permission denied/)
  })

  it('refuses a DELETE from the application role', async () => {
    await seedOneAuditRow()
    await expect(queryAsTenant(pool, TENANT, 'DELETE FROM audit_log')).rejects.toThrow(
      /permission denied/,
    )
  })

  it('refuses even a role that holds the grant', async () => {
    // 第二道：触发器。光收回权限不够——将来给某张表补授权时，
    // 一句 `GRANT ALL ON ALL TABLES` 就能把第一道悄悄撤销掉。
    // 触发器是表自己带着的规则，跟着表走，不依赖谁记得
    await seedOneAuditRow()
    const owner = new pg.Client({ connectionString: adminUrl() })
    await owner.connect()
    try {
      await expect(owner.query('DELETE FROM audit_log')).rejects.toThrow(/append-only/)
      await expect(owner.query(`UPDATE audit_log SET decision = 'Deny'`)).rejects.toThrow(
        /append-only/,
      )
    } finally {
      await owner.end()
    }
  })

  it('protects resource history the same way', async () => {
    // 历史是"谁在什么时候把什么改成了什么"的唯一记录。
    // 它可改的话，Automation Rate 之类靠回放历史算出来的指标全部失去意义
    const owner = new pg.Client({ connectionString: adminUrl() })
    await owner.connect()
    try {
      await expect(owner.query('DELETE FROM resource_history')).rejects.toThrow(/append-only/)
    } finally {
      await owner.end()
    }
  })
})
