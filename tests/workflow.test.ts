import { describe, expect, it } from 'vitest'
import {
  applyActions,
  assertValidInitialStatus,
  availableTransitions,
  groupOf,
  resolveTransition,
  WorkflowRegistry,
} from '../src/workflow/engine.ts'
import {
  buildDefaultWorkflowRegistry,
  DEFAULT_LIFECYCLES,
  TASK_LIFECYCLE,
} from '../src/workflow/defaults.ts'
import { describe as describeGuard, evaluateGuard } from '../src/workflow/guards.ts'
import { STATE_GROUPS } from '../src/workflow/types.ts'
import { TransitionError } from '../src/platform/errors.ts'
import type {
  Guard,
  GuardContext,
  Lifecycle,
  RelatedRef,
  StateDef,
  TransitionDef,
} from '../src/workflow/types.ts'

function ctx(overrides: Partial<GuardContext> = {}): GuardContext {
  return {
    attributes: {},
    owner: 'user://alice',
    outgoingRelationTypes: new Set(),
    incomingRelationTypes: new Set(),
    ...overrides,
  }
}

describe('guards give a usable reason, not just false (FR-WF-003)', () => {
  it('names the missing attribute', () => {
    const result = evaluateGuard({ kind: 'attributeSet', path: 'assignee' }, ctx())
    expect(result).toEqual({ ok: false, reason: 'attribute "assignee" must be set' })
  })

  it('treats an empty string as unset', () => {
    // "" 通过了必填校验但没有任何信息量，当成没填
    const result = evaluateGuard({ kind: 'attributeSet', path: 'x' }, ctx({ attributes: { x: '' } }))
    expect(result.ok).toBe(false)
  })

  it('names the missing relation and its direction', () => {
    const result = evaluateGuard({ kind: 'hasRelation', type: 'implementedBy', direction: 'out' }, ctx())
    expect(result).toEqual({
      ok: false,
      reason: 'a "implementedBy" relation (outgoing) is required',
    })
  })

  it('reports every alternative when an any-guard fails', () => {
    const result = evaluateGuard(
      {
        kind: 'any',
        of: [
          { kind: 'attributeSet', path: 'a' },
          { kind: 'attributeSet', path: 'b' },
        ],
      },
      ctx(),
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toContain('"a"')
      expect(result.reason).toContain('"b"')
    }
  })

  it('short-circuits an all-guard at the first failure', () => {
    const result = evaluateGuard(
      {
        kind: 'all',
        of: [
          { kind: 'attributeSet', path: 'first' },
          { kind: 'attributeSet', path: 'second' },
        ],
      },
      ctx(),
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain('first')
  })
})

/**
 * 守卫的其余几种（FR-DOM-001：不变量要有用例覆盖）。
 *
 * 这些是**不变量的原语**——七个上下文的聚合全靠它们表达。
 * 原语上的分支没被覆盖，意味着某种不变量的判定从来没被验证过，
 * 而它出错的样子是"这个守卫好像没生效"。
 */
describe('the remaining guard kinds', () => {
  it('attributeEquals names both the expected and the actual value', () => {
    const g: Guard = { kind: 'attributeEquals', path: 'level', value: 'Story' }
    expect(evaluateGuard(g, ctx({ attributes: { level: 'Story' } })).ok).toBe(true)

    const bad = evaluateGuard(g, ctx({ attributes: { level: 'Epic' } }))
    expect(bad.ok).toBe(false)
    // 只说"不等于期望值"，使用者还得自己去查现在是什么
    expect(bad.ok === false && bad.reason).toContain('"Epic"')
    expect(bad.ok === false && bad.reason).toContain('"Story"')
  })

  it('attributeEquals reports a missing attribute as null, not undefined', () => {
    // undefined 在错误信息里读起来像"程序出错了"，null 读起来像"没填"
    const result = evaluateGuard({ kind: 'attributeEquals', path: 'x', value: 1 }, ctx())
    expect(result.ok === false && result.reason).toContain('null')
  })

  it('attributeIn lists the allowed values', () => {
    const g: Guard = { kind: 'attributeIn', path: 'severity', values: ['P0', 'P1'] }
    expect(evaluateGuard(g, ctx({ attributes: { severity: 'P0' } })).ok).toBe(true)

    const bad = evaluateGuard(g, ctx({ attributes: { severity: 'P3' } }))
    expect(bad.ok).toBe(false)
    expect(bad.ok === false && bad.reason).toContain('["P0","P1"]')
  })

  it('ownerAssigned rejects an unowned object', () => {
    expect(evaluateGuard({ kind: 'ownerAssigned' }, ctx()).ok).toBe(true)
    const result = evaluateGuard({ kind: 'ownerAssigned' }, ctx({ owner: null }))
    expect(result.ok).toBe(false)
  })

  it('not inverts, and says what should not have held', () => {
    const inner: Guard = { kind: 'attributeSet', path: 'blockReason' }
    expect(evaluateGuard({ kind: 'not', of: inner }, ctx()).ok).toBe(true)

    const result = evaluateGuard(
      { kind: 'not', of: inner },
      ctx({ attributes: { blockReason: '等接口' } }),
    )
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.reason).toContain('blockReason')
  })

  it('hasRelation checks the incoming direction too', () => {
    // 只查出边的话，"必须被某个东西引用"这类不变量表达不出来
    const g: Guard = { kind: 'hasRelation', type: 'decomposedInto', direction: 'in' }
    expect(evaluateGuard(g, ctx({ incomingRelationTypes: new Set(['decomposedInto']) })).ok).toBe(
      true,
    )
    expect(evaluateGuard(g, ctx({ outgoingRelationTypes: new Set(['decomposedInto']) })).ok).toBe(
      false,
    )
  })

  it('all passes only when every part does', () => {
    const g: Guard = {
      kind: 'all',
      of: [
        { kind: 'attributeSet', path: 'a' },
        { kind: 'attributeSet', path: 'b' },
      ],
    }
    expect(evaluateGuard(g, ctx({ attributes: { a: 1, b: 2 } })).ok).toBe(true)
    expect(evaluateGuard(g, ctx({ attributes: { a: 1 } })).ok).toBe(false)
  })

  it('any passes as soon as one does', () => {
    const g: Guard = {
      kind: 'any',
      of: [
        { kind: 'attributeSet', path: 'a' },
        { kind: 'attributeSet', path: 'b' },
      ],
    }
    expect(evaluateGuard(g, ctx({ attributes: { b: 2 } })).ok).toBe(true)
  })

  it('describes every kind in words the UI can show', () => {
    // 这些字符串会出现在"这条迁移需要什么"里。少一种就是一句空白
    const kinds: Guard[] = [
      { kind: 'attributeSet', path: 'a' },
      { kind: 'attributeEquals', path: 'a', value: 1 },
      { kind: 'attributeIn', path: 'a', values: ['x'] },
      { kind: 'hasRelation', type: 'r', direction: 'out' },
      { kind: 'allRelatedIn', type: 'r', direction: 'out', states: ['Done'] },
      { kind: 'ownerAssigned' },
      { kind: 'all', of: [{ kind: 'ownerAssigned' }] },
      { kind: 'any', of: [{ kind: 'ownerAssigned' }] },
      { kind: 'not', of: { kind: 'ownerAssigned' } },
    ]
    for (const guard of kinds) {
      expect(describeGuard(guard), guard.kind).toBeTruthy()
    }
  })
})

