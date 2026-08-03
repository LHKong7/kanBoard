import type { z } from 'zod'
import { ValidationError } from '../platform/errors.ts'
import { attributesSchema, toFieldErrors } from './validation.ts'
import type { EntityTypeDef, RelationTypeDef } from './types.ts'

/**
 * Ontology Registry（FR-ONT-001）。
 *
 * 注册即生效：注册一个 EntityType 之后，它立刻可以通过统一 Resource API
 * 完成全生命周期操作，无需新增端点——这是 ADR-0002 的直接结果。
 */
export class OntologyRegistry {
  readonly #entities = new Map<string, EntityTypeDef>()
  readonly #relations = new Map<string, RelationTypeDef>()
  readonly #schemas = new Map<string, z.ZodTypeAny>()

  registerEntity(def: EntityTypeDef): void {
    if (this.#entities.has(def.name)) {
      throw new Error(`entity type already registered: ${def.name}`)
    }
    assertSemver(def.name, def.version)
    assertUniqueAttributeNames(def)
    this.#entities.set(def.name, def)
    // 提前构建 schema：本体定义里的错误（如 enum 没有取值）在注册时就暴露，而不是等到第一次写入
    this.#schemas.set(def.name, attributesSchema(def))
  }

  registerRelation(def: RelationTypeDef): void {
    if (this.#relations.has(def.name)) {
      throw new Error(`relation type already registered: ${def.name}`)
    }
    if (def.name === def.inverse) {
      throw new Error(`relation "${def.name}" cannot be its own inverse`)
    }
    this.#relations.set(def.name, def)
  }

  /**
   * 注册完成后的一致性检查。
   *
   * 分两阶段是必要的：关系的 domain/range 会引用尚未注册的实体类型，
   * 逆关系也可能后注册。全部注册完再统一校验。
   */
  seal(): void {
    for (const rel of this.#relations.values()) {
      for (const t of [...rel.domain, ...rel.range]) {
        if (!this.#entities.has(t)) {
          throw new Error(`relation "${rel.name}" references unknown entity type "${t}"`)
        }
      }
      const inverse = this.#relations.get(rel.inverse)
      if (inverse === undefined) {
        throw new Error(`relation "${rel.name}" declares inverse "${rel.inverse}" which is not registered`)
      }
      if (inverse.inverse !== rel.name) {
        throw new Error(
          `inverse mismatch: "${rel.name}".inverse = "${rel.inverse}", but "${inverse.name}".inverse = "${inverse.inverse}"`,
        )
      }
      // 逆关系的定义域/值域必须互换，否则双向查询语义不等价
      if (!sameSet(rel.domain, inverse.range) || !sameSet(rel.range, inverse.domain)) {
        throw new Error(
          `inverse domain/range mismatch between "${rel.name}" and "${inverse.name}"`,
        )
      }
    }
  }

  entityType(name: string): EntityTypeDef {
    const def = this.#entities.get(name)
    if (def === undefined) {
      throw new ValidationError(`unknown entity type: ${name}`, {
        known: [...this.#entities.keys()].sort(),
      })
    }
    return def
  }

  relationType(name: string): RelationTypeDef {
    const def = this.#relations.get(name)
    if (def === undefined) {
      throw new ValidationError(`unknown relation type: ${name}`, {
        known: [...this.#relations.keys()].sort(),
      })
    }
    return def
  }

  hasEntityType(name: string): boolean {
    return this.#entities.has(name)
  }

  entityTypes(): EntityTypeDef[] {
    return [...this.#entities.values()]
  }

  relationTypes(): RelationTypeDef[] {
    return [...this.#relations.values()]
  }

  /** 传递闭包关系可用于深度遍历（FR-ONT-004） */
  isTransitive(relationType: string): boolean {
    return this.relationType(relationType).transitive === true
  }

  /**
   * 校验 attributes（FR-ONT-002）。失败时抛出字段级错误。
   */
  validateAttributes(entityType: string, attributes: unknown): Record<string, unknown> {
    const schema = this.#schemas.get(entityType)
    if (schema === undefined) {
      throw new ValidationError(`unknown entity type: ${entityType}`)
    }
    const result = schema.safeParse(attributes ?? {})
    if (!result.success) {
      throw new ValidationError(`attributes failed ontology validation for ${entityType}`, {
        entityType,
        fields: toFieldErrors(result.error),
      })
    }
    return result.data as Record<string, unknown>
  }

  /**
   * 校验一条关系是否符合本体定义的定义域与值域（FR-ONT-002）。
   */
  validateRelation(relationType: string, fromType: string, toType: string): void {
    const def = this.relationType(relationType)
    if (!def.domain.includes(fromType)) {
      throw new ValidationError(
        `relation "${relationType}" cannot start from ${fromType}`,
        { allowed: def.domain },
      )
    }
    if (!def.range.includes(toType)) {
      throw new ValidationError(
        `relation "${relationType}" cannot point to ${toType}`,
        { allowed: def.range },
      )
    }
  }
}

function assertSemver(name: string, version: string): void {
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`entity type "${name}" has non-semver version: ${version}`)
  }
}

function assertUniqueAttributeNames(def: EntityTypeDef): void {
  const seen = new Set<string>()
  for (const attr of def.attributes) {
    if (seen.has(attr.name)) {
      throw new Error(`entity type "${def.name}" declares duplicate attribute "${attr.name}"`)
    }
    seen.add(attr.name)
  }
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  const setB = new Set(b)
  return a.every((x) => setB.has(x))
}
