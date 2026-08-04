import { describe, expect, it } from 'vitest'
import { allows, decide, digest, reconcile } from '../src/domain/migration/sync.ts'
import type {
  ExternalRecord,
  LocalRecord,
  MigrationPhase,
  SyncLink,
} from '../src/domain/migration/sync.ts'

/**
 * 三阶段迁移与双向同步（FR-CON-007）。
 *
 * 验收标准是「完成 3 阶段迁移演练，**无数据丢失**」。这一组考的正是
 * "东西有没有丢"，而那是同步引擎的性质，和源系统是谁无关——
 * 所以这里一个 Jira 的字都没有。
 *
 * 全组的主题是同一句话：**丢东西而不报错，是这里唯一真正严重的失败。**
 * 冲突判错了，人会看到；冲突被悄悄合并了，没有人会看到。
 */

const T0 = new Date('2026-01-01T00:00:00Z')
const T1 = new Date('2026-01-02T00:00:00Z')

const remote = (fields: Record<string, unknown>, id = 'PROJ-1'): ExternalRecord => ({
  externalId: id,
  fields,
  updatedAt: T1,
})
const local = (fields: Record<string, unknown>, id = 'task_1', ext: string | null = 'PROJ-1'): LocalRecord => ({
  localId: id,
  externalId: ext,
  fields,
  updatedAt: T1,
})
const link = (remoteFields: Record<string, unknown>, localFields: Record<string, unknown>): SyncLink => ({
  externalId: 'PROJ-1',
  localId: 'task_1',
  remoteDigest: digest(remoteFields),
  localDigest: digest(localFields),
  lastSyncedAt: T0,
})

describe('each phase writes in exactly one set of directions (FR-CON-007)', () => {
  it('mirror is read-only: the source system is the only truth', () => {
    expect(allows('mirror', 'toLocal')).toBe(true)
    expect(allows('mirror', 'toRemote')).toBe(false)
  })

  it('parallel runs both ways — that is what "并行运行" means', () => {
    expect(allows('parallel', 'toLocal')).toBe(true)
    expect(allows('parallel', 'toRemote')).toBe(true)
  })

  it('cutover stops writing back to the old system', () => {
    // 继续双写看起来是"留个后路"，实际效果是两份数据继续分叉，
    // 而且没有人再盯着它们
    expect(allows('cutover', 'toRemote')).toBe(false)
    expect(allows('cutover', 'toLocal')).toBe(true)
  })
})

describe('deciding what to do with one record', () => {
  const base = { title: '导出账单', status: 'Doing' }

  it('creates locally when the record is new here', () => {
    expect(decide('mirror', remote(base), null, null)).toMatchObject({
      kind: 'create-local',
      externalId: 'PROJ-1',
    })
  })

  it('does nothing when neither side moved', () => {
    expect(decide('parallel', remote(base), local(base), link(base, base)).kind).toBe('noop')
  })

  it('pulls a remote-only change down', () => {
    const changed = { ...base, status: 'Done' }
    expect(decide('parallel', remote(changed), local(base), link(base, base))).toMatchObject({
      kind: 'update-local',
      fields: changed,
    })
  })

  it('pushes a local-only change up during parallel run', () => {
    const changed = { ...base, status: 'Done' }
    expect(decide('parallel', remote(base), local(changed), link(base, base))).toMatchObject({
      kind: 'update-remote',
      fields: changed,
    })
  })
})

describe('a conflict is surfaced, never silently merged', () => {
  const base = { title: '导出账单', status: 'Doing' }

  it('reports both sides changing the same record', () => {
    // 按时间戳挑一个"赢家"看起来省事，代价是另一边那次修改**无声地消失**
    const result = decide(
      'parallel',
      remote({ ...base, status: 'Done' }),
      local({ ...base, status: 'Blocked' }),
      link(base, base),
    )
    expect(result.kind).toBe('conflict')
  })

  it('names the fields that disagree, not just "conflict"', () => {
    const result = decide(
      'parallel',
      remote({ ...base, status: 'Done', title: '导出对账单' }),
      local({ ...base, status: 'Blocked' }),
      link(base, base),
    )
    // 只说"冲突"的话，人得自己逐字段比
    expect(result).toMatchObject({ kind: 'conflict' })
    if (result.kind === 'conflict') expect([...result.fields]).toEqual(['status', 'title'])
  })

  it('is not a conflict when both sides made the same edit', () => {
    // 判成冲突会让一次批量的同义修改产出几百条要人处理的"冲突"
    const same = { ...base, status: 'Done' }
    expect(decide('parallel', remote(same), local(same), link(base, base)).kind).toBe('noop')
  })

  it('carries both versions so the decision can be made without re-fetching', () => {
    const result = decide(
      'parallel',
      remote({ ...base, status: 'Done' }),
      local({ ...base, status: 'Blocked' }),
      link(base, base),
    )
    if (result.kind !== 'conflict') throw new Error('expected a conflict')
    expect(result.remote['status']).toBe('Done')
    expect(result.local['status']).toBe('Blocked')
  })
})

