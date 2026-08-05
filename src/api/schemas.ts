import { z } from 'zod'

/**
 * HTTP 边界的运行期校验（FR-ARCH-010）。
 *
 * TS 的类型在运行期不存在，请求体是 `unknown`。凡是从网络进来的东西
 * 都必须先过 Zod 才能进入领域层——这是 ADR-0007 换语言时明确接下的债。
 *
 * 注意这里只校验**信封**（envelope）：id、分页、关系方向这些。
 * `attributes` 的内容由本体校验（OntologyRegistry），不在这里重复定义，
 * 否则本体一改这里就漂移。
 *
 * 信封一律 `.strict()`：多余字段直接 400，不静默丢弃。
 * 这条是自用第一天踩出来的（docs/dogfooding-log.md #1）——
 * 把分页写成 `{limit, cursor}` 而不是 `{page:{size, cursor}}`，
 * Zod 默认把两个字段都剥掉，接口回 200，游标永远不前进，
 * 于是 142 条需求被翻成 1000 条重复结果，而调用方没有任何办法察觉。
 * 宽松解析在这里买不到兼容性，只买到"看起来成功的错误答案"。
 *
 * `attributes` 是有意开放的 `z.record`：那部分归本体管，不受这条约束。
 */

export const resourceIdSchema = z
  .string()
  .regex(/^[a-z][a-z0-9]*_[0-9A-HJKMNP-TV-Z]{26}$/, 'invalid resource id')

export const visibilitySchema = z.enum(['private', 'project', 'workspace', 'tenant'])

export const createResourceSchema = z.object({
  type: z.string().min(1).max(64),
  workspace: z.string().min(1).max(64),
  project: resourceIdSchema.nullish(),
  owner: z.string().max(256).optional(),
  status: z.string().max(64).optional(),
  labels: z.array(z.string().max(64)).max(50).optional(),
  attributes: z.record(z.unknown()).optional(),
  visibility: visibilitySchema.optional(),
}).strict()

export const updateResourceSchema = z.object({
  expectedVersion: z.number().int().positive(),
  status: z.string().max(64).optional(),
  labels: z.array(z.string().max(64)).max(50).optional(),
  attributes: z.record(z.unknown()).optional(),
  visibility: visibilitySchema.optional(),
  owner: z.string().max(256).optional(),
  reason: z.string().max(2000).optional(),
}).strict()

export const transitionSchema = z.object({
  to: z.string().min(1).max(64),
  /** 可选：带上就做乐观锁检查。迁移本身是幂等意图，不强制要求版本 */
  expectedVersion: z.number().int().positive().optional(),
  reason: z.string().max(2000).optional(),
}).strict()

export const querySchema = z.object({
  type: z.string().max(64).optional(),
  filter: z
    .object({
      workspace: z.string().max(64).optional(),
      project: resourceIdSchema.optional(),
      owner: z.string().max(256).optional(),
      status: z.array(z.string().max(64)).max(20).optional(),
      labels: z.array(z.string().max(64)).max(20).optional(),
      attributes: z.record(z.unknown()).optional(),
      includeDeleted: z.boolean().optional(),
      /** 全文检索词（FR-RES-016）。与其余条件是 AND。 */
      text: z.string().min(1).max(256).optional(),
    })
    .strict()
    .optional(),
  page: z
    .object({
      size: z.number().int().min(1).max(200).default(50),
      cursor: z.string().max(64).optional(),
    })
    .strict()
    .optional(),
}).strict()

/**
 * `GET /v1/resources` 的查询串（FR-RES-017）。
 *
 * 为什么在 `POST :query` 之外还要一条 GET（docs/dogfooding-log.md #5）：
 * 只有 POST 的话，**看板上任何一个视图都没有 URL**——分享不了、收藏不了、
 * 浏览器前进后退不工作、HTTP 缓存完全用不上。「把搜索结果发给同事」
 * 是最基本的协作动作，而它此前做不到。
 *
 * GET 只覆盖**放得进查询串的那部分**：类型、工作区、项目、负责人、
 * 状态、标签、检索词、分页。`attributes` 的任意匹配留在 POST——
 * 把嵌套 JSON 塞进查询串是这类接口变丑的起点，而且它本来也不是分享场景。
 * 两条路径调用同一个 `service.query`，行为不会分叉。
 *
 * 同样 `.strict()`：查询串写错一个参数就 400。
 * 被静默忽略的 `?stauts=Done` 会安安静静地返回全部结果——正是 #1 那个坑。
 */
