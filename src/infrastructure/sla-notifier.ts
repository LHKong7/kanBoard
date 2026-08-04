import { serviceIn } from './service-factory.ts'
import { withTenant } from './db/client.ts'
import { createDb } from './db/client.ts'
import { PgResourceRepository } from './resource-repository.pg.ts'
import { PgRelationRepository } from './relation-repository.pg.ts'
import { PgOutbox, BufferedAuditSink, flushAudit } from './outbox.pg.ts'
import { ResourceService } from '../domain/resource/service.ts'
import { systemCaller } from '../domain/automation/runner.ts'
import type { SlaBreach } from './sla-sweeper.pg.ts'
import type { OntologyRegistry } from '../ontology/registry.ts'
import type { WorkflowRegistry } from '../workflow/engine.ts'
import type { Policy } from '../identity/types.ts'
import type { Clock } from '../platform/clock.ts'
import { systemClock } from '../platform/clock.ts'
import type pg from 'pg'

/**
 * 把一次 SLA 超时变成一条站内通知。
 *
 * 走的是**和自动化 notify 动作完全同一条路径**：同一个 ResourceService、
 * 同一个 system://internal 身份、同一套权限与审计。
 * 另写一条"系统直接插一行 notifications"的近路会省几十行，
 * 代价是这条路径上的租户隔离、权限、留痕都要重新实现一遍——
 * 而重新实现的那一份迟早会漏。
 */

export type SlaNotifierDeps = {
  pool: pg.Pool
  registry: OntologyRegistry
  workflows: WorkflowRegistry
  policies: readonly Policy[]
  clock?: Clock
}

/** `escalate` 通知给谁。缺省升级到 owner 之外的这个主体 */
export const ESCALATION_PRINCIPAL = 'user://oncall'

export function slaNotifier(
  deps: SlaNotifierDeps,
): (tenant: string, breach: SlaBreach) => Promise<string | null> {
  const clock = deps.clock ?? systemClock
  const db = createDb(deps.pool)

  return async (tenant, breach) => {
    // escalate 送给值班而不是 owner：会超时正是因为 owner 没动它，
    // 再通知同一个人一遍，是把"升级"做成了"重复提醒"
    const recipient = breach.action === 'escalate' ? ESCALATION_PRINCIPAL : breach.owner
    const audit = new BufferedAuditSink()

    const id = await withTenant(db, tenant, async (trx) => {
      const service = serviceIn(trx, tenant, {
        registry: deps.registry,
        workflows: deps.workflows,
        policies: deps.policies,
        audit,
        clock,
      })

      const caller = systemCaller(tenant, null)
      const created = await service.create(caller, {
        type: 'Notification',
        workspace: await workspaceOf(service, caller, breach.resourceId),
        attributes: {
          title: `${breach.type} 在 ${breach.status} 停留超时`,
          // 说清楚超了多久。只说"超时了"会让人还得自己去翻历史
          body: `已停留 ${humanize(clock.now().getTime() - breach.since.getTime())}，超出约定 ${humanize(breach.overdueMs)}。`,
          recipient,
          about: breach.resourceId,
          severity: breach.action === 'escalate' ? 'critical' : 'warning',
        },
      })
      return created.id
    })

    // 审计单独一个事务落库：通知已经建好了，审计写失败不该把它回滚掉，
    // 但也不能吞掉——写不进去要说出来
    const entries = audit.drain()
    if (entries.length > 0) {
      try {
        await withTenant(db, tenant, (trx) => flushAudit(trx, entries))
      } catch (error) {
        console.error('[sla] failed to flush audit for breach notification:', error)
      }
    }
    return id
  }
}

async function workspaceOf(
  service: ResourceService,
  caller: ReturnType<typeof systemCaller>,
  resourceId: string,
): Promise<string> {
  const resource = await service.get(caller, resourceId)
  return resource.workspace
}

/** 「3 天」比「259200000 毫秒」有用得多 */
function humanize(ms: number): string {
  const days = Math.floor(ms / 86_400_000)
  if (days >= 1) return `${days} 天`
  const hours = Math.floor(ms / 3_600_000)
  if (hours >= 1) return `${hours} 小时`
  return `${Math.max(1, Math.floor(ms / 60_000))} 分钟`
}