describe('lifecycle registration rejects self-contradictory definitions', () => {
  it('rejects an initial state that is not declared', () => {
    const registry = new WorkflowRegistry()
    expect(() =>
      registry.register({
        id: 'x',
        entityType: 'X',
        initial: 'Nowhere',
        states: [{ name: 'Start', group: 'Unstarted' }],
        transitions: [],
      }),
    ).toThrow(/initial state "Nowhere" is not declared/)
  })

  it('rejects a transition to an unknown state', () => {
    const registry = new WorkflowRegistry()
    expect(() =>
      registry.register({
        id: 'x',
        entityType: 'X',
        initial: 'A',
        states: [{ name: 'A', group: 'Unstarted' }],
        transitions: [{ from: ['A'], to: 'B' }],
      }),
    ).toThrow(/transition to unknown state "B"/)
  })

  it('rejects duplicate state names', () => {
    // 重名的状态会让"这个对象在哪一步"没有确定答案：
    // 两个 Done 各自有各自的守卫和 entry action
    expect(() =>
      new WorkflowRegistry().register({
        id: 'x',
        entityType: 'X',
        initial: 'A',
        states: [
          { name: 'A', group: 'Unstarted' },
          { name: 'A', group: 'Unstarted' },
        ],
        transitions: [],
      }),
    ).toThrow(/duplicate states/)
  })

  it('rejects a transition from an unknown state', () => {
    // 到不了的边不是无害的：它会出现在"可用迁移"里，然后点了没反应
    expect(() =>
      new WorkflowRegistry().register({
        id: 'x',
        entityType: 'X',
        initial: 'A',
        states: [{ name: 'A', group: 'Unstarted' }],
        transitions: [{ from: ['Nowhere'], to: 'A' }],
      }),
    ).toThrow(/transition from unknown state "Nowhere"/)
  })

  it('refuses to register the same lifecycle id twice', () => {
    // 第二次注册静默覆盖的话，"我改了流程但线上跑的是另一份"
    const registry = new WorkflowRegistry()
    const lifecycle: Lifecycle = {
      id: 'dup',
      entityType: 'X',
      initial: 'A',
      states: [{ name: 'A', group: 'Unstarted' }],
      transitions: [],
    }
    registry.register(lifecycle)
    expect(() => registry.register(lifecycle)).toThrow(/already registered/)
  })

  /**
   * 状态组（project-management-guide §2.2）。
   *
   * 指南把「自定义状态归错状态组」列为反模式，后果是燃尽图、进度条、
   * 所有统计一起失真。能机械查出来的只有一条，这里锁住它。
   */
  describe('状态组', () => {
    const lifecycle = (states: StateDef[]): Lifecycle => ({
      id: 'x',
      entityType: 'X',
      initial: states[0]?.name ?? 'A',
      states,
      transitions: [],
    })

    it('终态归进 Started 组会被拒 —— 否则燃尽图永远烧不到零', () => {
      expect(() =>
        new WorkflowRegistry().register(
          lifecycle([
            { name: 'A', group: 'Unstarted' },
            { name: 'Done', group: 'Started', terminal: true },
          ]),
        ),
      ).toThrow(/terminal but grouped as "Started"/)
    })

    it('Completed 组的非终态是合法的 —— Decision.Accepted 就是这种', () => {
      // 做完了，但还可能被后来的决策取代。反向检查会把这类建模判成错的
      expect(() =>
        new WorkflowRegistry().register(
          lifecycle([
            { name: 'A', group: 'Unstarted' },
            { name: 'Accepted', group: 'Completed' },
          ]),
        ),
      ).not.toThrow()
    })

    it('初始状态不能是关闭态 —— 一出生就"已完成"会让完成率永远好看', () => {
      expect(() =>
        new WorkflowRegistry().register(
          lifecycle([{ name: 'Done', group: 'Completed', terminal: true }]),
        ),
      ).toThrow(/cannot begin life closed/)
    })

    it('组名写错时列出全部可选值，而不是只说一句"不合法"', () => {
      expect(() =>
        new WorkflowRegistry().register(
          lifecycle([{ name: 'A', group: 'InProgress' as unknown as StateDef['group'] }]),
        ),
      ).toThrow(/Triage \/ Backlog \/ Unstarted \/ Started \/ Completed \/ Cancelled/)
    })

    it('groupOf 认识状态，遇到改过状态机之后的旧数据返回 null 而不是抛', () => {
      const machine = lifecycle([
        { name: 'A', group: 'Unstarted' },
        { name: 'Done', group: 'Completed', terminal: true },
      ])
      expect(groupOf(machine, 'Done')).toBe('Completed')
      // 为一条历史遗留的状态名让整张报表打不开，不划算
      expect(groupOf(machine, 'GoneForever')).toBeNull()
    })

    it('内置的 22 台状态机每个状态都标了组', () => {
      for (const machine of DEFAULT_LIFECYCLES) {
        for (const state of machine.states) {
          expect(STATE_GROUPS, `${machine.id}.${state.name}`).toContain(state.group)
        }
      }
    })
  })

  it('rejects an outgoing transition from a terminal state', () => {
    // 有出边的终态不是终态。自相矛盾的定义在注册时就该炸掉，
    // 而不是等某天有人发现"已完成"的任务又活了过来
    const registry = new WorkflowRegistry()
    expect(() =>
      registry.register({
        id: 'x',
        entityType: 'X',
        initial: 'A',
        states: [
          { name: 'A', group: 'Unstarted' },
          { name: 'Done', group: 'Completed', terminal: true },
        ],
        transitions: [
          { from: ['A'], to: 'Done' },
          { from: ['Done'], to: 'A' },
        ],
      }),
    ).toThrow(/marked terminal but has an outgoing transition/)
  })

  /**
   * 重开必须是显式的（ADR-0012）。
   *
   * 放开"终态可以有出边"时，很容易顺手把校验整条删掉。
   * 那样一台把 Done 悄悄连回去的状态机就再也没人拦——
   * 而它的症状是"已完成的数量在跳"，排查起来极难。
   * 所以放开的只是标了名字的那一条，其余三条规则各有一个用例。
   */
  describe('reopen edges (ADR-0012)', () => {
    const lifecycle = (transitions: TransitionDef[]): Lifecycle => ({
      id: 'x',
      entityType: 'X',
      initial: 'A',
      states: [
        { name: 'A', group: 'Unstarted' },
        { name: 'Done', group: 'Completed', terminal: true },
        { name: 'Dropped', group: 'Cancelled', terminal: true },
      ],
      transitions: [{ from: ['A'], to: 'Done' }, ...transitions],
    })

    it('accepts a terminal outgoing edge when it is marked reopen', () => {
      expect(() =>
        new WorkflowRegistry().register(lifecycle([{ from: ['Done'], to: 'A', reopen: true }])),
      ).not.toThrow()
    })

    it('still rejects an unmarked one, and says what to do', () => {
      expect(() => new WorkflowRegistry().register(lifecycle([{ from: ['Done'], to: 'A' }]))).toThrow(
        /mark it reopen: true/,
      )
    })

    it('rejects a reopen that does not start from a terminal state', () => {
      // 贴在普通边上的 reopen 是个假标记，会让 Rework Rate 统计到不是返工的东西
      expect(() =>
        new WorkflowRegistry().register(lifecycle([{ from: ['A'], to: 'Done', reopen: true }])),
      ).toThrow(/is not terminal/)
    })

    it('rejects a reopen that lands on another terminal state', () => {
      // 终态之间横跳不是重开，是分类错误
      expect(() =>
        new WorkflowRegistry().register(lifecycle([{ from: ['Done'], to: 'Dropped', reopen: true }])),
      ).toThrow(/must land on a non-terminal state/)
    })
  })
})

