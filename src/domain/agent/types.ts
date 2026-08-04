import type { Resource } from '../resource/resource.ts'

/**
 * Agent Runtime 的端口与类型（FR-AGT-002）。
 *
 * 一条硬规则：**所有内置 Agent 共用同一个执行入口，没有专用分支**。
 * Agent 之间的差异全部由声明（能力、模式、预算、提示）表达，
 * 而不是由 `if (agent === 'coding')` 表达——一旦允许分支，
 * "换一个 Agent 不影响协议"这句话就不成立了。
 */

/** 人机协作模式（FR-AGT-009，见 docs/prd/05-agent-runtime.md §4） */
export type CollaborationMode = 'Suggest' | 'Draft' | 'ExecuteWithReview' | 'Autonomous'

/**
 * 一段上下文，**必须带出处**（FR-AGT-004）。
 *
 * 这是这个系统与"把文档塞进 prompt"的分界线：上下文是从本体图上检索来的，
 * 每一段都记得自己来自哪个实体。没有出处的上下文没有资格进入推理——
 * 因为产出将无法回溯到依据。
 */
export type ContextSegment = {
  /** 来源实体 id */
  sourceId: string
  sourceType: string
  /** 从 Run 的 subject 走到这里经过的关系链，回答"它凭什么相关" */
  via: readonly string[]
  text: string
}

export type ModelTier = 'tier-low' | 'tier-mid' | 'tier-high'

export type ModelRequest = {
  tier: ModelTier
  /** Agent 的角色设定与规则 */
  system: string
  goal: string
  context: readonly ContextSegment[]
  /** 已经走过的步骤，供模型判断是否收敛 */
  history: readonly { thought: string; observation: string }[]
}

export type ModelResponse = {
  /** 本步推理 */
  thought: string
  /**
   * 下一步动作。`finish` 表示收敛，`propose` 表示产出一个待写回的对象。
   * 刻意做成很窄的一组：模型能做什么由这里决定，而不是由提示词里的约定决定。
   */
  action:
    | { kind: 'finish'; summary: string }
    | { kind: 'propose'; resourceType: string; attributes: Record<string, unknown>; rationale: string }
    /**
     * 调用一个外部工具。
     *
     * 注意这里给的是**意图**（哪个 connector、哪个操作、什么参数），
     * 不是一个 URL。运行时把它交给 ConnectorGateway，
     * 由网关去授权、限流、注入凭据、脱敏——模型既不知道凭据，
     * 也没有绕过这一层的办法（FR-CON-002）。
     */
    | {
        kind: 'call'
        connectorId: string
        operation: string
        target: string
        params: Record<string, unknown>
        idempotencyKey?: string
      }
  tokensUsed: number
  costUsd: number
}

/**
 * 模型客户端端口。
 *
 * 做成端口而不是直接调某家 SDK，理由和存储一样：
 * 领域层不该知道供应商是谁（FR-AGT-013 要求"切换模型仅需改 modelPolicy"）。
 * 附带的好处是运行时可以被完整地测——测试里用确定性实现，
 * 不必为了验证熔断逻辑去真的烧 token。
 */
export interface ModelClient {
  complete(request: ModelRequest): Promise<ModelResponse>
}

/**
 * 单次 Run 的预算（FR-AGT-012）。
 *
 * 三层预算里这是最内的一层。超限即终止并留痕，而不是"尽量少用"——
 * 没有硬上界的自动化是一个可以无限花钱的循环。
 */
export type RunBudget = {
  maxTokens: number
  maxSteps: number
  maxCostUsd: number
}

export const DEFAULT_RUN_BUDGET: RunBudget = {
  maxTokens: 100_000,
  maxSteps: 8,
  maxCostUsd: 5,
}

export type RunStepKind = 'context' | 'reasoning' | 'observation' | 'artifact' | 'guardrail' | 'tool'

/** Run 轨迹的一步（FR-AGT-007）。逐步可回放，所以每一步都要能独立看懂 */
export type RunStep = {
  runId: string
  seq: number
  kind: RunStepKind
  /** 人类可读的一句话，UI 直接显示 */
  summary: string
  /** 结构化细节；敏感字段在写入前脱敏 */
  detail: Record<string, unknown>
  tokensUsed: number
  costUsd: number
  occurredAt: Date
}

export interface RunStepRepository {
  append(step: RunStep): Promise<void>
  listFor(runId: string): Promise<RunStep[]>
}

/** Run 的终止方式。区分开来才能回答"有多少 Run 是被预算掐掉的" */
export type RunOutcome =
  | { kind: 'completed'; summary: string }
  | { kind: 'awaiting-review'; summary: string; proposals: number }
  | { kind: 'budget-exceeded'; limit: keyof RunBudget; used: number }
  | { kind: 'failed'; reason: string }

export type RunResult = {
  outcome: RunOutcome
  steps: number
  tokensUsed: number
  costUsd: number
  /** Agent 提议写回的对象；是否真的落库取决于协作模式 */
  proposals: readonly ProposedResource[]
}

export type ProposedResource = {
  resourceType: string
  attributes: Record<string, unknown>
  rationale: string
  /** 已经落库时带上 id；Suggest 模式下为 null */
  createdId: string | null
}

/** 运行时需要的 Agent 声明（FR-AGT-001 的运行期投影） */
export type AgentSpec = {
  /** Agent 资源的 id */
  id: string
  /** `agent://name@version`，这次 Run 的身份 */
  principal: string
  name: string
  system: string
  tier: ModelTier
  mode: CollaborationMode
  budget: RunBudget
  /** Context 从 subject 出发沿这些关系装配 */
  contextRelations: readonly string[]
  /** 允许提议写回的类型。空表示不允许写回，只能给建议 */
  mayPropose: readonly string[]
}

/** 从 Agent 资源读出运行期需要的部分 */
export function agentSpecFrom(agent: Resource, overrides: Partial<AgentSpec> = {}): AgentSpec {
  const attrs = agent.attributes
  return {
    id: agent.id,
    principal: String(attrs['principal'] ?? ''),
    name: String(attrs['name'] ?? agent.id),
    system: String(attrs['system'] ?? '你是一个项目交付助理。只依据给定的上下文作答。'),
    tier: (attrs['tier'] as ModelTier) ?? 'tier-mid',
    mode: (attrs['mode'] as CollaborationMode) ?? 'Suggest',
    budget: DEFAULT_RUN_BUDGET,
    contextRelations: (attrs['contextRelations'] as string[]) ?? ['partOf', 'implements', 'explains'],
    mayPropose: (attrs['mayPropose'] as string[]) ?? [],
    ...overrides,
  }
}
