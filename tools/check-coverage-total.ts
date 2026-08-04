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
  const mustIds = await mustIdsFromPrd()
  const breakdown = deliveredFromBreakdown(lines, mustIds)
  for (const row of rows) {
    if (row.delivered > row.must) {
      problems.push(`${row.label}: delivered ${row.delivered} exceeds Must ${row.must}`)
    }
    // 行首形如「WF 工作流」「AGT Agent」，取第一个词当模块代号
    const code = (row.label.split(/\s+/)[0] ?? '').toUpperCase()
    const actual = mustIds.get(code)?.size
    if (actual === undefined) {
      problems.push(`${row.label}: no FR-${code}-* requirements found in ${PRD_DIR}`)
    } else if (actual !== row.must) {
      problems.push(`${row.label}: table says ${row.must} Must but the PRD has ${actual}`)
    }

    // 有细分表的行，数字必须和细分表对得上
    const counted = breakdown.get(code)
    if (counted !== undefined && counted.size !== row.delivered) {
      problems.push(
        `${row.label}: row says ${row.delivered} delivered but its breakdown marks ${counted.size} with ✅`,
      )
    }
  }

  return { rows, stated, computed, problems }
}

/** 从 PRD 的需求表里读出每个模块的 Must **编号集合** */
async function mustIdsFromPrd(dir = PRD_DIR): Promise<Map<string, Set<string>>> {
  const ids = new Map<string, Set<string>>()
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
      const set = ids.get(code) ?? new Set<string>()
      set.add(id)
      ids.set(code, set)
    }
  }
  return ids
}

/**
 * 从「## XXX 细分」小节里数出**被标为已交付的 Must 条数**。
 *
 * 存在的理由是一次真实的错：IAM 那一行写成 11，而它自己的细分表
 * 数出来是 12。原来的检查只比"合计 vs 各行"，看不见"某一行 vs 它自己的细分表"——
 * 于是一个自相矛盾的文档照样通过。
 *
 * 只数 PRD 里确实是 Must 的编号：细分表里也会列 Should，
 * 把它们算进来会让覆盖率虚高。
 */
function deliveredFromBreakdown(
  lines: readonly string[],
  mustIds: ReadonlyMap<string, Set<string>>,
): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>()
  for (const line of lines) {
    if (!line.startsWith('|')) continue
    const cells = line.split('|').slice(1, -1).map((c) => c.trim())
    if (cells.length < 2) continue
    // 状态列以 ✅ 开头才算交付。⚠️ 是"部分"，按这份文档的规矩不计入
    if (!(cells[1] ?? '').startsWith('✅')) continue
    for (const id of (cells[0] ?? '').matchAll(/FR-([A-Z]+)-(\d+)/g)) {
      const code = id[1] ?? ''
      const full = id[0]
      if (mustIds.get(code)?.has(full) !== true) continue
      const set = out.get(code) ?? new Set<string>()
      set.add(full)
      out.set(code, set)
    }
    // 「FR-IAM-001/002/003 …」这种连写：补上后面几个编号
    const first = /FR-([A-Z]+)-(\d+)((?:\/\d+)+)/.exec(cells[0] ?? '')
    if (first !== null) {
      const code = first[1] ?? ''
      for (const tail of (first[3] ?? '').split('/').filter(Boolean)) {
        const full = `FR-${code}-${tail}`
        if (mustIds.get(code)?.has(full) !== true) continue
        const set = out.get(code) ?? new Set<string>()
        set.add(full)
        out.set(code, set)
      }
    }
  }
  return out
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
