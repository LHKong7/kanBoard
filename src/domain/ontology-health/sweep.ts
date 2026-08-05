import type { OntologyRegistry } from '../../ontology/registry.ts'

/**
 * 本体一致性巡检（FR-ONT-010）。
 *
 * 验收标准：**每日报告，问题对象可在 UI 中筛选。**
 *
 * 三类问题，每一类都有一个"为什么它会出现"的具体来源——
 * 光说"数据不一致"是查不动的：
 *
 *   孤儿  该归属某个项目却没归属。多半来自导入、或者建了一半的对象。
 *         它不会报错，只是**在所有按项目收窄的视图里都不出现**——
 *         包括每一个项目级指标。人以为它不存在。
 *   断链  关系指向一个**已被软删除**的对象。外键的级联只管硬删除，
 *         而这个系统是软删除（删掉的东西还读得到，审计才读得懂）。
 *         于是"删掉一个 Task"会留下一堆指向它的关系，
 *         而顺着关系走过去会拿到一个已经不算存在的东西。
 *   环    声明了 `acyclic` 的关系上出现了环。服务层建边时会挡，
 *         但**挡不住比这条守卫更早的数据**（迁移进来的、守卫上线前建的）。
 *
 * 这一层是纯函数：给它一份快照，它告诉你哪儿不对。
 * 把它和"怎么从库里查"分开，是因为判定规则是要被讨论的那部分，
 * 而混在 SQL 里的判定没法逐条测。
 */

export type ResourceSnapshot = {
  id: string
  type: string
  deletedAt: Date | null
  /** 归属的项目。null 表示没归属 */
  project: string | null
}

export type RelationSnapshot = {
  id: string
  type: string
  fromId: string
  toId: string
  /** 被否决的关系不算数（FR-ONT-006），巡检也不该报它 */
  confirmed: boolean | null
}

export type Finding =
  | { kind: 'orphan'; resourceId: string; resourceType: string; detail: string }
  | { kind: 'broken-link'; relationId: string; resourceId: string; detail: string }
  | { kind: 'cycle'; relationType: string; resourceIds: readonly string[]; detail: string }

export type HealthReport = {
  findings: readonly Finding[]
  /** 扫了多少。**报告里必须有分母**——"发现 3 个问题"在 10 个对象和
   *  10 万个对象里是完全不同的两件事 */
  scanned: { resources: number; relations: number }
  /** 问题对象的 id，UI 直接拿它筛（验收标准的后半句） */
  affectedIds: readonly string[]
}

/** 哪些类型应当归属项目。取自本体：`containedIn` 的定义域就是这份名单 */
function projectScopedTypes(registry: OntologyRegistry): Set<string> {
  const containedIn = registry.relationTypes().find((r) => r.name === 'containedIn')
  return new Set(containedIn?.domain ?? [])
}

export function sweep(
  registry: OntologyRegistry,
  resources: readonly ResourceSnapshot[],
  relations: readonly RelationSnapshot[],
): HealthReport {
  const findings: Finding[] = []
  const live = new Map<string, ResourceSnapshot>()
  for (const r of resources) {
    if (r.deletedAt === null) live.set(r.id, r)
  }

  // ── 孤儿 ────────────────────────────────────────────────
  const scoped = projectScopedTypes(registry)
  for (const r of live.values()) {
    // Project 自己不归属项目。用本体里的定义域判断，不写死一张类型名单——
    // 写死的话，新增一个类型时这条巡检会安静地漏掉它
    if (r.type === 'Project' || !scoped.has(r.type)) continue
    if (r.project === null) {
      findings.push({
        kind: 'orphan',
        resourceId: r.id,
        resourceType: r.type,
        detail: `${r.type} is not contained in any project; it will be invisible to every project-scoped view`,
      })
    }
  }

  // ── 断链 ────────────────────────────────────────────────
  for (const rel of relations) {
    // 被否决的关系不算数（FR-ONT-006）。报它只会让报告里全是噪音
    if (rel.confirmed === false) continue
    for (const end of [rel.fromId, rel.toId]) {
      if (!live.has(end)) {
        findings.push({
          kind: 'broken-link',
          relationId: rel.id,
          resourceId: end,
          detail: `relation "${rel.type}" points at ${end}, which is deleted or missing`,
        })
      }
    }
  }

  // ── 环 ──────────────────────────────────────────────────
  for (const type of registry.relationTypes()) {
    if (type.acyclic !== true) continue
    const edges = relations.filter(
      (r) => r.type === type.name && r.confirmed !== false && live.has(r.fromId) && live.has(r.toId),
    )
    for (const cycle of findCycles(edges)) {
      findings.push({
        kind: 'cycle',
        relationType: type.name,
        resourceIds: cycle,
        detail: `"${type.name}" is declared acyclic but ${cycle.join(' → ')} forms a cycle`,
      })
    }
  }

  return {
    findings,
    scanned: { resources: resources.length, relations: relations.length },
    affectedIds: [...new Set(findings.map(idOf))].sort(),
  }
}

function idOf(f: Finding): string {
  if (f.kind === 'cycle') return f.resourceIds[0] ?? ''
  return f.resourceId
}

/**
 * 找环。
 *
 * 每个环只报一次。**做到这件事的其实是三色标记**：一个节点变黑之后
 * 就不再被走第二遍，所以同一个环不会从它的三个节点各被发现一次。
 *
 * 那张按指纹去重的 Map 因此是**兜底而不是主力**——变异测试确认过：
 * 把指纹改坏，用例照样全绿。留着是因为它同时充当累加器，
 * 而且如果将来把三色标记换成别的遍历方式，它是唯一还拦得住重复的东西。
 */
function findCycles(edges: readonly RelationSnapshot[]): string[][] {
  const out = new Map<string, string[]>()
  const next = new Map<string, string[]>()
  for (const e of edges) next.set(e.fromId, [...(next.get(e.fromId) ?? []), e.toId])

  const colour = new Map<string, 'grey' | 'black'>()
  const stack: string[] = []

  const walk = (node: string): void => {
    const seen = colour.get(node)
    if (seen === 'black') return
    if (seen === 'grey') {
      // 回边：栈上从这个节点起就是一个环
      const at = stack.indexOf(node)
      if (at >= 0) {
        const cycle = stack.slice(at)
        const fingerprint = [...cycle].sort().join(',')
        if (!out.has(fingerprint)) out.set(fingerprint, cycle)
      }
      return
    }
    colour.set(node, 'grey')
    stack.push(node)
    for (const child of next.get(node) ?? []) walk(child)
    stack.pop()
    colour.set(node, 'black')
  }

  // 从每个节点都试一遍：只从入度为 0 的点出发的话，
  // 一个**完全由环组成**的子图（没有入口）会整个被跳过
  for (const node of next.keys()) walk(node)
  return [...out.values()]
}
