import { ResourceService } from '../domain/resource/service.ts'
import { PgResourceRepository } from './resource-repository.pg.ts'
import { PgRelationRepository } from './relation-repository.pg.ts'
import { PgOutbox } from './outbox.pg.ts'
import type { Db } from './db/client.ts'
import type { Clock } from '../platform/clock.ts'
import type { OntologyRegistry } from '../ontology/registry.ts'
import type { WorkflowRegistry } from '../workflow/engine.ts'
import type { Policy } from '../identity/types.ts'
import type { AuditSink, PendingApprovalSink } from '../domain/resource/ports.ts'

/**
 * 在一个事务里组装 `ResourceService`。
 *
 * 这段接线原本在**四个地方**各写了一遍（HTTP、outbox poller、SLA 巡检、
 * Agent runner）。四份长得几乎一样的接线有一个具体的坏处，
 * 不是"不好看"：**加一个依赖时会漏掉其中一份**，
 * 而漏掉的那份表现为"某些路径上这个东西不生效"——
 * 比如挂起单的 sink 只接在 HTTP 那份上，于是自动化触发的挂起就没人收。
 *
 * 现在只有一处。想知道"一个 ResourceService 由什么组成"，看这里。
 */
export type ServiceParts = {
  registry: OntologyRegistry
  workflows: WorkflowRegistry
  policies: readonly Policy[]
  clock: Clock
  audit: AuditSink
  /**
   * 挂起单（FR-IAM-009）。不给就是这条路径上产生不了挂起单——
   * 这对纯读或纯巡检的路径是对的，但必须是**显式**的选择。
   */
  approvals?: PendingApprovalSink
}

export function serviceIn(trx: Db, tenant: string, parts: ServiceParts): ResourceService {
  return new ResourceService({
    registry: parts.registry,
    workflows: parts.workflows,
    resources: new PgResourceRepository(trx, tenant),
    relations: new PgRelationRepository(trx, tenant),
    events: new PgOutbox(trx),
    audit: parts.audit,
    ...(parts.approvals === undefined ? {} : { approvals: parts.approvals }),
    policies: parts.policies,
    clock: parts.clock,
  })
}
