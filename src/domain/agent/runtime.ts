import { DomainError } from '../../platform/errors.ts'
import type { Clock } from '../../platform/clock.ts'
import type { Caller, ResourceService } from '../resource/service.ts'
import type { Resource } from '../resource/resource.ts'
import { WorkingMemory } from './memory.ts'
import { DEFAULT_AI_POLICY, prepareEgress } from './egress.ts'
import type { AiPolicy, DataClassification, EgressRecord } from './egress.ts'
import type { AgentMemory, MemoryEntry } from './memory.ts'
import { assembleContext } from './context.ts'
import { requireEvidence } from '../ai/capabilities.ts'
import type { Verdict } from '../ai/capabilities.ts'
import { agentSpecFrom, DEFAULT_RUN_BUDGET } from './types.ts'
import type { CallInput, CallResult } from '../connector/types.ts'
import type {
  AgentSpec,
  CollaborationMode,
  ModelClient,
  ProposedResource,
  RunBudget,
  RunResult,
  RunStep,
  RunStepRepository,
  ModelResponse,
} from './types.ts'

/**
 * 运行时只认这个窄接口，不认 `ConnectorGateway` 本身。
 *
 * 好处是测试里可以塞一个假的，而生产里塞真网关——
 * 更重要的是它明确了：运行时**只能**发起调用，
 * 拿不到 connector 列表，也碰不到凭据。
 */
export interface ConnectorInvoker {
  /** `signal` 一路传到真正等待的地方，否则一次挂住的外部请求会拖住取消（FR-ARCH-011） */
  invoke(caller: Caller, input: CallInput, signal?: AbortSignal): Promise<CallResult>
}

/**
 * Agent Runtime（FR-AGT-002）。
 *
 * **一个执行入口，没有 per-Agent 分支。** 每个 Agent 的差异都由它的声明表达：
 * 系统提示、模型档位、协作模式、预算、沿哪些关系装配上下文、允许提议哪些类型。
 * 运行时读这些声明，不认识具体是哪个 Agent。
 *
 * 三条贯穿的规则：
 *
 * 1. **Agent 不享有特权。** 它通过 `ResourceService` 读写，和人走同一条路径、
 *    同一套 PDP。这里没有任何绕过授权的捷径——所以"Agent 越权"这件事
 *    在结构上就做不到，而不是靠代码评审保证。
 * 2. **每一步都留痕。** 上下文装配、推理、产出、护栏拦截各是一条 step，
 *    Run 结束后整条轨迹可回放（FR-AGT-007）。
 * 3. **预算是硬上界。** 超了就终止，并且把"为什么终止"写进结果
 *    （FR-AGT-012）。没有上界的推理循环可以无限花钱。
 */

export type RuntimeDeps = {
  service: ResourceService
  model: ModelClient
  steps: RunStepRepository
  clock: Clock
  /**
   * 外部系统的唯一通道（FR-CON-002）。
   *
   * 不给就是这个 Agent 不能调用任何外部工具——**不是"不受限制"**。
   * 缺省值必须是最小权限那一侧。
   */
  connectors?: ConnectorInvoker
  /** Context 装配的深度与段数上限 */
  contextDepth?: number
  contextLimit?: number
  /**
   * 取消信号（FR-ARCH-011）。
   *
   * 在步与步之间、以及每次写回之前检查。**不在模型调用中途打断**——
   * 那一次调用的钱已经花了，硬断只会让它的用量丢失，
   * 而"取消掉的 Run 花了多少"正是最该问清楚的。
   */
  signal?: AbortSignal
  /**
   * 四级 Memory（FR-AGT-005）。不给就是这次 Run 没有跨 Run 的记忆——
   * **不是"记忆无限"**。缺省值必须是最小的那一侧。
   */
  memory?: AgentMemory
  /**
   * 租户级 AI 策略（FR-AI-012/014，决策见 ADR-0006）。
   *
   * 不给就用 `DEFAULT_AI_POLICY`——它是**关闭**的。
   * 缺省放行的话，一个忘了配置的租户会默默把上下文发出去，
   * 而这正是最不该靠"记得配置"来保证的事。
   */
  aiPolicy?: AiPolicy
  /** 这次要送去哪个供应商。要在白名单里 */
  provider?: string
  /** 本次上下文的最高数据分级。缺省按 internal 处理 */
  classification?: DataClassification
  /** 出境留痕（FR-AI-014） */
  onEgress?: (record: EgressRecord) => void
  /**
   * 单次 Run 允许影响的对象数上限（FR-IAM-012 blastRadius）。
   *
   * 来自**租户级策略**（PRD 07 §7 的 agentPolicy），不是 Run 上的属性：
   * 一道能被本次执行自己调大的闸不是闸。缺省用 DEFAULT_RUN_BUDGET。
   */
  blastRadius?: number
}

