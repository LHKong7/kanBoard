import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { api } from '../api.ts'
import {
  AreaChart,
  BarChart,
  foldSeries,
  LineChart,
  PieChart,
  RadarChart,
  ScatterChart,
  TreeMap,
} from '../charts/chart-kit.tsx'
import type { Row } from '../charts/chart-kit.tsx'
import { loadPalette, PALETTES, savePalette, seriesColors, useMode } from '../charts/palette.ts'
import type { PaletteName } from '../charts/palette.ts'

/**
 * 自定义分析：16 种 X 轴维度 × 9 种 Y 轴指标 × 二次分组。
 *
 * 下拉里的选项**全部来自服务端**（`/v1/analytics/dimensions`），
 * 前端一个都不写死。这和看板的列来自状态机是同一条原则：
 * 加一个维度时前端一行都不用改，而漏改的那一行不会报错，
 * 只会让某个维度在界面上不存在。
 */

const X_LABELS: Record<string, string> = {
  STATES: '状态',
  STATE_GROUPS: '状态组',
  PRIORITY: '优先级',
  LABELS: '标签',
  ESTIMATE_POINTS: '估点',
  WORK_ITEM_TYPES: '工作项类型',
  ASSIGNEES: '指派人',
  CREATED_BY: '创建人',
  CYCLES: '周期',
  MODULES: '模块',
  PROJECTS: '项目',
  EPICS: '史诗',
  START_DATE: '开始日期',
  TARGET_DATE: '截止日期',
  CREATED_AT: '创建时间',
  COMPLETED_AT: '完成时间',
}

const Y_LABELS: Record<string, string> = {
  WORK_ITEM_COUNT: '工作项总数',
  ESTIMATE_POINT_COUNT: '估点总和',
  PENDING_WORK_ITEM_COUNT: '待办数',
  IN_PROGRESS_WORK_ITEM_COUNT: '进行中数',
  COMPLETED_WORK_ITEM_COUNT: '已完成数',
  WORK_ITEM_DUE_TODAY_COUNT: '今日到期数',
  WORK_ITEM_DUE_THIS_WEEK_COUNT: '本周到期数',
  BLOCKED_WORK_ITEM_COUNT: '被阻塞数',
  EPIC_WORK_ITEM_COUNT: '史诗数',
}

const DURATION_LABELS: Record<string, string> = {
  YESTERDAY: '昨天',
  LAST_7_DAYS: '近 7 天',
  LAST_30_DAYS: '近 30 天',
  LAST_3_MONTHS: '近 3 个月',
}

const GROUPING_LABELS: Record<string, string> = {
  DAY: '按天',
  WEEK: '按周',
  MONTH: '按月',
  YEAR: '按年',
}

type ChartKind = 'bar' | 'stacked-bar' | 'line' | 'area' | 'pie' | 'radar' | 'scatter' | 'treemap'

const CHART_KINDS: Array<{ key: ChartKind; label: string }> = [
  { key: 'bar', label: '柱状图' },
  { key: 'stacked-bar', label: '堆叠柱' },
  { key: 'line', label: '折线图' },
  { key: 'area', label: '面积图' },
  { key: 'pie', label: '环形图' },
  { key: 'radar', label: '雷达图' },
  { key: 'scatter', label: '散点图' },
  { key: 'treemap', label: '矩形树图' },
]

/**
 * 指南 §5.2 列的高价值组合，做成一键预设。
 *
 * 不是为了省几次点击：**大多数人不知道该问什么**。
 * 一个 16 × 9 的空白下拉是个糟糕的起点，
 * 而"谁手上并行任务过多"是一个人一眼就懂的问题。
 */
