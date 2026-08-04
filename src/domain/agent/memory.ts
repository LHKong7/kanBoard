import { DomainError } from '../../platform/errors.ts'
import type { Caller, ResourceService } from '../resource/service.ts'
import type { Resource } from '../resource/resource.ts'

/**
 * Agent 的四级 Memory（FR-AGT-005，口径见 docs/prd/05-agent-runtime.md §3.3）。
 *
 * | 类型       | 作用域              | 生命周期        | 存储           |
 * | ---------- | ------------------- | --------------- | -------------- |
 * | Working    | 单次 Run            | Run 结束即释放  | 内存           |
 * | Episodic   | Agent × Project     | 可配置 TTL      | 关系库         |
 * | Semantic   | Project / Workspace | 长期            | **Knowledge BC** |
 * | Procedural | Agent               | 长期            | Agent / Skill 实体 |
 *
 * 四种放在一个门面后面，不是为了统一——它们的存储各不相同，
 * 也不该统一。放在一起是为了让**该往哪写**这个判断只做一次、写在一处。
 * 分散在调用点的话，"这条算 episodic 还是 semantic"会各人各判，
 * 而判错的方向永远是往私有存储里写（那更省事）。
 */

export type MemoryTier = 'working' | 'episodic' | 'semantic' | 'procedural'

export type MemoryEntry = {
  key: string
  value: unknown
  tier: MemoryTier
  /** 从哪儿来的。semantic 记忆会指向 Knowledge 对象的 id */
  sourceId?: string | undefined
}

export type EpisodicRecord = {
  id: string
  tenant: string
  agent: string
  project: string | null
  key: string
  value: unknown
  runRef: string | null
  createdAt: Date
  expiresAt: Date
}

/** Episodic 的存储端口。只有这一级需要专门的表 */
export interface EpisodicStore {
  /** 同一个 (agent, project, key) 覆盖写：记忆是被更新的，不是被累积的 */
  put(record: EpisodicRecord): Promise<void>
  /** 只返回**没过期**的。过期的当作不存在，不必等清理任务跑过 */
  recall(agent: string, project: string | null, now: Date, limit: number): Promise<EpisodicRecord[]>
  /** 删掉过期的。返回删了多少条 */
  purgeExpired(now: Date): Promise<number>
}

/** Episodic 的默认与上限（PRD §3.3：默认 30 天，可配置） */
export const EPISODIC_DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000
export const EPISODIC_MAX_TTL_MS = 90 * 24 * 60 * 60 * 1000

/**
 * 单次 Run 的 Working Memory。
 *
 * 就是一个对象，没有持久化——**这正是"Run 结束即释放"的实现**。
 * 做成一个类而不是散落的局部变量，是为了让"它不落库"这件事
 * 有一个能指的地方；否则下一个人很容易顺手给它加个存储，
 * 而那时它就不再是 working memory 了。
 */
export class WorkingMemory {
  readonly #entries = new Map<string, unknown>()
  /** 推理历史。模型据此判断是否收敛 */
  readonly steps: { thought: string; observation: string }[] = []

  put(key: string, value: unknown): void {
    this.#entries.set(key, value)
  }

  get(key: string): unknown {
    return this.#entries.get(key)
  }

  entries(): MemoryEntry[] {
    return [...this.#entries].map(([key, value]) => ({ key, value, tier: 'working' as const }))
  }

  get size(): number {
    return this.#entries.size
  }
}

export type MemoryDeps = {
  service: ResourceService
  episodic: EpisodicStore
  newId: () => string
  now: () => Date
}

/**
 * 写入语义记忆时**必须**给出来源，否则不允许写。
 *
 * Knowledge BC 的规矩是"无来源的知识不可信，不允许发布"（FR-DOM-008），
 * 而 Agent 产出的知识最需要这一条：一段没有出处的、由模型生成的
 * "项目知识"会被后来的人当成事实。
 */
export type SemanticInput = {
  title: string
  body: string
  /** 这条知识是从哪个对象得出的。会建成 derivedFrom 关系 */
  derivedFrom: string
  confidence?: number | undefined
}

export class AgentMemory {
  readonly #deps: MemoryDeps

