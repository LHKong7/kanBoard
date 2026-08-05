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
  const seenKeys = new Set<string>()
  let startAt = 0
  let total: number | null = null

  for (let page = 0; page < maxPages; page++) {
    const response = await fetchPage(startAt)
    const issues = response.issues ?? []
    if (total === null) total = response.total ?? null

    // **同一条 issue 回来第二次，就说明分页没在推进。**
    // 这条是把演练跑到真 HTTP 上之后才逼出来的：一个忽略 startAt、
    // 每次都返回第一页的服务器，会让上面那个"条数对不对得上 total"的
    // 检查**顺利通过**——因为它累加到 total 条就停了，
    // 而那 total 条是同一条记录复制了 total 遍。
    //
    // 迁移里"数据翻倍"和"数据丢失"一样糟，而且更难发现：
    // 对账会说"一条不少"。
    for (const issue of issues) {
      if (seenKeys.has(issue.key)) {
        throw new DomainError(
          'bad_gateway',
          `Jira returned "${issue.key}" twice; pagination is not advancing (startAt=${startAt})`,
          502,
          { key: issue.key, startAt, read: all.length },
        )
      }
      seenKeys.add(issue.key)
    }

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

/**
 * 真的去 Jira 读写的 `SyncSource`（FR-CON-007）。
 *
 * 上面那些是翻译规则，这里是**真的发 HTTP**。分开是因为翻译规则
 * 离线就能完整验证，而这一层要的是一个在监听的端口——
 * 演练跑在这条路径上，而不是跑在一个内存里的假源上，
 * 差别在于分页、认证头、错误映射、字段裁剪这几段**只有走过才算数**。
 *
 * ⚠️ 报文形状来自 Jira 的公开文档，不是实测抓的
 * （GitHub 那个连接器用的是从本仓库 CI 真抓下来的报文，两者不是一个成色）。
 * 也就是说：**整条管线验到位了，"Jira 真的长这样吗"没有。**
 */
export type JiraSourceOptions2 = JiraSourceOptions & {
  /** 形如 `https://acme.atlassian.net` */
  baseUrl: string
  /** JQL，决定搬哪些。**必填**：默认搬全站是个能把人吓死的默认值 */
  jql: string
  /** 邮箱 + API token。Basic 认证，由网关注入，用完即弃 */
  auth?: { email: string; token: string }
  pageSize?: number
  timeoutMs?: number
}

export class JiraSource {
  readonly #options: JiraSourceOptions2
  /** 翻译时发现的问题。演练报告要读它 */
  readonly problems: TranslationProblem[] = []

  constructor(options: JiraSourceOptions2) {
    this.#options = options
  }

  async readAll(): Promise<readonly ExternalRecord[]> {
    const issues = await readAllPages(
      (startAt) => this.#searchPage(startAt),
      { pageSize: this.#options.pageSize ?? 50 },
    )
    const { records, problems } = translateIssues(issues, this.#options)
    // 累积而不是覆盖：一次演练会分阶段跑好几遍，
    // 每一遍的问题都该留在报告里
    this.problems.push(...problems)
    return records
  }

  async write(externalId: string, fields: Record<string, unknown>): Promise<void> {
    // 反向映射：ProjectOS 的属性名换回 Jira 的字段名。
    // 没有映射的字段**不回写**——往源系统里写一个它不认识的字段，
    // 轻则报错，重则被某个自定义字段悄悄接住
    const byTo = new Map(this.#options.fields.map((f) => [f.to, f.from]))
    const payload: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(fields)) {
      const jiraField = byTo.get(key)
      if (jiraField === undefined) continue
      payload[jiraField] = value
    }
    if (Object.keys(payload).length === 0) return
    await this.#send('PUT', `/rest/api/3/issue/${encodeURIComponent(externalId)}`, {
      fields: payload,
    })
  }

  async #searchPage(startAt: number): Promise<JiraSearchResponse> {
    const params = new URLSearchParams({
      jql: this.#options.jql,
      startAt: String(startAt),
      maxResults: String(this.#options.pageSize ?? 50),
      // 只取要用的字段。不限定的话每条 issue 会带回几十 KB，
      // 其中大部分是我们不映射、因此也不该看到的内容
      fields: [...this.#options.fields.map((f) => f.from), 'status', 'updated'].join(','),
    })
    return (await this.#send('GET', `/rest/api/3/search?${params.toString()}`, null)) as JiraSearchResponse
  }

  async #send(method: string, path: string, body: unknown): Promise<unknown> {
    const headers: Record<string, string> = { accept: 'application/json' }
    if (this.#options.auth !== undefined) {
      const { email, token } = this.#options.auth
      headers['authorization'] = `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`
    }
    if (body !== null) headers['content-type'] = 'application/json'

    let response: Response
    try {
      response = await fetch(`${this.#options.baseUrl.replace(/\/$/, '')}${path}`, {
        method,
        headers,
        ...(body === null ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(this.#options.timeoutMs ?? 20_000),
      })
    } catch (error) {
      throw new DomainError('unavailable', `jira request failed: ${reason(error)}`, 503)
    }

    const text = await response.text()
    if (!response.ok) {
      // 迁移期间 4xx 和 5xx 要分开：前者是我们发错了（JQL 写错、字段名不对），
      // 后者是对面不稳。混成一个错误的话，一次持续几小时的迁移
      // 会在两种完全不同的问题上给出同一句话
      throw new DomainError(
        response.status >= 500 ? 'bad_gateway' : 'invalid_request',
        `jira ${method} ${path.split('?')[0]} → ${response.status}`,
        response.status >= 500 ? 502 : response.status,
        { body: text.slice(0, 500) },
      )
    }
    if (text === '') return {}
    try {
      return JSON.parse(text)
    } catch {
      throw new DomainError('bad_gateway', 'jira returned a non-JSON body', 502)
    }
  }
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
