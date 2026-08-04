import pg from 'pg'
import { buildDefaultRegistry } from '../src/ontology/defaults.ts'
import { ValidationError } from '../src/platform/errors.ts'

/**
 * 用当前本体去校验库里已有的每一行。
 *
 * 收紧一条约束（新增 `maxLength`、把可选改成必填、缩小枚举）到底是不是
 * 破坏性变更，取决于**现有数据有没有越界**——这件事只能查，不能猜。
 * `docs/prd/04-ontology.md` 的兼容矩阵把这条写成了规则，这个脚本是它的执行方式。
 *
 *   MIGRATE_DATABASE_URL=… node --experimental-strip-types tools/check-ontology-fit.ts
 *
 * 退出码非零表示有行通不过当前本体：要么放宽约束，要么写迁移把数据修好，
 * 要么按 major 版本处理。三条路都行，唯独不能不知道。
 */

type Row = {
  id: string
  type: string
  ontology_version: string
  attributes: Record<string, unknown>
}

export type Violation = {
  id: string
  type: string
  writtenUnder: string
  detail: string
}

export async function checkFit(connectionString: string): Promise<{
  checked: number
  violations: Violation[]
  unknownTypes: Map<string, number>
}> {
  const registry = buildDefaultRegistry()
  const client = new pg.Client({ connectionString })
  await client.connect()

  const violations: Violation[] = []
  const unknownTypes = new Map<string, number>()
  let checked = 0

  try {
    // 软删除的也要查：它们还能被恢复，恢复出来一个存不回去的对象没有意义
    const { rows } = await client.query<Row>(
      `SELECT id, type, ontology_version, attributes FROM resources ORDER BY id`,
    )

    for (const row of rows) {
      checked++
      if (!registry.hasEntityType(row.type)) {
        unknownTypes.set(row.type, (unknownTypes.get(row.type) ?? 0) + 1)
        continue
      }
      try {
        registry.validateAttributes(row.type, row.attributes)
      } catch (error) {
        violations.push({
          id: row.id,
          type: row.type,
          writtenUnder: row.ontology_version,
          // details 是 unknown（它装的东西每个错误类型都不一样），
          // 所以要先确认它真是个对象再取 fields，而不是假设它是
          detail: error instanceof ValidationError ? describe(error) : String(error),
        })
      }
    }
  } finally {
    await client.end()
  }

  return { checked, violations, unknownTypes }
}

const entry = process.argv[1]
if (entry !== undefined && import.meta.url.endsWith(entry.split('/').slice(-2).join('/'))) {
  const url = process.env['MIGRATE_DATABASE_URL'] ?? process.env['DATABASE_URL']
  if (url === undefined) {
    console.error('set MIGRATE_DATABASE_URL (or DATABASE_URL)')
    process.exit(1)
  }

  const { checked, violations, unknownTypes } = await checkFit(url)
  console.log(`checked ${checked.toLocaleString()} resource(s) against the current ontology`)

  for (const [type, n] of unknownTypes) {
    // 本体里已经没有这种类型了。不算越界，但一定要说出来
    console.warn(`  ! ${n} row(s) of unregistered type "${type}" were skipped`)
  }

  if (violations.length === 0) {
    console.log('  all rows satisfy the current ontology')
    process.exit(0)
  }

  console.error(`\n${violations.length} row(s) do NOT satisfy the current ontology:`)
  for (const v of violations.slice(0, 20)) {
    console.error(`  ${v.id} (${v.type}, written under ${v.writtenUnder}): ${v.detail}`)
  }
  if (violations.length > 20) console.error(`  … and ${violations.length - 20} more`)
  process.exit(1)
}

/** 校验失败时哪些字段不合规。取不到就退回错误消息本身 */
function describe(error: ValidationError): string {
  const details = error.details
  if (typeof details === 'object' && details !== null && 'fields' in details) {
    return JSON.stringify((details as { fields: unknown }).fields)
  }
  return error.message
}
