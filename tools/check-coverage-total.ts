import { readFile } from 'node:fs/promises'

/**
 * `docs/prd-coverage.md` 的合计必须等于各行之和。
 *
 * 这条检查来自一次真实的算错：把 WF 从 7 改成 8 时，合计跟着 +1，
 * 但那一行其实还差一条 Must——**合计对不上各行，而没有任何东西会发现**。
 *
 * 这份文档存在的全部意义是"诚实地报进度"。一个会悄悄漂移的数字
 * 比没有这个数字更糟：它看起来经过了核对。
 *
 *   node --experimental-strip-types tools/check-coverage-total.ts
 */

const DOC = 'docs/prd-coverage.md'

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
  for (const row of rows) {
    if (row.delivered > row.must) {
      problems.push(`${row.label}: delivered ${row.delivered} exceeds Must ${row.must}`)
    }
  }

  return { rows, stated, computed, problems }
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