describe('a change the phase cannot carry is held, not dropped', () => {
  const base = { title: '导出账单', status: 'Doing' }

  it('holds a local edit during the read-only mirror phase', () => {
    // 归进 noop 的话，"镜像阶段有人在这边改了东西"这件事就没人知道了
    const result = decide('mirror', remote(base), local({ ...base, status: 'Done' }), link(base, base))
    expect(result.kind).toBe('held')
    if (result.kind === 'held') expect(result.reason).toMatch(/does not write back/)
  })

  it('holds a local edit after cutover too', () => {
    const result = decide('cutover', remote(base), local({ ...base, status: 'Done' }), link(base, base))
    expect(result.kind).toBe('held')
  })

  it('never reports a held change as a no-op', () => {
    // 这条是整组里最重要的一条断言：被压住的改动和"什么都没发生"
    // 长得一样的话，演练报告就会显示一切正常
    for (const phase of ['mirror', 'cutover'] as MigrationPhase[]) {
      const result = decide(phase, remote(base), local({ ...base, status: 'Done' }), link(base, base))
      expect(result.kind).not.toBe('noop')
    }
  })
})

describe('digests do not depend on key order', () => {
  it('treats the same data written in a different order as unchanged', () => {
    // 适配器返回的字段顺序不受我们控制。不排序的话每次同步都"改过了"
    expect(digest({ a: 1, b: 2 })).toBe(digest({ b: 2, a: 1 }))
  })

  it('still notices a real change', () => {
    expect(digest({ a: 1, b: 2 })).not.toBe(digest({ a: 1, b: 3 }))
  })
})

// ── 无数据丢失 ───────────────────────────────────────────────
describe('reconciliation proves nothing was lost (FR-CON-007)', () => {
  it('is clean when both sides hold the same records', () => {
    const r = reconcile(
      [remote({ title: 'a' }, 'P-1'), remote({ title: 'b' }, 'P-2')],
      [local({ title: 'a' }, 'task_1', 'P-1'), local({ title: 'b' }, 'task_2', 'P-2')],
    )
    expect(r.clean).toBe(true)
    expect(r.matched).toBe(2)
  })

  it('names the records that did not make it across', () => {
    // 这就是"丢数据"。一个只给数量的对账，人无从下手
    const r = reconcile(
      [remote({ title: 'a' }, 'P-1'), remote({ title: 'b' }, 'P-2')],
      [local({ title: 'a' }, 'task_1', 'P-1')],
    )
    expect(r.clean).toBe(false)
    expect(r.missing).toEqual(['P-2'])
  })

  it('catches a record that arrived with a field mangled', () => {
    // 条数对得上不等于没丢东西。只比数量的话这一条完全测不出来
    const r = reconcile(
      [remote({ title: 'a', points: 5 }, 'P-1')],
      [local({ title: 'a', points: null }, 'task_1', 'P-1')],
    )
    expect(r.clean).toBe(false)
    expect(r.diverged).toEqual([{ externalId: 'P-1', fields: ['points'] }])
  })

  it('does not call a locally-created record a loss, but still reports it', () => {
    // 迁移期间这边新建的东西源系统里当然没有。算成丢失会让对账永远脏，
    // 而永远脏的对账等于没有对账
    const r = reconcile([remote({ title: 'a' }, 'P-1')], [
      local({ title: 'a' }, 'task_1', 'P-1'),
      local({ title: '新需求' }, 'task_2', null),
    ])
    expect(r.clean).toBe(true)
    expect(r.extra).toEqual(['task_2'])
  })

  it('reports a record the source system no longer has', () => {
    // 源那边删的是一次决定，不是一次丢失——但一次误删在这里是
    // 唯一还能被发现的地方，所以不能不报
    const r = reconcile([remote({ title: 'a' }, 'P-1')], [
      local({ title: 'a' }, 'task_1', 'P-1'),
      local({ title: 'b' }, 'task_2', 'P-2'),
    ])
    expect(r.extra).toEqual(['P-2'])
  })

  it('does not call local-only fields a divergence', () => {
    // 本地对象一定带着源系统里没有的东西（状态、owner、审计字段…）。
    // 双向比的话每一条记录都会显示为分叉，而一份永远脏的对账
    // 等于没有对账——然后真的分叉出现时没人会注意到
    const r = reconcile(
      [remote({ title: 'a' }, 'P-1')],
      [local({ title: 'a', status: 'Doing', owner: 'user://bob' }, 'task_1', 'P-1')],
    )
    expect(r.clean).toBe(true)
    expect(r.diverged).toEqual([])
  })

  it('still catches a field the source has and this side lost', () => {
    // 反过来必须抓到：那才是丢数据
    const r = reconcile(
      [remote({ title: 'a', points: 5 }, 'P-1')],
      [local({ title: 'a', status: 'Doing' }, 'task_1', 'P-1')],
    )
    expect(r.clean).toBe(false)
    expect(r.diverged[0]?.fields).toEqual(['points'])
  })

  it('an empty source does not read as a clean migration', () => {
    // 一次把源读空了的同步（认证过期、筛选条件写错）不该表现为"全对上了"
    const r = reconcile([], [local({ title: 'a' }, 'task_1', 'P-1')])
    expect(r.matched).toBe(0)
    expect(r.extra).toEqual(['P-1'])
  })
})