/**
 * 哪些模式允许 Agent 直接把产出落库。
 *
 * `Suggest` 只给建议，一个字都不写；其余三种写成 Draft 让人复核。
 * 注意即使是 `Autonomous` 也**只写非终态对象**——
 * PRD §4 的规则是"任何不可逆操作永远需要人工确认"，
 * 而把一个对象直接创建成终态，就等于替人做了不可逆的决定。
 */
/**
 * 哪些模式**直接创建目标对象**。
 *
 * Draft 从 true 改成了 false（FR-AI-001）。它仍然会落库，
 * 但落的是 `Proposal` 而不是目标对象——于是一棵生成出来的树
 * 可以被逐节点接受或拒绝。直接创建的话，"审阅"就只剩下
 * 对着一整棵树全要或全不要，而那实际上等于全都不要。
 */
const MAY_WRITE: Record<CollaborationMode, boolean> = {
  Suggest: false,
  Draft: false,
  ExecuteWithReview: true,
  Autonomous: true,
}

/** 哪些模式把产出记成可逐条决定的提议（FR-AI-001） */
const PROPOSES: Record<CollaborationMode, boolean> = {
  Suggest: false,
  Draft: true,
  ExecuteWithReview: false,
  Autonomous: false,
}

/** 哪些模式在产出后必须停下来等人（FR-AGT-009） */
const NEEDS_REVIEW: Record<CollaborationMode, boolean> = {
  Suggest: true,
  Draft: true,
  ExecuteWithReview: true,
  Autonomous: false,
}

export class AgentRuntime {
  readonly #deps: RuntimeDeps

  constructor(deps: RuntimeDeps) {
    this.#deps = deps
  }

  /**
   * 执行一次 Run。
   *
   * `caller` 必须已经是 Agent 的身份（`agent://…`）而不是发起人的身份：
   * Run 里的每一次读写都要记在 Agent 头上，否则审计里看到的是
   * "alice 创建了 40 个 Story"，而实际上是某个 Agent 干的（FR-AGT-003）。
   */
  async execute(caller: Caller, run: Resource): Promise<RunResult> {
    const agentId = String(run.attributes['agent'] ?? '')
    const agentResource = await this.#deps.service.get(caller, agentId)
    const mode = (run.attributes['mode'] as CollaborationMode) ?? 'Suggest'
    const spec = agentSpecFrom(agentResource, {
      mode,
      budget: budgetFor(run, this.#deps.blastRadius),
    })

    let seq = 0
    let tokensUsed = 0
    let costUsd = 0
    const proposals: ProposedResource[] = []
    /** 这次 Run 改动过的对象 id。blastRadius 数的是它的大小（FR-IAM-012） */
    const touched = new Set<string>()
    // Working Memory：单次 Run 的短期记忆，**Run 结束即释放**（FR-AGT-005）。
    // 它是个局部变量，没有任何持久化——那正是"释放"的实现方式
    const working = new WorkingMemory()
    const history = working.steps

    const record = async (
      kind: RunStep['kind'],
      summary: string,
      detail: Record<string, unknown>,
      cost = { tokensUsed: 0, costUsd: 0 },
    ): Promise<void> => {
      await this.#deps.steps.append({
        runId: run.id,
        seq: seq++,
        kind,
        summary,
        detail,
        tokensUsed: cost.tokensUsed,
        costUsd: cost.costUsd,
        occurredAt: this.#deps.clock.now(),
      })
    }

