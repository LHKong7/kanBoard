import { describe, expect, it } from 'vitest'
import { bumpOf, compatibilityOf } from '../src/ontology/compatibility.ts'
import { OntologyRegistry } from '../src/ontology/registry.ts'
import type { EntityTypeDef } from '../src/ontology/types.ts'

/**
 * 本体版本化与兼容策略（FR-ONT-007）。
 *
 * 验收标准：**升级 minor 版本后旧数据可正常读取。**
 *
 * 这一条此前被记成已交付，而实际上 `version` 只被校验了格式——
 * 注册时看它像不像 semver，然后没有任何代码读它。注册表甚至**不允许升级**
 * （`registerEntity` 对已存在的类型直接抛错），也就是说这条需求先前不是
 * "做得不完整"，是"做不了"。
 *
 * 关键在于：旧数据能不能读，**不取决于读的时候做了什么，取决于升级的时候
 * 允许了什么**。读路径不校验，所以旧行永远读得出来；真正会出事的是下一次
 * **写**——一次偷偷加了必填属性的 minor 升级，会让每条旧数据在下次更新时
 * 被拒，而报出来的错是"缺少必填属性"，没人会想到那是三个月前一次
 * "兼容的"升级造成的。
 */

const v = (version: string, attributes: EntityTypeDef['attributes']): EntityTypeDef => ({
  name: 'Widget',
  version,
  context: 'Project',
  attributes,
})

const BASE = v('1.0.0', [
  { name: 'title', kind: 'string', required: true },
  { name: 'note', kind: 'text' },
  { name: 'level', kind: 'enum', values: ['low', 'high'] },
])

describe('reading the version number (FR-ONT-007)', () => {
  it('classifies the bump', () => {
    expect(bumpOf('1.0.0', '2.0.0')).toBe('major')
    expect(bumpOf('1.0.0', '1.1.0')).toBe('minor')
    expect(bumpOf('1.0.0', '1.0.1')).toBe('patch')
  })

  it('refuses to go backwards or stand still', () => {
    // 允许回退的话，"当前是哪一版"就不再有确定的答案
    expect(bumpOf('1.1.0', '1.0.0')).toBe('invalid')
    expect(bumpOf('2.0.0', '1.9.9')).toBe('invalid')
    expect(bumpOf('1.0.0', '1.0.0')).toBe('invalid')
    // minor 退了、patch 进了。变异测试逮到的：只有上面那几条时，
    // 把 minor 回退的判断整个删掉照样全绿——1.1.0 → 1.0.0 会被
    // 后面那条 patch 判断顺手拦下，于是那行代码从来没被真正测过
    expect(bumpOf('1.1.0', '1.0.5')).toBe('invalid')
  })

  it('refuses a version that is not semver', () => {
    expect(bumpOf('1.0', '1.1')).toBe('invalid')
    expect(bumpOf('1.0.0', 'v2')).toBe('invalid')
  })
})

describe('what a minor upgrade may do (FR-ONT-007)', () => {
  it('may add an optional attribute', () => {
    const next = v('1.1.0', [...BASE.attributes, { name: 'owner', kind: 'string' }])
    expect(compatibilityOf(BASE, next)).toMatchObject({ bump: 'minor', ok: true })
  })

  it('may widen an enum', () => {
    // 放宽不会让存量里的任何值变成非法值
    const next = v('1.1.0', [
      { name: 'title', kind: 'string', required: true },
      { name: 'note', kind: 'text' },
      { name: 'level', kind: 'enum', values: ['low', 'medium', 'high'] },
    ])
    expect(compatibilityOf(BASE, next).ok).toBe(true)
  })

  it('may NOT add a required attribute', () => {
    // 升级当时什么也不会发生（读路径不校验）。直到某个人去改一条旧记录
    const next = v('1.1.0', [...BASE.attributes, { name: 'owner', kind: 'string', required: true }])
    const verdict = compatibilityOf(BASE, next)
    expect(verdict.ok).toBe(false)
    expect(verdict.problems[0]).toMatchObject({ attribute: 'owner' })
    expect(verdict.problems[0]?.reason).toMatch(/fail its next write/)
  })

  it('may NOT make an existing attribute required', () => {
    const next = v('1.1.0', [
      { name: 'title', kind: 'string', required: true },
      { name: 'note', kind: 'text', required: true },
      { name: 'level', kind: 'enum', values: ['low', 'high'] },
    ])
    expect(compatibilityOf(BASE, next).problems[0]).toMatchObject({ attribute: 'note' })
  })

  it('may NOT remove an attribute', () => {
    // 删掉一条属性，旧数据里那个值就读不出来了——那就是丢数据
    const next = v('1.1.0', [{ name: 'title', kind: 'string', required: true }])
    const verdict = compatibilityOf(BASE, next)
    expect(verdict.ok).toBe(false)
    expect(verdict.problems.map((p) => p.attribute).sort()).toEqual(['level', 'note'])
  })

  it('may NOT change an attribute kind', () => {
    const next = v('1.1.0', [
      { name: 'title', kind: 'string', required: true },
      { name: 'note', kind: 'int' },
      { name: 'level', kind: 'enum', values: ['low', 'high'] },
    ])
    expect(compatibilityOf(BASE, next).problems[0]?.reason).toMatch(/kind changed text → int/)
  })

  it('may NOT narrow an enum, and names the values that would become illegal', () => {
    const next = v('1.1.0', [
      { name: 'title', kind: 'string', required: true },
      { name: 'note', kind: 'text' },
      { name: 'level', kind: 'enum', values: ['low'] },
    ])
    expect(compatibilityOf(BASE, next).problems[0]?.reason).toMatch(/dropping \["high"\]/)
  })

  it('may NOT shrink maxLength', () => {
    const from = v('1.0.0', [{ name: 'title', kind: 'string', required: true, maxLength: 200 }])
    const next = v('1.1.0', [{ name: 'title', kind: 'string', required: true, maxLength: 50 }])
    expect(compatibilityOf(from, next).problems[0]?.reason).toMatch(/maxLength shrank 200 → 50/)
  })

  it('lists every problem, not just the first', () => {
    // 一条一条修、一次一次重跑，是这类工具最让人放弃使用的性质
    const next = v('1.1.0', [{ name: 'note', kind: 'int', required: true }])
    const verdict = compatibilityOf(BASE, next)
    expect(verdict.problems.length).toBeGreaterThanOrEqual(3)
  })
})

