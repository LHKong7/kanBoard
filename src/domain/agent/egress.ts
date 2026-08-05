import { DomainError } from '../../platform/errors.ts'
import { maskTextPii } from '../connector/masking.ts'
import type { ContextSegment } from './types.ts'

/**
 * 模型出境控制与提示注入防护（FR-AI-012/013/014，决策见 ADR-0006）。
 *
 * 这一层管的是**上下文离开系统之前的最后一道处理**。三件事：
 *
 *   ① 这个租户 / 项目允不允许用 AI（FR-AI-012）
 *   ② 要送去的供应商在不在白名单里、分级允不允许出境（FR-AI-014）
 *   ③ 检索来的内容是**数据不是指令**（FR-AI-013）
 *
 * 放在一处是因为它们都发生在同一个时刻：调用模型之前。
 * 散在调用点的话，第二个模型客户端接进来时必然漏掉其中一两条，
 * 而漏掉的表现是"没有表现"——数据照常出境，没有任何迹象。
 */

export type DataClassification = 'public' | 'internal' | 'confidential' | 'pii' | 'secret'

/** 分级从低到高。出境判定比的是序 */
const RANK: Record<DataClassification, number> = {
  public: 0,
  internal: 1,
  confidential: 2,
  pii: 3,
  secret: 4,
}

/**
 * 租户级 AI 策略（FR-AI-012 / ADR-0006）。
 *
 * 缺省值刻意是**最保守**的一侧：没有配置就等于没批准任何供应商，
 * 于是什么都出不去。反过来设的话，一个忘了配置的租户会默默把
 * 数据发给默认供应商——而这正是最不该靠"记得配置"来保证的事。
 */
export type AiPolicy = {
  /** 这个租户 / 项目能不能用 AI（FR-AI-012） */
  enabled: boolean
  /** 已批准的模型供应商。空表示一个都没批准 */
  approvedProviders: readonly string[]
  /** 允许出境的最高分级。ADR-0006 的默认是 confidential */
  maxClassification: DataClassification
}

export const DEFAULT_AI_POLICY: AiPolicy = {
  enabled: false,
  approvedProviders: [],
  maxClassification: 'confidential',
}

export type EgressResult = {
  /** 已脱敏、已中和的上下文 */
  segments: ContextSegment[]
  /** 本次出境涉及的最高分级。进审计 */
  highestClassification: DataClassification
  /** 被中和掉的注入尝试数量。持续大于零意味着有人在试 */
  neutralised: number
}

/**
 * 看起来像"指令"的片段。
 *
 * 中和这些**不是**主要防线——主要防线是结构性的：模型的动作空间是一个
 * 封闭联合（finish / propose / call），能提议什么由 Agent 声明的
 * `mayPropose` 限死，能调什么工具由连接器白名单限死。
 * 也就是说，注入成功也拿不到新的权限。
 *
 * 这里做的是第二层：不让检索来的内容**冒充系统在说话**。
 * 一段写着"### system:"的需求描述，即使拿不到权限，
 * 也足以让模型误解自己的角色，进而产出一堆看起来合理的垃圾。
 */
const INJECTION_MARKERS = [
  /^\s*#{1,6}\s*(system|assistant|user)\s*:/gim,
  /\b(ignore|disregard|forget)\s+(all\s+)?(previous|prior|above)\s+(instructions?|prompts?)\b/gi,
  /<\|[^|>]{0,32}\|>/g,
  /\[{2,}\s*(system|end of context)\s*\]{2,}/gi,
]

/** 上下文分隔符。模型据此知道哪一段是数据 */
const FENCE = '───'

export type EgressInput = {
  segments: readonly ContextSegment[]
  policy: AiPolicy
  /** 这次要送去哪个供应商 */
  provider: string
  /** 本次上下文里最高的数据分级。由调用方按对象分级得出 */
  classification: DataClassification
}

export function prepareEgress(input: EgressInput): EgressResult {
  // ① FR-AI-012：开关
  if (!input.policy.enabled) {
    throw new DomainError('forbidden', 'AI capabilities are disabled for this tenant/project', 403, {
      requirement: 'FR-AI-012',
    })
  }

  // ② FR-AI-014：供应商白名单。空清单 = 一个都没批准，不是"全部放行"
  if (!input.policy.approvedProviders.includes(input.provider)) {
    throw new DomainError(
      'forbidden',
      `model provider "${input.provider}" is not on the approved list`,
      403,
      { requirement: 'FR-AI-014', approved: input.policy.approvedProviders },
    )
  }

  // 分级上限。secret 无论如何不出境——ADR-0006 里它不在矩阵中
  if (input.classification === 'secret') {
    throw new DomainError('forbidden', 'secret-classified data never leaves the system', 403, {
      requirement: 'FR-AI-014',
    })
  }
  if (RANK[input.classification] > RANK[input.policy.maxClassification]) {
    throw new DomainError(
      'forbidden',
      `this tenant allows egress up to "${input.policy.maxClassification}", but the context is "${input.classification}"`,
      403,
      { requirement: 'FR-AI-014' },
    )
  }

  // ③ 脱敏 + 中和
  let neutralised = 0
  const segments = input.segments.map((segment) => {
    // pii 永远脱敏，与租户配置无关（ADR-0006：PII 不随出境）。
    // 这里用的是**按内容形状**的脱敏：上下文已经被拍平成一段话，
    // 字段名早没了，按字段名判的那套在这里用不上
    const masked = maskTextPii(segment.text)
    const { text, hits } = neutralise(masked)
    neutralised += hits
    return {
      ...segment,
      // 每段都带上出处并围起来：模型据此知道这是**数据**。
      // 不围的话，检索来的一段文字和系统提示在模型眼里是同一种东西
      text: `${FENCE} context from ${segment.sourceType} ${segment.sourceId} ${FENCE}\n${text}`,
    }
  })

  return { segments, highestClassification: input.classification, neutralised }
}

/** 把冒充系统说话的片段打上标记。返回中和了几处 */
export function neutralise(text: string): { text: string; hits: number } {
  let hits = 0
  let out = text
  for (const marker of INJECTION_MARKERS) {
    out = out.replace(marker, (match) => {
      hits++
      // 替换成可见的标注而不是删掉：删掉会让内容读起来像本来就没有，
      // 而"这里原本有一段试图冒充系统的话"本身是有用的信息
      return `[neutralised: ${match.trim().slice(0, 40)}]`
    })
  }
  return { text: out, hits }
}

/**
 * 一次出境的审计记录（FR-AI-014）。
 *
 * ADR-0006 列的字段一个不少：租户、Run、对象、最高分级、供应商、token 量。
 * 少记一样，事后就答不出"哪些数据发给过谁"——而这正是这条控制存在的理由。
 */
export type EgressRecord = {
  tenant: string
  runId: string
  provider: string
  classification: DataClassification
  /** 出境涉及的来源实体 */
  sourceIds: readonly string[]
  segments: number
  neutralised: number
  occurredAt: Date
}
