import { describe, expect, it } from 'vitest'
import { sweep } from '../src/domain/ontology-health/sweep.ts'
import { buildDefaultRegistry } from '../src/ontology/defaults.ts'
import type { RelationSnapshot, ResourceSnapshot } from '../src/domain/ontology-health/sweep.ts'

/**
 * 本体一致性巡检（FR-ONT-010）。
 *
 * 三类问题，每类都有一个具体的来源——光说"数据不一致"是查不动的。
 * 这一组的主题：**报告要能被读完。** 一份重复三倍、混着噪音、
 * 没有分母的报告，第二周就没人打开了。
 */

const registry = buildDefaultRegistry()

const res = (id: string, type: string, over: Partial<ResourceSnapshot> = {}): ResourceSnapshot => ({
  id,
  type,
  deletedAt: null,
  project: 'proj_1',
  ...over,
})

const rel = (id: string, type: string, fromId: string, toId: string, confirmed: boolean | null = null): RelationSnapshot => ({
  id,
  type,
  fromId,
  toId,
  confirmed,
})

describe('orphans (FR-ONT-010)', () => {
  it('flags an object that belongs to no project', () => {
    // 它不会报错，只是在所有按项目收窄的视图里都不出现——包括每个项目级指标
    const report = sweep(registry, [res('task_1', 'Task', { project: null })], [])
    expect(report.findings).toHaveLength(1)
    expect(report.findings[0]).toMatchObject({ kind: 'orphan', resourceId: 'task_1' })
  })

  it('says why it matters, not just that it happened', () => {
    const report = sweep(registry, [res('task_1', 'Task', { project: null })], [])
    expect(report.findings[0]?.detail).toMatch(/invisible to every project-scoped view/)
  })

  it('does not flag a Project for not being inside a project', () => {
    expect(sweep(registry, [res('proj_1', 'Project', { project: null })], []).findings).toEqual([])
  })

  it('does not flag a type that was never meant to live in a project', () => {
    expect(sweep(registry, [res('agent_1', 'Agent', { project: null })], []).findings).toEqual([])
  })

  it('reads the type list from the ontology, not from a hard-coded one', () => {
    // 用 Knowledge：它在 containedIn 的定义域里，但不是最先想到的那两个。
    // 写死一张 ['Task','Story'] 的名单也能让上面几条用例通过——
    // 而那样的话，新增一个类型时这条巡检会安静地漏掉它。变异测试逮到的
    const report = sweep(registry, [res('k_1', 'Knowledge', { project: null })], [])
    expect(report.findings).toHaveLength(1)
    expect(report.findings[0]).toMatchObject({ kind: 'orphan', resourceType: 'Knowledge' })
  })

  it('ignores objects that are already deleted', () => {
    const report = sweep(registry, [res('task_1', 'Task', { project: null, deletedAt: new Date() })], [])
    expect(report.findings).toEqual([])
  })
})

describe('broken links (FR-ONT-010)', () => {
  it('flags a relation pointing at a soft-deleted object', () => {
    // 外键的级联只管硬删除，而这个系统是软删除。
    // 于是"删掉一个 Task"会留下一堆指向它的关系
    const report = sweep(
      registry,
      [res('story_1', 'Story'), res('task_1', 'Task', { deletedAt: new Date() })],
      [rel('rel_1', 'decomposedInto', 'story_1', 'task_1')],
    )
    expect(report.findings).toHaveLength(1)
    expect(report.findings[0]).toMatchObject({ kind: 'broken-link', resourceId: 'task_1' })
  })

  it('flags a relation pointing at something that is not there at all', () => {
    const report = sweep(registry, [res('story_1', 'Story')], [rel('rel_1', 'decomposedInto', 'story_1', 'ghost')])
    expect(report.findings[0]).toMatchObject({ kind: 'broken-link', resourceId: 'ghost' })
  })

  it('names the relation, so it can be cleaned up', () => {
    const report = sweep(registry, [res('story_1', 'Story')], [rel('rel_7', 'decomposedInto', 'story_1', 'ghost')])
    expect(report.findings[0]).toMatchObject({ relationId: 'rel_7' })
  })

  it('ignores a relation a human already rejected', () => {
    // 被否决的关系不算数（FR-ONT-006）。报它只会让报告里全是噪音
    const report = sweep(
      registry,
      [res('story_1', 'Story')],
      [rel('rel_1', 'decomposedInto', 'story_1', 'ghost', false)],
    )
    expect(report.findings).toEqual([])
  })

  it('says nothing when both ends are alive', () => {
    const report = sweep(
      registry,
      [res('story_1', 'Story'), res('task_1', 'Task')],
      [rel('rel_1', 'decomposedInto', 'story_1', 'task_1')],
    )
    expect(report.findings).toEqual([])
  })
})