describe('what the other bumps mean (FR-ONT-007)', () => {
  it('a patch bump must not change the schema at all', () => {
    // 放宽的话 patch 和 minor 就没有区别了，而 patch 是唯一一种
    // 大家默认可以闭眼升的
    const next = v('1.0.1', [...BASE.attributes, { name: 'owner', kind: 'string' }])
    const verdict = compatibilityOf(BASE, next)
    expect(verdict.ok).toBe(false)
    expect(verdict.problems[0]?.reason).toMatch(/use a minor bump/)
  })

  it('a major bump may break things — that is what major means', () => {
    // 破坏性变更不是不允许，是要求它显式地表现在版本号上，
    // 于是"这次升级会不会弄坏旧数据"从评审里的一个问题变成一个事实
    const next = v('2.0.0', [{ name: 'somethingElse', kind: 'int', required: true }])
    expect(compatibilityOf(BASE, next)).toMatchObject({ bump: 'major', ok: true })
  })
})

describe('the registry enforces it (FR-ONT-007)', () => {
  const registry = (): OntologyRegistry => {
    const r = new OntologyRegistry()
    r.registerEntity(BASE)
    return r
  }

  it('applies a compatible minor upgrade', () => {
    const r = registry()
    r.upgradeEntity(v('1.1.0', [...BASE.attributes, { name: 'owner', kind: 'string' }]))
    expect(r.entityType('Widget').version).toBe('1.1.0')
    expect(r.entityType('Widget').attributes.map((a) => a.name)).toContain('owner')
  })

  it('rejects an incompatible one and says which attributes are at fault', () => {
    const r = registry()
    expect(() =>
      r.upgradeEntity(v('1.1.0', [...BASE.attributes, { name: 'owner', kind: 'string', required: true }])),
    ).toThrow(/incompatible minor upgrade/)
  })

  it('keeps the old definition when an upgrade is rejected', () => {
    // 半应用的升级比拒绝糟得多：类型定义处于一个没人写过的中间状态
    const r = registry()
    try {
      r.upgradeEntity(v('1.1.0', [{ name: 'title', kind: 'string', required: true }]))
    } catch {
      /* expected */
    }
    expect(r.entityType('Widget').version).toBe('1.0.0')
    expect(r.entityType('Widget').attributes).toHaveLength(3)
  })

  it('will not upgrade something that was never registered', () => {
    expect(() => new OntologyRegistry().upgradeEntity(BASE)).toThrow(/unregistered/)
  })

  it('still refuses a plain re-register — upgrading is a different act', () => {
    // 让 register 悄悄覆盖的话，一次拼错的类型名会安静地替换掉
    // 另一个类型的模式，而那要到第一次写入失败时才会被发现
    const r = registry()
    expect(() => r.registerEntity(v('1.1.0', BASE.attributes))).toThrow(/already registered/)
  })

  it('lets data written under 1.0.0 still validate after the minor upgrade', () => {
    // **这就是验收标准那句话。** 旧数据读得出来，而且下一次写也过得去——
    // 后者才是真正会出事的地方
    const r = registry()
    const old = { title: '旧数据', level: 'high' }
    expect(() => r.validateAttributes('Widget', old)).not.toThrow()

    r.upgradeEntity(v('1.1.0', [...BASE.attributes, { name: 'owner', kind: 'string' }]))
    expect(r.validateAttributes('Widget', old)).toMatchObject(old)
  })
})