    // ── Context 装配 ────────────────────────────────────
    const subjectId = run.attributes['subject']
    let context: Awaited<ReturnType<typeof assembleContext>> = { segments: [], truncated: false }
    if (typeof subjectId === 'string' && subjectId !== '') {
      context = await assembleContext(this.#deps.service, caller, {
        subjectId,
        relations: spec.contextRelations,
        maxDepth: this.#deps.contextDepth ?? 3,
        limit: this.#deps.contextLimit ?? 40,
      })
    }
    // ── Memory 装配（FR-AGT-005） ────────────────────────
    //
    // Episodic：这个 Agent 在**这个项目**里没过期的经历。
    // Procedural：它的声明本身（system 提示、可提议类型…）。
    // Semantic 不在这里读——它是 Knowledge 对象，本来就走上面的图装配，
    // 和别的知识一样带出处。**这正是 FR-AGT-006 想要的效果**：
    // Agent 学到的东西和人写的知识在同一条路径上，没有私有捷径
    const recalled: MemoryEntry[] = []
    if (this.#deps.memory !== undefined) {
      recalled.push(
        ...(await this.#deps.memory.recall(spec.principal, run.project)),
        ...this.#deps.memory.procedural(agentResource),
      )
      for (const entry of recalled) working.put(`${entry.tier}:${entry.key}`, entry.value)
    }

    await record('context', `装配了 ${context.segments.length} 段上下文`, {
      // 出处清单进轨迹：FR-AGT-004 的验收标准就是这个列表可查
      sources: context.segments.map((s) => ({ id: s.sourceId, type: s.sourceType, via: s.via })),
      truncated: context.truncated,
      memory: recalled.map((m) => ({ tier: m.tier, key: m.key, sourceId: m.sourceId })),
    })

    /**
     * 这次 Run 是不是该停了。
     *
     * 两个来源：
     *   ① 进程内的 AbortSignal——关停时打断在途的 Run。
     *   ② **库里这条 Run 的状态**——有人把它迁到了 Cancelled。
     *
     * 第二条是跨进程取消的实现方式。它多花一次主键读，
     * 而这一步本来就要发一次模型调用，代价可以忽略。
     * 换成进程间广播的话，消息丢了没人知道，表现是"点了取消但它还在跑"
     * ——和 ADR-0008 里拒绝广播失效的理由是同一个。
     */
    const cancelled = async (): Promise<boolean> => {
      if (this.#deps.signal?.aborted === true) return true
      const current = await this.#deps.service.get(caller, run.id)
      return current.status === 'Cancelled'
    }

    // ── 出境控制与注入防护（FR-AI-012/013/014，ADR-0006） ──
    //
    // 放在循环之前做一次：上下文在整个 Run 里不变，
    // 每一步都重做只是白费。工具调用回来的观察另有网关脱敏
    const policy = this.#deps.aiPolicy ?? DEFAULT_AI_POLICY
    const provider = this.#deps.provider ?? 'unconfigured'
    const egress = prepareEgress({
      segments: context.segments,
      policy,
      provider,
      classification: this.#deps.classification ?? 'internal',
    })
    context = { segments: egress.segments, truncated: context.truncated }
    this.#deps.onEgress?.({
      tenant: run.tenant,
      runId: run.id,
      provider,
      classification: egress.highestClassification,
      sourceIds: egress.segments.map((s) => s.sourceId),
      segments: egress.segments.length,
      neutralised: egress.neutralised,
      occurredAt: this.#deps.clock.now(),
    })
    if (egress.neutralised > 0) {
      // 有人往需求描述里塞了冒充系统的话。中和掉了，但必须留痕——
      // 持续出现意味着有人在试
      await record('guardrail', `中和了 ${egress.neutralised} 处提示注入尝试`, {
        requirement: 'FR-AI-013',
        neutralised: egress.neutralised,
      })
    }

    // ── 推理循环 ────────────────────────────────────────
    for (let step = 0; step < spec.budget.maxSteps; step++) {
      if (await cancelled()) {
        await record('guardrail', '收到取消信号，停止', { afterSteps: step })
        return {
          outcome: { kind: 'cancelled', afterSteps: step },
          steps: seq,
          tokensUsed,
          costUsd,
          proposals,
        }
      }
      const response = await this.#deps.model.complete({
        tier: spec.tier,
        system: spec.system,
        goal: String(run.attributes['goal'] ?? ''),
        context: context.segments,
        history,
      })
      tokensUsed += response.tokensUsed
      costUsd += response.costUsd

      await record('reasoning', response.thought, { action: response.action.kind }, response)

      // 预算检查放在**记账之后**：把 Agent 已经花掉的钱记下来再终止，
      // 否则最后一次调用的成本会凭空消失
      const exceeded = overBudget(spec.budget, { tokensUsed, costUsd, steps: step + 1 })
      if (exceeded !== null) {
        await record('guardrail', `预算触顶：${exceeded.limit}`, exceeded)
        return { outcome: { kind: 'budget-exceeded', ...exceeded }, steps: seq, tokensUsed, costUsd, proposals }
      }

      // ── 调用外部工具 ──────────────────────────────────
      if (response.action.kind === 'call') {
        const observation = await this.#callTool(caller, response.action, record)
        history.push({ thought: response.thought, observation })
        continue
      }

      if (response.action.kind === 'finish') {
        const summary = response.action.summary
        await record('artifact', '完成', { summary })
        // 把这次的结论记成一条经历（FR-AGT-005）。
        // 记的是**结论**不是全过程：把整段推理存下来，下一次召回
        // 会把上下文塞满旧的思考过程，而那些既占地方又容易误导
        await this.#remember(spec, run, summary, proposals.length)
        return {
          outcome:
            NEEDS_REVIEW[spec.mode] && proposals.length > 0
              ? { kind: 'awaiting-review', summary, proposals: proposals.length }
              : { kind: 'completed', summary },
          steps: seq,
          tokensUsed,
          costUsd,
          proposals,
        }
      }

      // ── 提议写回 ──────────────────────────────────────
      const proposal = response.action
      if (!spec.mayPropose.includes(proposal.resourceType)) {
        // 声明里没允许就是不允许。用护栏挡住而不是让模型的输出决定能写什么
        await record('guardrail', `拒绝提议 ${proposal.resourceType}：不在该 Agent 的允许清单内`, {
          allowed: spec.mayPropose,
        })
        history.push({
          thought: response.thought,
          observation: `不允许创建 ${proposal.resourceType}；允许的类型：${spec.mayPropose.join(', ') || '（无）'}`,
        })
        continue
      }

      // blastRadius 在**动手之前**判（FR-IAM-012）。
      //
      // 和预算相反：预算记的是已经花掉的，所以事后判；
      // 影响面记的是损害，第 101 个对象改下去之后再终止，
      // 只是把事情记录下来，而不是拦住它。
      if (MAY_WRITE[spec.mode] && touched.size >= spec.budget.maxObjectsPerRun) {
        await record('guardrail', `影响面触顶：已改动 ${touched.size} 个对象`, {
          limit: spec.budget.maxObjectsPerRun,
          touched: touched.size,
        })
        return {
          outcome: {
            kind: 'blast-radius-exceeded',
            limit: spec.budget.maxObjectsPerRun,
            touched: touched.size,
          },
          steps: seq,
          tokensUsed,
          costUsd,
          proposals,
        }
      }

      // 取消之后**不再写回**。模型这一步已经算完了，钱花了，
      // 但把结果落库就是在做一件已经被叫停的事
      if (await cancelled()) {
        await record('guardrail', '收到取消信号，放弃本次写回', { afterSteps: step + 1 })
        return {
          outcome: { kind: 'cancelled', afterSteps: step + 1 },
          steps: seq,
          tokensUsed,
          costUsd,
          proposals,
        }
      }

      // 产出闸（FR-AI-006）。风险条目必须指得出触发它的实体。
      //
      // 放在这里而不是放过去让本体校验拦：本体只知道"有没有这个字段"，
      // 拦下来的错误信息是"缺少必填属性"。而模型需要读懂的是
      // **为什么**——一条没有证据的风险读起来像洞察，跟进时无从下手，
      // 没人能判断它是不是编的。所以把话说清楚，让它下一步能改对。
      const gate = evidenceGate(proposal)
      if (!gate.ok) {
        await record('guardrail', `产出被拒：${gate.reason}`, {
          type: proposal.resourceType,
          offenders: gate.offenders,
        })
        history.push({ thought: response.thought, observation: `产出被拒：${gate.reason}` })
        continue
      }

      let createdId: string | null = null
      if (MAY_WRITE[spec.mode]) {
        try {
          const created = await this.#deps.service.create(caller, {
            type: proposal.resourceType,
            workspace: run.workspace,
            project: run.project,
            attributes: proposal.attributes,
            labels: ['agent-generated'],
          })
          createdId = created.id
          // 用集合而不是计数器：同一个对象改多次，影响面还是 1。
          //
          // **老实说：当前运行时只会创建、不会更新，所以这里换成计数器
          // 全部用例照样绿**（试过）。留着集合是因为更新路径一旦出现，
          // 计数器会把一个反复修订同一份文档的 Agent 误杀，
          // 而真正该被拦下的是批量改一百个对象的那种
          touched.add(created.id)
          await record('artifact', `创建了 ${proposal.resourceType} ${created.id}`, {
            rationale: proposal.rationale,
          })
        } catch (error) {
          // 写回失败不该让整个 Run 崩掉：把失败作为一次观察交回给模型，
          // 它可能换个写法。但失败必须留痕
          const message = error instanceof DomainError ? error.message : String(error)
          await record('guardrail', `写回被拒：${message}`, { type: proposal.resourceType })
          history.push({ thought: response.thought, observation: `创建失败：${message}` })
          continue
        }
      } else if (PROPOSES[spec.mode]) {
        // Draft：落一条**提议**，不落目标对象（FR-AI-001）。
        // 每个节点各一条，人可以留下十七个、扔掉三个
        try {
          const proposalRecord = await this.#deps.service.create(caller, {
            type: 'Proposal',
            workspace: run.workspace,
            project: run.project,
            attributes: {
              resourceType: proposal.resourceType,
              draft: proposal.attributes,
              rationale: proposal.rationale,
              runRef: run.id,
            },
            labels: ['agent-generated'],
          })
          createdId = proposalRecord.id
          touched.add(proposalRecord.id)
          await record('artifact', `提议创建 ${proposal.resourceType}（待逐条决定）`, {
            proposalId: proposalRecord.id,
            rationale: proposal.rationale,
          })
        } catch (error) {
          const message = error instanceof DomainError ? error.message : String(error)
          await record('guardrail', `提议落库被拒：${message}`, { type: proposal.resourceType })
          history.push({ thought: response.thought, observation: `提议失败：${message}` })
          continue
        }
      } else {
        await record('artifact', `建议创建 ${proposal.resourceType}（Suggest 模式，未落库）`, {
          rationale: proposal.rationale,
        })
      }

      proposals.push({ ...proposal, createdId })
      history.push({
        thought: response.thought,
        observation: createdId === null ? '已记录为建议' : `已创建 ${createdId}`,
      })
    }

    // 步数用完还没收敛，同样是预算触顶
    await record('guardrail', '步数用尽仍未收敛', { maxSteps: spec.budget.maxSteps })
    return {
      outcome: { kind: 'budget-exceeded', limit: 'maxSteps', used: spec.budget.maxSteps },
      steps: seq,
      tokensUsed,
      costUsd,
      proposals,
    }
  }

  /**
   * 经网关调用一个外部工具。
   *
   * 失败**不终止 Run**：把失败原文作为一次观察交回模型，它可能换个参数再试。
   * 但失败必须留痕——一次静默失败的工具调用，会让模型基于"什么都没发生"
   * 继续推理，而使用者看到的产出像是凭空来的。
   */
  /**
   * 写一条 Episodic 记忆。失败不影响 Run 的结论。
   *
   * 记忆写不进去是遗憾，不是错误——但必须**说出来**。
   * 安静吞掉的话，表现是"这个 Agent 好像什么都记不住"，
   * 而没有任何地方能查出为什么。
   */
  async #remember(
    spec: AgentSpec,
    run: Resource,
    summary: string,
    produced: number,
  ): Promise<void> {
    if (this.#deps.memory === undefined) return
    try {
      await this.#deps.memory.remember(
        spec.principal,
        run.project,
        `run:${String(run.attributes['goal'] ?? '').slice(0, 64)}`,
        { summary, produced, at: this.#deps.clock.now().toISOString() },
        { tenant: run.tenant, runRef: run.id },
      )
    } catch (error) {
      console.error(`[agent] failed to record episodic memory for run ${run.id}:`, error)
    }
  }

  async #callTool(
    caller: Caller,
    action: Extract<ModelResponse['action'], { kind: 'call' }>,
    record: (kind: RunStep['kind'], summary: string, detail: Record<string, unknown>) => Promise<void>,
  ): Promise<string> {
    const invoker = this.#deps.connectors
    if (invoker === undefined) {
      // 没配就是不能调，**不是**不受限制。缺省值必须在最小权限那一侧
      await record('guardrail', `拒绝调用 ${action.connectorId}.${action.operation}：该 Run 未配置外部工具`, {
        connectorId: action.connectorId,
      })
      return '这次执行没有配置任何外部工具'
    }

    try {
      const result = await invoker.invoke(caller, {
        connectorId: action.connectorId,
        operation: action.operation,
        target: action.target,
        params: action.params,
        ...(action.idempotencyKey === undefined ? {} : { idempotencyKey: action.idempotencyKey }),
      }, this.#deps.signal)
      await record('tool', `${action.connectorId}.${action.operation} → ${action.target}`, {
        // 记的是网关脱敏之后的结果：轨迹会被人看、被导出，不该成为泄漏点
        replayed: result.replayed,
        attempts: result.attempts,
        data: result.data,
      })
      return JSON.stringify(result.data)
    } catch (error) {
      const message = error instanceof DomainError ? error.message : String(error)
      await record('guardrail', `工具调用被拒或失败：${message}`, {
        connectorId: action.connectorId,
        operation: action.operation,
      })
      return `调用失败：${message}`
    }
  }
}

