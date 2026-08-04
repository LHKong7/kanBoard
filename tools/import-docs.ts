import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * 把 `docs/` 迁进 ProjectOS。
 *
 * ADR-0011 决定先内部自用，而自用的第一步是把项目自己的需求与决策
 * 放进系统里。用真实文档而不是造数据——造出来的数据只会证明
 * 系统能处理我们为它设计的形状。
 *
 * 迁入的映射：
 *   docs/adr/*.md          → Decision
 *   docs/prd/*.md          → Knowledge
 *   PRD 里的 FR-* 表格行   → Requirement
 *   ADR 的「关联需求」     → Decision --explains--> Requirement
 */

const AUTH = {
  'content-type': 'application/json',
  'x-principal': 'user://alice',
  'x-tenant': 'default',
  'x-roles': 'Admin',
  'x-capabilities': '',
}

type Created = { id: string; version: number }

export type ImportSummary = {
  project: string
  requirements: Map<string, string>
  decisions: Map<string, string>
  knowledge: number
  relations: number
  /** 导入过程中被系统拒绝的条目：这些是真实的摩擦点，不该被吞掉 */
  rejected: Array<{ what: string; why: string }>
}

async function post(base: string, path: string, body: unknown): Promise<Created> {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: AUTH,
    body: JSON.stringify(body),
  })
  const text = await res.text()
  if (!res.ok) {
    const parsed = text === '' ? {} : JSON.parse(text)
    throw new Error(parsed.message ?? `HTTP ${res.status}`)
  }
  return JSON.parse(text) as Created
}

