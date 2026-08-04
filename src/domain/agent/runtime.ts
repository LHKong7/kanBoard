import { DomainError } from '../../platform/errors.ts'
import type { Clock } from '../../platform/clock.ts'
import type { Caller, ResourceService } from '../resource/service.ts'
import type { Resource } from '../resource/resource.ts'
import { assembleContext } from './context.ts'
import { agentSpecFrom, DEFAULT_RUN_BUDGET } from './types.ts'
import type {
  AgentSpec,
  CollaborationMode,
  ModelClient,
  ProposedResource,
  RunBudget,
  RunResult,
  RunStep,
  RunStepRepository,
} from './types.ts'

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
  /** Context 装配的深度与段数上限 */
  contextDepth?: number
  contextLimit?: number
}

/**
 * 哪些模式允许 Agent 直接把产出落库。
 *
 * `Suggest` 只给建议，一个字都不写；其余三种写成 Draft 让人复核。
 * 注意即使是 `Autonomous` 也**只写非终态对象**——
 * PRD §4 的规则是"任何不可逆操作永远需要人工确认"，
 * 而把一个对象直接创建成终态，就等于替人做了不可逆的决定。
 */
const MAY_WRITE: Record<CollaborationMode, boolean> = {
  Suggest: false,
  Draft: true,
  ExecuteWithReview: true,
  Autonomous: true,
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
      budget: budgetFor(run),
    })

    let seq = 0
    let tokensUsed = 0
    let costUsd = 0
    const proposals: ProposedResource[] = []
    const history: { thought: string; observation: string }[] = []

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
    await record('context', `装配了 ${context.segments.length} 段上下文`, {
      // 出处清单进轨迹：FR-AGT-004 的验收标准就是这个列表可查
      sources: context.segments.map((s) => ({ id: s.sourceId, type: s.sourceType, via: s.via })),
      truncated: context.truncated,
    })

    // ── 推理循环 ────────────────────────────────────────
    for (let step = 0; step < spec.budget.maxSteps; step++) {
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

      if (response.action.kind === 'finish') {
        const summary = response.action.summary
        await record('artifact', '完成', { summary })
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
}

/** Run 上写了预算就用它，否则用默认值。Run 级预算让"这次别花太多"成为可能 */
function budgetFor(run: Resource): RunBudget {
  const maxTokens = run.attributes['maxTokens']
  const maxSteps = run.attributes['maxSteps']
  return {
    maxTokens: typeof maxTokens === 'number' ? maxTokens : DEFAULT_RUN_BUDGET.maxTokens,
    maxSteps: typeof maxSteps === 'number' ? maxSteps : DEFAULT_RUN_BUDGET.maxSteps,
    maxCostUsd: DEFAULT_RUN_BUDGET.maxCostUsd,
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

export { MAY_WRITE, NEEDS_REVIEW }
