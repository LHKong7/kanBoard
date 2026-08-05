import { describe, expect, it } from 'vitest'
import { readAllPages, translateIssues } from '../src/infrastructure/connectors/jira.ts'
import type { JiraIssue, JiraSourceOptions } from '../src/infrastructure/connectors/jira.ts'

/**
 * Jira 翻译层（FR-CON-007）。
 *
 * 迁移里丢数据几乎都不是丢在传输上，而是丢在**翻译**和**分页**上，
 * 而且丢得没有痕迹：工具会成功，报告会显示"已迁移 N 条"。
 * 所以这一组考的全是"该失败的时候有没有失败"。
 *
 * ⚠️ 成色说明：这里没有 Jira 实例，报文形状来自文档而不是实测
 * （GitHub 那组用的是从本仓库 CI 真抓下来的报文，两者不是一个成色）。
 * **翻译规则本身验到位了，"Jira 真的长这样吗"没有。**
 */

const options: JiraSourceOptions = {
  fields: [
    { from: 'summary', to: 'title' },
    { from: 'description', to: 'description' },
    { from: 'customfield_10011', to: 'estimate', translate: (v) => Number(v) },
  ],
  status: { 'To Do': 'Todo', 'In Progress': 'Doing', Done: 'Done' },
  ignore: ['reporter', 'project'],
}

const issue = (fields: Record<string, unknown>, key = 'PROJ-1'): JiraIssue => ({
  id: '10001',
  key,
  fields: { updated: '2026-01-02T00:00:00.000+0000', ...fields },
})

describe('translating a Jira issue', () => {
  it('maps the fields it was told about', () => {
    const { records, problems } = translateIssues(
      [issue({ summary: '导出账单', status: { name: 'In Progress' } })],
      options,
    )
    expect(problems).toEqual([])
    expect(records[0]).toMatchObject({
      externalId: 'PROJ-1',
      fields: { title: '导出账单', status: 'Doing' },
    })
  })

  it('runs the value translation, so a Jira string becomes a number here', () => {
    const { records } = translateIssues([issue({ summary: 's', customfield_10011: '5' })], options)
    expect(records[0]?.fields['estimate']).toBe(5)
  })

  it('reads the updated timestamp — sync ordering depends on it', () => {
    const { records } = translateIssues([issue({ summary: 's' })], options)
    expect(records[0]?.updatedAt.toISOString()).toBe('2026-01-02T00:00:00.000Z')
  })

  it('does not pretend an unreadable timestamp is "now"', () => {
    // 给"现在"会让这条记录看起来刚改过，于是每次同步都把它当成变更推一遍
    const { records } = translateIssues([{ id: '1', key: 'P-1', fields: { summary: 's', updated: '???' } }], options)
    expect(records[0]?.updatedAt.getTime()).toBe(0)
  })
})

