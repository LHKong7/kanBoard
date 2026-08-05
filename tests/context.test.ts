import { describe, expect, it } from 'vitest'
import { assembleContext } from '../src/domain/agent/context.ts'
import type { Caller, ResourceService } from '../src/domain/resource/service.ts'

/**
 * Context 装配（FR-AGT-004）。
 *
 * PRD 把这里称作"关键差异点"：上下文不是一团被拼进 prompt 的文本，
 * 而是从本体图上检索出来的一组实体，每段都记得自己经过哪条关系链被找到。
 *
 * 这组用例是纯的——用一个假的 service。装配逻辑里最容易错的两处
 * （截断的判定、每段来源是否单独授权）都不需要数据库就能钉死。
 */

type Fake = {
  resources: Record<string, { id: string; type: string; status: string; attributes: Record<string, unknown> }>
  hits: { id: string; path: string[] }[]
  truncated?: boolean
  /** 记下每次 get 的 id：来源实体必须**逐个**过一次授权 */
  reads: string[]
}

function fakeService(f: Fake): ResourceService {
  return {
    async get(_caller: Caller, id: string) {
      f.reads.push(id)
      const r = f.resources[id]
      if (r === undefined) throw new Error(`no such resource: ${id}`)
      return r
    },
    async traverse() {
      return { hits: f.hits, truncated: f.truncated ?? false }
    },
  } as unknown as ResourceService
}

const caller = {} as Caller
const res = (id: string, attributes: Record<string, unknown> = {}) => ({
  id,
  type: 'Task',
  status: 'Todo',
  attributes,
})

describe('context assembly carries provenance (FR-AGT-004)', () => {
  it('always puts the subject first, with an empty path', async () => {
    const f: Fake = { resources: { t1: res('t1', { title: 'a' }) }, hits: [], reads: [] }
    const out = await assembleContext(fakeService(f), caller, {
      subjectId: 't1',
      relations: [],
      maxDepth: 3,
      limit: 10,
    })
    expect(out.segments).toHaveLength(1)
    expect(out.segments[0]?.sourceId).toBe('t1')
    // Run 是围绕 subject 展开的，它不是"经过某条关系找到的"
    expect(out.segments[0]?.via).toEqual([])
  })

  it('skips traversal entirely when the agent declares no relations', async () => {
    // 声明里没写关系就是不遍历——不是"遍历全部"
    const f: Fake = { resources: { t1: res('t1') }, hits: [{ id: 'x', path: ['r'] }], reads: [] }
    const out = await assembleContext(fakeService(f), caller, {
      subjectId: 't1',
      relations: [],
      maxDepth: 3,
      limit: 10,
    })
    expect(out.segments).toHaveLength(1)
    expect(out.truncated).toBe(false)
  })

  it('records the relation path each segment was found through', async () => {
    const f: Fake = {
      resources: { t1: res('t1'), t2: res('t2') },
      hits: [{ id: 't2', path: ['implementedBy', 'decomposedInto'] }],
      reads: [],
    }
    const out = await assembleContext(fakeService(f), caller, {
      subjectId: 't1',
      relations: ['implementedBy'],
      maxDepth: 3,
      limit: 10,
    })
    // "它凭什么相关"必须有确定答案，而不是"模型觉得"
    expect(out.segments[1]?.via).toEqual(['implementedBy', 'decomposedInto'])
  })

  it('reads every source entity individually, so each one passes the PDP', async () => {
    // 先拼文本再送模型的话，权限只能在拼之前粗粒度判一次
    const f: Fake = {
      resources: { t1: res('t1'), t2: res('t2'), t3: res('t3') },
      hits: [{ id: 't2', path: ['r'] }, { id: 't3', path: ['r'] }],
      reads: [],
    }
    await assembleContext(fakeService(f), caller, {
      subjectId: 't1',
      relations: ['r'],
      maxDepth: 3,
      limit: 10,
    })
    expect(f.reads).toEqual(['t1', 't2', 't3'])
  })

  it('flags truncation when the traversal itself was cut short', async () => {
    // 静默截断会让人以为 Agent 看过全部
    const f: Fake = {
      resources: { t1: res('t1'), t2: res('t2') },
      hits: [{ id: 't2', path: ['r'] }],
      truncated: true,
      reads: [],
    }
    const out = await assembleContext(fakeService(f), caller, {
      subjectId: 't1',
      relations: ['r'],
      maxDepth: 3,
      limit: 10,
    })
    expect(out.truncated).toBe(true)
  })

  it('flags truncation when the segment limit is what cut it short', async () => {
    const f: Fake = {
      resources: { t1: res('t1'), t2: res('t2'), t3: res('t3') },
      hits: [{ id: 't2', path: ['r'] }, { id: 't3', path: ['r'] }],
      reads: [],
    }
    const out = await assembleContext(fakeService(f), caller, {
      subjectId: 't1',
      relations: ['r'],
      maxDepth: 3,
      limit: 2,
    })
    expect(out.segments).toHaveLength(2)
    expect(out.truncated).toBe(true)
  })

  it('renders values without the empty ones', async () => {
    // 空值占窗口又不帮助推理
    const f: Fake = {
      resources: { t1: res('t1', { title: '有值', note: '', dropped: null, n: 3 }) },
      hits: [],
      reads: [],
    }
    const out = await assembleContext(fakeService(f), caller, {
      subjectId: 't1',
      relations: [],
      maxDepth: 3,
      limit: 10,
    })
    const text = out.segments[0]?.text ?? ''
    expect(text).toContain('title: 有值')
    expect(text).toContain('n: 3')
    expect(text).not.toContain('note:')
    expect(text).not.toContain('dropped:')
    // 类型与状态要带上：同一段文字在不同状态下的含义不一样
    expect(text).toContain('[Task t1 · Todo]')
  })
})