describe('initial status validation (creation path)', () => {
  it('accepts a declared state', () => {
    expect(() => assertValidInitialStatus(TASK_LIFECYCLE, 'Todo')).not.toThrow()
    // 不必是 initial：从 Doing 建一个任务是合法的
    expect(() => assertValidInitialStatus(TASK_LIFECYCLE, 'Doing')).not.toThrow()
  })

  it('lists the valid states when the status is not one of them', () => {
    // "非法状态"四个字会让人去翻源码找正确写法，而系统自己知道
    try {
      assertValidInitialStatus(TASK_LIFECYCLE, 'Shipped')
      expect.unreachable('should have thrown')
    } catch (error) {
      const details = (error as { details: { allowed: string[]; initial: string } }).details
      expect(details.allowed).toContain('Todo')
      expect(details.initial).toBe('Todo')
    }
  })
})

describe('transition resolution distinguishes its failure modes', () => {
  const lifecycle = TASK_LIFECYCLE

  it('rejects an unknown target state and lists the real ones', () => {
    try {
      resolveTransition(lifecycle, 'Task', 'Todo', 'Shipped', ctx())
      expect.unreachable('should have thrown')
    } catch (error) {
      expect(error).toBeInstanceOf(TransitionError)
      const details = (error as TransitionError).details as { states: string[] }
      expect(details.states).toContain('Doing')
    }
  })

  it('rejects an unreachable target and lists what is reachable', () => {
    try {
      resolveTransition(lifecycle, 'Task', 'Todo', 'Review', ctx())
      expect.unreachable('should have thrown')
    } catch (error) {
      const details = (error as TransitionError).details as { allowed: string[] }
      expect(details.allowed).toEqual(expect.arrayContaining(['Doing', 'Cancelled']))
      expect(details.allowed).not.toContain('Review')
    }
  })

  it('rejects a reachable target whose guard is unsatisfied, and says which', () => {
    // Todo → Doing 合法，但 Doing 要求 assignee
    try {
      resolveTransition(lifecycle, 'Task', 'Todo', 'Doing', ctx())
      expect.unreachable('should have thrown')
    } catch (error) {
      expect((error as TransitionError).message).toMatch(/attribute "assignee" must be set/)
    }
  })

  it('resolves when the guard is satisfied and reports the required capability', () => {
    const resolved = resolveTransition(
      lifecycle,
      'Task',
      'Todo',
      'Doing',
      ctx({ attributes: { assignee: 'user://bob' } }),
    )
    expect(resolved.to).toBe('Doing')
    expect(resolved.capability).toBe('Task.Execute')
    expect(resolved.actions).toContainEqual({ kind: 'stampNow', path: 'startedAt' })
  })

  it('requires a reason before a task can be marked blocked', () => {
    expect(() =>
      resolveTransition(lifecycle, 'Task', 'Doing', 'Blocked', ctx()),
    ).toThrow(/blockReason/)
  })
})

