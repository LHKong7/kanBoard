import { describe, expect, it } from 'vitest'
import { EXPORT_LIMIT, exportResources } from '../src/api/export.ts'
import type { Resource } from '../src/domain/resource/resource.ts'

/**
 * 导出（CSV / JSON）。
 *
 * 导出的失败模式很特别：它**不会报错**。一个列错位、中文乱码、
 * 或者少了一半数据的文件，看起来和正常文件一模一样，
 * 而收到它的人会拿去对账。
 */

const resource = (over: Partial<Resource> = {}): Resource =>
  ({
    id: 'task_1',
    type: 'Task',
    status: 'Doing',
    tenant: 't',
    workspace: 'ws',
    project: 'proj_1',
    owner: 'user://alice',
    labels: ['urgent', 'backend'],
    attributes: { title: '导出账单' },
    version: 1,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-02T00:00:00Z'),
    deletedAt: null,
    ...over,
  }) as Resource

const csv = (items: Resource[], truncated = false) =>
  exportResources(items, 'csv', truncated).body

describe('CSV comes out openable', () => {
  it('leads with a BOM so Excel does not mangle Chinese', () => {
    // 这个系统的内容大半是中文。"导出来打不开"等于没有导出
    expect(csv([resource()]).startsWith('﻿')).toBe(true)
  })

  it('puts the fixed columns first, in a fixed order', () => {
    const header = csv([resource()]).split('\r\n')[0]
    expect(header).toContain('id,type,status,workspace,project,owner,labels,createdAt,updatedAt')
  })

  it('carries the values', () => {
    const row = csv([resource()]).split('\r\n')[1] ?? ''
    expect(row).toContain('task_1')
    expect(row).toContain('Doing')
    expect(row).toContain('导出账单')
    // 标签压成一格，空格分隔——逗号会把它切成多列
    expect(row).toContain('urgent backend')
  })
})

describe('the columns are the union, not the first row', () => {
  it('keeps a field that only some rows have', () => {
    // 按第一行的键取列，会让"某些行多出来的字段"整列消失——
    // 而消失的那一列不会有任何提示
    const body = csv([
      resource({ attributes: { title: 'a' } }),
      resource({ id: 'task_2', attributes: { title: 'b', blockReason: '等接口' } }),
    ])
    expect(body.split('\r\n')[0]).toContain('blockReason')
    expect(body).toContain('等接口')
  })

  it('sorts attribute columns so the file does not reshuffle between exports', () => {
    const header = csv([resource({ attributes: { zeta: 1, alpha: 2 } })]).split('\r\n')[0] ?? ''
    expect(header.indexOf('alpha')).toBeLessThan(header.indexOf('zeta'))
  })
})

describe('escaping', () => {
  it('quotes a value containing a comma', () => {
    expect(csv([resource({ attributes: { title: 'a,b' } })])).toContain('"a,b"')
  })

  it('doubles embedded quotes', () => {
    expect(csv([resource({ attributes: { title: 'say "hi"' } })])).toContain('"say ""hi"""')
  })

  it('quotes a value containing a newline', () => {
    expect(csv([resource({ attributes: { title: 'a\nb' } })])).toContain('"a\nb"')
  })

  it('defuses a formula so the spreadsheet does not execute it', () => {
    // 一条标题写成 =HYPERLINK("http://evil","点我") 的需求，
    // 导出后打开就是一个可点的钓鱼链接
    const body = csv([resource({ attributes: { title: '=HYPERLINK("http://evil","点我")' } })])
    expect(body).toContain("'=HYPERLINK")
  })

  it.each(['=cmd', '+1', '-1', '@SUM(A1)'])('defuses %s', (value) => {
    expect(csv([resource({ attributes: { title: value } })])).toContain(`'${value}`)
  })
})

describe('JSON keeps the truncation where a program can see it', () => {
  it('says so in the payload', () => {
    // 一个少了一半数据却看起来完整的文件，会被当作全量拿去对账
    const parsed = JSON.parse(exportResources([resource()], 'json', true).body)
    expect(parsed.truncated).toBe(true)
    expect(parsed.limit).toBe(EXPORT_LIMIT)
    expect(parsed.items).toHaveLength(1)
  })

  it('reports not-truncated when everything fit', () => {
    expect(JSON.parse(exportResources([resource()], 'json', false).body).truncated).toBe(false)
  })
})

describe('empty results still produce a valid file', () => {
  it('emits just a header rather than an empty file', () => {
    // 零字节的文件看起来像"下载失败"，而不是"没有匹配的数据"
    const body = csv([])
    expect(body).toContain('id,type,status')
    expect(body.split('\r\n').filter((l) => l !== '')).toHaveLength(1)
  })
})
