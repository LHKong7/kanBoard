import { spawn } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { DomainError } from '../../platform/errors.ts'
import type {
  CallInput,
  Connector,
  ConnectorSpec,
  OperationSpec,
} from '../../domain/connector/types.ts'

/**
 * MCP Connector（FR-CON-008：接入任意 MCP Server 作为 Tool）。
 *
 * MCP 是 JSON-RPC 2.0，这里走 stdio。协议本身很小，所以不引第三方 SDK：
 * 一个只用到 initialize / tools/list / tools/call 的客户端，
 * 自己写比引一个会带着自己的版本节奏和依赖树的库更容易说清楚。
 *
 * **"任意 MCP Server"这句话的代价要说明白。** 一个 MCP server 是别人写的代码，
 * 它声明的工具可能做任何事。所以这里的默认全部倒向保守一侧：
 *
 *   - 工具**不是**默认可用的：`allowedTools` 没列出来的一个都调不了
 *   - 工具**不是**默认只读的：没有显式声明 readOnlyHint 的一律当作 action，
 *     于是走人工确认（FR-CON-010 的那条闸）
 *   - 返回内容按 `confidential` 处理，进 Agent 上下文前由网关脱敏
 *
 * 反过来设的话，接一个新 server 就等于把它声明的一切直接授权给 Agent，
 * 而那份声明来自系统外面。
 */

/** MCP 工具声明里我们用到的部分 */
export type McpTool = {
  name: string
  description?: string
  annotations?: {
    /** 明确声明只读。**没有这个字段就不是只读** */
    readOnlyHint?: boolean
    destructiveHint?: boolean
  }
}

