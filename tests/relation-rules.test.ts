import { describe, expect, it } from 'vitest'
import { edgesFor, validateRule } from '../src/ontology/relation-rules.ts'
import { buildDefaultRegistry } from '../src/ontology/defaults.ts'
import type { RelationRule, RuleSubject } from '../src/ontology/relation-rules.ts'

/**
 * 自动关系建立规则（FR-ONT-008）。
 *
 * 验收标准：**规则可增删改，变更即时生效。**
 *
 * 这一组的主题是**规则的表达力要小**。一条写得太宽的规则会在一夜之间
 * 建出几千条谁也没审过的边，而图上的边是**会被守卫读的**
 * （Release 只装 Done 的 Task、Story 要有验收标准…）——
 * 也就是说，一条随手写的关系规则可以让一批对象的状态机行为整个变掉。
 */

const registry = buildDefaultRegistry()

const STORY_ID = 'story_01J8ZQ9X7K3M4N5P6Q7R8S9T0V'
const OTHER_STORY = 'story_01J8ZQ9X7K3M4N5P6Q7R8S9T0W'

const rule = (over: Partial<RelationRule> = {}): RelationRule => ({
  id: 'r1',
  relationType: 'partOf',
  subjectType: 'Task',
  locator: { kind: 'idInAttribute', attribute: 'description' },
  confidence: 0.7,
  ...over,
})

const task = (attributes: Record<string, unknown>, id = 'task_01J8ZQ9X7K3M4N5P6Q7R8S9T11'): RuleSubject => ({
  id,
  type: 'Task',
  attributes,
})

describe('a rule is validated when it is written, not when it fires (FR-ONT-008)', () => {
  it('accepts a well-formed rule', () => {
    expect(() => validateRule(rule(), registry)).not.toThrow()
  })

  it('rejects an unknown relation type', () => {
    expect(() => validateRule(rule({ relationType: 'inventedBy' }), registry)).toThrow(/unknown relation type/)
  })

  it('rejects a subject type outside the relation domain', () => {
    // 不守本体的定义域的话，"自动建关系"就成了绕过本体校验的后门
    expect(() => validateRule(rule({ subjectType: 'Knowledge' }), registry)).toThrow(/does not start from/)
  })

  it('rejects an attribute the subject type does not have', () => {
    expect(() =>
      validateRule(rule({ locator: { kind: 'idInAttribute', attribute: 'nope' } }), registry),
    ).toThrow(/has no attribute/)
  })

  it('rejects a target type outside the relation range', () => {
    expect(() =>
      validateRule(
        rule({
          locator: {
            kind: 'attributeEquals',
            attribute: 'description',
            targetType: 'Knowledge',
            targetAttribute: 'title',
          },
        }),
        registry,
      ),
    ).toThrow(/does not point at/)
  })

  it('refuses confidence 1 — a rule-inferred edge is never certain', () => {
    // 允许写 1 的话，这些边在 UI 上会和人工确认过的边长得一模一样
    expect(() => validateRule(rule({ confidence: 1 }), registry)).toThrow(/never certain/)
    expect(() => validateRule(rule({ confidence: 0 }), registry)).toThrow(/never certain/)
  })

  it('lists every problem at once', () => {
    expect(() =>
      validateRule(rule({ relationType: 'nope', confidence: 5 }), registry),
    ).toThrow(/invalid relation rule "r1"/)
  })
})

describe('finding the other end (FR-ONT-008)', () => {
  it('picks up a resource id written into a text field', () => {
    // 人本来就会把工单号写进标题和描述里
    const edges = edgesFor(task({ description: `拆自 ${STORY_ID} 的第二步` }), [rule()], [])
    expect(edges).toHaveLength(1)
    expect(edges[0]).toMatchObject({ relationType: 'partOf', toId: STORY_ID, confidence: 0.7 })
  })

  it('picks up several ids from one field', () => {
    const edges = edgesFor(task({ description: `${STORY_ID} 与 ${OTHER_STORY}` }), [rule()], [])
    expect(edges.map((e) => e.toId).sort()).toEqual([STORY_ID, OTHER_STORY].sort())
  })

  it('says nothing when the field holds no id', () => {
    expect(edgesFor(task({ description: '就是随便写点什么' }), [rule()], [])).toEqual([])
  })

  it('matches on an equal attribute value', () => {
    const r = rule({
      relationType: 'partOf',
      locator: {
        kind: 'attributeEquals',
        attribute: 'description',
        targetType: 'Story',
        targetAttribute: 'title',
      },
    })
    const candidates: RuleSubject[] = [
      { id: STORY_ID, type: 'Story', attributes: { title: '导出账单' } },
      { id: OTHER_STORY, type: 'Story', attributes: { title: '别的事' } },
      // **同名但类型不对的**。原来这条用例里没有它，于是把类型判断
      // 整个删掉照样通过——变异测试逮到的
      { id: 'know_01J8ZQ9X7K3M4N5P6Q7R8S9T0X', type: 'Knowledge', attributes: { title: '导出账单' } },
    ]
    const edges = edgesFor(task({ description: '导出账单' }), [r], candidates)
    expect(edges.map((e) => e.toId)).toEqual([STORY_ID])
  })

  it('never proposes a self-loop', () => {
    // relations 表上有 CHECK 挡着，但让它走到数据库再被拒的话，
    // 错误信息会指向一个和规则无关的地方
    const me = 'task_01J8ZQ9X7K3M4N5P6Q7R8S9T11'
    expect(edgesFor(task({ description: `see ${me}` }, me), [rule()], [])).toEqual([])
  })
})

describe('the rule set stays tame (FR-ONT-008)', () => {
  it('skips a disabled rule — that is how "删" works without losing the rule', () => {
    expect(edgesFor(task({ description: STORY_ID }), [rule({ enabled: false })], [])).toEqual([])
  })

  it('ignores rules for a different subject type', () => {
    expect(edgesFor(task({ description: STORY_ID }), [rule({ subjectType: 'Story' })], [])).toEqual([])
  })

  it('does not propose the same edge twice when two rules agree', () => {
    // 建两条一模一样的边只会让人多点一次"否决"
    const edges = edgesFor(
      task({ description: STORY_ID }),
      [rule({ id: 'a' }), rule({ id: 'b' })],
      [],
    )
    expect(edges).toHaveLength(1)
  })

  it('still proposes two different relation types to the same target', () => {
    const edges = edgesFor(
      task({ description: STORY_ID }),
      [rule({ id: 'a' }), rule({ id: 'b', relationType: 'blockedBy' })],
      [],
    )
    expect(edges).toHaveLength(2)
  })

  it('carries the rule id, so a runaway rule can be found and switched off', () => {
    const edges = edgesFor(task({ description: STORY_ID }), [rule({ id: 'noisy' })], [])
    expect(edges[0]?.ruleId).toBe('noisy')
  })

  it('proposes edges as suggestions, never as certainties', () => {
    // 规则建的边不是事实，是建议。直接当成已确认的话，
    // 那些读图的守卫就会开始信任一批没有人看过的数据
    const edges = edgesFor(task({ description: STORY_ID }), [rule()], [])
    expect(edges[0]?.confidence).toBeGreaterThan(0)
    expect(edges[0]?.confidence).toBeLessThan(1)
  })
})