describe('available transitions drive the UI (FR-RES-008)', () => {
  it('lists unready transitions too, with what is missing', () => {
    // 只返回就绪的会让 UI 变成猜谜：用户看不到"下一步差什么"
    const options = availableTransitions(TASK_LIFECYCLE, 'Task', 'Todo', ctx())
    const doing = options.find((o) => o.to === 'Doing')
    expect(doing).toBeDefined()
    expect(doing?.ready).toBe(false)
    expect(doing?.blockedBy).toMatch(/assignee/)
    expect(doing?.requires).toMatch(/assignee/)
  })

  it('marks a transition ready once its guard is satisfied', () => {
    const options = availableTransitions(
      TASK_LIFECYCLE,
      'Task',
      'Todo',
      ctx({ attributes: { assignee: 'user://bob' } }),
    )
    expect(options.find((o) => o.to === 'Doing')?.ready).toBe(true)
  })

  it('offers only the reopen edge from a terminal state', () => {
    // ADR-0012：终态不再等于封闭，但它唯一的出口是显式的重开。
    // 这条用例原本断言"什么都不返回"——放开重开时它红了，正是它该做的事
    const options = availableTransitions(TASK_LIFECYCLE, 'Task', 'Done', ctx())
    expect(options.map((o) => o.to)).toEqual(['Doing'])
  })

  it('collapses multiple paths to the same target into one entry', () => {
    const options = availableTransitions(TASK_LIFECYCLE, 'Task', 'Doing', ctx())
    const targets = options.map((o) => o.to)
    expect(new Set(targets).size).toBe(targets.length)
  })
})