export type McpConnectorOptions = {
  /** 连接器 id，用于能力名 `Connector.<id>.<tool>` */
  id: string
  title: string
  /** 怎么把 server 拉起来。stdio 传输 */
  command: string
  args?: readonly string[]
  /**
   * 允许调用的工具名。**空数组表示一个都不允许**，不是"不限制"。
   * 这一份就是网关的 `allowedTargets`
   */
  allowedTools: readonly string[]
  /** 请求超时。一个不回话的 server 不该把 Agent 挂住 */
  timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 15_000

type RpcResponse = {
  id?: number
  result?: unknown
  error?: { code: number; message: string }
}

/**
 * 一个已连接的 MCP server。
 *
 * 用异步工厂而不是构造函数：工具清单要**先问过 server 才知道**，
 * 而 ConnectorSpec 必须在网关看到它之前就是完整的。
 * 构造函数里没法 await，硬塞会得到一个"有时候还没准备好"的连接器。
 */
export class McpConnector implements Connector {
  readonly spec: ConnectorSpec
  readonly #options: McpConnectorOptions
  readonly #child: ChildProcessWithoutNullStreams
  readonly #pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  #nextId = 1
  #buffer = ''
  #closed = false

  private constructor(
    options: McpConnectorOptions,
    child: ChildProcessWithoutNullStreams,
    tools: readonly McpTool[],
  ) {
    this.#options = options
    this.#child = child
    this.spec = specFor(options, tools)
    child.on('exit', () => {
      this.#closed = true
      // server 死了要把在等的调用都叫醒。不叫的话它们会一直挂到超时，
      // 而超时的错误信息说的是"慢"，不是"进程没了"
      for (const [, p] of this.#pending) p.reject(new Error('mcp server exited'))
      this.#pending.clear()
    })
  }

  static async connect(options: McpConnectorOptions): Promise<McpConnector> {
    const child = spawn(options.command, [...(options.args ?? [])], {
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const placeholder = new McpConnector(options, child, [])
    child.stdout.on('data', (chunk: Buffer) => placeholder.#onData(chunk))

    await placeholder.#request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'projectos', version: '1.0.0' },
    })
    const listed = (await placeholder.#request('tools/list', {})) as { tools?: McpTool[] }
    const tools = listed.tools ?? []

    // 清单拿到之后才有完整的 spec。把它装回去，不再暴露那个空壳
    const connector = new McpConnector(options, child, tools)
    child.stdout.removeAllListeners('data')
    child.stdout.on('data', (chunk: Buffer) => connector.#onData(chunk))
    return connector
  }

  /** server 声明了哪些工具。用于运维排查"为什么这个工具调不到" */
  get discovered(): readonly OperationSpec[] {
    return this.spec.operations
  }

  async execute(input: CallInput, _secret: string | null, signal?: AbortSignal): Promise<unknown> {
    if (signal?.aborted === true) {
      throw new DomainError('cancelled', 'mcp call cancelled before starting', 499)
    }
    if (this.#closed) {
      throw new DomainError('unavailable', `mcp server "${this.#options.id}" is not running`, 503)
    }
    const result = (await this.#request('tools/call', {
      name: input.operation,
      arguments: input.params,
    })) as { content?: unknown; isError?: boolean }

    // MCP 用 `isError` 表示工具**自己**失败了（而不是协议失败）。
    // 当成成功返回的话，Agent 会把一段错误信息当作结果继续推理
    if (result.isError === true) {
      throw new DomainError('bad_gateway', `mcp tool "${input.operation}" reported an error`, 502, {
        content: result.content,
      })
    }
    return result.content ?? result
  }

  async close(): Promise<void> {
    this.#closed = true
    this.#child.kill()
  }

  #onData(chunk: Buffer): void {
    this.#buffer += chunk.toString('utf8')
    // 按行分帧。JSON-RPC over stdio 一行一条消息
    for (;;) {
      const nl = this.#buffer.indexOf('\n')
      if (nl < 0) break
      const line = this.#buffer.slice(0, nl).trim()
      this.#buffer = this.#buffer.slice(nl + 1)
      if (line === '') continue
      let message: RpcResponse
      try {
        message = JSON.parse(line) as RpcResponse
      } catch {
        // 一行读不懂就跳过这一行，而不是把整条连接判死：
        // server 往 stdout 打一句日志不该让所有在途调用一起失败
        continue
      }
      if (message.id === undefined) continue // 通知，不是回复
      const pending = this.#pending.get(message.id)
      if (pending === undefined) continue
      this.#pending.delete(message.id)
      if (message.error !== undefined) {
        pending.reject(new Error(`mcp error ${message.error.code}: ${message.error.message}`))
      } else {
        pending.resolve(message.result ?? {})
      }
    }
  }

  #request(method: string, params: unknown): Promise<unknown> {
    const id = this.#nextId++
    const payload = `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        reject(new Error(`mcp request "${method}" timed out`))
      }, this.#options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
      // unref：一个在等的超时定时器不该让进程退不出去
      timer.unref?.()

      this.#pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer)
          resolve(v)
        },
        reject: (e) => {
          clearTimeout(timer)
          reject(e)
        },
      })
      this.#child.stdin.write(payload)
    })
  }
}

/**
 * 把 MCP 的工具清单翻译成 ConnectorSpec。
 *
 * 两条保守规则写在这里，是因为它们是**翻译规则**而不是运行期判断：
 * 看一眼这个函数就能回答"接一个陌生 server 会得到什么"。
 */
function specFor(options: McpConnectorOptions, tools: readonly McpTool[]): ConnectorSpec {
  return {
    id: options.id,
    title: options.title,
    // 白名单就是允许的工具名。target 不是 URL，网关按字面比对
    allowedTargets: options.allowedTools,
    operations: tools.map((tool) => ({
      name: tool.name,
      // **没有显式声明只读就当作 action**。反过来的话，
      // 一个 server 只要不声明就能拿到"不需要人工确认"的待遇，
      // 而那份声明来自系统外面
      kind: tool.annotations?.readOnlyHint === true ? ('read' as const) : ('action' as const),
      description: tool.description ?? `MCP tool ${tool.name}`,
      // 外部 server 返回的内容可能包含任何东西
      returns: 'confidential' as const,
    })),
    limits: { perMinute: 60, maxRetries: 1, breakAfterFailures: 5, breakForMs: 30_000 },
  }
}
