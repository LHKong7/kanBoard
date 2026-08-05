import { createDb, withTenant } from './db/client.ts'
import type { Db } from './db/client.ts'
import { WorkflowRegistry } from '../workflow/engine.ts'
import type { Lifecycle } from '../workflow/types.ts'
import type { Clock } from '../platform/clock.ts'
import { systemClock } from '../platform/clock.ts'
import type pg from 'pg'

/**
 * 状态机定义的存储与热加载（FR-WF-001）。
 *
 * 需求原文是「修改状态机定义后新实例即时生效」——"即时"排除了重启，
 * 所以定义必须是数据而不是代码常量。
 *
 * 缓存策略：进程内缓存 + 短 TTL。
 *
 * 为什么不是"写入时广播失效"：那需要一条进程间的消息通道，
 * 而这个系统目前刻意没有（ADR-0008 模块化单体）。TTL 的代价是
 * 一个明确的上界——最坏情况下别的进程晚 `ttlMs` 生效——
 * 而广播的代价是一条会悄悄坏掉的链路：消息丢了没人知道，
 * 表现是"我改了流程但线上没变"，排查起来极难。
 * **一个说得清的延迟，好过一个说不清的不一致。**
 */

export type LifecycleRecord = {
  lifecycle: Lifecycle
  revision: number
  updatedBy: string
  updatedAt: Date
}

export class PgLifecycleStore {
  readonly #db: Db
  readonly #tenant: string

  constructor(db: Db, tenant: string) {
    this.#db = db
    this.#tenant = tenant
  }

  async list(): Promise<LifecycleRecord[]> {
    const rows = await this.#db
      .selectFrom('lifecycles')
      .selectAll()
      .where('tenant', '=', this.#tenant)
      .orderBy('id')
      .execute()

    return rows.map((r) => ({
      lifecycle: r.definition as unknown as Lifecycle,
      revision: r.revision,
      updatedBy: r.updated_by,
      updatedAt: r.updated_at,
    }))
  }

  /**
   * 写入一台状态机。
   *
   * 校验在**写入时**做（`WorkflowRegistry.register` 内），不是读取时：
   * 一台非法的状态机存进去之后，损害会在下一次有人试图迁移时才出现，
   * 而那时故障点离原因已经很远了。
   */
  async put(lifecycle: Lifecycle, updatedBy: string, clock: Clock = systemClock): Promise<number> {
    // 借一个空注册表来跑校验：合法性规则只有一份，不在这里重写
    new WorkflowRegistry().register(lifecycle)

    const row = await this.#db
      .insertInto('lifecycles')
      .values({
        tenant: this.#tenant,
        id: lifecycle.id,
        entity_type: lifecycle.entityType,
        definition: JSON.stringify(lifecycle),
        updated_by: updatedBy,
        updated_at: clock.now(),
      })
      .onConflict((oc) =>
        oc.columns(['tenant', 'id']).doUpdateSet((eb) => ({
          entity_type: lifecycle.entityType,
          definition: JSON.stringify(lifecycle),
          revision: eb('lifecycles.revision', '+', 1),
          updated_by: updatedBy,
          updated_at: clock.now(),
        })),
      )
      .returning('revision')
      .executeTakeFirstOrThrow()

    return row.revision
  }
}

export type ReloadingRegistryDeps = {
  pool: pg.Pool
  tenant: string
  /** 代码里的内置状态机。库里没有同名定义时用它 */
  builtins: readonly Lifecycle[]
  /** 缓存有效期。到期后下一次取用会重新加载 */
  ttlMs?: number
  clock?: Clock
}

/**
 * 会自己过期重载的工作流注册表。
 *
 * 库里的定义**覆盖**同名的内置定义；库里没有的，内置的继续生效。
 * 这样"改流程"是一次增量操作，不需要先把全部内置定义导进库里——
 * 要求先做一次全量导入的设计，会让第一次修改的成本高到没人愿意做。
 */
export class ReloadingWorkflowRegistry {
  readonly #deps: ReloadingRegistryDeps
  #cached: WorkflowRegistry
  #loadedAt = 0

  constructor(deps: ReloadingRegistryDeps) {
    this.#deps = deps
    this.#cached = build(deps.builtins, [])
  }

  /** 立刻失效。同进程内写完就调它，让"即时生效"在本进程里是真的即时 */
  invalidate(): void {
    this.#loadedAt = 0
  }

  async current(): Promise<WorkflowRegistry> {
    const now = (this.#deps.clock ?? systemClock).now().getTime()
    const ttl = this.#deps.ttlMs ?? 5_000
    if (now - this.#loadedAt < ttl) return this.#cached

    const db = createDb(this.#deps.pool)
    const overrides = await withTenant(db, this.#deps.tenant, async (trx) =>
      new PgLifecycleStore(trx, this.#deps.tenant).list(),
    )

    try {
      this.#cached = build(this.#deps.builtins, overrides.map((r) => r.lifecycle))
    } catch (error) {
      // 库里存了一台跑不起来的状态机时，**保留上一份可用的定义**并大声报错。
      // 换成空注册表会让所有对象立刻失去生命周期——
      // 一次坏配置不该演变成全站不可迁移
      console.error('[workflow] failed to build registry from stored lifecycles, keeping previous:', error)
    }
    this.#loadedAt = now
    return this.#cached
  }
}

function build(builtins: readonly Lifecycle[], overrides: readonly Lifecycle[]): WorkflowRegistry {
  const registry = new WorkflowRegistry()
  const overridden = new Set(overrides.map((l) => l.id))
  const overriddenTypes = new Set(overrides.map((l) => l.entityType))

  for (const lifecycle of builtins) {
    // 同 id 或同 entityType 都算被覆盖：一个类型只能绑一台状态机
    if (overridden.has(lifecycle.id) || overriddenTypes.has(lifecycle.entityType)) continue
    registry.register(lifecycle)
  }
  for (const lifecycle of overrides) registry.register(lifecycle)
  return registry
}
