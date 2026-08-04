import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * `docs/prd-coverage.md` 的合计必须等于各行之和。
 *
 * 这条检查来自一次真实的算错：把 WF 从 7 改成 8 时，合计跟着 +1，
 * 但那一行其实还差一条 Must——**合计对不上各行，而没有任何东西会发现**。
 *
 * 这份文档存在的全部意义是"诚实地报进度"。一个会悄悄漂移的数字
 * 比没有这个数字更糟：它看起来经过了核对。
 *
 * 顺带核对每个模块的 **Must 条数**是不是真的等于 PRD 里 M 的数量。
 * 这一列原本是手数出来的，而"表里写 9 条、PRD 其实 11 条"这种错
 * 会让覆盖率显得比实际高，且永远不会有人发现。
 *
 *   node --experimental-strip-types tools/check-coverage-total.ts
 */

const DOC = 'docs/prd-coverage.md'
const PRD_DIR = 'docs/prd'

export type CoverageRow = { label: string; must: number; delivered: number }

export type CoverageCheck = {
  rows: CoverageRow[]
  /** 文档里写的合计 */
  stated: { must: number; delivered: number } | null
  /** 各行加出来的合计 */
  computed: { must: number; delivered: number }
  problems: string[]
}

export async function checkCoverage(path = DOC): Promise<CoverageCheck> {
  const lines = (await readFile(path, 'utf8')).split('\n')
  const rows: CoverageRow[] = []
  let stated: CoverageCheck['stated'] = null

  for (const line of lines) {
    if (!line.startsWith('|')) continue
    const cells = line.split('|').slice(1, -1).map((c) => c.trim())
    if (cells.length < 3) continue

    const label = cells[0] ?? ''
    // 合计行的数字用 **粗体** 包着，先剥掉
    const must = toInt(cells[1])
    const delivered = toInt(cells[2])
    if (must === null || delivered === null) continue

    if (label.includes('合计')) {
      stated = { must, delivered }
    } else {
      rows.push({ label, must, delivered })
    }
  }

  const computed = rows.reduce(
    (acc, r) => ({ must: acc.must + r.must, delivered: acc.delivered + r.delivered }),
    { must: 0, delivered: 0 },
  )

  const problems: string[] = []
  if (rows.length === 0) {
    // 表格结构变了而检查还在"通过"，是这类脚本最常见的坏法
    problems.push(`no module rows found in ${path}; has the table format changed?`)
  }
  if (stated === null) {
    problems.push(`no 合计 row found in ${path}`)
  } else {
    if (stated.must !== computed.must) {
      problems.push(`Must total says ${stated.must} but the rows add up to ${computed.must}`)
    }
    if (stated.delivered !== computed.delivered) {
      problems.push(
        `delivered total says ${stated.delivered} but the rows add up to ${computed.delivered}`,
      )
    }
  }
  const declared = await mustCountsFromPrd()
  for (const row of rows) {
    if (row.delivered > row.must) {
      problems.push(`${row.label}: delivered ${row.delivered} exceeds Must ${row.must}`)
    }
    // 行首形如「WF 工作流」「AGT Agent」，取第一个词当模块代号
    const code = (row.label.split(/\s+/)[0] ?? '').toUpperCase()
    const actual = declared.get(code)
    if (actual === undefined) {
      problems.push(`${row.label}: no FR-${code}-* requirements found in ${PRD_DIR}`)
    } else if (actual !== row.must) {
      problems.push(`${row.label}: table says ${row.must} Must but the PRD has ${actual}`)
    }
  }

  return { rows, stated, computed, problems }
}

/** 从 PRD 的需求表里数出每个模块的 Must 条数 */
async function mustCountsFromPrd(dir = PRD_DIR): Promise<Map<string, number>> {
  const counts = new Map<string, number>()
  const seen = new Set<string>()
  for (const name of await readdir(dir)) {
    if (!name.endsWith('.md')) continue
    for (const line of (await readFile(join(dir, name), 'utf8')).split('\n')) {
      const match = /^\|\s*(FR-([A-Z]+)-\d+)\s*\|(.*)$/.exec(line.trim())
      if (match === null) continue
      const id = match[1] ?? ''
      // 同一个编号在两处出现过的话，数出来的条数会翻倍
      if (seen.has(id)) continue
      seen.add(id)
      const cells = (match[3] ?? '').split('|').map((c) => c.trim())
      if (cells[1] !== 'M') continue
      const code = match[2] ?? ''
      counts.set(code, (counts.get(code) ?? 0) + 1)
    }
  }
  return counts
}

function toInt(cell: string | undefined): number | null {
  if (cell === undefined) return null
  const cleaned = cell.replace(/\*/g, '').trim()
  return /^\d+$/.test(cleaned) ? Number(cleaned) : null
}

const entry = process.argv[1]
if (entry !== undefined && import.meta.url.endsWith(entry.split('/').slice(-2).join('/'))) {
  const result = await checkCoverage()
  if (result.problems.length === 0) {
    console.log(
      `coverage totals check out: ${result.computed.delivered}/${result.computed.must} across ${result.rows.length} modules`,
    )
    process.exit(0)
  }
  console.error(`${DOC} does not add up:`)
  for (const problem of result.problems) console.error(`  ${problem}`)
  process.exit(1)
}
