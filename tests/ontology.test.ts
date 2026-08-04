import { describe, expect, it } from 'vitest'
import { OntologyRegistry } from '../src/ontology/registry.ts'
import { buildDefaultRegistry } from '../src/ontology/defaults.ts'
import { MAX_LENGTH_BY_KIND } from '../src/ontology/types.ts'
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

/**
 * 长度上限长在本体上（docs/dogfooding-log.md #7）。
 *
 * 上限一直都存在，只是藏在校验器里：客户端无从知道多长会被拒，
 * 只能各自猜一个数去截断，猜得不一样，同一份内容就以不同方式被截断。
 * 这组用例锁的是**它可被发现**，而不只是**它被执行**。
 */
describe('attribute length bounds are part of the ontology (dogfooding #7)', () => {
  it('resolves a concrete maxLength for every text-ish attribute', () => {
    const registry = buildDefaultRegistry()
    const textish = new Set(['string', 'text', 'richtext', 'json'])

    for (const type of registry.entityTypes()) {
      for (const attr of type.attributes) {
        if (!textish.has(attr.kind)) continue
        expect(
          typeof attr.maxLength,
          `${type.name}.${attr.name} (${attr.kind}) 没有可用的 maxLength`,
        ).toBe('number')
      }
    }
  })

  it('separates a paragraph from a document', () => {
    // 此前 text 与 richtext 共用 1,000,000：一个「阻塞原因」能写一兆字节
    // 不是用法，是缺陷
    const registry = buildDefaultRegistry()
    const attrOf = (type: string, name: string) =>
      registry.entityType(type).attributes.find((a) => a.name === name)

    expect(attrOf('Task', 'blockReason')?.maxLength).toBe(MAX_LENGTH_BY_KIND.text)
    expect(attrOf('Knowledge', 'body')?.maxLength).toBe(MAX_LENGTH_BY_KIND.richtext)
    expect(MAX_LENGTH_BY_KIND.text).toBeLessThan(MAX_LENGTH_BY_KIND.richtext as number)
  })

  it('lets an attribute override the default for its kind', () => {
    const registry = new OntologyRegistry()
    registry.registerEntity({
      name: 'Note',
      version: '1.0.0',
      context: 'Knowledge',
      attributes: [{ name: 'blurb', kind: 'text', maxLength: 40 }],
    })
    expect(registry.entityType('Note').attributes[0]?.maxLength).toBe(40)
    expect(() => registry.validateAttributes('Note', { blurb: 'x'.repeat(41) })).toThrow()
    expect(registry.validateAttributes('Note', { blurb: 'x'.repeat(40) })).toEqual({
      blurb: 'x'.repeat(40),
    })
  })

  it('enforces the very bound it publishes', () => {
    // 声明一个数、按另一个数校验，比不声明更糟
    const registry = buildDefaultRegistry()
    const limit = registry.entityType('Task').attributes.find((a) => a.name === 'blockReason')
      ?.maxLength as number

    expect(() =>
      registry.validateAttributes('Task', { title: 't', blockReason: 'x'.repeat(limit + 1) }),
    ).toThrow(/ontology validation/)
    expect(
      registry.validateAttributes('Task', { title: 't', blockReason: 'x'.repeat(limit) }),
    ).toBeTruthy()
  })

  it('bounds json by serialized length, which was previously unbounded', () => {
    const registry = buildDefaultRegistry()
    const limit = registry.entityType('Agent').attributes.find((a) => a.name === 'capabilities')
      ?.maxLength as number
    expect(limit).toBe(MAX_LENGTH_BY_KIND.json)

    const tooBig = ['x'.repeat(limit)]
    expect(() =>
      registry.validateAttributes('Agent', {
        name: 'a',
        principal: 'agent://a@1.0.0',
        capabilities: tooBig,
      }),
    ).toThrow()
  })
})
