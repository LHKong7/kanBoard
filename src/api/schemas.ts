import { z } from 'zod'

/**
 * HTTP 边界的运行期校验（FR-ARCH-010）。
 *
 * TS 的类型在运行期不存在，请求体是 `unknown`。凡是从网络进来的东西
 * 都必须先过 Zod 才能进入领域层——这是 ADR-0007 换语言时明确接下的债。
 *
 * 注意这里只校验**信封**（envelope）：id、分页、关系方向这些。
 * `attributes` 的内容由本体校验（OntologyRegistry），不在这里重复定义，
 * 否则本体一改这里就漂移。
 */

export const resourceIdSchema = z
  .string()
  .regex(/^[a-z][a-z0-9]*_[0-9A-HJKMNP-TV-Z]{26}$/, 'invalid resource id')

export const visibilitySchema = z.enum(['private', 'project', 'workspace', 'tenant'])

export const createResourceSchema = z.object({
  type: z.string().min(1).max(64),
  workspace: z.string().min(1).max(64),
  project: resourceIdSchema.nullish(),
  owner: z.string().max(256).optional(),
  status: z.string().max(64).optional(),
  labels: z.array(z.string().max(64)).max(50).optional(),
  attributes: z.record(z.unknown()).optional(),
  visibility: visibilitySchema.optional(),
})

export const updateResourceSchema = z.object({
  expectedVersion: z.number().int().positive(),
  status: z.string().max(64).optional(),
  labels: z.array(z.string().max(64)).max(50).optional(),
  attributes: z.record(z.unknown()).optional(),
  visibility: visibilitySchema.optional(),
  owner: z.string().max(256).optional(),
  reason: z.string().max(2000).optional(),
})

export const querySchema = z.object({
  type: z.string().max(64).optional(),
  filter: z
    .object({
      workspace: z.string().max(64).optional(),
      project: resourceIdSchema.optional(),
      owner: z.string().max(256).optional(),
      status: z.array(z.string().max(64)).max(20).optional(),
      labels: z.array(z.string().max(64)).max(20).optional(),
      attributes: z.record(z.unknown()).optional(),
      includeDeleted: z.boolean().optional(),
    })
    .optional(),
  page: z
    .object({
      size: z.number().int().min(1).max(200).default(50),
      cursor: z.string().max(64).optional(),
    })
    .optional(),
})

export const relateSchema = z.object({
  type: z.string().min(1).max(64),
  toId: resourceIdSchema,
  confidence: z.number().min(0).max(1).optional(),
})

export const traverseSchema = z.object({
  start: resourceIdSchema,
  follow: z.array(z.string().min(1).max(64)).min(1).max(10),
  maxDepth: z.number().int().min(1).max(10).default(3),
  direction: z.enum(['out', 'in', 'both']).default('out'),
})

export const pathSchema = z.object({
  from: resourceIdSchema,
  to: resourceIdSchema,
  maxDepth: z.number().int().min(1).max(10).default(6),
})

export const relationDirectionSchema = z.enum(['out', 'in', 'both']).default('out')

export type CreateResourceBody = z.infer<typeof createResourceSchema>
export type UpdateResourceBody = z.infer<typeof updateResourceSchema>
export type QueryBody = z.infer<typeof querySchema>
export type RelateBody = z.infer<typeof relateSchema>
export type TraverseBody = z.infer<typeof traverseSchema>
export type PathBody = z.infer<typeof pathSchema>