const csvOrRepeated = z
  .union([z.string(), z.array(z.string())])
  // `?status=A&status=B` 与 `?status=A,B` 都支持：前者是 HTML 表单的习惯，
  // 后者是手写 URL 的习惯，没有理由逼使用者记住我们挑了哪一种
  .transform((v) => (Array.isArray(v) ? v : v.split(',')).map((s) => s.trim()).filter((s) => s !== ''))
  .pipe(z.array(z.string().max(64)).min(1).max(20))

/** 同上，但上限放到 200：id 清单是机器拼的，20 个一批会退化成 N+1 本身 */
const csvOrRepeatedIds = z
  .union([z.string(), z.array(z.string())])
  .transform((v) => (Array.isArray(v) ? v : v.split(',')).map((s) => s.trim()).filter((s) => s !== ''))
  .pipe(z.array(resourceIdSchema).min(1).max(200))

export const queryParamsSchema = z
  .object({
    type: z.string().max(64).optional(),
    workspace: z.string().max(64).optional(),
    project: resourceIdSchema.optional(),
    owner: z.string().max(256).optional(),
    status: csvOrRepeated.optional(),
    labels: csvOrRepeated.optional(),
    text: z.string().min(1).max(256).optional(),
    /**
     * 按 id 批量取（仓储层早就支持，只是没暴露出来）。
     *
     * 存在的理由和 `ResourceFilter.ids` 上写的一样：避免 N+1。
     * 拉一个对象的评论是"先问关系拿到一串 id，再一次取回全部"，
     * 逐个 GET 会让一次抽屉展开发出几十条请求。
     *
     * 上限 200 与 `size` 对齐——传进来 500 个 id 却只回 200 条，
     * 是那种"看起来成功了"的错误答案。
     */
    ids: csvOrRepeatedIds.optional(),
    // 查询串里的一切都是字符串。写成枚举而不是 z.coerce.boolean()：
    // 后者会把 "false" 也当成真，那正是"看起来成功的错误答案"
    includeDeleted: z.enum(['true', 'false']).optional(),
    size: z.coerce.number().int().min(1).max(200).optional(),
    cursor: z.string().max(64).optional(),
  })
  .strict()

/**
 * 导出的入参：和 `querySchema` 同一套筛选，外加一个格式。
 *
 * 没有 `page`——导出就是"把筛出来的都拿走"，翻页由服务端自己完成到上限为止。
 * 也没有 `includeDeleted`：导出一份混着已删对象的表格，收到的人不会知道。
 */
export const exportSchema = z.object({
  type: z.string().max(64).optional(),
  filter: z
    .object({
      workspace: z.string().max(64).optional(),
      project: resourceIdSchema.optional(),
      owner: z.string().max(256).optional(),
      status: z.array(z.string().max(64)).max(20).optional(),
      labels: z.array(z.string().max(64)).max(20).optional(),
      attributes: z.record(z.unknown()).optional(),
      text: z.string().min(1).max(256).optional(),
    })
    .strict()
    .optional(),
  format: z.enum(['csv', 'json']).default('csv'),
}).strict()

export const relateSchema = z.object({
  type: z.string().min(1).max(64),
  toId: resourceIdSchema,
  confidence: z.number().min(0).max(1).optional(),
}).strict()

export const traverseSchema = z.object({
  start: resourceIdSchema,
  /**
   * 跟哪些关系类型走。**不传 = 本体里声明的全部。**
   *
   * 上限 10 是给"我只关心这几种"用的。要画一张关系图的调用方
   * 得列出 28 个名字，塞不下就只能 slice——而被 slice 掉的部分
   * 不会报错，只会让图安静地少掉几种关系。省略它来表达「全部」。
   */
  follow: z.array(z.string().min(1).max(64)).min(1).max(10).optional(),
  maxDepth: z.number().int().min(1).max(10).default(3),
  direction: z.enum(['out', 'in', 'both']).default('out'),
  /** 返回节点数上限。默认值刻意保守：超出部分由响应里的 truncated 显式告知 */
  limit: z.number().int().min(1).max(5000).default(500),
}).strict()

