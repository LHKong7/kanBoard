import { decide, digest, reconcile } from './sync.ts'
import type { ExternalRecord, LocalRecord, MigrationPhase, SyncLink, SyncDecision } from './sync.ts'
import type { Caller, ResourceService } from '../resource/service.ts'
import type { Resource } from '../resource/resource.ts'

/**
 * 迁移演练的执行器（FR-CON-007）。
 *
 * `sync.ts` 只回答"该怎么办"，这一层负责**真的去做**——而做的方式是
 * 走普通的 `ResourceService.create` / `update`：本体校验、权限、审计、
 * 事件一个不少。**迁移进来的对象和人建的对象没有区别。**
 *
 * 这个决定和 CI 回写、和自动化引擎的 invokeAgent 是同一个：
 * 另开一条"迁移专用的写路径"能省掉不少麻烦（跳过必填校验、跳过状态机），
 * 而代价是迁移进来的数据**从第一天起就不满足系统自己的不变量**，
 * 然后所有守卫在这批数据上都失效——它们只挡后来的人。
 *
 * 所以：**迁移不过去的数据，是这次迁移的问题，不是守卫的问题。**
 * 报告会把它逐条列出来。
 */

/** 源系统。演练不关心它是 Jira 还是别的什么 */
export interface SyncSource {
  /** 全量读。分页、重试、缺页检测由实现负责 */
  readAll(): Promise<readonly ExternalRecord[]>
  /** 回写。`parallel` 阶段才会被调用 */
  write?(externalId: string, fields: Record<string, unknown>): Promise<void>
}

/** 同步链接的存储。演练时可以是内存，生产时落库 */
export interface LinkStore {
  get(externalId: string): Promise<SyncLink | null>
  put(link: SyncLink): Promise<void>
  all(): Promise<readonly SyncLink[]>
}

export type RehearsalReport = {
  phase: MigrationPhase
  created: number
  updatedLocal: number
  updatedRemote: number
  /** 阶段传不动的改动。**不是 noop**，报告里必须看得见 */
  held: readonly { externalId: string; reason: string }[]
  /** 要人决定的。一条都不该被自动合并 */
  conflicts: readonly { externalId: string; fields: readonly string[] }[]
  /**
   * 写不进去的。**这是迁移最该看的一栏**——
   * 一条因为缺必填字段而没能落库的记录，就是一条丢掉的数据
   */
  rejected: readonly { externalId: string; reason: string }[]
  unchanged: number
  reconciliation: ReturnType<typeof reconcile>
}

export type RunOptions = {
  phase: MigrationPhase
  source: SyncSource
  links: LinkStore
  service: ResourceService
  caller: Caller
  /** 迁进来的对象类型，如 'Task' */
  resourceType: string
  workspace: string
  project?: string
}

/**
 * 跑一个阶段。
 *
 * 返回报告而不是抛异常：**一次演练的价值在于它的报告是完整的**。
 * 遇到第一条问题就中断的话，人只能一条一条修、一次一次重跑，
 * 而每次重跑都要几十分钟。
 */