describe('nothing is dropped quietly (FR-CON-007「无数据丢失」)', () => {
  it('refuses to silently drop a populated custom field', () => {
    // 自定义字段是迁移丢数据的重灾区，而且丢了没有痕迹
    const { problems } = translateIssues(
      [issue({ summary: 's', customfield_99999: '客户承诺的上线日期' })],
      options,
    )
    expect(problems).toHaveLength(1)
    expect(problems[0]).toMatchObject({ key: 'PROJ-1', kind: 'unmapped-field' })
    expect(problems[0]?.detail).toContain('customfield_99999')
  })

  it('says which issue the problem is on, not just that there was one', () => {
    const { problems } = translateIssues(
      [issue({ summary: 'a' }, 'PROJ-1'), issue({ summary: 'b', weird: 'x' }, 'PROJ-7')],
      options,
    )
    expect(problems.map((p) => p.key)).toEqual(['PROJ-7'])
  })

  it('does not cry about a field that was never filled in', () => {
    // 报出来只会让人学会忽略这类报告
    const { problems } = translateIssues([issue({ summary: 's', customfield_99999: null })], options)
    expect(problems).toEqual([])
  })

  it('lets "we are not migrating this" be an explicit decision', () => {
    // reporter 在 ignore 里。没有 ignore 名单的话，
    // "不迁移"就成了一次遗漏的默认结果，而不是有人写下来的决定
    const { problems } = translateIssues([issue({ summary: 's', reporter: { name: 'bob' } })], options)
    expect(problems).toEqual([])
  })

  it('treats an unmapped status as a problem instead of guessing', () => {
    // 猜一个近似状态，迁移会成功，然后有人按着一块错的看板做决定
    const { records, problems } = translateIssues(
      [issue({ summary: 's', status: { name: 'Awaiting Deployment' } })],
      options,
    )
    expect(problems[0]).toMatchObject({ kind: 'unmapped-status' })
    expect(problems[0]?.detail).toContain('Awaiting Deployment')
    // 而且**不写一个错的状态进去**
    expect(records[0]?.fields['status']).toBeUndefined()
  })

  it('still returns the record so the report covers the whole set', () => {
    // 遇到问题就中断的话，人只能一条一条修、一次一次重跑
    const { records, problems } = translateIssues(
      [issue({ summary: 'a', bad: 1 }, 'P-1'), issue({ summary: 'b', bad: 2 }, 'P-2')],
      options,
    )
    expect(records).toHaveLength(2)
    expect(problems).toHaveLength(2)
  })
})

describe('pagination cannot silently truncate (FR-CON-007)', () => {
  const page = (keys: string[], total: number, maxResults = 2) => ({
    issues: keys.map((k) => issue({ summary: k }, k)),
    maxResults,
    total,
  })

  it('reads every page', async () => {
    const pages = [page(['A', 'B'], 3), page(['C'], 3)]
    const all = await readAllPages(async (startAt) => pages[startAt === 0 ? 0 : 1] ?? { issues: [] })
    expect(all.map((i) => i.key)).toEqual(['A', 'B', 'C'])
  })

  it('throws when the count does not match what Jira said it had', async () => {
    // 少读一页不会有任何报错。后面的对账会把它报成"源系统里少了这些"，
    // 而那时人会去查 Jira——查的是一个根本没出问题的地方
    await expect(
      readAllPages(async (startAt) => (startAt === 0 ? page(['A', 'B'], 5) : { issues: [], total: 5 })),
    ).rejects.toThrow(/only 2 were read/)
  })

  it('refuses the partial set rather than returning it', async () => {
    // 返回一个"尽力而为"的结果是这类工具最危险的性质：它会成功，而且看起来对
    await expect(
      readAllPages(async () => ({ issues: [], total: 9 })),
    ).rejects.toThrow(/refusing to migrate a partial set/)
  })

  it('stops after a bounded number of pages even when every page looks new', async () => {
    // 重复检测挡的是"卡住的分页"，挡不住一个源源不断吐出**新** key 的源
    // （没有 total、页页都满）。那种情况下 maxPages 是最后一道闸——
    // 没有它，一次迁移会一直读到内存耗尽
    let calls = 0
    const all = await readAllPages(
      async () => {
        calls++
        return { issues: [issue({ summary: `s${calls}` }, `K-${calls}`)], maxResults: 1 }
      },
      { maxPages: 4 },
    )
    expect(calls).toBe(4)
    expect(all).toHaveLength(4)
  })

  it('refuses a source whose pagination never advances', async () => {
    // 每次都返回第一页的服务器，会让"条数对不对得上 total"那个检查
    // **顺利通过**——因为它累加到 total 条就停了，而那 total 条是
    // 同一条复制了 total 遍。迁移里"数据翻倍"和"数据丢失"一样糟，
    // 而且更难发现：对账会说一条不少。
    // 这条是把演练跑到真 HTTP 上之后才逼出来的
    let calls = 0
    await expect(
      readAllPages(
        async () => {
          calls++
          return page(['A'], 999, 1)
        },
        { maxPages: 5 },
      ),
    ).rejects.toThrow(/twice; pagination is not advancing/)
    // 第二页就发现了，不会真的翻满 5 次
    expect(calls).toBe(2)
  })
})