/** Run 上写了预算就用它，否则用默认值。Run 级预算让"这次别花太多"成为可能 */
function budgetFor(run: Resource, blastRadius?: number): RunBudget {
  const maxTokens = run.attributes['maxTokens']
  const maxSteps = run.attributes['maxSteps']
  return {
    maxTokens: typeof maxTokens === 'number' ? maxTokens : DEFAULT_RUN_BUDGET.maxTokens,
    maxSteps: typeof maxSteps === 'number' ? maxSteps : DEFAULT_RUN_BUDGET.maxSteps,
    maxCostUsd: DEFAULT_RUN_BUDGET.maxCostUsd,
    // 影响面上限**不读 Run 上的属性**（FR-IAM-012）。
    // 它是最后一道闸，而一道能被本次执行自己调大的闸不是闸。
    // 要改就改租户级策略，那是一次有人签字的决定
    maxObjectsPerRun: blastRadius ?? DEFAULT_RUN_BUDGET.maxObjectsPerRun,
  }
}

function overBudget(
  budget: RunBudget,
  used: { tokensUsed: number; costUsd: number; steps: number },
): { limit: keyof RunBudget; used: number } | null {
  if (used.tokensUsed > budget.maxTokens) return { limit: 'maxTokens', used: used.tokensUsed }
  if (used.costUsd > budget.maxCostUsd) return { limit: 'maxCostUsd', used: used.costUsd }
  if (used.steps > budget.maxSteps) return { limit: 'maxSteps', used: used.steps }
  return null
}