/**
 * `allRelatedIn`（FR-DOM-007）。
 *
 * 这一组是**在集成测试没能抓住两个种下的缺陷之后补的**：
 *   - "邻居状态没装配 → 当作通过"：HTTP 路径上永远装配得好，那条分支走不到。
 *   - "只检查第一个邻居"：集成用例里未完成的那个恰好排在第一，
 *     于是 `slice(0, 1)` 照样红不了——**它通过靠的是顺序，不是逻辑**。
 * 直接对着守卫写，两个都能钉死。
 */
describe('allRelatedIn (FR-DOM-007)', () => {
  const guard: Guard = {
    kind: 'allRelatedIn',
    type: 'ships',
    direction: 'out',
    targetType: 'Task',
    states: ['Done', 'Cancelled'],
  }
  const withRelated = (refs: RelatedRef[]): GuardContext =>
    ctx({ related: new Map([['ships:out', refs]]) })

  it('passes when every related object is in an allowed state', () => {
    const result = evaluateGuard(
      guard,
      withRelated([
        { id: 'task_1', type: 'Task', status: 'Done' },
        { id: 'task_2', type: 'Task', status: 'Cancelled' },
      ]),
    )
    expect(result.ok).toBe(true)
  })

  it('fails on an offender in the LAST position', () => {
    // 位置很重要：只看第一个的实现在这条用例上必然红
    const result = evaluateGuard(
      guard,
      withRelated([
        { id: 'task_1', type: 'Task', status: 'Done' },
        { id: 'task_2', type: 'Task', status: 'Done' },
        { id: 'task_late', type: 'Task', status: 'Doing' },
      ]),
    )
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.reason).toContain('task_late')
  })

  it('names several offenders and says how many more there are', () => {
    const refs: RelatedRef[] = Array.from({ length: 6 }, (_, i) => ({
      id: `task_${i}`,
      type: 'Task',
      status: 'Doing',
    }))
    const result = evaluateGuard(guard, withRelated(refs))
    expect(result.ok === false && result.reason).toMatch(/and 3 more/)
  })

  it('passes on an empty set — a universal claim over nothing is true', () => {
    // 要"至少有一条"就另加一条 hasRelation。合成一个守卫的话，
    // 失败信息说不清到底是哪一件不满足
    expect(evaluateGuard(guard, withRelated([])).ok).toBe(true)
  })

  it('ignores related objects of another type', () => {
    const result = evaluateGuard(
      guard,
      withRelated([
        { id: 'task_1', type: 'Task', status: 'Done' },
        { id: 'note_1', type: 'Knowledge', status: 'Draft' },
      ]),
    )
    expect(result.ok).toBe(true)
  })

  it('FAILS when the statuses were never assembled', () => {
    // 这里返回"通过"会让不变量静默失效：发版守卫形同虚设，
    // 而且看起来一切正常。装配漏了必须是响的
    const result = evaluateGuard(guard, ctx())
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.reason).toMatch(/not assembled/)
  })
})

