import { describe, expect, it } from 'vitest'
import { OntologyRegistry } from '../src/ontology/registry.ts'
import { buildDefaultRegistry } from '../src/ontology/defaults.ts'
import { ValidationError } from '../src/platform/errors.ts'

describe('OntologyRegistry (FR-ONT-001/002/003)', () => {
  it('accepts a valid entity and validates its attributes', () => {
    const registry = buildDefaultRegistry()
    const attrs = registry.validateAttributes('Task', { title: 'ship M0', estimate: 3 })
    expect(attrs).toEqual({ title: 'ship M0', estimate: 3 })
  })

  it('rejects writes missing a required attribute, with a field-level reason', () => {
    const registry = buildDefaultRegistry()
    try {
      registry.validateAttributes('Task', { estimate: 3 })
      expect.unreachable('should have thrown')
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError)
      const details = (error as ValidationError).details as { fields: { path: string }[] }
      expect(details.fields.map((f) => f.path)).toContain('title')
    }
  })

  it('rejects attributes that are not declared in the ontology', () => {
    // 这是 ADR-0001 的 P1.3：API 不得暴露本体中不存在的字段语义。
    // 允许未知字段等于允许绕过本体，问题会在半年后以脏数据的形式回来。
    const registry = buildDefaultRegistry()
    expect(() => registry.validateAttributes('Task', { title: 'x', sneaky: 1 })).toThrow(
      ValidationError,
    )
  })

  it('rejects an enum value outside the declared set', () => {
    const registry = buildDefaultRegistry()
    expect(() =>
      registry.validateAttributes('Requirement', {
        title: 'x',
        level: 'Saga',
        statement: 'y',
      }),
    ).toThrow(ValidationError)
  })

  it('rejects an unknown entity type and lists what is known', () => {
    const registry = buildDefaultRegistry()
    try {
      registry.entityType('Wormhole')
      expect.unreachable('should have thrown')
    } catch (error) {
      const details = (error as ValidationError).details as { known: string[] }
      expect(details.known).toContain('Task')
    }
  })

  it('enforces relation domain and range', () => {
    const registry = buildDefaultRegistry()
    // Requirement --implementedBy--> Story 合法
    expect(() => registry.validateRelation('implementedBy', 'Requirement', 'Story')).not.toThrow()
    // Task --implementedBy--> Story 不合法：定义域不含 Task
    expect(() => registry.validateRelation('implementedBy', 'Task', 'Story')).toThrow(ValidationError)
    // Requirement --implementedBy--> Task 不合法：值域不含 Task
    expect(() => registry.validateRelation('implementedBy', 'Requirement', 'Task')).toThrow(
      ValidationError,
    )
  })

  it('requires every relation to declare a symmetric inverse', () => {
    const registry = new OntologyRegistry()
    registry.registerEntity({
      name: 'A',
      version: '1.0.0',
      context: 'Project',
      attributes: [],
    })
    registry.registerRelation({ name: 'likes', inverse: 'likedBy', domain: ['A'], range: ['A'] })
    // 只注册了一半：seal 必须拦住
    expect(() => registry.seal()).toThrow(/inverse "likedBy" which is not registered/)
  })

  it('rejects an inverse pair whose domain and range are not swapped', () => {
    const registry = new OntologyRegistry()
    for (const name of ['A', 'B', 'C']) {
      registry.registerEntity({ name, version: '1.0.0', context: 'Project', attributes: [] })
    }
    registry.registerRelation({ name: 'fwd', inverse: 'bwd', domain: ['A'], range: ['B'] })
    // bwd 的值域应该是 A，写成 C 就让双向查询语义不等价了
    registry.registerRelation({ name: 'bwd', inverse: 'fwd', domain: ['B'], range: ['C'] })
    expect(() => registry.seal()).toThrow(/domain\/range mismatch/)
  })

  it('rejects a relation whose domain references an unregistered entity type', () => {
    const registry = new OntologyRegistry()
    registry.registerEntity({ name: 'A', version: '1.0.0', context: 'Project', attributes: [] })
    registry.registerRelation({ name: 'r', inverse: 'ri', domain: ['A'], range: ['Ghost'] })
    registry.registerRelation({ name: 'ri', inverse: 'r', domain: ['Ghost'], range: ['A'] })
    expect(() => registry.seal()).toThrow(/unknown entity type "Ghost"/)
  })

  it('rejects a non-semver entity version', () => {
    const registry = new OntologyRegistry()
    expect(() =>
      registry.registerEntity({ name: 'A', version: '1.0', context: 'Project', attributes: [] }),
    ).toThrow(/non-semver/)
  })

  it('rejects duplicate attribute names', () => {
    const registry = new OntologyRegistry()
    expect(() =>
      registry.registerEntity({
        name: 'A',
        version: '1.0.0',
        context: 'Project',
        attributes: [
          { name: 'x', kind: 'string' },
          { name: 'x', kind: 'int' },
        ],
      }),
    ).toThrow(/duplicate attribute/)
  })

  it('surfaces a malformed enum at registration time, not at first write', () => {
    const registry = new OntologyRegistry()
    expect(() =>
      registry.registerEntity({
        name: 'A',
        version: '1.0.0',
        context: 'Project',
        attributes: [{ name: 'kind', kind: 'enum' }],
      }),
    ).toThrow(/declares no values/)
  })

  it('marks contains as transitive so it can be closed over', () => {
    const registry = buildDefaultRegistry()
    expect(registry.isTransitive('contains')).toBe(true)
    expect(registry.isTransitive('implementedBy')).toBe(false)
  })
})