export async function runPhase(options: RunOptions): Promise<RehearsalReport> {
  const { phase, source, links, service, caller } = options

  const remotes = await source.readAll()
  const held: { externalId: string; reason: string }[] = []
  const conflicts: { externalId: string; fields: readonly string[] }[] = []
  const rejected: { externalId: string; reason: string }[] = []
  let created = 0
  let updatedLocal = 0
  let updatedRemote = 0
  let unchanged = 0

  for (const remote of remotes) {
    const link = await links.get(remote.externalId)
    const local = link === null ? null : await loadLocal(service, caller, link)

    // link 在、对象没了（被删了）。当成新记录重建而不是崩掉：
    // 演练期间本地被清空重来是常事
    const decision: SyncDecision = decide(phase, remote, local, local === null ? null : link)

    try {
      switch (decision.kind) {
        case 'create-local': {
          const { status, attributes } = splitStatus(decision.fields)
          const resource = await service.create(caller, {
            type: options.resourceType,
            workspace: options.workspace,
            ...(options.project === undefined ? {} : { project: options.project }),
            // **建在某个状态上 ≠ 迁移到某个状态。**
            // 一条 Jira 里已经在做的任务，搬过来就该是 Doing——
            // 让它落在 Todo 再由人一条条推过去，那不是迁移，是重录一遍。
            //
            // 但迁移作业**没有** `*.Transition` 权限（策略里显式 Deny）：
            // 建的时候说清楚它在哪儿是陈述事实，建完之后还能推状态机
            // 就等于拿到了一把绕开所有守卫的钥匙——而迁移正是最想
            // 绕开守卫的那个场景（"这批老数据不满足新规则"）。
            ...(status === undefined ? {} : { status }),
            attributes,
            // 打上标记：迁移进来的东西要能被一眼认出来，
            // 出问题时才知道该重跑哪一批
            labels: ['migrated', `from:${remote.externalId}`],
          })
          await links.put({
            externalId: remote.externalId,
            localId: resource.id,
            remoteDigest: digest(decision.fields),
            // 本地摘要也要带上 status，否则下一轮同步会把
            // "远端有 status、本地没有"看成一次远端变更，每次都推一遍
            localDigest: digest({ ...resource.attributes, status: resource.status }),
            lastSyncedAt: remote.updatedAt,
          })
          created++
          break
        }
        case 'update-local': {
          const current = await service.get(caller, decision.localId)
          const { status, attributes } = splitStatus(decision.fields)
          if (status !== undefined && status !== current.status) {
            // 状态在源那边变了，但迁移作业推不动状态机（策略里显式 Deny）。
            // **这不是失败，是一件要人看见的事**——所以记 held 而不是
            // 悄悄跳过，也不是伪装成写成功
            held.push({
              externalId: remote.externalId,
              reason: `source moved to "${status}" but migration may not transition (currently "${current.status}")`,
            })
          }
          const updated = await service.update(caller, decision.localId, {
            expectedVersion: current.version,
            // attributes 是整体替换而非合并，所以读-改-写。
            // 只发变化的那几个字段会**静默抹掉**非必填属性
            attributes: { ...current.attributes, ...attributes },
          })
          await links.put({
            externalId: remote.externalId,
            localId: decision.localId,
            remoteDigest: digest(decision.fields),
            localDigest: digest({ ...updated.attributes, status: updated.status }),
            lastSyncedAt: remote.updatedAt,
          })
          updatedLocal++
          break
        }
        case 'update-remote': {
          if (source.write === undefined) {
            held.push({ externalId: remote.externalId, reason: 'source is not writable' })
            break
          }
          await source.write(remote.externalId, decision.fields)
          await links.put({
            externalId: remote.externalId,
            localId: decision.localId,
            remoteDigest: digest(decision.fields),
            localDigest: digest(decision.fields),
            lastSyncedAt: remote.updatedAt,
          })
          updatedRemote++
          break
        }
        case 'conflict':
          conflicts.push({ externalId: decision.externalId, fields: decision.fields })
          break
        case 'held':
          held.push({ externalId: decision.externalId, reason: decision.reason })
          break
        case 'noop':
          unchanged++
          break
      }
    } catch (error) {
      // 写不进去最常见的原因是**本地的不变量它满足不了**（缺必填字段、
      // 状态机不认这个状态）。这不该让整场演练停下，但必须逐条记下来：
      // 迁移报告里这一栏才是要读的那一栏
      rejected.push({ externalId: remote.externalId, reason: reason(error) })
    }
  }

  return {
    phase,
    created,
    updatedLocal,
    updatedRemote,
    held,
    conflicts,
    rejected,
    unchanged,
    reconciliation: reconcile(remotes, await loadAllLocal(service, caller, await links.all())),
  }
}

async function loadLocal(
  service: ResourceService,
  caller: Caller,
  link: SyncLink,
): Promise<LocalRecord | null> {
  const resource = await tryGet(service, caller, link.localId)
  if (resource === null) return null
  return {
    localId: resource.id,
    externalId: link.externalId,
    // status 参与比对：它在源那边是一个普通字段，在这边是资源状态，
    // 但**对账关心的是这条记录的内容有没有对上**，而状态是内容的一部分。
    // 漏掉它的话，一次没搬过来的状态在对账里完全看不见
    fields: { ...resource.attributes, status: resource.status },
    updatedAt: resource.updatedAt,
  }
}

async function loadAllLocal(
  service: ResourceService,
  caller: Caller,
  links: readonly SyncLink[],
): Promise<LocalRecord[]> {
  const out: LocalRecord[] = []
  for (const link of links) {
    const record = await loadLocal(service, caller, link)
    // 读不到就**不放进对账的本地一侧**，于是它会被报成 missing。
    // 那是对的：一条有 link 却读不到的记录，就是丢了
    if (record !== null) out.push(record)
  }
  return out
}

async function tryGet(
  service: ResourceService,
  caller: Caller,
  id: string,
): Promise<Resource | null> {
  try {
    return await service.get(caller, id)
  } catch {
    return null
  }
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 内存版链接存储。演练与测试用 */
export class InMemoryLinkStore implements LinkStore {
  readonly #links = new Map<string, SyncLink>()
  async get(externalId: string): Promise<SyncLink | null> {
    return this.#links.get(externalId) ?? null
  }
  async put(link: SyncLink): Promise<void> {
    this.#links.set(link.externalId, link)
  }
  async all(): Promise<readonly SyncLink[]> {
    return [...this.#links.values()]
  }
}

/**
 * 把 `status` 从属性里拆出来。
 *
 * 源系统那边状态就是一个字段，这边它是**资源状态**，由生命周期管着。
 * 不拆的话本体校验会直接拒——Task 上没有名为 status 的属性——
 * 而报出来的错是"未知属性"，看不出这是两个系统的模型差异。
 */
function splitStatus(fields: Record<string, unknown>): {
  status: string | undefined
  attributes: Record<string, unknown>
} {
  const { status, ...attributes } = fields
  return { status: typeof status === 'string' ? status : undefined, attributes }
}
