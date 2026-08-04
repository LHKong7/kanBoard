import { DomainError } from '../../platform/errors.ts'
import type { CallInput, Connector, ConnectorSpec } from '../../domain/connector/types.ts'
import type { CiStatus, CiVerdict } from '../../domain/execution/ci.ts'

/**
 * GitHub Connector（FR-CON-006：PR / Commit / Review / CI）。
 *
 * 验收标准是「**可创建 PR、读取 CI 状态并回写 Task**」——三件具体的事，
 * 不是"接通 GitHub"。所以这个适配器只暴露这三件事需要的操作，
 * 而不是把 GitHub 的 API 面铺开：一个 Connector 声明了什么，
 * 就等于授权了什么，而这份声明是给 Agent 用的。
 *
 * **白名单的单位是 repo，不是 host。**
 * 按 host 白名单的话，"允许访问 api.github.com" 等于允许它动这个账号下的
 * 每一个仓库——这不是任何人想批准的那件事。`allowedTargets` 里写的是
 * `owner/repo`，网关按字面比对（`isAllowed` 对非 URL 的 target 就是字面比）。
 *
 * 凭据由网关注入 `secret`，用完即弃。这里**不缓存、不写日志、不放进返回值**：
 * 一个 GitHub token 泄进 Agent 上下文，等于把整个账号交出去。
 */

export type GitHubConnectorOptions = {
  /** 允许操作的仓库，形如 `owner/repo`。**空数组表示一个都不允许** */
  allowedRepos: readonly string[]
  /**
   * API 根地址。做成可注入是为了让测试指向本地服务器——
   * 请求构造对不对（方法、路径、头、报文）是可以离线钉死的，
   * 而它恰恰是最容易写错、又最难从错误信息里看出来的部分。
   */
  baseUrl?: string
  timeoutMs?: number
}

const DEFAULT_BASE_URL = 'https://api.github.com'
const DEFAULT_TIMEOUT_MS = 15_000

/** GitHub 要求显式声明 API 版本，否则将来它换默认值时我们会静默地跟着换 */
const API_VERSION = '2022-11-28'

export function githubConnectorSpec(options: GitHubConnectorOptions): ConnectorSpec {
  return {
    id: 'github',
    title: 'GitHub',
    allowedTargets: options.allowedRepos,
    credentialRef: 'github.token',
    operations: [
      {
        name: 'createPullRequest',
        // action 而不是 write：PR 是**对外可见**的。发错了不是回滚一条记录，
        // 是一屋子人收到了通知。默认要人确认正是为这种事准备的
        kind: 'action',
        description: '创建一个 Pull Request',
        returns: 'internal',
      },
      {
        name: 'readChecks',
        kind: 'read',
        description: '读取某个 commit 的 CI 状态',
        returns: 'internal',
      },
      {
        name: 'readPullRequest',
        kind: 'read',
        description: '读取一个 PR 的当前状态',
        returns: 'internal',
      },
      {
        name: 'comment',
        kind: 'write',
        description: '在 PR / Issue 下留言',
        returns: 'internal',
      },
    ],
    // GitHub 的次级限流（secondary rate limit）对写操作尤其敏感，
    // 触发之后会封一段时间，所以这里给的比默认值保守
    limits: { perMinute: 30, maxRetries: 2, breakAfterFailures: 5, breakForMs: 60_000 },
  }
}

/** GitHub 的 workflow run。只声明我们真的读的字段 */
type WorkflowRun = {
  id: number
  name?: string
  head_sha: string
  status: string
  conclusion: string | null
  html_url?: string
  run_number?: number
  updated_at?: string
}

/**
 * 把一批 workflow run 归并成一个结论。
 *
 * 归并规则写成纯函数并导出，是因为它是**判断**而不是传输：
 * "有一个失败就算失败"是一条可以被指着讨论、可以被单独测试的决定。
 * 埋在 fetch 后面的话，改动它的人不会知道自己在改什么。
 */
export function summarizeRuns(sha: string, runs: readonly WorkflowRun[]): CiStatus {
  const failing: { name: string; url: string }[] = []
  let pending = false

  for (const run of runs) {
    if (run.status !== 'completed') {
      pending = true
      continue
    }
    // success / neutral / skipped 之外一律算失败。
    // 白名单而不是黑名单：GitHub 将来加一种结论时，
    // 未知的那种会被当成失败——**误报比漏报安全**
    if (run.conclusion !== null && !['success', 'neutral', 'skipped'].includes(run.conclusion)) {
      failing.push({ name: run.name ?? `run ${run.id}`, url: run.html_url ?? '' })
    }
  }

  // 失败优先于在跑：还有一个在跑，但已经有一个红了，结论就是红的。
  // 反过来的话，一个总有任务在排队的仓库永远等不到"失败"
  const verdict: CiVerdict = failing.length > 0 ? 'failing' : pending ? 'pending' : 'passing'
  return { sha, verdict, failing, total: runs.length }
}

export class GitHubConnector implements Connector {
  readonly spec: ConnectorSpec
  readonly #baseUrl: string
  readonly #timeoutMs: number

