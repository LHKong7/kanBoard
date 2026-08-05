import { ValidationError } from '../platform/errors.ts'
import type { OntologyRegistry } from './registry.ts'

/**
 * 自动关系建立规则（FR-ONT-008）。
 *
 * 验收标准：**规则可增删改，变更即时生效。**
 *
 * "自动建关系"的诱惑很大，而它的失败方式很难看：一条写得太宽的规则
 * 会在一夜之间建出几千条谁也没审过的边，而图上的边是**会被守卫读的**
 * （Release 只装 Done 的 Task、Story 要有验收标准…）。
 * 也就是说，一条随手写的关系规则可以让一批对象的状态机行为整个变掉。
 *
 * 所以这里和自动化动作是同一个doctrine：**规则的表达力刻意很小。**
 * 匹配条件是一个封闭联合，没有表达式、没有脚本。
 * 想做规则表达不了的事，写代码。
 *
 * 建出来的边一律带 `confidence` 与"待确认"（FR-ONT-006）——
 * **规则建的边不是事实，是建议**。直接当成已确认的话，
 * 上面那些守卫就会开始信任一批没有人看过的数据。
 */

/** 从哪个字段里找对方。**只支持这两种**，加第三种要能说出是哪条需求要求的 */
export type TargetLocator =
  /**
   * 在本对象的某个属性文本里找资源 id（形如 `task_01J…`）。
   * 人本来就会把工单号写进标题和描述里——和外部事件那边认对象是同一个思路
   */
  | { kind: 'idInAttribute'; attribute: string }
  /**
   * 找属性值相等的对象。用于"同一个 epic key"这类约定
   */
  | { kind: 'attributeEquals'; attribute: string; targetType: string; targetAttribute: string }

export type RelationRule = {
  id: string
  /** 建哪种关系 */
  relationType: string
  /** 对哪种对象生效 */
  subjectType: string
  locator: TargetLocator
  /** 置信度。规则建的边一律是建议，这个值决定它有多像一条建议 */
  confidence: number
  enabled?: boolean | undefined
  description?: string | undefined
}

/**
 * 校验一条规则——**在写入时**，不是在触发时。
 *
 * 触发时才校验的话，一条写错的规则会安静地躺着，直到某天某个对象
 * 恰好触发它，然后在一条和规则毫无关系的调用栈里报错。
 */
export function validateRule(rule: RelationRule, registry: OntologyRegistry): void {
  const problems: { path: string; message: string }[] = []

  const relation = registry.relationTypes().find((r) => r.name === rule.relationType)
  if (relation === undefined) {
    problems.push({ path: 'relationType', message: `unknown relation type "${rule.relationType}"` })
  } else {
    // 规则建的边也要守本体的定义域/值域。不守的话，"自动建关系"
    // 就成了绕过本体校验的一个后门
    if (!relation.domain.includes(rule.subjectType)) {
      problems.push({
        path: 'subjectType',
        message: `"${rule.relationType}" does not start from ${rule.subjectType} (domain: ${relation.domain.join(', ')})`,
      })
    }
    if (rule.locator.kind === 'attributeEquals' && !relation.range.includes(rule.locator.targetType)) {
      problems.push({
        path: 'locator.targetType',
        message: `"${rule.relationType}" does not point at ${rule.locator.targetType} (range: ${relation.range.join(', ')})`,
      })
    }
  }

  try {
    const subject = registry.entityType(rule.subjectType)
    const attr = rule.locator.attribute
    if (!subject.attributes.some((a) => a.name === attr)) {
      problems.push({ path: 'locator.attribute', message: `${rule.subjectType} has no attribute "${attr}"` })
    }
  } catch {
    problems.push({ path: 'subjectType', message: `unknown entity type "${rule.subjectType}"` })
  }

  // 置信度必须在 (0,1]，而且**不能是 1**：1 表示"确定"，
  // 而一条规则推出来的边按定义不是确定的。允许写 1 的话，
  // 这些边在 UI 上会和人工确认过的边长得一模一样
  if (!(rule.confidence > 0 && rule.confidence < 1)) {
    problems.push({
      path: 'confidence',
      message: 'must be between 0 and 1, exclusive; a rule-inferred edge is never certain',
    })
  }

  if (problems.length > 0) {
    const why = problems.map((p) => `${p.path}: ${p.message}`).join('; ')
    throw new ValidationError(`invalid relation rule "${rule.id}" — ${why}`, {
      ruleId: rule.id,
      fields: problems,
    })
  }
}

/** 规则要建的一条边 */
export type ProposedEdge = {
  ruleId: string
  relationType: string
  fromId: string
  toId: string
  confidence: number
}

export type RuleSubject = {
  id: string
  type: string
  attributes: Record<string, unknown>
}

/** ProjectOS 的资源 id。和外部事件那边用的是同一个形状 */
const RESOURCE_ID = /\b([a-z][a-z0-9]{1,23}_[0-9A-HJKMNP-TV-Z]{26})\b/g

/**
 * 一个对象触发了哪些规则、该建哪些边。
 *
 * 纯函数：候选对象由调用方查好传进来。把"查"和"判"分开，
 * 是因为判定规则是要被讨论的那部分——而混在 SQL 里的判定没法逐条测。
 */
export function edgesFor(
  subject: RuleSubject,
  rules: readonly RelationRule[],
  candidates: readonly RuleSubject[],
): ProposedEdge[] {
  const edges: ProposedEdge[] = []
  const seen = new Set<string>()

  for (const rule of rules) {
    if (rule.enabled === false) continue
    if (rule.subjectType !== subject.type) continue

    const raw = subject.attributes[rule.locator.attribute]
    if (typeof raw !== 'string' || raw === '') continue

    const targets: string[] = []
    if (rule.locator.kind === 'idInAttribute') {
      // 一段文本里可能提到好几个 id，全都算
      for (const m of raw.matchAll(RESOURCE_ID)) if (m[1] !== undefined) targets.push(m[1])
    } else {
      const { targetType, targetAttribute } = rule.locator
      for (const c of candidates) {
        if (c.type === targetType && c.attributes[targetAttribute] === raw) targets.push(c.id)
      }
    }

    for (const toId of targets) {
      // 自环没有意义，而且 relations 表上有 CHECK 挡着——
      // 让它走到数据库再被拒，错误信息会指向一个和规则无关的地方
      if (toId === subject.id) continue
      const key = `${rule.relationType}:${toId}`
      // 同一种关系指向同一个对象只建一条：两条规则都命中时，
      // 建两条一模一样的边只会让人多点一次"否决"
      if (seen.has(key)) continue
      seen.add(key)
      edges.push({
        ruleId: rule.id,
        relationType: rule.relationType,
        fromId: subject.id,
        toId,
        confidence: rule.confidence,
      })
    }
  }
  return edges
}
