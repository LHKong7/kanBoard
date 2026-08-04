import type { DataClassification } from '../../ontology/types.ts'

/**
 * 按数据分级脱敏（FR-CON-012 / ADR-0006）。
 *
 * 规则来自 ADR-0006：
 *   `secret` —— 永不进入模型上下文，整体替换
 *   `pii`    —— 出境前脱敏，保留可读的形状（能看出是邮箱/手机号）但不可还原
 *   其余     —— 原样通过
 *
 * 为什么脱敏发生在**网关的最后一步**而不是各个 Connector 里：
 * 放在 Connector 里就是十几份实现，其中总有一份会忘。
 * 放在唯一出口上，"有没有脱敏"就变成一个可以一眼看完的问题。
 */

/** 看起来像凭据的键名。命中即整体遮蔽，不管值长什么样 */
const SECRET_KEYS =
  /(password|passwd|secret|token|api[-_]?key|authorization|credential|private[-_]?key|access[-_]?key)/i

/** 看起来像 PII 的键名 */
const PII_KEYS = /(email|e-mail|phone|mobile|tel|id[-_]?card|ssn|address|birth)/i

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const DIGITS = /^\+?[\d\s-]{7,}$/

export function maskByClassification(value: unknown, classification: DataClassification): unknown {
  // secret 级：整块都不给。这类数据没有"部分可见"的安全说法
  if (classification === 'secret') return '[redacted:secret]'
  return walk(value, classification === 'pii')
}

function walk(value: unknown, piiContext: boolean): unknown {
  if (value === null || value === undefined) return value
  if (Array.isArray(value)) return value.map((v) => walk(v, piiContext))
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      // 键名先判：即使这次调用整体不是 pii 级，
      // 一个叫 `apiKey` 的字段也绝不该原样流出去
      if (SECRET_KEYS.test(key)) {
        out[key] = '[redacted]'
      } else if (piiContext || PII_KEYS.test(key)) {
        out[key] = typeof v === 'string' ? maskValue(v) : walk(v, piiContext)
      } else {
        out[key] = walk(v, piiContext)
      }
    }
    return out
  }
  return value
}

/**
 * 遮蔽一个值，但**保留它的形状**。
 *
 * `a***@example.com` 仍然看得出是邮箱、来自哪个域，
 * 这对判断"这条数据对不对得上"有用，而完整地址没有必要给出去。
 * 全部替换成 `***` 会让 Agent 连"这里本来有个邮箱"都不知道，
 * 反而容易推理出错。
 */
export function maskValue(value: string): string {
  if (EMAIL.test(value)) {
    const [local = '', domain = ''] = value.split('@')
    return `${local.slice(0, 1)}***@${domain}`
  }
  if (DIGITS.test(value)) {
    const tail = value.replace(/\D/g, '').slice(-4)
    return `***${tail}`
  }
  if (value.length <= 4) return '***'
  return `${value.slice(0, 2)}***`
}
