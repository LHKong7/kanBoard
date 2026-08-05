import { serviceIn } from './service-factory.ts'
import { createDb, withTenant } from './db/client.ts'
import { BufferedAuditSink, flushAudit } from './outbox.pg.ts'
import { systemCaller } from '../domain/automation/runner.ts'
import { systemClock } from '../platform/clock.ts'
import type { HealthReport } from '../domain/ontology-health/sweep.ts'
import type { OntologyRegistry } from '../ontology/registry.ts'
import type { WorkflowRegistry } from '../workflow/engine.ts'
import type { Policy } from '../identity/types.ts'
import type { Clock } from '../platform/clock.ts'
import type pg from 'pg'

/**
 * 每日巡检（FR-ONT-010 验收标准的前半句）。
 *
 * 走的是**和 HTTP 那条完全同一个 `ontologyHealth`**：同一套快照、
 * 同一份判定、同一道授权。另写一条"后台任务直接扫库"的近路会省几十行，
 * 代价是定时任务看到的和界面上看到的可能不一样——
 * 而那种不一致没人会当成 bug 报，只会让人不再相信这份报告。
 *
 * 身份用 `system://internal`：默认策略里它有 `*.Read`，没有写权限。
 * 巡检本来就只该读——一个能改数据的巡检任务是个很坏的主意。
 */
export type HealthSweepDeps = {
  pool: pg.Pool
  registry: OntologyRegistry
  workflows: WorkflowRegistry
  policies: readonly Policy[]
  clock?: Clock
  maxResources?: number
  maxRelations?: number
}

export async function sweepOntologyHealth(
  deps: HealthSweepDeps,
  tenant: string,
): Promise<{ report: HealthReport; complete: boolean }> {
  const db = createDb(deps.pool)
  const audit = new BufferedAuditSink()
  const clock = deps.clock ?? systemClock

  try {
    return await withTenant(db, tenant, (trx) =>
      serviceIn(trx, tenant, {
        registry: deps.registry,
        workflows: deps.workflows,
        policies: deps.policies,
        audit,
        clock,
      }).ontologyHealth(systemCaller(tenant, null), {
        maxResources: deps.maxResources ?? 50_000,
        maxRelations: deps.maxRelations ?? 50_000,
      }),
    )
  } finally {
    // 审计单独落。巡检读了全租户的对象，这件事本身要留痕——
    // 一个能看见一切的后台身份，最起码得说得清它什么时候看的
    const entries = audit.drain()
    if (entries.length > 0) {
      await withTenant(db, tenant, (trx) => flushAudit(trx, entries))
    }
  }
}

/**
 * 报告的一行摘要。
 *
 * 刻意包含分母和 `complete`：日志里一句"本体巡检：0 个问题"
 * 会被当成"一切正常"，而它可能意味着"只扫了前一万个对象"。
 */
export function summarise(result: { report: HealthReport; complete: boolean }): string {
  const byKind = new Map<string, number>()
  for (const f of result.report.findings) byKind.set(f.kind, (byKind.get(f.kind) ?? 0) + 1)
  const parts = [...byKind].sort().map(([kind, n]) => `${kind}=${n}`)
  const detail = parts.length === 0 ? 'clean' : parts.join(' ')
  const scanned = `${result.report.scanned.resources} resources / ${result.report.scanned.relations} relations`
  return `${detail} (scanned ${scanned}${result.complete ? '' : ', INCOMPLETE'})`
}