// ── 三阶段演练 ───────────────────────────────────────────────
describe('the three-phase rehearsal, end to end (FR-CON-007)', () => {
  /** 极小的一次演练：源两条，中途两边各改一条 */
  it('carries every record through mirror → parallel → cutover with nothing lost', () => {
    const source = new Map<string, Record<string, unknown>>([
      ['P-1', { title: '导出账单', status: 'Todo' }],
      ['P-2', { title: '批量下载', status: 'Todo' }],
    ])
    const here = new Map<string, { localId: string; fields: Record<string, unknown> }>()
    const links = new Map<string, SyncLink>()
    const held: string[] = []
    const conflicts: string[] = []

    const sync = (phase: MigrationPhase): void => {
      for (const [externalId, fields] of source) {
        const mine = here.get(externalId)
        const decision = decide(
          phase,
          { externalId, fields, updatedAt: T1 },
          mine === undefined ? null : { ...mine, externalId, updatedAt: T1 },
          links.get(externalId) ?? null,
        )
        switch (decision.kind) {
          case 'create-local': {
            const localId = `task_${here.size + 1}`
            here.set(externalId, { localId, fields: { ...fields } })
            links.set(externalId, {
              externalId, localId,
              remoteDigest: digest(fields), localDigest: digest(fields),
              lastSyncedAt: T1,
            })
            break
          }
          case 'update-local': {
            here.set(externalId, { localId: decision.localId, fields: { ...decision.fields } })
            links.set(externalId, {
              externalId, localId: decision.localId,
              remoteDigest: digest(decision.fields), localDigest: digest(decision.fields),
              lastSyncedAt: T1,
            })
            break
          }
          case 'update-remote': {
            source.set(externalId, { ...decision.fields })
            links.set(externalId, {
              externalId, localId: decision.localId,
              remoteDigest: digest(decision.fields), localDigest: digest(decision.fields),
              lastSyncedAt: T1,
            })
            break
          }
          case 'conflict': conflicts.push(externalId); break
          case 'held': held.push(externalId); break
          case 'noop': break
        }
      }
    }

    // ① 镜像：两条都过来
    sync('mirror')
    expect(here.size).toBe(2)

    // 镜像期间有人在这边改了一条——它传不回去，但必须被记下来
    const p1 = here.get('P-1')
    if (p1 === undefined) throw new Error('P-1 should have been mirrored')
    here.set('P-1', { ...p1, fields: { ...p1.fields, status: 'Doing' } })
    sync('mirror')
    expect(held).toEqual(['P-1'])

    // ② 并行：这次它传得回去了
    sync('parallel')
    expect(source.get('P-1')).toMatchObject({ status: 'Doing' })

    // 源那边改另一条，拉下来
    source.set('P-2', { title: '批量下载', status: 'Doing' })
    sync('parallel')
    expect(here.get('P-2')?.fields).toMatchObject({ status: 'Doing' })

    // ③ 切换：这边成为事实来源，不再回写
    const p2 = here.get('P-2')
    if (p2 === undefined) throw new Error('P-2 should be here')
    here.set('P-2', { ...p2, fields: { ...p2.fields, status: 'Done' } })
    sync('cutover')
    expect(source.get('P-2')).toMatchObject({ status: 'Doing' })
    expect(held).toContain('P-2')

    // 对账：切换时源与本地的差异只应来自切换后本地的那次改动
    const finalReconcile = reconcile(
      [...source].map(([externalId, fields]) => ({ externalId, fields, updatedAt: T1 })),
      [...here].map(([externalId, v]) => ({
        localId: v.localId, externalId, fields: v.fields, updatedAt: T1,
      })),
    )
    // 没有一条记录消失——这是「无数据丢失」的判据
    expect(finalReconcile.missing).toEqual([])
    expect(conflicts).toEqual([])
    // P-2 的分叉是切换之后本地改的，而且它被 held 记下来了，不是丢失
    expect(finalReconcile.diverged.map((d) => d.externalId)).toEqual(['P-2'])
  })
})
