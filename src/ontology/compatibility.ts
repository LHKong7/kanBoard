import type { AttributeType, EntityTypeDef } from './types.ts'

/**
 * 本体版本化与兼容策略（FR-ONT-007）。
 *
 * 验收标准是「**升级 minor 版本后旧数据可正常读取**」。
 *
 * 在此之前，`version` 是一个只被校验了格式的字段——注册时检查它像不像
 * semver，然后就没有任何代码读它了。`EntityTypeDef.version` 的注释写着
 * 「实例写入时记录 ontologyVersion，读取旧实例时按兼容视图投影」，
 * 而那两件事都没有发生。**一个看起来配置好了、实际什么也不做的字段，
 * 比没有这个字段更糟**——这个项目已经在 `sla` 上栽过一次同样的跟头。
 *
 * 而且注册表压根**不允许升级**：`registerEntity` 对已存在的类型直接抛错。
 * 也就是说这条需求先前不是"做得不完整"，是"做不了"。
 *
 * 关键在于：旧数据能不能读，**不取决于读的时候做了什么，取决于升级的时候
 * 允许了什么**。读路径不做校验，所以旧行永远读得出来；真正会出事的是
 * 下一次**写**——如果 minor 升级偷偷加了一条必填属性，那么每一条旧数据
 * 在下次更新时都会被拒，而报出来的错是"缺少必填属性"，
 * 没有人会想到那是三个月前一次"兼容的"升级造成的。
 *
 * 所以这一层管的是**升级时拦住什么**，而不是读取时补救什么。
 */

export type Bump = 'major' | 'minor' | 'patch' | 'invalid'

export type CompatibilityProblem = {
  attribute: string
  reason: string
}

export type CompatibilityVerdict = {
  bump: Bump
  ok: boolean
  /** 具体是哪几条属性不兼容。**空数组表示真的没有**，不是"没查" */
  problems: readonly CompatibilityProblem[]
}

export function bumpOf(from: string, to: string): Bump {
  const a = from.split('.').map(Number)
  const b = to.split('.').map(Number)
  if (a.length !== 3 || b.length !== 3 || [...a, ...b].some(Number.isNaN)) return 'invalid'
  const [aMajor = 0, aMinor = 0, aPatch = 0] = a
  const [bMajor = 0, bMinor = 0, bPatch = 0] = b

  // 版本必须往前走。允许回退的话，"当前是哪一版"就不再有确定的答案
  if (bMajor < aMajor) return 'invalid'
  if (bMajor > aMajor) return 'major'
  if (bMinor < aMinor) return 'invalid'
  if (bMinor > aMinor) return 'minor'
  if (bPatch <= aPatch) return 'invalid'
  return 'patch'
}

/**
 * 这次升级兼不兼容。
 *
 * `major` 不做检查——**那正是 major 的含义**。破坏性变更不是不允许，
 * 是要求它显式地表现为一次 major 升级，于是"这次升级会不会弄坏旧数据"
 * 从代码评审里的一个问题变成版本号上的一个事实。
 */
export function compatibilityOf(from: EntityTypeDef, to: EntityTypeDef): CompatibilityVerdict {
  const bump = bumpOf(from.version, to.version)
  if (bump === 'invalid') {
    return {
      bump,
      ok: false,
      problems: [{ attribute: '(version)', reason: `${from.version} → ${to.version} is not a forward semver bump` }],
    }
  }
  if (bump === 'major') return { bump, ok: true, problems: [] }

  const before = new Map(from.attributes.map((a) => [a.name, a]))
  const after = new Map(to.attributes.map((a) => [a.name, a]))
  const problems: CompatibilityProblem[] = []

  for (const [name, old] of before) {
    const next = after.get(name)
    if (next === undefined) {
      // 删掉一条属性，旧数据里那个值就读不出来了——那就是丢数据
      problems.push({ attribute: name, reason: 'removed; existing values would become unreadable' })
      continue
    }
    problems.push(...changeProblems(name, old, next))
  }

  for (const [name, next] of after) {
    if (before.has(name)) continue
    if (next.required === true) {
      // 这是最隐蔽的一种：升级当时什么也不会发生，因为读路径不校验。
      // 直到某个人去改一条旧记录，才会撞上"缺少必填属性"
      problems.push({
        attribute: name,
        reason: 'added as required; every existing record would fail its next write',
      })
    }
  }

  // patch 不允许任何模式变化。放宽的话 patch 和 minor 就没有区别了，
  // 而"打个补丁版本"是唯一一种大家默认可以闭眼升的
  if (bump === 'patch' && problems.length === 0) {
    const added = [...after.keys()].filter((n) => !before.has(n))
    for (const name of added) {
      problems.push({ attribute: name, reason: 'a patch bump must not change the schema; use a minor bump' })
    }
  }

  return { bump, ok: problems.length === 0, problems }
}

/** 同名属性改动带来的问题 */
function changeProblems(name: string, old: AttributeType, next: AttributeType): CompatibilityProblem[] {
  const problems: CompatibilityProblem[] = []

  if (old.kind !== next.kind) {
    problems.push({ attribute: name, reason: `kind changed ${old.kind} → ${next.kind}` })
  }
  if (old.required !== true && next.required === true) {
    // 旧数据里这条可以是空的，改必填之后它们全都写不回去了
    problems.push({ attribute: name, reason: 'became required; existing records may not have a value' })
  }
  if (old.kind === 'enum' && next.kind === 'enum') {
    const kept = new Set(next.values ?? [])
    const dropped = (old.values ?? []).filter((v) => !kept.has(v))
    if (dropped.length > 0) {
      // 收窄枚举 = 存量里那些值变成非法值
      problems.push({ attribute: name, reason: `enum narrowed, dropping ${JSON.stringify(dropped)}` })
    }
  }
  const oldMax = old.maxLength
  const newMax = next.maxLength
  if (oldMax !== undefined && newMax !== undefined && newMax < oldMax) {
    // 存量里可能有比新上限更长的值
    problems.push({ attribute: name, reason: `maxLength shrank ${oldMax} → ${newMax}` })
  }
  return problems
}
