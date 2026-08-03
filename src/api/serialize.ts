import type { Resource } from '../domain/resource/resource.ts'

/**
 * 领域对象 → 线上表示。
 *
 * 领域层用 `Date`，线上一律 ISO 8601 字符串。
 * 这层转换刻意显式：让 JSON.stringify 隐式处理 Date 的话，
 * 领域层某天换成别的时间类型就会静默改变 API 契约。
 */
export type WireResource = Omit<Resource, 'createdAt' | 'updatedAt' | 'deletedAt'> & {
  createdAt: string
  updatedAt: string
  deletedAt: string | null
}

export function toWire(resource: Resource): WireResource {
  return {
    ...resource,
    createdAt: resource.createdAt.toISOString(),
    updatedAt: resource.updatedAt.toISOString(),
    deletedAt: resource.deletedAt === null ? null : resource.deletedAt.toISOString(),
  }
}