/**
 * 巡检的扫描上界（FR-ONT-010）。
 *
 * 默认值大到覆盖任何真实规模的租户，同时**仍然是个有限的数**——
 * 一次没有上界的全表扫描不是"偶尔慢"，是这条端点被谁调一下就能
 * 把库拖住。超出的部分由响应里的 `complete: false` 说出来。
 */
export const healthParamsSchema = z.object({
  maxResources: z.coerce.number().int().min(1).max(200_000).default(50_000),
  maxRelations: z.coerce.number().int().min(1).max(200_000).default(50_000),
})

/**
 * 带出处的问答（FR-ONT-011 / FR-RES-009）。
 *
 * 走 GET 而不是 POST：一次问答的结果要能**发给同事**。
 * 这和看板视图为什么有 URL 是同一个理由（docs/dogfooding-log.md #5）。
 */
export const askSchema = z
  .object({
    q: z.string().min(1).max(500),
    /** 焦点对象。给了它，图上的距离参与重排（但不单独召回） */
    near: resourceIdSchema.optional(),
    /**
     * 只在这一类里找。
     *
     * 不只是过滤：中文二元组短于三字符、走不了 trigram 索引，
     * 不带它的话每个词都要扫一遍全租户。**知道自己在找什么的
     * 调用方应该说出来。**
     */
    type: z.string().max(64).optional(),
    limit: z.coerce.number().int().min(1).max(20).default(5),
  })
  .strict()

export const pathSchema = z.object({
  from: resourceIdSchema,
  to: resourceIdSchema,
  maxDepth: z.number().int().min(1).max(10).default(6),
}).strict()

/**
 * 一条自动关系建立规则（FR-ONT-008）。
 *
 * 这里只校验**形状**。合法性（关系类型存在、定义域/值域对得上、
 * 属性名在本体里、置信度严格在 0 与 1 之间）由 `validateRule` 判——
 * 那份规则只有一处实现，在这里重写一遍必然漂移。
 */
export const relationRuleSchema = z
  .object({
    relationType: z.string().min(1).max(64),
    subjectType: z.string().min(1).max(64),
    locator: z.union([
      z.object({ kind: z.literal('idInAttribute'), attribute: z.string().min(1).max(64) }).strict(),
      z
        .object({
          kind: z.literal('attributeEquals'),
          attribute: z.string().min(1).max(64),
          targetType: z.string().min(1).max(64),
          targetAttribute: z.string().min(1).max(64),
        })
        .strict(),
    ]),
    confidence: z.number(),
    enabled: z.boolean().optional(),
    description: z.string().max(500).optional(),
  })
  .strict()

export const relationRuleIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9-]*$/, 'rule id must be lowercase kebab-case')

/**
 * 租户级本体扩展（FR-ONT-009）。
 *
 * 这里只校验**形状**。三条真正的规则（必须带 `x_<tenant>_` 前缀、
 * 必须可选、不能是 derived）由 `validateExtension` 判——
 * 它们要读到基底类型才判得了，而且只该有一处实现。
 */
export const extensionSchema = z
  .object({
    attributes: z
      .array(
        z
          .object({
            name: z.string().min(1).max(64),
            // 和 AttributeKind 逐字对齐。写成 z.string() 更省事，
            // 但那样一个拼错的 kind 要到第一次写对象时才报错
            kind: z.enum([
              'string', 'text', 'richtext', 'int', 'float',
              'percent', 'bool', 'datetime', 'enum', 'ref', 'json',
            ]),
            required: z.boolean().optional(),
            derived: z.boolean().optional(),
            values: z.array(z.string().max(64)).max(50).optional(),
            target: z.string().max(64).optional(),
            maxLength: z.number().int().positive().optional(),
          })
          .strict(),
      )
      .min(1)
      .max(50),
  })
  .strict()

