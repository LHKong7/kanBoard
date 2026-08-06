import { useId, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { colorOf, INK } from './palette.ts'
import type { Mode } from './palette.ts'

/**
 * 图表原语。全部是手写的内联 SVG，没有引入图表库。
 *
 * 理由不是"不想加依赖"，是这套图的要求很具体：
 * 堆叠段之间要留 2px **背景色**的缝（不是描边）、数据端 4px 圆角而根部是方的、
 * 端点要带 2px 背景色的环、亮暗两套主题各自验算过配色。
 * 这些在通用图表库里多半是"配不出来"或者"配出来但下个版本就变了"。
 *
 * 每个图都遵守同一组规格（见 dataviz 的 marks-and-anatomy）：
 *
 *   柱 / 条   ≤ 24px 粗，数据端 4px 圆角，根部方角，从同一条基线长出
 *   线        2px，圆角接头
 *   标记点    直径 ≥ 8px，带 2px 背景色环
 *   面积填充  序列色 10% 不透明度——一层薄雾，不是一块实色
 *   网格线    比背景深一档的灰，1px 实线，永远不用虚线
 *
 * 两条负空间规则做的是分隔的活：**2px 的缝**隔开相接的两块填充，
 * **2px 的环**让重叠的点仍然认得出。都不用描边——描边是不承载数据的墨。
 */

export type Row = Record<string, string | number>

export type ChartProps = {
  rows: readonly Row[]
  /** 分组名。一条序列时是 `['value']` */
  groups: readonly string[]
  colors: readonly string[]
  mode: Mode
  height?: number
  /** Y 轴标签，用于 tooltip 与无障碍描述 */
  unit?: string
  /** 表格视图的列名（X 轴那一列） */
  xLabel?: string
}

/** 超过这个条数就折叠成「其他」。第 9 个色相在 CVD 下必然和前面某个重合 */
export const MAX_SERIES = 8
export const OTHER = '其他'

/**
 * 把超出 8 条的序列折叠成「其他」。
 *
 * 不是截断——截断会让总量对不上，而**一张加起来不等于总数的图
 * 比一张粗糙的图糟得多**：它让人怀疑所有数字。
 */
export function foldSeries(
  rows: readonly Row[],
  groups: readonly string[],
): { rows: Row[]; groups: string[] } {
  if (groups.length <= MAX_SERIES) return { rows: [...rows], groups: [...groups] }

  // 按总量排，留下最大的 7 条，其余合并
  const totals = new Map<string, number>()
  for (const group of groups) {
    totals.set(group, rows.reduce((sum, row) => sum + Number(row[group] ?? 0), 0))
  }
  const ranked = [...groups].sort((a, b) => (totals.get(b) ?? 0) - (totals.get(a) ?? 0))
  const kept = ranked.slice(0, MAX_SERIES - 1)
  const folded = ranked.slice(MAX_SERIES - 1)

  return {
    groups: [...kept, OTHER],
    rows: rows.map((row) => {
      const next: Row = { key: row['key'] as string }
      for (const group of kept) next[group] = Number(row[group] ?? 0)
      next[OTHER] = folded.reduce((sum, group) => sum + Number(row[group] ?? 0), 0)
      return next
    }),
  }
}

const PAD = { top: 16, right: 16, bottom: 44, left: 52 }
/** 相接的两块填充之间的缝。用背景色画，不是描边 */
const GAP = 2
const MAX_BAR = 24

/**
 * Y 轴刻度。
 *
 * **最后一格必须 ≥ 最大值**——顶格算错的后果不是"轴不好看"，
 * 是最高的那根柱子/ 那个点被画到绘图区外面去，压在标题上。
 * 34 配上 0/10/20/30 这组刻度就会这样：曲线的起点跑到了图的上方，
 * 而图本身看不出任何异常。
 */
function niceTicks(max: number, count = 4): number[] {
  if (max <= 0) return [0]
  const rough = max / count
  const magnitude = 10 ** Math.floor(Math.log10(rough))
  const step = [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((s) => s >= rough) ?? magnitude * 10
  const top = Math.ceil(max / step) * step
  const ticks: number[] = []
  for (let value = 0; value < top; value += step) ticks.push(Math.round(value * 100) / 100)
  ticks.push(Math.round(top * 100) / 100)
  return ticks
}

function sumRow(row: Row, groups: readonly string[]): number {
  return groups.reduce((sum, group) => sum + Number(row[group] ?? 0), 0)
}

/** 截断过长的刻度文字。**测量后截断**，不靠 CSS 溢出隐藏 */
function short(text: string, max = 12): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

type Hover = { x: number; y: number; title: string; entries: Array<[string, number, string]> } | null

/**
 * 悬浮提示。
 *
 * 默认就有，不是可选项：一张 HTML 图表**本来就是可交互的**，
 * 而"这个点具体是多少"是读图的人第一个会问的问题。
 * 没有它，唯一的答案是去数网格线。
 */
function Tooltip({ hover, mode }: { hover: Hover; mode: Mode }): ReactNode {
  if (hover === null) return null
  const ink = INK[mode]
  return (
    <div
      className="chart-tooltip"
      style={{
        left: hover.x,
        top: hover.y,
        background: ink['surface'],
        color: ink['text'],
        borderColor: ink['grid'],
      }}
      role="status"
    >
      <div className="chart-tooltip-title">{hover.title}</div>
      {hover.entries.map(([name, value, color]) => (
        <div className="chart-tooltip-row" key={name}>
          <span className="chart-tooltip-swatch" style={{ background: color }} aria-hidden="true" />
          <span className="chart-tooltip-name">{name === 'value' ? '数量' : name}</span>
          <span className="chart-tooltip-value">{value}</span>
        </div>
      ))}
    </div>
  )
}

/**
 * 图例。
 *
 * 两条以上序列**一定有**，因为它是唯一可靠的身份通道——
 * 让人靠比对颜色去认序列，在色觉异常时直接失效。
 * 只有一条序列时不画：那个框只是把标题又说了一遍，白占地方。
 */
export function Legend({
  groups,
  colors,
  mode,
}: {
  groups: readonly string[]
  colors: readonly string[]
  mode: Mode
}): ReactNode {
  if (groups.length < 2) return null
  return (
    <ul className="chart-legend" style={{ color: INK[mode]['secondary'] }}>
      {groups.map((group) => (
        <li key={group}>
          <span
            className="chart-legend-swatch"
            style={{ background: colorOf(groups, group, colors) }}
            aria-hidden="true"
          />
          {group}
        </li>
      ))}
    </ul>
  )
}

/**
 * 表格视图。
 *
 * 每张图都配一份。它同时解决三件事：色觉异常的读者、读屏软件、
 * 以及"我想把这几个数抄出去"。**不是可选的无障碍补丁**——
 * 对比度检查里那几个 WARN 正是靠它才合法。
 */
export function ChartTable({
  rows,
  groups,
  xLabel = '刻度',
}: {
  rows: readonly Row[]
  groups: readonly string[]
  xLabel?: string | undefined
}): ReactNode {
  return (
    <table className="chart-table">
      <caption className="visually-hidden">图表数据</caption>
      <thead>
        <tr>
          <th scope="col">{xLabel}</th>
          {groups.map((group) => (
            <th scope="col" key={group}>
              {group === 'value' ? '数量' : group}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={String(row['key'])}>
            <th scope="row">{String(row['key'])}</th>
            {groups.map((group) => (
              <td key={group}>{Number(row[group] ?? 0)}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

type AxisFrameProps = ChartProps & {
  children: (ctx: {
    width: number
    height: number
    plotW: number
    plotH: number
    max: number
    bandW: number
    scaleY: (value: number) => number
    setHover: (hover: Hover) => void
  }) => ReactNode
  /** 堆叠时按行求和取最大值，分组时按单值取最大值 */
  stacked?: boolean
  hideXTicks?: boolean
}

/**
 * 带坐标轴的图的公共骨架：网格、刻度、基线、图例、tooltip、表格。
 *
 * 抽出来是因为这四种图（面积 / 柱 / 折线 / 散点）的坐标轴行为必须
 * **一模一样**——刻度取整规则不同的两张图放在一起，读者会以为
 * 它们的量纲不同。
 */
function AxisFrame(props: AxisFrameProps): ReactNode {
  const { rows, groups, colors, mode, height = 260, stacked = false, unit, xLabel } = props
  const [hover, setHover] = useState<Hover>(null)
  const ink = INK[mode]
  const width = 640
  const plotW = width - PAD.left - PAD.right
  const plotH = height - PAD.top - PAD.bottom

  const max = useMemo(() => {
    const values = rows.map((row) =>
      stacked ? sumRow(row, groups) : Math.max(...groups.map((g) => Number(row[g] ?? 0)), 0),
    )
    return Math.max(...values, 0)
  }, [rows, groups, stacked])

  const ticks = niceTicks(max)
  const top = ticks[ticks.length - 1] ?? 1
  const scaleY = (value: number): number => plotH - (top === 0 ? 0 : (value / top) * plotH)
  const bandW = rows.length === 0 ? plotW : plotW / rows.length

  return (
    <figure className="chart-figure">
      <div className="chart-plot" onMouseLeave={() => setHover(null)}>
        <svg
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-label={`图表，共 ${rows.length} 个刻度、${groups.length} 条序列`}
          className="chart-svg"
        >
          <g transform={`translate(${PAD.left} ${PAD.top})`}>
            {/* 网格：1px 实线，比背景深一档。永远不用虚线——虚线会和"这是预测值"的含义打架 */}
            {ticks.map((tick) => (
              <g key={tick}>
                <line
                  x1={0}
                  x2={plotW}
                  y1={scaleY(tick)}
                  y2={scaleY(tick)}
                  stroke={ink['grid']}
                  strokeWidth={1}
                />
                <text
                  x={-8}
                  y={scaleY(tick)}
                  textAnchor="end"
                  dominantBaseline="middle"
                  fontSize={11}
                  fill={ink['muted']}
                >
                  {tick.toLocaleString()}
                </text>
              </g>
            ))}
            <line x1={0} x2={plotW} y1={plotH} y2={plotH} stroke={ink['axis']} strokeWidth={1} />

            {props.children({ width, height, plotW, plotH, max: top, bandW, scaleY, setHover })}

            {!props.hideXTicks &&
              rows.map((row, index) => (
                <text
                  key={String(row['key'])}
                  x={index * bandW + bandW / 2}
                  y={plotH + 18}
                  textAnchor="middle"
                  fontSize={11}
                  fill={ink['muted']}
                >
                  {short(String(row['key']), rows.length > 8 ? 6 : 12)}
                </text>
              ))}
          </g>
        </svg>
        <Tooltip hover={hover} mode={mode} />
      </div>
      <Legend groups={groups} colors={colors} mode={mode} />
      <figcaption className="chart-caption">{unit}</figcaption>
      <details className="chart-data">
        <summary>数据表</summary>
        <ChartTable rows={rows} groups={groups} xLabel={xLabel} />
      </details>
    </figure>
  )
}

function hoverEntries(
  row: Row,
  groups: readonly string[],
  colors: readonly string[],
): Array<[string, number, string]> {
  return groups.map((group) => [group, Number(row[group] ?? 0), colorOf(groups, group, colors)])
}

/**
 * 柱状图。
 *
 * `variant` 三档对应文档里的 bar / lollipop / lollipop-dotted。
 * 棒棒糖形态存在的理由不是好看：柱子很多而数值都很小时，
 * 一排贴地的矮柱子读不出差别，而一排高低不同的圆点读得出。
 */
export function BarChart(
  props: ChartProps & {
    stacked?: boolean
    variant?: 'bar' | 'lollipop' | 'lollipop-dotted'
    showPercentage?: boolean
  },
): ReactNode {
  const { rows, groups, colors, mode, stacked = false, variant = 'bar', showPercentage } = props
  const ink = INK[mode]

  return (
    <AxisFrame {...props} stacked={stacked}>
      {({ plotH, bandW, scaleY, setHover }) => (
        <>
          {rows.map((row, index) => {
            const slot = index * bandW
            const total = sumRow(row, groups)
            const onEnter = (): void =>
              setHover({
                x: slot + bandW / 2 + PAD.left,
                y: PAD.top + 8,
                title: String(row['key']),
                entries: hoverEntries(row, groups, colors),
              })

            if (stacked) {
              let cursor = 0
              return (
                <g key={String(row['key'])} onMouseEnter={onEnter}>
                  {/* 命中区比柱子宽：贴着柱子的鼠标位置很难对准 */}
                  <rect x={slot} y={0} width={bandW} height={plotH} fill="transparent" />
                  {groups.map((group, gi) => {
                    const value = Number(row[group] ?? 0)
                    if (value <= 0) return null
                    const barW = Math.min(MAX_BAR, bandW * 0.6)
                    const y = scaleY(cursor + value)
                    const rawH = scaleY(cursor) - y
                    cursor += value
                    // 段与段之间留 2px 背景色的缝。最上面一段不留——
                    // 它上面没有东西要隔开
                    const h = Math.max(1, rawH - (gi === groups.length - 1 ? 0 : GAP))
                    return (
                      <rect
                        key={group}
                        x={slot + (bandW - barW) / 2}
                        y={y + (gi === groups.length - 1 ? 0 : GAP)}
                        width={barW}
                        height={h}
                        fill={colorOf(groups, group, colors)}
                      />
                    )
                  })}
                  {showPercentage === true && total > 0 && (
                    <text
                      x={slot + bandW / 2}
                      y={scaleY(total) - 6}
                      textAnchor="middle"
                      fontSize={11}
                      fill={ink['secondary']}
                    >
                      {total}
                    </text>
                  )}
                </g>
              )
            }

            const each = bandW / Math.max(1, groups.length)
            return (
              <g key={String(row['key'])} onMouseEnter={onEnter}>
                <rect x={slot} y={0} width={bandW} height={plotH} fill="transparent" />
                {groups.map((group, gi) => {
                  const value = Number(row[group] ?? 0)
                  const color = colorOf(groups, group, colors)
                  // 并列柱之间同样留 2px 的缝
                  const barW = Math.min(MAX_BAR, Math.max(2, each - GAP))
                  const cx = slot + gi * each + each / 2
                  const y = scaleY(value)

                  if (variant !== 'bar') {
                    return (
                      <g key={group}>
                        <line
                          x1={cx}
                          x2={cx}
                          y1={plotH}
                          y2={y}
                          stroke={color}
                          strokeWidth={2}
                          strokeLinecap="round"
                          strokeDasharray={variant === 'lollipop-dotted' ? '2 4' : undefined}
                        />
                        <circle cx={cx} cy={y} r={5} fill={color} stroke={ink['surface']} strokeWidth={2} />
                      </g>
                    )
                  }

                  const h = Math.max(0, plotH - y)
                  // 数据端 4px 圆角、根部方角：用一条 path 而不是 rect 的 rx，
                  // rx 会把四个角都磨圆，于是柱子看起来是浮在基线上方的
                  const r = Math.min(4, h, barW / 2)
                  const x = cx - barW / 2
                  return (
                    <path
                      key={group}
                      d={
                        h <= 0
                          ? ''
                          : `M ${x} ${plotH} L ${x} ${y + r} Q ${x} ${y} ${x + r} ${y} L ${x + barW - r} ${y} Q ${x + barW} ${y} ${x + barW} ${y + r} L ${x + barW} ${plotH} Z`
                      }
                      fill={color}
                    />
                  )
                })}
              </g>
            )
          })}
        </>
      )}
    </AxisFrame>
  )
}

function linePath(points: Array<[number, number]>, smooth: boolean): string {
  if (points.length === 0) return ''
  if (!smooth || points.length < 3) {
    return points.map(([x, y], i) => `${i === 0 ? 'M' : 'L'} ${x} ${y}`).join(' ')
  }
  // Catmull–Rom 转三次贝塞尔。平滑只是观感，**不改变任何数据点的位置**
  let d = `M ${points[0]?.[0]} ${points[0]?.[1]}`
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[Math.max(0, i - 1)] as [number, number]
    const p1 = points[i] as [number, number]
    const p2 = points[i + 1] as [number, number]
    const p3 = points[Math.min(points.length - 1, i + 2)] as [number, number]
    const c1x = p1[0] + (p2[0] - p0[0]) / 6
    const c1y = p1[1] + (p2[1] - p0[1]) / 6
    const c2x = p2[0] - (p3[0] - p1[0]) / 6
    const c2y = p2[1] - (p3[1] - p1[1]) / 6
    d += ` C ${c1x} ${c1y} ${c2x} ${c2y} ${p2[0]} ${p2[1]}`
  }
  return d
}

export function LineChart(
  props: ChartProps & {
    smooth?: boolean
    showDot?: boolean
    /** 这几条序列画成虚线。理想线、基准线用它 */
    dashed?: readonly string[]
  },
): ReactNode {
  const { rows, groups, colors, mode, smooth = false, showDot = true, dashed = [] } = props
  const ink = INK[mode]

  return (
    <AxisFrame {...props}>
      {({ plotH, bandW, scaleY, setHover }) => (
        <>
          {rows.map((row, index) => (
            <rect
              key={`hit-${String(row['key'])}`}
              x={index * bandW}
              y={0}
              width={bandW}
              height={plotH}
              fill="transparent"
              onMouseEnter={() =>
                setHover({
                  x: index * bandW + bandW / 2 + PAD.left,
                  y: PAD.top + 8,
                  title: String(row['key']),
                  entries: hoverEntries(row, groups, colors),
                })
              }
            />
          ))}
          {groups.map((group) => {
            const color = colorOf(groups, group, colors)
            // null 的点断开线段而不是当成 0：燃尽图里"还没到那天"
            // 和"那天剩 0 件"完全是两回事
            const points = rows
              .map((row, index): [number, number] | null => {
                const raw = row[group]
                if (raw === null || raw === undefined || raw === '') return null
                return [index * bandW + bandW / 2, scaleY(Number(raw))]
              })
              .filter((p): p is [number, number] => p !== null)

            return (
              <g key={group}>
                <path
                  d={linePath(points, smooth)}
                  fill="none"
                  stroke={color}
                  strokeWidth={2}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeDasharray={dashed.includes(group) ? '6 3' : undefined}
                />
                {/* 虚线是**参考**不是观测**，所以不打数据点。
                    给理想线加上端点，它看起来就和实际值一样是量出来的了 */}
                {showDot &&
                  !dashed.includes(group) &&
                  points.map(([x, y]) => (
                    <circle
                      key={`${group}-${x}`}
                      cx={x}
                      cy={y}
                      r={4}
                      fill={color}
                      // 2px 背景色的环：两条线交叉的地方，点还认得出
                      stroke={ink['surface']}
                      strokeWidth={2}
                    />
                  ))}
              </g>
            )
          })}
        </>
      )}
    </AxisFrame>
  )
}

export function AreaChart(
  props: ChartProps & { stacked?: boolean; smooth?: boolean; comparison?: string },
): ReactNode {
  const { rows, groups, colors, mode, stacked = false, smooth = false, comparison } = props
  const gradientId = useId()
  const ink = INK[mode]

  return (
    <AxisFrame {...props} stacked={stacked}>
      {({ plotH, bandW, scaleY, setHover }) => {
        const cursor = new Array(rows.length).fill(0) as number[]
        return (
          <>
            {rows.map((row, index) => (
              <rect
                key={`hit-${String(row['key'])}`}
                x={index * bandW}
                y={0}
                width={bandW}
                height={plotH}
                fill="transparent"
                onMouseEnter={() =>
                  setHover({
                    x: index * bandW + bandW / 2 + PAD.left,
                    y: PAD.top + 8,
                    title: String(row['key']),
                    entries: hoverEntries(row, groups, colors),
                  })
                }
              />
            ))}
            {groups.map((group) => {
              const color = colorOf(groups, group, colors)
              const isComparison = group === comparison
              const tops: Array<[number, number]> = []
              const bottoms: Array<[number, number]> = []

              rows.forEach((row, index) => {
                const value = Number(row[group] ?? 0)
                const base = stacked ? (cursor[index] as number) : 0
                const x = index * bandW + bandW / 2
                tops.push([x, scaleY(base + value)])
                bottoms.push([x, scaleY(base)])
                if (stacked) cursor[index] = base + value
              })

              return (
                <g key={group}>
                  {/* 对比基准线（燃尽图的理想线）只画线不填色：
                      它不是一份"量"，填色会让人以为那块面积有含义 */}
                  {!isComparison && (
                    <path
                      d={`${linePath(tops, smooth)} L ${bottoms[bottoms.length - 1]?.[0]} ${bottoms[bottoms.length - 1]?.[1]} ${linePath([...bottoms].reverse(), smooth).replace('M', 'L')} Z`}
                      fill={color}
                      // 10% 的薄雾，不是一块实色
                      fillOpacity={0.1}
                      stroke="none"
                    />
                  )}
                  <path
                    d={linePath(tops, smooth)}
                    fill="none"
                    stroke={color}
                    strokeWidth={2}
                    strokeLinecap="round"
                    strokeDasharray={isComparison ? '6 3' : undefined}
                  />
                  {!isComparison &&
                    tops.map(([x, y]) => (
                      <circle
                        key={`${group}-${x}`}
                        cx={x}
                        cy={y}
                        r={4}
                        fill={color}
                        stroke={ink['surface']}
                        strokeWidth={2}
                      />
                    ))}
                  <linearGradient id={`${gradientId}-${group}`} />
                </g>
              )
            })}
          </>
        )
      }}
    </AxisFrame>
  )
}

export function ScatterChart(props: ChartProps): ReactNode {
  const { rows, groups, colors, mode } = props
  const ink = INK[mode]
  return (
    <AxisFrame {...props}>
      {({ bandW, scaleY, setHover }) => (
        <>
          {rows.map((row, index) =>
            groups.map((group) => {
              const value = Number(row[group] ?? 0)
              const x = index * bandW + bandW / 2
              return (
                <circle
                  key={`${String(row['key'])}-${group}`}
                  cx={x}
                  cy={scaleY(value)}
                  // 标记点直径 ≥ 8px，否则鼠标够不着也看不清
                  r={5}
                  fill={colorOf(groups, group, colors)}
                  stroke={ink['surface']}
                  strokeWidth={2}
                  onMouseEnter={() =>
                    setHover({
                      x: x + PAD.left,
                      y: PAD.top + 8,
                      title: String(row['key']),
                      entries: hoverEntries(row, groups, colors),
                    })
                  }
                />
              )
            }),
          )}
        </>
      )}
    </AxisFrame>
  )
}

/**
 * 饼图 / 环形图。
 *
 * `innerRadius > 0` 即环形图。默认就用环形：中间那个洞可以放总数，
 * 而总数恰好是看构成时最想同时知道的那个数。
 *
 * 只画一层，不做多层嵌套饼——嵌套饼的外层扇区面积天生比内层大，
 * 于是同样的占比看起来不一样重。
 */
export function PieChart({
  rows,
  colors,
  mode,
  innerRadius = 52,
  centerLabel,
  height = 240,
  unit,
  xLabel,
}: {
  rows: readonly Row[]
  colors: readonly string[]
  mode: Mode
  innerRadius?: number
  centerLabel?: string
  height?: number
  unit?: string
  xLabel?: string
}): ReactNode {
  const [hover, setHover] = useState<Hover>(null)
  const [active, setActive] = useState<string | null>(null)
  const ink = INK[mode]
  const size = height
  const cx = size / 2
  const cy = size / 2
  const outer = size / 2 - 12
  const names = rows.map((row) => String(row['key']))
  const total = rows.reduce((sum, row) => sum + Number(row['value'] ?? 0), 0)

  let angle = -Math.PI / 2
  const arcs = rows.map((row) => {
    const value = Number(row['value'] ?? 0)
    const sweep = total === 0 ? 0 : (value / total) * Math.PI * 2
    const start = angle
    angle += sweep
    return { name: String(row['key']), value, start, end: angle }
  })

  const arcPath = (start: number, end: number, r: number, ri: number): string => {
    // 扇区之间留出 2px 的缝，换算成弧度随半径变化
    const pad = r === 0 ? 0 : GAP / r
    const s = start + pad / 2
    const e = Math.max(s, end - pad / 2)
    const large = e - s > Math.PI ? 1 : 0
    const x1 = cx + r * Math.cos(s)
    const y1 = cy + r * Math.sin(s)
    const x2 = cx + r * Math.cos(e)
    const y2 = cy + r * Math.sin(e)
    const ix2 = cx + ri * Math.cos(e)
    const iy2 = cy + ri * Math.sin(e)
    const ix1 = cx + ri * Math.cos(s)
    const iy1 = cy + ri * Math.sin(s)
    return `M ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2} L ${ix2} ${iy2} A ${ri} ${ri} 0 ${large} 0 ${ix1} ${iy1} Z`
  }

  return (
    <figure className="chart-figure">
      <div className="chart-plot chart-plot-pie" onMouseLeave={() => { setHover(null); setActive(null) }}>
        <svg viewBox={`0 0 ${size} ${size}`} role="img" aria-label="构成占比" className="chart-svg">
          {arcs.map((arc) => (
            <path
              key={arc.name}
              // 悬停时外扩 3px：比变色好，因为变色会和"这是另一条序列"混淆
              d={arcPath(arc.start, arc.end, active === arc.name ? outer + 3 : outer, innerRadius)}
              fill={colorOf(names, arc.name, colors)}
              onMouseEnter={() => {
                setActive(arc.name)
                setHover({
                  x: cx,
                  y: 8,
                  title: arc.name,
                  entries: [[arc.name, arc.value, colorOf(names, arc.name, colors)]],
                })
              }}
            />
          ))}
          {innerRadius > 0 && (
            <>
              <text
                x={cx}
                y={cy - 4}
                textAnchor="middle"
                fontSize={22}
                fill={ink['text']}
                fontWeight={600}
              >
                {total.toLocaleString()}
              </text>
              <text x={cx} y={cy + 16} textAnchor="middle" fontSize={11} fill={ink['muted']}>
                {centerLabel ?? '合计'}
              </text>
            </>
          )}
        </svg>
        <Tooltip hover={hover} mode={mode} />
      </div>
      <Legend groups={names} colors={colors} mode={mode} />
      <figcaption className="chart-caption">{unit}</figcaption>
      <details className="chart-data">
        <summary>数据表</summary>
        <ChartTable rows={rows} groups={['value']} xLabel={xLabel} />
      </details>
    </figure>
  )
}

/**
 * 雷达图。多维度对比用。
 *
 * 刻意只画 3 条以内的序列：雷达图的多边形一旦互相覆盖，
 * 就没人读得出哪块是哪块了——它比别的图更早失控。
 */
export function RadarChart({
  rows,
  groups,
  colors,
  mode,
  height = 260,
  unit,
  xLabel,
}: ChartProps): ReactNode {
  const ink = INK[mode]
  const size = height
  const cx = size / 2
  const cy = size / 2
  const radius = size / 2 - 40
  const axes = rows.map((row) => String(row['key']))
  const max = Math.max(
    ...rows.flatMap((row) => groups.map((group) => Number(row[group] ?? 0))),
    1,
  )

  const point = (index: number, value: number): [number, number] => {
    const angle = (index / Math.max(1, axes.length)) * Math.PI * 2 - Math.PI / 2
    const r = (value / max) * radius
    return [cx + r * Math.cos(angle), cy + r * Math.sin(angle)]
  }

  return (
    <figure className="chart-figure">
      <div className="chart-plot chart-plot-pie">
        <svg viewBox={`0 0 ${size} ${size}`} role="img" aria-label="多维对比" className="chart-svg">
          {[0.25, 0.5, 0.75, 1].map((ring) => (
            <polygon
              key={ring}
              points={axes.map((_, i) => point(i, max * ring).join(',')).join(' ')}
              fill="none"
              stroke={ink['grid']}
              strokeWidth={1}
            />
          ))}
          {axes.map((axis, index) => {
            const [x, y] = point(index, max)
            return (
              <g key={axis}>
                <line x1={cx} y1={cy} x2={x} y2={y} stroke={ink['grid']} strokeWidth={1} />
                <text
                  x={cx + (x - cx) * 1.14}
                  y={cy + (y - cy) * 1.14}
                  textAnchor="middle"
                  dominantBaseline="middle"
                  fontSize={10}
                  fill={ink['muted']}
                >
                  {short(axis, 8)}
                </text>
              </g>
            )
          })}
          {groups.slice(0, 3).map((group) => {
            const color = colorOf(groups, group, colors)
            const points = rows.map((row, index) => point(index, Number(row[group] ?? 0)).join(','))
            return (
              <polygon
                key={group}
                points={points.join(' ')}
                fill={color}
                fillOpacity={0.1}
                stroke={color}
                strokeWidth={2}
                strokeLinejoin="round"
              />
            )
          })}
        </svg>
      </div>
      <Legend groups={groups.slice(0, 3)} colors={colors} mode={mode} />
      <figcaption className="chart-caption">{unit}</figcaption>
      <details className="chart-data">
        <summary>数据表</summary>
        <ChartTable rows={rows} groups={groups} xLabel={xLabel} />
      </details>
    </figure>
  )
}

/**
 * 矩形树图。看"谁占的体量大"。
 *
 * 内容按可用面积**逐级降级**：先去掉数值，再去掉名字。
 * 硬画上去再让 CSS 裁掉的话，读到的会是半个词——
 * 而半个词比没有词更容易被误读成另一个词。
 */
export function TreeMap({
  rows,
  colors,
  mode,
  height = 260,
  unit,
  xLabel,
}: {
  rows: readonly Row[]
  colors: readonly string[]
  mode: Mode
  height?: number
  unit?: string
  xLabel?: string
}): ReactNode {
  const width = 640
  const ink = INK[mode]
  const names = rows.map((row) => String(row['key']))
  const items = [...rows]
    .map((row) => ({ name: String(row['key']), value: Number(row['value'] ?? 0) }))
    .filter((item) => item.value > 0)
    .sort((a, b) => b.value - a.value)
  const total = items.reduce((sum, item) => sum + item.value, 0)

  // 简单的条带切分：够用，且不会因为一次布局抖动让色块整体重排
  const tiles: Array<{ name: string; value: number; x: number; y: number; w: number; h: number }> = []
  let y = 0
  let index = 0
  while (index < items.length && y < height) {
    const remaining = items.slice(index)
    const remainingValue = remaining.reduce((sum, item) => sum + item.value, 0)
    const rowHeight = Math.max(24, ((remaining[0]?.value ?? 0) / Math.max(1, remainingValue)) * (height - y) * 2)
    const h = Math.min(rowHeight, height - y)
    let rowValue = 0
    const rowItems: typeof items = []
    for (const item of remaining) {
      if (rowItems.length > 0 && rowValue + item.value > remainingValue * (h / Math.max(1, height - y))) break
      rowItems.push(item)
      rowValue += item.value
    }
    let x = 0
    for (const item of rowItems) {
      const w = (item.value / Math.max(1, rowValue)) * width
      tiles.push({ ...item, x, y, w, h })
      x += w
    }
    index += rowItems.length
    y += h
  }

  return (
    <figure className="chart-figure">
      <div className="chart-plot">
        <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="体量占比" className="chart-svg">
          {tiles.map((tile) => {
            const color = colorOf(names, tile.name, colors)
            // 面积决定显示什么：够大显示名字 + 数值，中等只显示名字，
            // 太小什么都不显示（悬停与数据表兜底）
            const showValue = tile.w > 92 && tile.h > 44
            const showName = tile.w > 52 && tile.h > 24
            return (
              <g key={tile.name}>
                <title>{`${tile.name}: ${tile.value}`}</title>
                <rect
                  // 2px 的缝用背景色画，不是描边
                  x={tile.x + GAP / 2}
                  y={tile.y + GAP / 2}
                  width={Math.max(0, tile.w - GAP)}
                  height={Math.max(0, tile.h - GAP)}
                  fill={color}
                  rx={4}
                />
                {showName && (
                  <text x={tile.x + 8} y={tile.y + 18} fontSize={11} fill="#FFFFFF" fontWeight={600}>
                    {short(tile.name, Math.floor(tile.w / 8))}
                  </text>
                )}
                {showValue && (
                  <text x={tile.x + 8} y={tile.y + 34} fontSize={11} fill="#FFFFFF" fillOpacity={0.85}>
                    {tile.value.toLocaleString()}
                    {total > 0 && ` · ${Math.round((tile.value / total) * 100)}%`}
                  </text>
                )}
              </g>
            )
          })}
        </svg>
      </div>
      <figcaption className="chart-caption" style={{ color: ink['muted'] }}>
        {unit}
      </figcaption>
      <details className="chart-data">
        <summary>数据表</summary>
        <ChartTable rows={rows} groups={['value']} xLabel={xLabel} />
      </details>
    </figure>
  )
}
