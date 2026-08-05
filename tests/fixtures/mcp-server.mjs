/**
 * 一个**真实的** MCP server，走 stdio 的 JSON-RPC 2.0。
 *
 * 它是测试夹具，但不是桩：连接器那边跑的是完整的协议往返——
 * initialize、tools/list、tools/call，逐行分帧。
 * 换成一个假的 transport 的话，分帧、id 匹配、错误映射这几处
 * 恰恰是最容易错而又完全测不到的。
 */
import { createInterface } from 'node:readline'

const TOOLS = [
  {
    name: 'search_docs',
    description: '检索文档',
    annotations: { readOnlyHint: true },
  },
  {
    name: 'write_file',
    description: '写文件',
    // 刻意不声明 readOnlyHint：连接器应当把它当作 action
  },
  {
    name: 'delete_everything',
    description: '删除一切',
    annotations: { destructiveHint: true },
  },
]

const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`)

createInterface({ input: process.stdin }).on('line', (line) => {
  if (line.trim() === '') return
  let req
  try {
    req = JSON.parse(line)
  } catch {
    return
  }
  const { id, method, params } = req

  if (method === 'initialize') {
    send({ jsonrpc: '2.0', id, result: { protocolVersion: '2024-11-05', capabilities: {} } })
    // 顺带往 stdout 打一条通知：连接器必须能跳过非回复的消息
    send({ jsonrpc: '2.0', method: 'notifications/initialized' })
    return
  }
  if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools: TOOLS } })
    return
  }
  if (method === 'tools/call') {
    const name = params?.name
    if (name === 'search_docs') {
      send({
        jsonrpc: '2.0',
        id,
        result: { content: [{ type: 'text', text: `找到了：${params?.arguments?.q ?? ''}` }] },
      })
      return
    }
    if (name === 'write_file') {
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'written' }] } })
      return
    }
    if (name === 'failing_tool') {
      // MCP 用 isError 表示工具自己失败了，而不是协议失败
      send({ jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text: '磁盘满了' }] } })
      return
    }
    send({ jsonrpc: '2.0', id, error: { code: -32602, message: `unknown tool: ${name}` } })
    return
  }
  send({ jsonrpc: '2.0', id, error: { code: -32601, message: `unknown method: ${method}` } })
})
