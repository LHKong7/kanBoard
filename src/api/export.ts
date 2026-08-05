import type { Resource } from '../domain/resource/resource.ts'

/**
 * 把一批资源导成 CSV（FR-RES 的"数据带得走"那一面）。
 *
 * 放在 api 层而不是 domain：CSV 是一种**表示**，不是领域概念。
 * 领域层不该知道有人要拿它去开 Excel。
 */

/**
 * 一次导出最多多少条。
 *
 * 必须有上界：没有上界的导出等于给了任何人一个把整库拉进内存的按钮。
 * 5000 条是"一个人真的会去看"的量级——再多就该走离线导出，
 * 而那是另一件事，不该由一个同步请求假装完成。
 */
export const EXPORT_LIMIT = 5_000

/** 固定在前面的列。顺序写死，导出文件的列序不该随数据变 */
const FIXED_COLUMNS = [
  'id',
  'type',
  'status',
  'workspace',
  'project',
  'owner',
  'labels',
  'createdAt',
  'updatedAt',
] as const

export type ExportResult = {
  body: string
  contentType: string
  filename: string
  /** 命中上限被截断了。**必须报出去**，见下 */
  truncated: boolean
}

export function exportResources(
  resources: readonly Resource[],
  format: 'csv' | 'json',
  truncated: boolean,
): ExportResult {
  if (format === 'json') {
    return {
      // JSON 里把截断标记**放进内容**：一个少了一半数据却看起来完整的文件，
      // 会被当作全量拿去对账
      body: JSON.stringify({ items: resources, truncated, limit: EXPORT_LIMIT }, null, 2),
      contentType: 'application/json; charset=utf-8',
      filename: 'projectos-export.json',
      truncated,
    }
  }

  // 属性列取这批数据的并集，排序后固定下来。
  // 按第一行的键取会让"某些行多出来的字段"整列消失
  const attributeKeys = [
    ...new Set(resources.flatMap((r) => Object.keys(r.attributes))),
  ].sort()

  const header = [...FIXED_COLUMNS, ...attributeKeys]
  const rows = resources.map((r) => [
    ...FIXED_COLUMNS.map((column) => fixedValue(r, column)),
    ...attributeKeys.map((key) => stringify(r.attributes[key])),
  ])

  return {
    // BOM 打头：没有它，Excel 会把 UTF-8 的中文读成乱码。
    // 这个系统的内容大半是中文，"导出来打不开"等于没有导出
    body: `﻿${[header, ...rows].map((cells) => cells.map(escapeCsv).join(',')).join('\r\n')}\r\n`,
    contentType: 'text/csv; charset=utf-8',
    filename: 'projectos-export.csv',
    truncated,
  }
}

function fixedValue(resource: Resource, column: (typeof FIXED_COLUMNS)[number]): string {
  switch (column) {
    case 'id':
      return resource.id
    case 'type':
      return resource.type
    case 'status':
      return resource.status
    case 'workspace':
      return resource.workspace
    case 'project':
      return resource.project ?? ''
    case 'owner':
      return resource.owner ?? ''
    case 'labels':
      return resource.labels.join(' ')
    case 'createdAt':
      return resource.createdAt.toISOString()
    case 'updatedAt':
      return resource.updatedAt.toISOString()
  }
}

function stringify(value: unknown): string {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return JSON.stringify(value)
}

/**
 * CSV 转义。
 *
 * 除了引号和换行，还挡一件表格软件特有的事：以 `=` `+` `-` `@` 开头的单元格
 * 会被 Excel / Sheets 当作**公式**执行（CSV 注入）。一条标题写成
 * `=HYPERLINK("http://evil","点我")` 的需求，导出后打开就是一个钓鱼链接。
 * 前面加一个单引号让它退回文本——这是表格软件认的写法。
 */
function escapeCsv(value: string): string {
  const guarded = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value
  if (/[",\r\n]/.test(guarded)) return `"${guarded.replaceAll('"', '""')}"`
  return guarded
}
