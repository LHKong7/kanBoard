import { sql } from 'kysely'
import type { RawBuilder } from 'kysely'
import type { Db } from './db/client.ts'
import type { AnalyticsQuery, AnalyticsRepository } from '../domain/analytics/ports.ts'
import { NONE_KEY } from '../domain/analytics/spec.ts'
import type { ChartCell, ChartXAxis, DateGrouping } from '../domain/analytics/spec.ts'
import type { ResourceFilter } from '../domain/resource/ports.ts'

/**
 * 自定义分析的取数（16 维 × 9 指标 × 二次分组）。
 *
 * **一条 SQL 算完**，不是先把行拉回来再在内存里分组。
 * 这不是性能洁癖：分析这条路径上没有分页，一个百万行的租户
 * 会把进程打死，而症状是整个服务变慢，不是这一个接口变慢。
 *
 * 结构是三层：
 *
 *   sg    —— (类型, 状态) → 状态组 的对照表，由调用方从工作流注册表装配
 *   base  —— 过滤之后的工作项，外加算好的状态组、估点、到期日、是否被阻塞
 *   外层  —— 挂上 X / group 两个维度的横向展开，再分组聚合
 *
 * 维度里有三种要**横向展开**（标签、周期、模块、史诗）：一个工作项
 * 属于两个模块时，它在两个模块下各算一次。这是有意的——
 * 让它只算在"第一个"模块下的话，两个模块的进度加起来永远小于总量，
 * 而没有人看得出少了什么。
 */
export class PgAnalyticsRepository implements AnalyticsRepository {
  readonly #db: Db
  readonly #tenant: string

  constructor(db: Db, tenant: string) {
    this.#db = db
    this.#tenant = tenant
  }