const PRESETS: Array<{
  label: string
  question: string
  x: string
  y: string
  group?: string
  grouping?: string
  kind: ChartKind
}> = [
  {
    label: '并行任务过多的人',
    question: '单人超过 3 个进行中就该干预',
    x: 'ASSIGNEES',
    y: 'IN_PROGRESS_WORK_ITEM_COUNT',
    kind: 'bar',
  },
  {
    label: '负载是否均衡',
    question: '按状态组看每个人手上的估点',
    x: 'ASSIGNEES',
    y: 'ESTIMATE_POINT_COUNT',
    group: 'STATE_GROUPS',
    kind: 'stacked-bar',
  },
  {
    label: '哪个领域积压最重',
    question: '标签 × 状态组',
    x: 'LABELS',
    y: 'WORK_ITEM_COUNT',
    group: 'STATE_GROUPS',
    kind: 'stacked-bar',
  },
  {
    label: '团队速率曲线',
    question: '按周聚合的完成估点，用于预测',
    x: 'COMPLETED_AT',
    y: 'ESTIMATE_POINT_COUNT',
    grouping: 'WEEK',
    kind: 'line',
  },
  {
    label: '高优先级是不是被卡住了',
    question: '优先级 × 被阻塞数',
    x: 'PRIORITY',
    y: 'BLOCKED_WORK_ITEM_COUNT',
    kind: 'bar',
  },
  {
    label: '哪个模块离交付最远',
    question: '模块 × 待办数，按优先级堆叠',
    x: 'MODULES',
    y: 'PENDING_WORK_ITEM_COUNT',
    group: 'PRIORITY',
    kind: 'stacked-bar',
  },
  {
    label: '需求 / Bug 的结构变化',
    question: '按月聚合的创建量，按类型堆叠',
    x: 'CREATED_AT',
    y: 'WORK_ITEM_COUNT',
    group: 'WORK_ITEM_TYPES',
    grouping: 'MONTH',
    kind: 'area',
  },
  {
    label: '优先级分布',
    question: 'Urgent + High 超过 40% 就说明优先级已经失效',
    x: 'PRIORITY',
    y: 'WORK_ITEM_COUNT',
    kind: 'pie',
  },
]

const DATE_AXES = ['START_DATE', 'TARGET_DATE', 'CREATED_AT', 'COMPLETED_AT']

