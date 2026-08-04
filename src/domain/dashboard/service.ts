import { DomainError } from '../../platform/errors.ts'
import type { Caller, ResourceService } from '../resource/service.ts'
import type { GroupCount, Page, PageResult } from '../resource/ports.ts'
import type { Resource } from '../resource/resource.ts'
import { DEFAULT_METRICS, findMetric } from './metrics.ts'
import type { MetricDef } from './metrics.ts'

/**
 * 指标服务（FR-DASH-005/006/010/011）。
 *
 * 它薄得几乎不像一个服务，那是刻意的：所有的读都转交给 `ResourceService`，
 * 于是权限、租户隔离、软删除过滤全部沿用主路径的实现。
 * 指标层**不自己碰数据库**——一旦它开始直接查表，
 * 就必须自己重新实现一遍权限，而重新实现的那份迟早会漏。
 */

export type MetricScopeFilter = {
  project?: string | undefined
  workspace?: string | undefined
}

export type MetricValue = {
  id: string
  title: string
  definition: string
  direction: MetricDef['direction']
  /** 单值指标的总数；分组指标是各组之和 */
  total: number
  /** 分组指标的分布；单值指标为空数组 */
  groups: GroupCount[]
  /** 算这个数字的时刻。现算的，所以就是"现在" */
  computedAt: Date
}

export class DashboardService {
  readonly #resources: ResourceService

  constructor(resources: ResourceService) {
    this.#resources = resources
  }

  catalogue(): readonly MetricDef[] {
    return DEFAULT_METRICS
  }

  async value(caller: Caller, metricId: string, scope: MetricScopeFilter): Promise<MetricValue> {
    const metric = this.#require(metricId)
    const filter = { ...metric.filter, ...definedOnly(scope) }

    // 分组与不分组都走同一条 countGrouped：不分组时按 type 分组再求和。
    // 少一条代码路径，就少一个"两处算得不一样"的可能
    const groups = await this.#resources.countGrouped(caller, filter, metric.groupBy ?? 'type')
    const total = groups.reduce((sum, g) => sum + g.count, 0)

    return {
      id: metric.id,
      title: metric.title,
      definition: metric.definition,
      direction: metric.direction,
      total,
      groups: metric.groupBy === undefined ? [] : groups,
      computedAt: new Date(),
    }
  }

  /**
   * 下钻（FR-DASH-006）。
   *
   * 用**同一个 filter** 跑一次普通查询。指标和明细因此不可能对不上——
   * 它们本来就是一次查询的两种投影。
   */
  async breakdown(
    caller: Caller,
    metricId: string,
    scope: MetricScopeFilter,
    page: Page,
    group?: string,
  ): Promise<PageResult<Resource>> {
    const metric = this.#require(metricId)
    const filter = { ...metric.filter, ...definedOnly(scope) }

    // 点的是分布里的某一格，就再按那一格收窄
    if (group !== undefined && metric.groupBy !== undefined) {
      Object.assign(filter, groupFilter(metric.groupBy, group))
    }
    return this.#resources.query(caller, filter, page)
  }

  #require(metricId: string): MetricDef {
    const metric = findMetric(metricId)
    if (metric === undefined) {
      // 404 并把已知指标列出来：拼错一个指标 id 时，
      // 光说"没找到"要人去翻源码才知道正确的写法
      throw new DomainError('not_found', `unknown metric: ${metricId}`, 404, {
        known: DEFAULT_METRICS.map((m) => m.id),
      })
    }
    return metric
  }
}

/** 把 groupBy 的某一格转成过滤条件 */
function groupFilter(groupBy: string, key: string): Record<string, unknown> {
  switch (groupBy) {
    case 'status':
      return { status: [key] }
    case 'type':
      return { type: key }
    case 'owner':
      return { owner: key }
    case 'project':
      return { project: key }
    default:
      return {}
  }
}

/**
 * 只保留真的传了的字段。
 *
 * `{...metric.filter, ...scope}` 里如果 scope 带着 `project: undefined`，
 * 会把 metric.filter 自己的 project 覆盖成 undefined——
 * "某个项目的指标"于是悄悄变成"全租户的指标"，数字更大，而且看不出错。
 *
 * **老实说：目前没有一个内置指标在自己的 filter 里写 project，
 * 所以这个函数现在是防御性的，删掉它当前所有用例照样绿**（试过）。
 * 留着是因为第一个自带 project 条件的指标出现时，这个坑会当场生效，
 * 而它的表现是"数字偏大"——不会报错，只会让人做错决定。
 */
function definedOnly(scope: MetricScopeFilter): Record<string, string> {
  const out: Record<string, string> = {}
  if (scope.project !== undefined) out['project'] = scope.project
  if (scope.workspace !== undefined) out['workspace'] = scope.workspace
  return out
}
