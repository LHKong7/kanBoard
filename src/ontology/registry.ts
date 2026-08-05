import type { z } from 'zod'
import { ValidationError } from '../platform/errors.ts'
import { attributesSchema, toFieldErrors } from './validation.ts'
import { MAX_LENGTH_BY_KIND } from './types.ts'
import type { EntityTypeDef, RelationTypeDef } from './types.ts'
import { compatibilityOf } from './compatibility.ts'

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
    const normalized = withResolvedMaxLength(def)
    this.#entities.set(def.name, normalized)
    // 提前构建 schema：本体定义里的错误（如 enum 没有取值）在注册时就暴露，而不是等到第一次写入
    this.#schemas.set(def.name, attributesSchema(normalized))
  }

  /**
   * 升级一个已注册的类型（FR-ONT-007）。
   *
   * 和 `registerEntity` 分开，是因为**升级和首次注册是两件事**：
   * 让 register 悄悄覆盖已有定义的话，一次拼错的类型名会安静地
   * 替换掉另一个类型的模式，而那要到第一次写入失败时才会被发现。
   *
   * minor / patch 升级要过兼容检查。不兼容就是 major——
   * 破坏性变更不是不允许，是要求它显式地表现在版本号上。
   */
  upgradeEntity(def: EntityTypeDef): void {
    const current = this.#entities.get(def.name)
    if (current === undefined) {
      throw new ValidationError(`cannot upgrade unregistered entity type: ${def.name}`, {
        known: [...this.#entities.keys()].sort(),
      })
    }
    assertSemver(def.name, def.version)
    assertUniqueAttributeNames(def)

    const verdict = compatibilityOf(current, def)
    if (!verdict.ok) {
      throw new ValidationError(
        `incompatible ${verdict.bump} upgrade of "${def.name}" (${current.version} → ${def.version})`,
        {
          entityType: def.name,
          bump: verdict.bump,
          // 逐条列出来。只说"不兼容"的话，人得自己逐属性比对
          fields: verdict.problems.map((p) => ({ path: p.attribute, message: p.reason })),
        },
      )
    }

    const normalized = withResolvedMaxLength(def)
    this.#entities.set(def.name, normalized)
    this.#schemas.set(def.name, attributesSchema(normalized))
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

/**
 * 把 `maxLength` 按 kind 补成具体数字。
 *
 * 在注册时补，而不是留给每个使用方各自去查默认表：
 * 校验器、`GET /v1/ontology/entity-types`、以及照本体渲染表单的前端，
 * 看到的必须是同一个数。默认规则一旦要在三个地方各实现一遍，
 * 迟早会有一处漂移，而漂移的表现是"这里能存那里存不下"——
 * 又一种没人报错的错。
 */
function withResolvedMaxLength(def: EntityTypeDef): EntityTypeDef {
  return {
    ...def,
    attributes: def.attributes.map((attr) => {
      const resolved = attr.maxLength ?? MAX_LENGTH_BY_KIND[attr.kind]
      return resolved === undefined ? attr : { ...attr, maxLength: resolved }
    }),
  }
}