export function isAgentPrincipal(principal: string): boolean {
  return principal.startsWith('agent://')
}

/**
 * 哪些产出类型必须带证据（FR-AI-006）。
 *
 * 只列 `Risk`，不是"先做一个再说"。**每加一种类型都是在收紧模型能产出什么**，
 * 而收紧得没有依据就会变成挡路：一条 Task 不需要"证据"字段，
 * 硬要求它带，结果是所有人在那个字段里填 "N/A"。
 *
 * FR-AI-006 点名的就是风险识别。别的需求要别的闸时再加，
 * 加的时候要能说出是哪一条需求要求的。
 */
const EVIDENCE_REQUIRED = new Set(['Risk'])

/** 风险条目要指得出触发它的实体（FR-AI-006） */
function evidenceGate(proposal: { resourceType: string; attributes: Record<string, unknown> }): Verdict {
  if (!EVIDENCE_REQUIRED.has(proposal.resourceType)) {
    return { ok: true, reason: 'no evidence required for this type', offenders: [] }
  }
  const raw = proposal.attributes['evidence']
  // 只认字符串数组。一个 `evidence: "看起来很危险"` 的字段
  // 满足"有这个字段"，却什么也指不到——而那正是这条需求要挡的东西
  const evidence = Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : []
  const title = String(proposal.attributes['title'] ?? proposal.resourceType)
  return requireEvidence([{ id: title, statement: title, evidence }])
}

export { MAY_WRITE, NEEDS_REVIEW }
