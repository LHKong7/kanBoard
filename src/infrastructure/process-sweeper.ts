import { createDb, withTenant } from './db/client.ts'
import { serviceIn } from './service-factory.ts'
import { BufferedAuditSink, flushAudit } from './outbox.pg.ts'
import { PgProcessRunStore } from './process-run-store.pg.ts'
import { processRunner } from './process-runner.ts'
import { drive } from '../domain/orchestration/executor.ts'
import { systemCaller } from '../domain/automation/runner.ts'
import { systemClock } from '../platform/clock.ts'
import type { ProcessRun } from '../domain/orchestration/executor.ts'
import type { Process } from '../workflow/orchestration.ts'
import type { ConnectorInvoker } from '../domain/agent/runtime.ts'
import type { OntologyRegistry } from '../ontology/registry.ts'
import type { WorkflowRegistry } from '../workflow/engine.ts'
import type { Policy } from '../identity/types.ts'
import type { Clock } from '../platform/clock.ts'
import type pg from 'pg'

/**
 * 等人等过头了的流程实例（FR-WF-010 的"超时"那一档）。
 *
 * **不设上界的话，一个等人的实例会永远挂着**，而它攥着一个已冻结的
 * Release——没有任何报错，只是那个发布再也不动了。定义里的
 * `timeoutMs` + `onTimeout` 因此必须有人来兑现，而"有人"就是这个巡检。
 *
 * 它不自己判断超时：把实例交给 `drive`，`advance` 看到期限已过就会
 * 按 `onTimeout` 决定是失败（走补偿）还是放行。判定只有一处实现。
 */
export type ProcessSweepDeps = {
  pool: pg.Pool
  registry: OntologyRegistry
  workflows: WorkflowRegistry
  policies: readonly Policy[]
  processes: readonly Process[]
  connectors?: ConnectorInvoker | undefined
  clock?: Clock
}

export async function sweepOverdueRuns(
  deps: ProcessSweepDeps,
  tenant: string,
): Promise<ProcessRun[]> {
  const db = createDb(deps.pool)
  const clock = deps.clock ?? systemClock
  const audit = new BufferedAuditSink()
  const caller = systemCaller(tenant, null)

  try {
    return await withTenant(db, tenant, async (trx) => {
      const store = new PgProcessRunStore(trx, tenant)
      const overdue = await store.overdue(clock.now())
      const driven: ProcessRun[] = []

      for (const run of overdue) {
        const process = deps.processes.find((p) => p.id === run.processId)
        // 定义没了的实例**不要静默跳过**：它会每一轮巡检都被捞出来又放回去，
        // 而没有任何地方说得出"这个实例为什么不动了"
        if (process === undefined) {
          console.error(`[process] run ${run.id} references unknown process "${run.processId}"`)
          continue
        }
        driven.push(
          await drive({ ...process }, { ...run, status: 'running' }, {
            runner: processRunner({
              service: serviceIn(trx, tenant, {
                registry: deps.registry,
                workflows: deps.workflows,
                policies: deps.policies,
                audit,
                clock,
              }),
              caller,
              connectors: deps.connectors,
              runId: run.id,
            }),
            store,
            now: () => clock.now(),
          }),
        )
      }
      return driven
    })
  } finally {
    const entries = audit.drain()
    if (entries.length > 0) {
      await withTenant(db, tenant, (trx) => flushAudit(trx, entries))
    }
  }
}
