import { DomainError } from '../../platform/errors.ts'
import type { ExternalRecord } from '../../domain/migration/sync.ts'

/**
 * Jira 适配器（FR-CON-007：双向同步与并行运行）。
 *
 * 三阶段迁移与对账在 `src/domain/migration/sync.ts`——那一层不认识 Jira。
 * 这一层只做一件事：**把 Jira 的 issue 翻译成同步引擎认识的形状，
 * 并且在翻译不过去的时候说出来。**
 *
 * ⚠️ **这个文件的成色和 GitHub 那个不一样，必须说清楚。**
 * GitHub 连接器的响应报文是从本仓库真实的 CI 抓下来的；这里没有 Jira 实例，
 * 也没有办法抓一份真的报文，所以下面的字段形状来自文档而不是实测。
 * 也就是说：**翻译规则本身经过完整验证，"Jira 真的长这样吗"没有。**
 *
 * 迁移里丢数据几乎都不是丢在传输上，而是丢在这一层的三个地方：
 *
 *   ① 映射不到的字段被**默默扔掉**（自定义字段是重灾区）
 *   ② 映射不到的状态被**猜**成一个近似值
 *   ③ 分页少读了一页，而调用方看到的是"同步成功"
 *
 * 所以这三处全部倒向"停下来报错"，而不是"尽力而为"。
 * 迁移工具最危险的性质就是"尽力而为"：它会成功，而且看起来对。
 */

/** Jira issue 里我们读的部分 */
export type JiraIssue = {
  id: string
  key: string
  fields: Record<string, unknown>
}

export type JiraSearchResponse = {
  issues?: JiraIssue[]
  startAt?: number
  maxResults?: number
  total?: number
}

/**
 * 字段映射表。
 *
 * 写成显式的一张表而不是"同名就搬过来"：同名映射看着省事，
 * 代价是**改名等于丢字段**，而且丢得没有痕迹。
 */
export type FieldMapping = {
  /** Jira 的字段名（含 `customfield_10011` 这种） */
  from: string
  /** ProjectOS 这边的属性名 */
  to: string
  /** 值的翻译。不给就原样搬 */
  translate?: (value: unknown) => unknown
}

export type StatusMapping = Record<string, string>

export type JiraSourceOptions = {
  fields: readonly FieldMapping[]
  status: StatusMapping
  /**
   * 明确声明**不迁移**的 Jira 字段。
   *
   * 有这一份的意义是：没列进 `fields` 也没列进这里的字段会让翻译**失败**。
   * 「不迁移」于是成为一个要有人写下来的决定，而不是一次遗漏的默认结果。
   */
  ignore?: readonly string[]
}

/** 翻译不过去的东西。**空数组表示真的没有**，不是"没查" */
export type TranslationProblem = {
  key: string
  kind: 'unmapped-field' | 'unmapped-status'
  detail: string
}

export type TranslationResult = {
  records: readonly ExternalRecord[]
  /** 有一条就不该继续迁移。判断留给调用方，但**必须看得见** */
  problems: readonly TranslationProblem[]
}

/**
 * Jira 内部固定字段。它们不进 ProjectOS，也不该因此报"未映射"——
 * 但要写下来，而不是靠前缀猜。
 */
const JIRA_INTERNAL = new Set(['created', 'updated', 'lastViewed', 'workratio', 'watches', 'votes'])

export function translateIssues(
  issues: readonly JiraIssue[],
  options: JiraSourceOptions,
): TranslationResult {
  const ignore = new Set([...(options.ignore ?? []), ...JIRA_INTERNAL])
  const byFrom = new Map(options.fields.map((f) => [f.from, f]))
  const records: ExternalRecord[] = []
  const problems: TranslationProblem[] = []

  for (const issue of issues) {
    const fields: Record<string, unknown> = {}

    for (const [name, value] of Object.entries(issue.fields)) {
      if (name === 'status') continue // 单独处理
      const mapping = byFrom.get(name)
      if (mapping === undefined) {
        // 值是空的就不算丢——一个从没填过的自定义字段，
        // 迁移时报出来只会让人学会忽略这类报告
        if (ignore.has(name) || value === null || value === undefined) continue
        problems.push({
          key: issue.key,
          kind: 'unmapped-field',
          detail: `field "${name}" has a value but no mapping and is not in the ignore list`,
        })
        continue
      }
      fields[mapping.to] = mapping.translate === undefined ? value : mapping.translate(value)
    }

    const rawStatus = statusName(issue.fields['status'])
    if (rawStatus !== null) {
      const mapped = options.status[rawStatus]
      if (mapped === undefined) {
        // **不猜**。猜一个近似状态，迁移会成功，然后有人按着一块
        // 错的看板做决定——那比迁移失败糟得多
        problems.push({
          key: issue.key,
          kind: 'unmapped-status',
          detail: `Jira status "${rawStatus}" has no mapping`,
        })
      } else {
        fields['status'] = mapped
      }
    }

    records.push({
      externalId: issue.key,
      fields,
      updatedAt: parseDate(issue.fields['updated']),
    })
  }

  return { records, problems }
}

function statusName(value: unknown): string | null {
  if (typeof value === 'string') return value
  if (typeof value === 'object' && value !== null) {
    const name = (value as Record<string, unknown>)['name']
    if (typeof name === 'string') return name
  }
  return null
}

function parseDate(value: unknown): Date {
  if (typeof value === 'string') {
    const parsed = new Date(value)
    if (!Number.isNaN(parsed.getTime())) return parsed
  }
  // 读不出时间不是小事：同步靠它判断先后。给一个"现在"会让这条记录
  // 看起来刚改过，于是每次同步都把它当成变更推一遍
  return new Date(0)
}

/**
 * 把分页读完。
 *
 * `total` 和实际读到的条数**必须对上**，对不上就抛。
 * 这是"无数据丢失"在读取侧的那一半：少读一页不会有任何报错，
 * 后面的对账会把它报成"源系统里少了这些"——而那时人会去查 Jira，
 * 查的是一个根本没出问题的地方。
 */
export async function readAllPages(
  fetchPage: (startAt: number) => Promise<JiraSearchResponse>,
  options: { pageSize?: number; maxPages?: number } = {},
): Promise<JiraIssue[]> {
  const pageSize = options.pageSize ?? 100
  const maxPages = options.maxPages ?? 1000
  const all: JiraIssue[] = []
  let startAt = 0
  let total: number | null = null

  for (let page = 0; page < maxPages; page++) {
    const response = await fetchPage(startAt)
    const issues = response.issues ?? []
    if (total === null) total = response.total ?? null
    all.push(...issues)
    if (issues.length === 0) break
    startAt += issues.length
    if (total !== null && all.length >= total) break
    // 页大小不是我们说了算的，Jira 可能返回得更少
    if (issues.length < (response.maxResults ?? pageSize) && total === null) break
  }

  if (total !== null && all.length !== total) {
    throw new DomainError(
      'bad_gateway',
      `Jira reported ${total} issues but only ${all.length} were read; refusing to migrate a partial set`,
      502,
      { total, read: all.length },
    )
  }
  return all
}