  async chart(query: AnalyticsQuery): Promise<ChartCell[]> {
    const xDim = dimension(query.xAxis, query.dateGrouping, 'xd')
    const gDim =
      query.groupBy === null ? null : dimension(query.groupBy, query.groupDateGrouping, 'gd')

    const statement = sql<{ xkey: string | null; gkey: string | null; value: string | null }>`
      WITH sg (entity_type, status, grp) AS (${stateGroupValues(query)}),
      base AS (
        SELECT
          r.id,
          r.tenant,
          r.type,
          r.status,
          r.owner,
          r.created_by,
          r.project,
          r.labels,
          r.attributes,
          r.created_at,
          COALESCE(sg.grp, ${NONE_KEY}) AS grp,
          ${POINTS_EXPR} AS points,
          ${tsOf(sql.raw('r.attributes'), 'dueDate')} AS due_at,
          EXISTS (
            SELECT 1 FROM relations br
            WHERE br.tenant = r.tenant
              AND (
                (br.type = 'blockedBy' AND br.from_id = r.id)
                OR (br.type = 'blocks' AND br.to_id = r.id)
              )
          ) AS is_blocked
        FROM resources r
        LEFT JOIN sg ON sg.entity_type = r.type AND sg.status = r.status
        WHERE ${whereOf(query)}
      )
      SELECT ${xDim.expr} AS xkey, ${gDim === null ? sql`NULL` : gDim.expr} AS gkey, ${aggregateOf(query)} AS value
      FROM base b
      ${xDim.join ?? sql``}
      ${gDim?.join ?? sql``}
      GROUP BY 1, 2
    `

    const result = await statement.execute(this.#db)
    return (result.rows as Array<{ xkey: string | null; gkey: string | null; value: string | null }>)
      .map((row) => ({
        x: row.xkey ?? NONE_KEY,
        group: row.gkey,
        value: Number(row.value ?? 0),
      }))
      // 值为 0 的格子照样返回：一个"本周到期 0 条"的负责人是有意义的信息，
      // 而滤掉之后他会从图上整个消失，看起来像没有这个人
      .filter((cell) => Number.isFinite(cell.value))
  }
}

/**
 * 估点：Story 用 `storyPoint`，Task 用 `estimate`。
 *
 * 两个名字合成一个数值，因为 Y 轴上的"估点总和"不该关心
 * 这条是 Story 还是 Task——问的是工作量，不是类型。
 * 非数值的一律当 0：`jsonb_typeof` 先判过，一个被写成字符串的估点
 * 会被排除而不是让整条 SQL 报错。
 */
const POINTS_EXPR = sql`
  CASE
    WHEN jsonb_typeof(r.attributes -> 'storyPoint') = 'number'
      THEN (r.attributes ->> 'storyPoint')::numeric
    WHEN jsonb_typeof(r.attributes -> 'estimate') = 'number'
      THEN (r.attributes ->> 'estimate')::numeric
    ELSE 0
  END`

/**
 * 从 JSONB 里取一个时间戳，**取不出来就当空**。
 *
 * Postgres 没有 TRY_CAST：一行里存着 `"tomorrow"` 会让整条查询报错，
 * 而那意味着一条脏数据能让整个分析页打不开。先用正则挡一道，
 * 形状不对的当成没填——图上少一个点，好过整张图没有。
 */
function tsOf(container: RawBuilder<unknown>, key: string): RawBuilder<Date | null> {
  return sql<Date | null>`
    CASE WHEN ${container} ->> ${key} ~ '^\\d{4}-\\d{2}-\\d{2}'
      THEN (${container} ->> ${key})::timestamptz
    END`
}

function stateGroupValues(query: AnalyticsQuery): RawBuilder<unknown> {
  // 一台状态机都没有时也要生成一行，否则 `VALUES ()` 是语法错误。
  // 用一行不可能匹配上的占位，效果等同于空表
  const rows =
    query.stateGroups.length === 0
      ? [sql`(${''}::text, ${''}::text, ${''}::text)`]
      : query.stateGroups.map(
          (row) => sql`(${row.entityType}::text, ${row.status}::text, ${row.group}::text)`,
        )
  return sql`VALUES ${sql.join(rows, sql`, `)}`
}

/**
 * 过滤条件。
 *
 * 和 `PgResourceRepository.#applyFilter` 是同一套语义，但这里是裸 SQL——
 * 两处必须保持一致，否则图上的数字和点开的明细会对不上。
 * 共用不了的原因是那边是 Kysely 的 builder 链，接不进这条 CTE。
 */
function whereOf(query: AnalyticsQuery): RawBuilder<boolean> {
  const filter: ResourceFilter = query.filter
  // 租户由 RLS 兜底，这里不再重复一条 tenant = … ——重复的那条
  // 会让人以为隔离靠的是它，于是某天有人删掉 RLS 时测试还是绿的
  const parts: RawBuilder<boolean>[] = [sql<boolean>`r.deleted_at IS NULL`]
  if (filter.type !== undefined) parts.push(sql<boolean>`r.type = ${filter.type}`)
  if (filter.workspace !== undefined) parts.push(sql<boolean>`r.workspace = ${filter.workspace}`)
  if (filter.project !== undefined) parts.push(sql<boolean>`r.project = ${filter.project}`)
  if (filter.owner !== undefined) parts.push(sql<boolean>`r.owner = ${filter.owner}`)
  if (filter.status !== undefined && filter.status.length > 0) {
    parts.push(sql<boolean>`r.status = ANY(${filter.status as string[]})`)
  }
  if (filter.labels !== undefined && filter.labels.length > 0) {
    parts.push(sql<boolean>`r.labels @> ${filter.labels as string[]}`)
  }
  if (filter.attributes !== undefined && Object.keys(filter.attributes).length > 0) {
    parts.push(sql<boolean>`r.attributes @> ${JSON.stringify(filter.attributes)}::jsonb`)
  }
  if (query.window !== null) {
    parts.push(sql<boolean>`r.created_at >= ${query.window.from}`)
    parts.push(sql<boolean>`r.created_at < ${query.window.to}`)
  }
  return sql<boolean>`${sql.join(parts, sql` AND `)}`
}

/**
 * Y 轴：九种聚合。
 *
 * 六种是带条件的计数，写成 `COUNT(*) FILTER (WHERE …)` 而不是
 * 在 WHERE 里筛：筛掉的话，一个"进行中 0 条"的分组会整个消失，
 * 而它恰恰是要看的东西——那个人手上一件在做的都没有。
 */
function aggregateOf(query: AnalyticsQuery): RawBuilder<string> {
  const openAndDue = (from: RawBuilder<unknown>, to: RawBuilder<unknown>): RawBuilder<string> =>
    sql<string>`COUNT(*) FILTER (
      WHERE b.due_at >= ${from} AND b.due_at < ${to}
        AND b.grp NOT IN ('Completed', 'Cancelled')
    )`

  const today = sql`date_trunc('day', ${query.now}::timestamptz)`
  const tomorrow = sql`${today} + interval '1 day'`
  const nextWeek = sql`${today} + interval '7 days'`

  switch (query.yMetric) {
    case 'WORK_ITEM_COUNT':
      return sql<string>`COUNT(*)`
    case 'ESTIMATE_POINT_COUNT':
      return sql<string>`COALESCE(SUM(b.points), 0)`
    case 'PENDING_WORK_ITEM_COUNT':
      // Triage 也算待办：还没分诊的东西是待办的，只是还没人决定要不要做
      return sql<string>`COUNT(*) FILTER (WHERE b.grp IN ('Triage', 'Backlog', 'Unstarted'))`
    case 'IN_PROGRESS_WORK_ITEM_COUNT':
      return sql<string>`COUNT(*) FILTER (WHERE b.grp = 'Started')`
    case 'COMPLETED_WORK_ITEM_COUNT':
      return sql<string>`COUNT(*) FILTER (WHERE b.grp = 'Completed')`
    case 'WORK_ITEM_DUE_TODAY_COUNT':
      return openAndDue(today, tomorrow)
    case 'WORK_ITEM_DUE_THIS_WEEK_COUNT':
      return openAndDue(today, nextWeek)
    case 'BLOCKED_WORK_ITEM_COUNT':
      return sql<string>`COUNT(*) FILTER (WHERE b.is_blocked)`
    case 'EPIC_WORK_ITEM_COUNT':
      return sql<string>`COUNT(*) FILTER (
        WHERE b.type = 'Requirement' AND b.attributes ->> 'level' = 'Epic'
      )`
    default: {
      const exhaustive: never = query.yMetric
      throw new Error(`unhandled y metric: ${String(exhaustive)}`)
    }
  }
}

type Dimension = {
  expr: RawBuilder<string | null>
  /** 需要横向展开的维度带一个 LATERAL 连接 */
  join?: RawBuilder<unknown>
}

/** 时间分桶格式。四档都选**字典序即时间序**的写法，于是排序不需要另外解析一次 */
const DATE_FORMATS: Record<DateGrouping, string> = {
  DAY: 'YYYY-MM-DD',
  // ISO 周：`IYYY` 与 `IW` 必须成对用。配 `YYYY` 的话，
  // 跨年那一周会被算到错误的年份上（12 月 31 日可能属于下一年的第 1 周）
  WEEK: 'IYYY-"W"IW',
  MONTH: 'YYYY-MM',
  YEAR: 'YYYY',
}

function dateBucket(value: RawBuilder<Date | null>, grouping: DateGrouping): RawBuilder<string | null> {
  return sql<string | null>`to_char(${value}, ${DATE_FORMATS[grouping]})`
}

/**
 * 一个维度怎么取值。
 *
 * `alias` 让 X 和 group 各自的 LATERAL 有不同的名字——两个维度都需要
 * 横向展开时（比如"标签 × 模块"），同名会直接是 SQL 错误。
 */
function dimension(axis: ChartXAxis, grouping: DateGrouping | null, alias: string): Dimension {
  const none = (expr: RawBuilder<string | null>): RawBuilder<string | null> =>
    sql<string | null>`COALESCE(NULLIF(${expr}, ''), ${NONE_KEY})`
  const a = sql.raw(alias)

  switch (axis) {
    case 'STATES':
      return { expr: none(sql<string | null>`b.status`) }
    case 'STATE_GROUPS':
      return { expr: none(sql<string | null>`b.grp`) }
    case 'PRIORITY':
      // 没填的按 `None` 归档，和本体里那个显式的 None 归成一桶：
      // 分成两桶的话，"多少条还没定优先级"会被拆成两个数
      return { expr: sql<string | null>`COALESCE(b.attributes ->> 'priority', 'None')` }
    case 'WORK_ITEM_TYPES':
      return { expr: none(sql<string | null>`b.type`) }
    case 'ASSIGNEES':
      /**
       * 指派人：Task 有 `assignee` 属性，Story 没有——它落在 owner 上。
       * 两者合并成一个维度，因为"谁手上并行任务过多"这个问题
       * 不区分那件事是 Story 还是 Task。
       */
      return { expr: none(sql<string | null>`COALESCE(b.attributes ->> 'assignee', b.owner)`) }
    case 'CREATED_BY':
      return { expr: none(sql<string | null>`b.created_by`) }
    case 'PROJECTS':
      return { expr: none(sql<string | null>`b.project`) }
    case 'ESTIMATE_POINTS':
      // 估点当成刻度而不是数值：`3` 和 `3.0` 要落在同一桶里
      return {
        expr: sql<string | null>`CASE WHEN b.points = 0 THEN ${NONE_KEY} ELSE trim_scale(b.points)::text END`,
      }
    case 'LABELS':
      return {
        expr: none(sql<string | null>`${a}.value`),
        join: sql`LEFT JOIN LATERAL unnest(b.labels) AS ${a}(value) ON TRUE`,
      }
    case 'CYCLES':
      return relationDimension(alias, 'plannedIn', 'plans')
    case 'MODULES':
      return relationDimension(alias, 'inModule', 'moduleIncludes')
    case 'EPICS':
      return epicDimension(alias)
    case 'START_DATE':
      return { expr: dateBucket(tsOf(sql.raw('b.attributes'), 'startDate'), grouping ?? 'DAY') }
    case 'TARGET_DATE':
      return { expr: dateBucket(sql<Date | null>`b.due_at`, grouping ?? 'DAY') }
    case 'CREATED_AT':
      return { expr: dateBucket(sql<Date | null>`b.created_at`, grouping ?? 'DAY') }
    case 'COMPLETED_AT':
      return { expr: dateBucket(tsOf(sql.raw('b.attributes'), 'completedAt'), grouping ?? 'DAY') }
    default: {
      const exhaustive: never = axis
      throw new Error(`unhandled x axis: ${String(exhaustive)}`)
    }
  }
}

/**
 * 沿一条关系走到的容器（周期 / 模块）。
 *
 * **两个存储方向都查**：同一件事既可以存成 Task ─plannedIn→ Sprint，
 * 也可以存成 Sprint ─plans→ Task（从周期那一侧拖进来时就是后者）。
 * 只查一边的话，一半的数据会落进"未指定"，而图看起来完全正常。
 */
function relationDimension(alias: string, forward: string, backward: string): Dimension {
  const a = sql.raw(alias)
  return {
    expr: sql<string | null>`COALESCE(${a}.label, ${NONE_KEY})`,
    join: sql`
      LEFT JOIN LATERAL (
        SELECT COALESCE(c.attributes ->> 'name', c.id) AS label
        FROM relations rel
        JOIN resources c
          ON c.id = CASE WHEN rel.type = ${forward} THEN rel.to_id ELSE rel.from_id END
         AND c.deleted_at IS NULL
        WHERE rel.tenant = b.tenant
          AND (
            (rel.type = ${forward} AND rel.from_id = b.id)
            OR (rel.type = ${backward} AND rel.to_id = b.id)
          )
      ) AS ${a} ON TRUE`,
  }
}

/**
 * 史诗：工作项**归到哪个 Epic 级需求下**。
 *
 * 两条路径合起来看，因为层级本来就有两层：
 *
 *   Story ─implements→ Requirement(level=Epic)
 *   Task  ─partOf→ Story ─implements→ Requirement(level=Epic)
 *
 * 只查一跳的话，所有 Task 都会落进"未指定"——而 Task 恰恰是数量最多的那一类，
 * 于是这个维度看起来像是没数据，而不是像少了一半。
 */
function epicDimension(alias: string): Dimension {
  const a = sql.raw(alias)
  const parentAlias = sql.raw(`${alias}_parent`)
  const epicOf = (itemId: RawBuilder<unknown>) => sql`
    SELECT COALESCE(e.attributes ->> 'title', e.id) AS label
    FROM relations rel
    JOIN resources e
      ON e.id = CASE WHEN rel.type = 'implements' THEN rel.to_id ELSE rel.from_id END
     AND e.deleted_at IS NULL
     AND e.type = 'Requirement'
     AND e.attributes ->> 'level' = 'Epic'
    WHERE rel.tenant = b.tenant
      AND (
        (rel.type = 'implements' AND rel.from_id = ${itemId})
        OR (rel.type = 'implementedBy' AND rel.to_id = ${itemId})
      )`

  // 父 Story 的 LATERAL 必须**排在前面**：LATERAL 只看得见它左边的东西，
  // 写反了不是查不到数据，是直接的 SQL 错误（parent 未定义）
  return {
    expr: sql<string | null>`COALESCE(${a}.label, ${NONE_KEY})`,
    join: sql`
      LEFT JOIN LATERAL (
        SELECT CASE WHEN pr.type = 'partOf' THEN pr.to_id ELSE pr.from_id END AS story_id
        FROM relations pr
        WHERE pr.tenant = b.tenant
          AND (
            (pr.type = 'partOf' AND pr.from_id = b.id)
            OR (pr.type = 'decomposedInto' AND pr.to_id = b.id)
          )
      ) AS ${parentAlias} ON TRUE
      LEFT JOIN LATERAL (
        ${epicOf(sql`b.id`)}
        UNION
        ${epicOf(sql.raw(`${alias}_parent.story_id`))}
      ) AS ${a} ON TRUE`,
  }
}
