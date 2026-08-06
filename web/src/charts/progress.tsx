import type { ReactNode } from 'react'
import { GROUP_COLORS, INK, STATUS } from './palette.ts'
import type { Mode } from './palette.ts'

/**
 * 进度指示器（非图表类可视化）。
 *
 * 四种，对照 `product-features.md` §3.6。它们不是"小一号的图表"——
 * 图表回答"分布是什么样"，进度条回答"到哪儿了"，
 * 后者只有一个数，用图表画它是把一个数字铺成一整块画布。
 *
 * 四个都**不用状态色表示进度多少**。进度是一个量，不是一个状态；
 * 把 40% 画成黄色、90% 画成绿色，等于替读者做了"多少算好"的判断，
 * 而那取决于今天是迭代第二天还是最后一天。
 */

const TRACK_LIGHT = '#E1E0D9'
const TRACK_DARK = '#2C2C2A'

function track(mode: Mode): string {
  return mode === 'dark' ? TRACK_DARK : TRACK_LIGHT
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0))
}

/** 径向环形进度。周期完成度用它 */
export function RadialProgress({
  value,
  mode,
  size = 72,
  label,
  color,
}: {
  /** 0–1 */
  value: number
  mode: Mode
  size?: number
  label?: string
  color?: string
}): ReactNode {
  const ratio = clamp(value)
  const stroke = 8
  const r = size / 2 - stroke / 2
  const circumference = 2 * Math.PI * r
  const ink = INK[mode]

  return (
    <div className="progress-radial" role="img" aria-label={`${label ?? '进度'} ${Math.round(ratio * 100)}%`}>
      <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={track(mode)} strokeWidth={stroke} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={color ?? STATUS['good']}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${circumference * ratio} ${circumference}`}
          // 从十二点方向开始。默认的三点方向读起来像"已经过了四分之一"
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
        <text
          x={size / 2}
          y={size / 2}
          textAnchor="middle"
          dominantBaseline="central"
          fontSize={size / 4}
          fontWeight={600}
          fill={ink['text']}
        >
          {Math.round(ratio * 100)}%
        </text>
      </svg>
      {label !== undefined && <span style={{ color: ink['muted'] }}>{label}</span>}
    </div>
  )
}

/** 圆形进度，中心可放任意文案（如「3/8」）。子任务完成比用它 */
export function CircularProgressIndicator({
  value,
  mode,
  size = 40,
  center,
}: {
  value: number
  mode: Mode
  size?: number
  center?: string
}): ReactNode {
  const ratio = clamp(value)
  const stroke = 4
  const r = size / 2 - stroke / 2
  const circumference = 2 * Math.PI * r
  const ink = INK[mode]

  return (
    <svg
      viewBox={`0 0 ${size} ${size}`}
      width={size}
      height={size}
      role="img"
      aria-label={`完成 ${Math.round(ratio * 100)}%`}
    >
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={track(mode)} strokeWidth={stroke} />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke={GROUP_COLORS[mode]['Started'] as string}
        strokeWidth={stroke}
        strokeLinecap="round"
        strokeDasharray={`${circumference * ratio} ${circumference}`}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
      {center !== undefined && (
        <text
          x={size / 2}
          y={size / 2}
          textAnchor="middle"
          dominantBaseline="central"
          fontSize={size / 3.6}
          fill={ink['secondary']}
        >
          {center}
        </text>
      )}
    </svg>
  )
}

export type Segment = { key: string; count: number; color?: string }

/**
 * 线性分段条：多个状态组按色块拼接。
 *
 * 段与段之间留 2px 背景色的缝，和堆叠柱一个规矩。没有缝的话，
 * 两个相邻且明度接近的段会读成一段——而"进行中"和"已完成"
 * 恰恰是最需要一眼分开的两段。
 */
export function LinearProgressIndicator({
  segments,
  mode,
  height = 8,
  showLegend = true,
}: {
  segments: readonly Segment[]
  mode: Mode
  height?: number
  showLegend?: boolean
}): ReactNode {
  const ink = INK[mode]
  const total = segments.reduce((sum, segment) => sum + segment.count, 0)
  const visible = segments.filter((segment) => segment.count > 0)

  return (
    <div className="progress-linear">
      <div
        className="progress-linear-track"
        style={{ background: track(mode), height, borderRadius: height / 2 }}
        role="img"
        aria-label={visible.map((s) => `${s.key} ${s.count}`).join('，')}
      >
        {total > 0 &&
          visible.map((segment) => (
            <span
              key={segment.key}
              style={{
                width: `${(segment.count / total) * 100}%`,
                background: segment.color ?? GROUP_COLORS[mode][segment.key] ?? ink['muted'],
              }}
              title={`${segment.key}: ${segment.count}`}
            />
          ))}
      </div>
      {showLegend && (
        <ul className="chart-legend" style={{ color: ink['secondary'] }}>
          {visible.map((segment) => (
            <li key={segment.key}>
              <span
                className="chart-legend-swatch"
                style={{ background: segment.color ?? GROUP_COLORS[mode][segment.key] ?? ink['muted'] }}
                aria-hidden="true"
              />
              {segment.key} {segment.count}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** 基础进度条。附件上传、批量操作这类"一件事的进度"用它 */
export function ProgressBar({
  value,
  mode,
  height = 6,
  color,
}: {
  value: number
  mode: Mode
  height?: number
  color?: string
}): ReactNode {
  const ratio = clamp(value)
  return (
    <div
      className="progress-linear-track"
      style={{ background: track(mode), height, borderRadius: height / 2 }}
      role="progressbar"
      aria-valuenow={Math.round(ratio * 100)}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <span style={{ width: `${ratio * 100}%`, background: color ?? GROUP_COLORS[mode]['Started'] }} />
    </div>
  )
}
