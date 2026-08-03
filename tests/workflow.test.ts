import { describe, expect, it } from 'vitest'
import {
  applyActions,
  availableTransitions,
  resolveTransition,
  WorkflowRegistry,
} from '../src/workflow/engine.ts'
import { buildDefaultWorkflowRegistry, TASK_LIFECYCLE } from '../src/workflow/defaults.ts'
import { evaluateGuard } from '../src/workflow/guards.ts'
import { TransitionError } from '../src/platform/errors.ts'
import type { GuardContext } from '../src/workflow/types.ts'

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

describe('lifecycle registration rejects self-contradictory definitions', () => {
  it('rejects an initial state that is not declared', () => {
    const registry = new WorkflowRegistry()
    expect(() =>
      registry.register({
        id: 'x',
        entityType: 'X',
        initial: 'Nowhere',
        states: [{ name: 'Start' }],
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
        states: [{ name: 'A' }],
        transitions: [{ from: ['A'], to: 'B' }],
      }),
    ).toThrow(/transition to unknown state "B"/)
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
        states: [{ name: 'A' }, { name: 'Done', terminal: true }],
        transitions: [
          { from: ['A'], to: 'Done' },
          { from: ['Done'], to: 'A' },
        ],
      }),
    ).toThrow(/marked terminal but has an outgoing transition/)
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

  it('returns nothing from a terminal state', () => {
    expect(availableTransitions(TASK_LIFECYCLE, 'Task', 'Done', ctx())).toEqual([])
  })

  it('collapses multiple paths to the same target into one entry', () => {
    const options = availableTransitions(TASK_LIFECYCLE, 'Task', 'Doing', ctx())
    const targets = options.map((o) => o.to)
    expect(new Set(targets).size).toBe(targets.length)
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