/**
 * 启动一个流程实例（FR-WF-010）。
 *
 * `refs` 把流程定义里的符号名绑到真实对象上——定义里写的是 `release`，
 * 实例才知道是哪一个。绑不上的名字在跑到那一步时会失败，
 * 而不是在启动时——所以这里要求至少给一个，别让一个什么都没绑的实例
 * 一路跑到中间才发现。
 */
export const startProcessSchema = z
  .object({
    processId: z.string().min(1).max(64),
    refs: z.record(resourceIdSchema).refine((r) => Object.keys(r).length > 0, {
      message: 'a process instance must bind at least one resource',
    }),
  })
  .strict()

export const decisionSchema = z
  .object({
    approved: z.boolean(),
    reason: z.string().max(2000).optional(),
  })
  .strict()

export const confirmRelationSchema = z.object({
  confirmed: z.boolean(),
}).strict()

export const relationDirectionSchema = z.enum(['out', 'in', 'both']).default('out')

export type TransitionBody = z.infer<typeof transitionSchema>
export type CreateResourceBody = z.infer<typeof createResourceSchema>
export type UpdateResourceBody = z.infer<typeof updateResourceSchema>
export type QueryBody = z.infer<typeof querySchema>
export type RelateBody = z.infer<typeof relateSchema>
export type TraverseBody = z.infer<typeof traverseSchema>
export type PathBody = z.infer<typeof pathSchema>

/**
 * Dashboard 指标的参数（FR-DASH-005/006）。
 *
 * 指标 id 是点分小写标识（`project.tasks.blocked`），不是资源 id，
 * 所以单独一个 schema 而不是复用 `resourceIdSchema`。
 */
export const metricIdSchema = z.object({ id: z.string().min(1).max(96).regex(/^[a-z][a-z0-9.-]*$/) })

export const metricScopeSchema = z
  .object({
    project: resourceIdSchema.optional(),
    workspace: z.string().max(64).optional(),
  })
  .strict()

/**
 * Automation Rate 的查询参数（FR-DASH-015/016）。
 *
 * `from` / `to` 界定「同期」，按**采纳时刻**落窗。
 * 时间用 ISO 串而不是 epoch 毫秒：指标区间是要被人手写进 URL 的，
 * 而一串数字里的错误没人看得出来。
 */
export const automationRateSchema = metricScopeSchema
  .extend({
    from: z.string().datetime().optional(),
    to: z.string().datetime().optional(),
  })
  .strict()
  .refine((q) => q.from === undefined || q.to === undefined || q.from < q.to, {
    // from > to 会安静地返回一个空区间，看起来像"这段时间没干活"
    message: 'from must be earlier than to',
    path: ['from'],
  })

export const metricBreakdownSchema = metricScopeSchema.extend({
  /** 分布指标里被点开的那一格，如 status=Blocked */
  group: z.string().max(64).optional(),
  size: z.coerce.number().int().min(1).max(200).optional(),
  cursor: z.string().max(64).optional(),
}).strict()

/**
 * 状态机定义（FR-WF-001）。
 *
 * 这里只校验**形状**，合法性（初始状态存在、迁移两端有定义、没有孤岛状态）
 * 由 `WorkflowRegistry.register` 在写入时判——那份规则只有一处实现，
 * 在这里重写一遍必然漂移。
 */
export const lifecycleSchema = z
  .object({
    id: z.string().min(1).max(64).regex(/^[a-z][a-z0-9-]*$/),
    entityType: z.string().min(1).max(64),
    initial: z.string().min(1).max(64),
    states: z
      .array(
        z
          .object({
            name: z.string().min(1).max(64),
            terminal: z.boolean().optional(),
            requires: z.array(z.record(z.unknown())).max(20).optional(),
            entryActions: z.array(z.record(z.unknown())).max(20).optional(),
            slaHours: z.number().int().min(1).max(8760).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(40),
    transitions: z
      .array(
        z
          .object({
            from: z.array(z.string().min(1).max(64)).min(1).max(40),
            to: z.string().min(1).max(64),
            capability: z.string().max(96).optional(),
            /** 从终态重开（ADR-0012）。合法性由 WorkflowRegistry 判，这里只认形状 */
            reopen: z.boolean().optional(),
          })
          .strict(),
      )
      .min(1)
      .max(200),
  })
  .strict()