/** `# ADR-0007 · 服务端采用 TypeScript` → { number, title } */
function parseAdrHeading(markdown: string): { number: string; title: string } | null {
  const match = markdown.match(/^#\s*ADR-(\d{4})\s*·\s*(.+)$/m)
  if (match === null) return null
  return { number: match[1] ?? '', title: (match[2] ?? '').trim() }
}

/** 取元信息表里的一行，如「| 状态 | Accepted |」 */
function metaValue(markdown: string, key: string): string | null {
  const match = markdown.match(new RegExp(`^\\|\\s*${key}\\s*\\|\\s*(.+?)\\s*\\|`, 'm'))
  return match === null ? null : (match[1] ?? '').trim()
}

/** 取某个二级标题下的正文 */
function section(markdown: string, heading: string): string {
  const pattern = new RegExp(`^##\\s*${heading}[^\\n]*\\n([\\s\\S]*?)(?=^##\\s|\\Z)`, 'm')
  const match = markdown.match(pattern)
  return match === null ? '' : (match[1] ?? '').trim()
}

/** ADR 元信息里的「关联需求」列出的 FR / NFR 编号 */
function referencedRequirements(markdown: string): string[] {
  const raw = metaValue(markdown, '关联需求') ?? ''
  const ids = raw.match(/(FR|NFR)-[A-Z]+-\d{3}/g) ?? []
  return [...new Set(ids)]
}

/**
 * 从 PRD 的需求表里抽行。
 *
 * 形如：`| FR-ONT-001 | 提供 Ontology Registry… | M | 可通过 API 注册… |`
 * 已废弃的行（`~~FR-…~~`）跳过。
 */
function parseRequirementRows(markdown: string): Array<{
  id: string
  title: string
  priority: string | null
  acceptance: string
}> {
  const rows: Array<{ id: string; title: string; priority: string | null; acceptance: string }> = []
  const priorityMap: Record<string, string> = { M: 'Must', S: 'Should', C: 'Could', W: 'Wont' }

  for (const line of markdown.split('\n')) {
    const match = line.match(
      /^\|\s*((?:FR|NFR)-[A-Z]+-\d{3})\s*\|\s*(.+?)\s*\|\s*([MSCW])\s*\|\s*(.+?)\s*\|\s*$/,
    )
    if (match === null) continue
    rows.push({
      id: match[1] ?? '',
      title: stripMarkdown(match[2] ?? ''),
      priority: priorityMap[match[3] ?? ''] ?? null,
      acceptance: stripMarkdown(match[4] ?? ''),
    })
  }
  return rows
}

function stripMarkdown(text: string): string {
  return text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[*`~]/g, '')
    .trim()
}

export async function importDocs(base: string, docsDir: string): Promise<ImportSummary> {
  const summary: ImportSummary = {
    project: '',
    requirements: new Map(),
    decisions: new Map(),
    knowledge: 0,
    relations: 0,
    rejected: [],
  }

  const project = await post(base, '/v1/resources', {
    type: 'Project',
    workspace: 'ws_projectos',
    attributes: {
      key: 'PROJECTOS',
      name: 'ProjectOS',
      vision: 'AI Native Project Operating System —— 让项目、知识、数据与智能体在统一领域模型中演化',
      ownerTeam: 'platform',
    },
  })
  summary.project = project.id

  // ── PRD → Requirement + Knowledge ────────────────────────
  const prdDir = join(docsDir, 'prd')
  for (const file of (await readdir(prdDir)).filter((f) => f.endsWith('.md')).sort()) {
    const markdown = await readFile(join(prdDir, file), 'utf8')
    const title = (markdown.match(/^#\s*(.+)$/m)?.[1] ?? file).trim()

    for (const row of parseRequirementRows(markdown)) {
      try {
        const created = await post(base, '/v1/resources', {
          type: 'Requirement',
          workspace: 'ws_projectos',
          project: project.id,
          labels: [row.id.split('-')[1] ?? 'misc'],
          attributes: {
            title: `${row.id} ${row.title}`.slice(0, 1024),
            // 三级里 Story 是可执行的最小单元；FR 条目相当于 Feature
            level: 'Feature',
            statement: `验收标准：${row.acceptance}`,
            source: 'internal',
            ...(row.priority === null ? {} : { priority: row.priority }),
          },
        })
        summary.requirements.set(row.id, created.id)
        await post(base, `/v1/resources/${project.id}/relations`, {
          type: 'contains',
          toId: created.id,
        })
        summary.relations++
      } catch (error) {
        summary.rejected.push({ what: row.id, why: String((error as Error).message) })
      }
    }

    // 整篇文档作为一条知识。Knowledge 必须有来源关系才能发布，
    // 这里先留在 Draft——迁入的文档暂时没有可指向的来源对象
    try {
      const created = await post(base, '/v1/resources', {
        type: 'Knowledge',
        workspace: 'ws_projectos',
        project: project.id,
        labels: ['prd'],
        attributes: { title, body: markdown.slice(0, 200_000), confidence: 100 },
      })
      summary.knowledge++
      // 第一版漏了这条边，16 条知识就那么漂着，系统一声没吭
      // （docs/dogfooding-log.md #6）。`project` 字段只是个标量，
      // 不构成图上的边——要能从项目遍历到它，必须真的建关系。
      await post(base, `/v1/resources/${project.id}/relations`, {
        type: 'contains',
        toId: created.id,
      })
      summary.relations++
    } catch (error) {
      summary.rejected.push({ what: `Knowledge: ${title}`, why: String((error as Error).message) })
    }
  }

  // ── ADR → Decision，并连回它引用的需求 ────────────────────
  const adrDir = join(docsDir, 'adr')
  for (const file of (await readdir(adrDir)).filter((f) => /^\d{4}-/.test(f)).sort()) {
    const markdown = await readFile(join(adrDir, file), 'utf8')
    const heading = parseAdrHeading(markdown)
    if (heading === null) continue

    const status = metaValue(markdown, '状态') ?? 'Proposed'
    try {
      const created = await post(base, '/v1/resources', {
        type: 'Decision',
        workspace: 'ws_projectos',
        project: project.id,
        labels: ['adr'],
        attributes: {
          question: `ADR-${heading.number} ${heading.title}`,
          chosen: section(markdown, '决策').slice(0, 20_000) || heading.title,
          rationale: section(markdown, '背景').slice(0, 20_000) || '（未记录）',
          consequences: section(markdown, '后果').slice(0, 20_000),
        },
      })
      summary.decisions.set(heading.number, created.id)
      await post(base, `/v1/resources/${project.id}/relations`, {
        type: 'contains',
        toId: created.id,
      })
      summary.relations++

      // 决策接受了就推进状态。Superseded 的 ADR 也要如实反映
      const clean = status.replace(/[*~]/g, '').trim()
      if (clean.startsWith('Accepted') || clean.startsWith('Superseded')) {
        await post(base, `/v1/resources/${created.id}/transitions`, { to: 'Accepted' })
        if (clean.startsWith('Superseded')) {
          await post(base, `/v1/resources/${created.id}/transitions`, { to: 'Superseded' })
        }
      }

      // Decision --explains--> Requirement：PRD 承诺的可追溯链路，这里第一次真的建起来
      for (const requirementId of referencedRequirements(markdown)) {
        const target = summary.requirements.get(requirementId)
        if (target === undefined) continue
        try {
          await post(base, `/v1/resources/${created.id}/relations`, {
            type: 'explains',
            toId: target,
          })
          summary.relations++
        } catch (error) {
          summary.rejected.push({
            what: `ADR-${heading.number} explains ${requirementId}`,
            why: String((error as Error).message),
          })
        }
      }
    } catch (error) {
      summary.rejected.push({
        what: `ADR-${heading.number}`,
        why: String((error as Error).message),
      })
    }
  }

  return summary
}

const entry = process.argv[1]
if (entry !== undefined && import.meta.url.endsWith(entry.split('/').slice(-2).join('/'))) {
  const base = process.env['PROJECTOS_URL'] ?? 'http://127.0.0.1:3000'
  const docs = process.env['DOCS_DIR'] ?? 'docs'
  const summary = await importDocs(base, docs)

  console.log(`project     ${summary.project}`)
  console.log(`requirements ${summary.requirements.size}`)
  console.log(`decisions    ${summary.decisions.size}`)
  console.log(`knowledge    ${summary.knowledge}`)
  console.log(`relations    ${summary.relations}`)
  if (summary.rejected.length > 0) {
    console.log(`\n被拒绝 ${summary.rejected.length} 条：`)
    for (const item of summary.rejected.slice(0, 20)) {
      console.log(`  ${item.what}: ${item.why}`)
    }
  }
}
