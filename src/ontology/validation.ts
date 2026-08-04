import { z } from 'zod'
import { MAX_LENGTH_BY_KIND } from './types.ts'
import type { AttributeType, EntityTypeDef } from './types.ts'

/**
 * 本体 → Zod schema 的生成管道。
 *
 * 这是 ADR-0007 的核心理由之一：TS 类型在运行期不存在，所有边界必须运行期校验。
 * 与其手写校验器（会和本体漂移），不如由本体直接生成——本体是唯一真源。
 * 同一份定义将来也用于生成前端渲染元数据。
 */

function schemaForAttribute(attr: AttributeType): z.ZodTypeAny {
  let base: z.ZodTypeAny

  // 长度上限一律取本体上声明的那个（注册时已按 kind 补成具体数字）。
  // 校验器**不再自己拍一个数**：那个数客户端看不到，只能靠被拒绝来试探边界
  // （docs/dogfooding-log.md #7）。
  const maxLength = attr.maxLength ?? MAX_LENGTH_BY_KIND[attr.kind]

  switch (attr.kind) {
    case 'string':
    case 'text':
    case 'richtext':
      base = maxLength === undefined ? z.string() : z.string().max(maxLength)
      break
    case 'int':
      base = z.number().int()
      break
    case 'float':
      base = z.number()
      break
    case 'percent':
      base = z.number().min(0).max(100)
      break
    case 'bool':
      base = z.boolean()
      break
    case 'datetime':
      base = z.string().datetime()
      break
    case 'enum': {
      const values = attr.values ?? []
      if (values.length === 0) {
        throw new Error(`ontology error: enum attribute "${attr.name}" declares no values`)
      }
      base = z.enum(values as [string, ...string[]])
      break
    }
    case 'ref':
      // 引用只校验形状；目标存在性由仓储层在写入时检查（跨行约束不适合放在 schema 里）
      base = z.string().regex(/^[a-z][a-z0-9]*_[0-9A-HJKMNP-TV-Z]{26}$/, 'invalid resource id')
      break
    case 'json':
      // 此前完全没有上限，唯一的边界是 4MB 请求体。按序列化后的长度约束：
      // json 属性没有天然的"字符数"，但它一样会把一条记录撑爆
      base =
        maxLength === undefined
          ? z.unknown()
          : z.unknown().refine(
              (v) => v === undefined || JSON.stringify(v ?? null).length <= maxLength,
              { message: `serialized JSON must be at most ${maxLength} characters` },
            )
      break
    default: {
      const exhaustive: never = attr.kind
      throw new Error(`unhandled attribute kind: ${String(exhaustive)}`)
    }
  }

  return attr.required === true ? base : base.optional()
}

/**
 * 由 EntityType 生成 attributes 的校验器。
 *
 * `strict()` 是刻意的：写入本体中不存在的字段会被拒绝，而不是静默存下来。
 * 允许未知字段等于允许绕过本体（违反 ADR-0001 的 P1.3）。
 */
export function attributesSchema(def: EntityTypeDef): z.ZodTypeAny {
  const shape: Record<string, z.ZodTypeAny> = {}
  for (const attr of def.attributes) {
    shape[attr.name] = schemaForAttribute(attr)
  }
  return z.object(shape).strict()
}

export type FieldError = {
  path: string
  message: string
}

/** 把 Zod 的错误压平成字段级错误列表（FR-ONT-002 要求返回字段级原因） */
export function toFieldErrors(error: z.ZodError): FieldError[] {
  return error.issues.map((issue) => ({
    path: issue.path.length > 0 ? issue.path.join('.') : '(root)',
    message: issue.message,
  }))
}