describe('cycles (FR-ONT-010)', () => {
  const three = [res('a', 'Task'), res('b', 'Task'), res('c', 'Task')]

  it('finds a cycle on a relation declared acyclic', () => {
    // 服务层建边时会挡，但挡不住比这条守卫更早的数据
    const report = sweep(registry, three, [
      rel('r1', 'blockedBy', 'a', 'b'),
      rel('r2', 'blockedBy', 'b', 'c'),
      rel('r3', 'blockedBy', 'c', 'a'),
    ])
    const cycles = report.findings.filter((f) => f.kind === 'cycle')
    expect(cycles).toHaveLength(1)
  })

  it('reports each cycle once, not once per node', () => {
    // 同一个环从三个节点各走一遍会报三条，说的是同一件事——
    // 报告里重复三倍，人会开始跳过它
    const report = sweep(registry, three, [
      rel('r1', 'blockedBy', 'a', 'b'),
      rel('r2', 'blockedBy', 'b', 'c'),
      rel('r3', 'blockedBy', 'c', 'a'),
    ])
    expect(report.findings.filter((f) => f.kind === 'cycle')).toHaveLength(1)
  })

  it('finds a cycle even when nothing points into it', () => {
    // 只从入度为 0 的点出发的话，一个完全由环组成、没有入口的子图
    // 会整个被跳过
    const report = sweep(registry, [res('a', 'Task'), res('b', 'Task')], [
      rel('r1', 'blockedBy', 'a', 'b'),
      rel('r2', 'blockedBy', 'b', 'a'),
    ])
    expect(report.findings.filter((f) => f.kind === 'cycle')).toHaveLength(1)
  })

  it('leaves a cyclic-looking chain alone when the relation allows cycles', () => {
    // `explains` 是本体里**真实存在且没声明 acyclic** 的关系，成环合法。
    // 原来这条用的是一个registry 里根本不存在的关系名，
    // 于是"所有关系都查环"这个缺陷照样能通过——变异测试逮到的
    const report = sweep(registry, [res('d_1', 'Decision'), res('d_2', 'Decision')], [
      rel('r1', 'explains', 'd_1', 'd_2'),
      rel('r2', 'explains', 'd_2', 'd_1'),
    ])
    expect(report.findings.filter((f) => f.kind === 'cycle')).toEqual([])
  })

  it('does not count a cycle that runs through a deleted object', () => {
    // 那条边已经被"断链"报过了，再报一次环是同一个问题的第二种说法
    const report = sweep(
      registry,
      [res('a', 'Task'), res('b', 'Task', { deletedAt: new Date() })],
      [rel('r1', 'blockedBy', 'a', 'b'), rel('r2', 'blockedBy', 'b', 'a')],
    )
    expect(report.findings.filter((f) => f.kind === 'cycle')).toEqual([])
  })

  it('names the objects on the cycle', () => {
    const report = sweep(registry, three, [
      rel('r1', 'blockedBy', 'a', 'b'),
      rel('r2', 'blockedBy', 'b', 'c'),
      rel('r3', 'blockedBy', 'c', 'a'),
    ])
    const cycle = report.findings.find((f) => f.kind === 'cycle')
    if (cycle?.kind !== 'cycle') throw new Error('expected a cycle')
    expect([...cycle.resourceIds].sort()).toEqual(['a', 'b', 'c'])
    expect(cycle.detail).toMatch(/→/)
  })
})

describe('the report is readable (FR-ONT-010)', () => {
  it('carries the denominator', () => {
    // "发现 3 个问题"在 10 个对象和 10 万个对象里是完全不同的两件事
    const report = sweep(registry, [res('a', 'Task'), res('b', 'Task')], [rel('r', 'blockedBy', 'a', 'b')])
    expect(report.scanned).toEqual({ resources: 2, relations: 1 })
  })

  it('hands the UI a list of ids to filter by', () => {
    // 验收标准的后半句：问题对象可在 UI 中筛选
    const report = sweep(registry, [res('task_1', 'Task', { project: null })], [])
    expect(report.affectedIds).toEqual(['task_1'])
  })

  it('does not repeat an id that has two problems', () => {
    // 两条关系指向**同一个**失踪对象。原来那条用例指向两个不同的 id，
    // 于是根本没有重复可去——去重删掉照样通过
    const report = sweep(registry, [res('task_1', 'Task')], [
      rel('r1', 'blockedBy', 'task_1', 'ghost'),
      rel('r2', 'blockedBy', 'task_1', 'ghost'),
    ])
    expect(report.findings.filter((f) => f.kind === 'broken-link')).toHaveLength(2)
    expect(report.affectedIds).toEqual(['ghost'])
  })

  it('is empty on a healthy graph', () => {
    const report = sweep(
      registry,
      [res('story_1', 'Story'), res('task_1', 'Task')],
      [rel('r1', 'decomposedInto', 'story_1', 'task_1')],
    )
    expect(report.findings).toEqual([])
    expect(report.affectedIds).toEqual([])
  })
})