describe('entry actions', () => {
  it('stamps a timestamp without mutating the input', () => {
    const before = { title: 't' }
    const after = applyActions(before, [{ kind: 'stampNow', path: 'startedAt' }], new Date('2026-08-03T10:00:00Z'))
    expect(after['startedAt']).toBe('2026-08-03T10:00:00.000Z')
    expect(before).toEqual({ title: 't' })
  })

  it('clears an attribute', () => {
    const after = applyActions({ blockReason: 'waiting' }, [{ kind: 'clearAttribute', path: 'blockReason' }], new Date())
    expect(after).not.toHaveProperty('blockReason')
  })
})

describe('default lifecycles encode real constraints', () => {
  const registry = buildDefaultWorkflowRegistry()

  it('registers one lifecycle per entity type that declares one', () => {
    expect(registry.forEntityType('Task')?.id).toBe('task-default')
    expect(registry.forEntityType('Requirement')?.id).toBe('requirement-default')
    expect(registry.forEntityType('Nonexistent')).toBeNull()
  })

  it('will not let a requirement enter Planning without a decomposition', () => {
    const lifecycle = registry.forEntityType('Requirement')
    expect(lifecycle).not.toBeNull()
    expect(() =>
      resolveTransition(lifecycle!, 'Requirement', 'Approved', 'Planning', ctx()),
    ).toThrow(/implementedBy/)

    expect(() =>
      resolveTransition(
        lifecycle!,
        'Requirement',
        'Approved',
        'Planning',
        ctx({ outgoingRelationTypes: new Set(['implementedBy']) }),
      ),
    ).not.toThrow()
  })

  it('will not let knowledge be published without a source (FR-DOM-008)', () => {
    const lifecycle = registry.forEntityType('Knowledge')
    expect(() => resolveTransition(lifecycle!, 'Knowledge', 'Draft', 'Published', ctx())).toThrow(
      /derivedFrom/,
    )
  })

  it('requires approval capability to accept a decision', () => {
    const lifecycle = registry.forEntityType('Decision')
    const resolved = resolveTransition(
      lifecycle!,
      'Decision',
      'Proposed',
      'Accepted',
      ctx({ attributes: { chosen: 'B', rationale: 'because' } }),
    )
    expect(resolved.capability).toBe('Decision.Approve')
  })
})
