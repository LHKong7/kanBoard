import { serviceIn } from './service-factory.ts'
import { createDb, withTenant } from './db/client.ts'
import { BufferedAuditSink, flushAudit } from './outbox.pg.ts'
import { systemCaller } from '../domain/automation/runner.ts'
import type { OntologyRegistry } from '../ontology/registry.ts'
import type { WorkflowRegistry } from '../workflow/engine.ts'
import type { Policy } from '../identity/types.ts'
import type { Clock } from '../platform/clock.ts'
import { systemClock } from '../platform/clock.ts'
import type pg from 'pg'

/**
 * 自动归档 / 自动关闭真正落地的两个动作。
 *
 * 和 `slaNotifier` 同一个套路，理由也一样：**走和人完全同一条路径**。
 * 让巡检自己 `UPDATE resources SET archived_at = now()` 会省掉这个文件，
 * 代价是这条路径上的租户隔离、权限、审计、历史、事件全都要重来一遍，
 * 而重来的那一份迟早会漏掉其中一样——通常是审计。
 *
 * 身份是 `system://internal`，和自动化引擎共用。它的权限刻意很窄，
 * 见 `SYSTEM_SUBJECT`：能推进状态、能读、能改几类对象，**不能删**。
 * 自动关闭改的是状态，走的是守卫照常生效的 `transition()`——
 * 一条守卫拦下的自动关闭会被记成 skipped，而不是硬推过去。
 */

export type ArchiveActionDeps = {
  pool: pg.Pool
  registry: OntologyRegistry
  workflows: WorkflowRegistry
  policies: readonly Policy[]
  clock?: Clock
}

export function archiveActions(deps: ArchiveActionDeps): {
  archive: (tenant: string, id: string) => Promise<void>
  close: (tenant: string, id: string, to: string) => Promise<void>
} {
  const clock = deps.clock ?? systemClock
  const db = createDb(deps.pool)

  async function run(tenant: string, fn: (service: ReturnType<typeof serviceIn>, caller: ReturnType<typeof systemCaller>) => Promise<void>): Promise<void> {
    const audit = new BufferedAuditSink()
    try {
      await withTenant(db, tenant, async (trx) => {
        const service = serviceIn(trx, tenant, {
          registry: deps.registry,
          workflows: deps.workflows,
          policies: deps.policies,
          audit,
          clock,
        })
        await fn(service, systemCaller(tenant, null))
      })
    } finally {
      // 审计单独一个事务：业务事务回滚时（尤其是被守卫拒绝），
      // 那次**被拒绝的尝试**同样要留痕
      const entries = audit.drain()
      if (entries.length > 0) {
        try {
          await withTenant(db, tenant, (trx) => flushAudit(trx, entries))
        } catch (error) {
          console.error('[archive] failed to flush audit:', error)
        }
      }
    }
  }

  return {
    archive: (tenant, id) => run(tenant, (service, caller) => service.setArchived(caller, id, true).then(() => undefined)),
    close: (tenant, id, to) =>
      run(tenant, (service, caller) =>
        service
          .transition(caller, id, to, { reason: 'automation: auto-close (project closeInMonths)' })
          .then(() => undefined),
      ),
  }
}