  constructor(deps: MemoryDeps) {
    this.#deps = deps
  }

  /**
   * 记一条经历（Episodic）。
   *
   * TTL 有上界。没有上界的 TTL 等于长期存储，而长期的项目知识
   * 必须落 Knowledge BC（FR-AGT-006）——数据库那条 CHECK 会拦下超界的写入，
   * 这里先给一个说得清的错误，而不是让人去读约束名
   */
  async remember(
    agent: string,
    project: string | null,
    key: string,
    value: unknown,
    options: { ttlMs?: number; runRef?: string; tenant: string } = { tenant: '' },
  ): Promise<void> {
    const ttl = options.ttlMs ?? EPISODIC_DEFAULT_TTL_MS
    if (ttl <= 0 || ttl > EPISODIC_MAX_TTL_MS) {
      throw new DomainError(
        'validation_failed',
        `episodic memory ttl must be between 1ms and ${EPISODIC_MAX_TTL_MS}ms; long-lived project knowledge belongs in the Knowledge BC (FR-AGT-006)`,
        422,
        { field: 'ttlMs', maxMs: EPISODIC_MAX_TTL_MS },
      )
    }
    const now = this.#deps.now()
    await this.#deps.episodic.put({
      id: this.#deps.newId(),
      tenant: options.tenant,
      agent,
      project,
      key,
      value,
      runRef: options.runRef ?? null,
      createdAt: now,
      expiresAt: new Date(now.getTime() + ttl),
    })
  }

  /** 召回这个 Agent 在这个项目里还没过期的经历 */
  async recall(agent: string, project: string | null, limit = 20): Promise<MemoryEntry[]> {
    const records = await this.#deps.episodic.recall(agent, project, this.#deps.now(), limit)
    return records.map((r) => ({ key: r.key, value: r.value, tier: 'episodic' as const, sourceId: r.id }))
  }

  /**
   * 写一条语义记忆（FR-AGT-006）。
   *
   * 它**不进 agent_memories**，而是变成一个 Knowledge 对象。
   * 这不是实现选择，是这条需求本身：项目级的长期知识必须是
   * 所有人都看得见、能被引用、能被复核的共享资产，
   * 而不是某个 Agent 私藏的一段字符串。
   */
  async learn(caller: Caller, workspace: string, project: string | null, input: SemanticInput): Promise<Resource> {
    const knowledge = await this.#deps.service.create(caller, {
      type: 'Knowledge',
      workspace,
      project,
      attributes: {
        title: input.title,
        body: input.body,
        ...(input.confidence === undefined ? {} : { confidence: input.confidence }),
      },
      labels: ['agent-learned'],
    })
    // 来源关系立刻建上。分两步做的话，中间失败会留下一条无来源的知识，
    // 而它永远发布不了——一个卡在半路、没人看得懂为什么的对象
    await this.#deps.service.relate(caller, {
      type: 'derivedFrom',
      fromId: knowledge.id,
      toId: input.derivedFrom,
      origin: 'system',
    })
    return knowledge
  }

  /**
   * 读取程序性记忆（Procedural）：这个 Agent「会怎么做事」。
   *
   * 它就是 Agent 声明本身——system 提示、允许提议的类型、装配上下文的关系。
   * 不另存一份，因为另存的那份会和声明漂移，
   * 而漂移之后没人知道运行时到底按哪份在跑。
   */
  procedural(agentResource: Resource): MemoryEntry[] {
    const attrs = agentResource.attributes
    const out: MemoryEntry[] = []
    for (const key of ['system', 'contextRelations', 'mayPropose', 'capabilities']) {
      const value = attrs[key]
      if (value === undefined || value === null) continue
      out.push({ key, value, tier: 'procedural', sourceId: agentResource.id })
    }
    return out
  }
}