  constructor(options: GitHubConnectorOptions) {
    this.spec = githubConnectorSpec(options)
    this.#baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '')
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  async execute(input: CallInput, secret: string | null, signal?: AbortSignal): Promise<unknown> {
    // **老实说：这一条现在是冗余的**——把它删掉，全部用例照样绿（试过）。
    // 已经取消的信号传给 fetch，fetch 自己就会立刻拒绝，
    // 而下面的 catch 会把它翻译成同一个 `cancelled`。
    //
    // 留着是因为它管的是**顺序**：没有它，一次已被取消、且 repo 名还写错了的
    // 调用会先报 `validation_failed`。取消是调用方已经知道的事实，
    // 参数错是它还不知道的——先报后者会让人去查一个已经不重要的问题。
    if (signal?.aborted === true) {
      throw new DomainError('cancelled', 'github call cancelled before starting', 499)
    }
    // target 就是 `owner/repo`。网关已经比对过白名单，这里只做形状校验：
    // 让一个畸形的 target 拼进 URL 会得到一个 404，而 404 的错误信息
    // 说的是"没找到"，不是"你传的 repo 名不对"
    const repo = assertRepo(input.target)

    switch (input.operation) {
      case 'createPullRequest':
        return await this.#send(
          'POST',
          `/repos/${repo}/pulls`,
          {
            title: required(input, 'title'),
            head: required(input, 'head'),
            base: required(input, 'base'),
            body: str(input.params['body']) ?? '',
            draft: input.params['draft'] === true,
          },
          secret,
          signal,
        )

      case 'readChecks': {
        const sha = required(input, 'sha')
        // 按 head_sha 过滤而不是拉全部再筛：一个活跃仓库的 runs 列表
        // 很快就会翻页，而"我关心的那个 commit"永远在越来越后面
        const body = (await this.#send(
          'GET',
          `/repos/${repo}/actions/runs?head_sha=${encodeURIComponent(sha)}&per_page=100`,
          null,
          secret,
          signal,
        )) as { workflow_runs?: WorkflowRun[] }
        return summarizeRuns(sha, body.workflow_runs ?? [])
      }

      case 'readPullRequest': {
        const number = required(input, 'number')
        const pr = (await this.#send('GET', `/repos/${repo}/pulls/${number}`, null, secret, signal)) as
          Record<string, unknown>
        // 只取用得上的字段。整个 PR 对象带着提交者邮箱、完整 diff 统计、
        // 一串 URL——那些进 Agent 上下文既没用又有代价
        return {
          number: pr['number'],
          title: pr['title'],
          state: pr['state'],
          merged: pr['merged'] === true,
          draft: pr['draft'] === true,
          headSha: (pr['head'] as Record<string, unknown> | undefined)?.['sha'],
          url: pr['html_url'],
        }
      }

      case 'comment':
        return await this.#send(
          'POST',
          // PR 的评论走 issues 端点——GitHub 的 PR 就是一种 issue。
          // 这一条不写下来的话，下一个人会去找 /pulls/{n}/comments，
          // 而那个端点是**行级 review 评论**，不是这里要的
          `/repos/${repo}/issues/${required(input, 'number')}/comments`,
          { body: required(input, 'body') },
          secret,
          signal,
        )

      default:
        throw new DomainError('not_found', `unknown github operation: ${input.operation}`, 404)
    }
  }

  async #send(
    method: string,
    path: string,
    body: unknown,
    secret: string | null,
    signal?: AbortSignal,
  ): Promise<unknown> {
    // 自己的超时 + 调用方的取消信号合并成一个。
    // 只用调用方的信号的话，一个不回话的 GitHub 会把 Agent 挂到天荒地老；
    // 只用自己的超时，取消就传不进来（FR-ARCH-011 要求 5 秒内停）
    const timeout = AbortSignal.timeout(this.#timeoutMs)
    const merged = signal === undefined ? timeout : AbortSignal.any([signal, timeout])

    const headers: Record<string, string> = {
      accept: 'application/vnd.github+json',
      'x-github-api-version': API_VERSION,
      'user-agent': 'projectos',
    }
    // 没有凭据也发得出去（公开仓库的读操作），但不要凭空造一个空 token：
    // `Bearer ` 后面跟空串会得到 401，而 401 会被当成"凭据错了"去查配置
    if (secret !== null && secret !== '') headers['authorization'] = `Bearer ${secret}`
    if (body !== null) headers['content-type'] = 'application/json'

    let response: Response
    try {
      response = await fetch(`${this.#baseUrl}${path}`, {
        method,
        headers,
        ...(body === null ? {} : { body: JSON.stringify(body) }),
        signal: merged,
      })
    } catch (error) {
      if (signal?.aborted === true) {
        throw new DomainError('cancelled', 'github call was cancelled', 499)
      }
      throw new DomainError('unavailable', `github request failed: ${reason(error)}`, 503)
    }

    const text = await response.text()
    if (!response.ok) {
      // 把 GitHub 的错误**原样**带出来，但不带响应头——
      // 头里有 rate-limit 信息也有可能有别的，而返回值会进审计
      throw new DomainError(
        response.status === 404 ? 'not_found' : response.status >= 500 ? 'bad_gateway' : 'forbidden',
        `github ${method} ${path} → ${response.status}`,
        response.status >= 500 ? 502 : response.status,
        { body: text.slice(0, 500) },
      )
    }
    if (text === '') return {}
    try {
      return JSON.parse(text)
    } catch {
      throw new DomainError('bad_gateway', `github returned a non-JSON body for ${path}`, 502)
    }
  }
}

/** `owner/repo`，两段，不含斜杠以外的路径分隔 */
function assertRepo(target: string): string {
  if (!/^[\w.-]+\/[\w.-]+$/.test(target)) {
    throw new DomainError('validation_failed', `target must be "owner/repo", got "${target}"`, 422, {
      field: 'target',
    })
  }
  return target
}

function required(input: CallInput, field: string): string {
  const value = str(input.params[field])
  if (value === undefined || value === '') {
    throw new DomainError('validation_failed', `${input.operation} requires "${field}"`, 422, { field })
  }
  return value
}

function str(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (typeof value === 'number') return String(value)
  return undefined
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
