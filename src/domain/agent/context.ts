import type { Caller, ResourceService } from '../resource/service.ts'
import type { ContextSegment } from './types.ts'

/**
 * Context 装配（FR-AGT-004）。
 *
 * PRD 把这里称作"关键差异点"，值得说清楚差在哪：
 * 常见做法是把相关文档拼进 prompt，上下文是**一团文本**；
 * 这里的上下文是**从本体图上检索出来的一组实体**，每一段都记得
 * 自己是谁、以及经过哪条关系链被找到的。
 *
 * 两个直接后果：
 *
 * 1. 产出可回溯。"这条风险是根据什么提的"有确定答案，而不是"模型觉得"。
 * 2. 权限可执行。每个来源实体都单独过一次 `service.get`，
 *    也就是过一次 PDP——Agent 看不到它本来无权看的东西。
 *    如果先拼文本再送模型，权限就只能在拼之前粗粒度地判一次。
 */

export type AssembleOptions = {
  /** 从哪个对象出发 */
  subjectId: string
  /** 沿哪些关系走。来自 Agent 声明，不是写死的 */
  relations: readonly string[]
  maxDepth: number
  /** 段数上限。上下文窗口是有限的，截断必须是显式的 */
  limit: number
}

export type AssembleResult = {
  segments: ContextSegment[]
  /** 命中数超过 limit 时为 true。静默截断会让人以为 Agent 看过全部 */
  truncated: boolean
}

/**
 * 把一个实体压成模型能读的一段文字。
 *
 * 只取属性的**值**，并带上类型与状态。不塞 id 之外的内部字段：
 * 那些对推理没有帮助，只会占窗口。
 */
function render(resource: {
  id: string
  type: string
  status: string
  attributes: Record<string, unknown>
}): string {
  const body = Object.entries(resource.attributes)
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join('\n')
  return `[${resource.type} ${resource.id} · ${resource.status}]\n${body}`
}

export async function assembleContext(
  service: ResourceService,
  caller: Caller,
  options: AssembleOptions,
): Promise<AssembleResult> {
  const segments: ContextSegment[] = []

  // subject 本身永远是第一段：Run 是围绕它展开的
  const subject = await service.get(caller, options.subjectId)
  segments.push({
    sourceId: subject.id,
    sourceType: subject.type,
    via: [],
    text: render(subject),
  })

  if (options.relations.length === 0) {
    return { segments, truncated: false }
  }

  const walk = await service.traverse(caller, {
    start: options.subjectId,
    follow: options.relations,
    direction: 'both',
    maxDepth: options.maxDepth,
    // 多取一些再截断，好知道是不是真的还有
    limit: options.limit,
  })

  for (const hit of walk.hits) {
    if (segments.length >= options.limit) break
    // 逐个 get：这一次 get 就是这个来源实体的权限判定。
    // 遍历本身只回 id，读内容必须另外授权
    const related = await service.get(caller, hit.id)
    segments.push({
      sourceId: related.id,
      sourceType: related.type,
      via: hit.path,
      text: render(related),
    })
  }

  return {
    segments,
    truncated: walk.truncated || walk.hits.length + 1 > options.limit,
  }
}