export function Analytics({ types }: { types: string[] }): ReactNode {
  const mode = useMode()
  const [palette, setPalette] = useState<PaletteName>(() => loadPalette())
  const [dims, setDims] = useState<{ xAxes: string[]; yMetrics: string[]; durations: string[] } | null>(
    null,
  )

  const [xAxis, setXAxis] = useState('PRIORITY')
  const [yMetric, setYMetric] = useState('WORK_ITEM_COUNT')
  const [groupBy, setGroupBy] = useState('')
  const [grouping, setGrouping] = useState('')
  const [duration, setDuration] = useState('')
  const [type, setType] = useState('Task')
  const [kind, setKind] = useState<ChartKind>('bar')

  const [data, setData] = useState<{ rows: Row[]; groups: string[]; total: number } | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    api
      .analyticsDimensions()
      .then(setDims)
      .catch((e: unknown) => setFailed(String(e instanceof Error ? e.message : e)))
  }, [])

  useEffect(() => {
    const params: Record<string, string> = { x_axis: xAxis, y_metric: yMetric }
    if (groupBy !== '') params['group_by'] = groupBy
    if (grouping !== '' && DATE_AXES.includes(xAxis)) params['date_grouping'] = grouping
    if (duration !== '') params['duration'] = duration
    if (type !== '') params['type'] = type

    setLoading(true)
    api
      .analytics(params)
      .then((result) => {
        // 超过 8 条序列折叠成「其他」，而不是循环取色
        const folded = foldSeries(result.rows as Row[], result.groups)
        setData({ rows: folded.rows, groups: folded.groups, total: result.total })
        setFailed(null)
      })
      .catch((e: unknown) => {
        setFailed(String(e instanceof Error ? e.message : e))
        setData(null)
      })
      .finally(() => setLoading(false))
  }, [xAxis, yMetric, groupBy, grouping, duration, type])

  const colors = seriesColors(palette, mode)
  const xLabel = X_LABELS[xAxis] ?? xAxis
  const unit = `${Y_LABELS[yMetric] ?? yMetric}${groupBy === '' ? '' : ` · 按${X_LABELS[groupBy] ?? groupBy}分组`}`

  function applyPreset(preset: (typeof PRESETS)[number]): void {
    setXAxis(preset.x)
    setYMetric(preset.y)
    setGroupBy(preset.group ?? '')
    setGrouping(preset.grouping ?? '')
    setKind(preset.kind)
  }

  return (
    <section className="analytics">
      <div className="analytics-presets">
        {PRESETS.map((preset) => (
          <button
            key={preset.label}
            className="btn ghost"
            data-preset={preset.label}
            title={preset.question}
            onClick={() => applyPreset(preset)}
          >
            {preset.label}
          </button>
        ))}
      </div>

      {/* 筛选器排一行，放在图上方：图在下、控件在上是唯一不会让人
          找不到控件的排法 */}
      <div className="analytics-controls">
        <label>
          X 轴
          <select value={xAxis} onChange={(e) => setXAxis(e.target.value)} data-control="x">
            {(dims?.xAxes ?? []).map((axis) => (
              <option key={axis} value={axis}>
                {X_LABELS[axis] ?? axis}
              </option>
            ))}
          </select>
        </label>
        <label>
          Y 轴
          <select value={yMetric} onChange={(e) => setYMetric(e.target.value)} data-control="y">
            {(dims?.yMetrics ?? []).map((metric) => (
              <option key={metric} value={metric}>
                {Y_LABELS[metric] ?? metric}
              </option>
            ))}
          </select>
        </label>
        <label>
          二次分组
          <select value={groupBy} onChange={(e) => setGroupBy(e.target.value)} data-control="group">
            <option value="">不分组</option>
            {(dims?.xAxes ?? [])
              // 和 X 轴同一个维度会被服务端拒掉，所以这里先不给选
              .filter((axis) => axis !== xAxis)
              .map((axis) => (
                <option key={axis} value={axis}>
                  {X_LABELS[axis] ?? axis}
                </option>
              ))}
          </select>
        </label>
        {DATE_AXES.includes(xAxis) && (
          <label>
            粒度
            <select value={grouping} onChange={(e) => setGrouping(e.target.value)} data-control="grouping">
              <option value="">按天</option>
              {Object.entries(GROUPING_LABELS).map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </select>
          </label>
        )}
        <label>
          时间范围
          <select value={duration} onChange={(e) => setDuration(e.target.value)} data-control="duration">
            <option value="">全部</option>
            {(dims?.durations ?? []).map((d) => (
              <option key={d} value={d}>
                {DURATION_LABELS[d] ?? d}
              </option>
            ))}
          </select>
        </label>
        <label>
          对象类型
          <select value={type} onChange={(e) => setType(e.target.value)} data-control="type">
            <option value="">全部</option>
            {types.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>
        <label>
          图形
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as ChartKind)}
            data-control="kind"
          >
            {CHART_KINDS.map((c) => (
              <option key={c.key} value={c.key}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          配色
          <select
            value={palette}
            onChange={(e) => {
              const next = e.target.value as PaletteName
              setPalette(next)
              savePalette(next)
            }}
            data-control="palette"
          >
            {PALETTES.map((p) => (
              <option key={p.name} value={p.name}>
                {p.label} —— {p.note}
              </option>
            ))}
          </select>
        </label>
      </div>

      {failed !== null && (
        <div className="board-empty" data-analytics-error>
          <h3>这个组合画不出来</h3>
          <p>{failed}</p>
        </div>
      )}

      {failed === null && data !== null && data.rows.length === 0 && (
        <div className="board-empty">
          <h3>没有数据</h3>
          <p>当前筛选条件下没有任何对象。换个类型或放宽时间范围。</p>
        </div>
      )}

      {failed === null && data !== null && data.rows.length > 0 && (
        <div className="analytics-chart" data-chart={kind} aria-busy={loading}>
          <h3 className="analytics-title">
            {unit} · 按{xLabel}
          </h3>
          <Render kind={kind} data={data} colors={colors} mode={mode} unit={unit} xLabel={xLabel} />
        </div>
      )}
    </section>
  )
}

function Render({
  kind,
  data,
  colors,
  mode,
  unit,
  xLabel,
}: {
  kind: ChartKind
  data: { rows: Row[]; groups: string[] }
  colors: readonly string[]
  mode: ReturnType<typeof useMode>
  unit: string
  xLabel: string
}): ReactNode {
  const common = { rows: data.rows, groups: data.groups, colors, mode, unit, xLabel }

  // 饼图与树图只能表达一维构成，所以只取第一条序列。
  // 硬把二次分组塞进去的话，扇区加起来会超过 100%
  const flat: Row[] = data.rows.map((row) => ({
    key: String(row['key']),
    value: data.groups.reduce((sum, group) => sum + Number(row[group] ?? 0), 0),
  }))

  switch (kind) {
    case 'bar':
      return <BarChart {...common} />
    case 'stacked-bar':
      return <BarChart {...common} stacked />
    case 'line':
      return <LineChart {...common} />
    case 'area':
      return <AreaChart {...common} stacked={data.groups.length > 1} />
    case 'pie':
      return <PieChart rows={flat} colors={colors} mode={mode} unit={unit} xLabel={xLabel} />
    case 'radar':
      return <RadarChart {...common} />
    case 'scatter':
      return <ScatterChart {...common} />
    case 'treemap':
      return <TreeMap rows={flat} colors={colors} mode={mode} unit={unit} xLabel={xLabel} />
    default:
      return null
  }
}
