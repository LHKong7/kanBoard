import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Agent 运行时不得直接访问网络（FR-CON-002）。
 *
 * `pnpm lint:layers` 已经挡住了 `import http` / axios 这类**有 import 的**路径，
 * 但挡不住 `fetch(...)`——它是全局的，没有 import，
 * 依赖分析器根本看不见它。
 *
 * 这个缺口不能靠"记得别用"来补：绕过网关的一次调用会**静默地**
 * 失去审计、限流、脱敏，而且凭据可能被写进 prompt。
 * 所以补一条源码级检查，和分层校验一起进 CI。
 *
 *   node --experimental-strip-types tools/check-no-direct-network.ts
 *
 * 有命中就非零退出。要新增外部能力，写一个 Connector。
 */

/** 全局的网络入口。都是没有 import、因此依赖图看不见的 */
const FORBIDDEN = [
  { pattern: /\bfetch\s*\(/, what: 'fetch()' },
  { pattern: /\bXMLHttpRequest\b/, what: 'XMLHttpRequest' },
  { pattern: /\bWebSocket\s*\(/, what: 'WebSocket' },
  { pattern: /\bnavigator\.sendBeacon\b/, what: 'sendBeacon' },
]

/** 只查 Agent 运行时。别处（如 Connector 适配器本身）当然要能发请求 */
const GUARDED_DIRS = ['src/domain/agent']

export type Finding = { file: string; line: number; what: string; text: string }

async function walk(dir: string): Promise<string[]> {
  const out: string[] = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...(await walk(full)))
    else if (entry.name.endsWith('.ts')) out.push(full)
  }
  return out
}

export async function findDirectNetworkUse(dirs = GUARDED_DIRS): Promise<Finding[]> {
  const findings: Finding[] = []
  for (const dir of dirs) {
    for (const file of await walk(dir)) {
      const lines = (await readFile(file, 'utf8')).split('\n')
      lines.forEach((text, index) => {
        // 注释里提到 fetch 不算——这份文件自己就提了好几次
        const code = text.replace(/\/\/.*$/, '').replace(/^\s*\*.*$/, '')
        for (const { pattern, what } of FORBIDDEN) {
          if (pattern.test(code)) {
            findings.push({ file, line: index + 1, what, text: text.trim() })
          }
        }
      })
    }
  }
  return findings
}

const entry = process.argv[1]
if (entry !== undefined && import.meta.url.endsWith(entry.split('/').slice(-2).join('/'))) {
  const findings = await findDirectNetworkUse()
  if (findings.length === 0) {
    console.log(`no direct network use in ${GUARDED_DIRS.join(', ')}`)
    process.exit(0)
  }
  console.error('Agent runtime must reach external systems only through ConnectorGateway (FR-CON-002):')
  for (const f of findings) {
    console.error(`  ${f.file}:${f.line}  ${f.what}  ${f.text}`)
  }
  process.exit(1)
}
