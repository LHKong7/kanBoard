import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { api } from '../api.ts'
import type { Resource } from '../api.ts'
import { LineChart } from '../charts/chart-kit.tsx'
import type { Row } from '../charts/chart-kit.tsx'
import { GROUP_COLORS, INK, loadPalette, seriesColors, useMode } from '../charts/palette.ts'
import { LinearProgressIndicator, RadialProgress } from '../charts/progress.tsx'

/**
 * 周期（Cycle / Sprint）的专属界面：燃尽图 + 进度。
 *
 * 单独一屏而不是复用通用的对象表格，因为周期上有两样表格答不了的东西：
 * **一条随时间变化的线**，和**一个由状态组拼出来的进度条**。
 * 把它们塞进一列文本里，指南 §5.1 里那四种"形态 → 含义"的读法
 * 就一种也用不上了。
 */

const GROUP_ORDER = ['Triage', 'Backlog', 'Unstarted', 'Started', 'Completed', 'Cancelled']

const GROUP_LABELS: Record<string, string> = {
  Triage: '待分诊',
  Backlog: '待办',
  Unstarted: '已排期',
  Started: '进行中',
  Completed: '已完成',
  Cancelled: '已取消',
}

type Burndown = Awaited<ReturnType<typeof api.burndown>>
type Progress = Awaited<ReturnType<typeof api.cycleProgress>>

/**
 * 燃尽图的读法。指南 §5.1 那张表，直接放在图旁边。
 *
 * 写在界面上而不是文档里：一张读不懂的图和没有图是一样的，
 * 而没有人会为了看一眼进度先去翻文档。
 */
const SHAPES: Array<[string, string]> = [
  ['实线长期在虚线上方', '进度落后 —— 立即砍范围，别指望最后冲刺'],
  ['实线平台期后陡降', '全部堆到最后完成 —— 检查状态更新是否及时，或任务拆得太粗'],
  ['实线阶梯状均匀下降', '健康 —— 保持'],
  ['实线向上跳', '迭代中途加了需求 —— 检查范围管理纪律'],
]

export function Cycles(): ReactNode {
  const mode = useMode()
  const colors = seriesColors(loadPalette(), mode)
  const [cycles, setCycles] = useState<Resource[] | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [unit, setUnit] = useState<'count' | 'points'>('count')
  const [burndown, setBurndown] = useState<Burndown | null>(null)
  const [progress, setProgress] = useState<Progress | null>(null)
  const [failed, setFailed] = useState<string | null>(null)

  useEffect(() => {
    api
      .list('Sprint')
      .then((result) => {
        setCycles(result.items)
        // 默认选进行中的那个；没有就选最近的一个。
        // 让人每次进来都先点一下的话，这一屏的价值就少了一半
        const active = result.items.find((c) => c.status === 'Active')
        setSelected((active ?? result.items[0])?.id ?? null)
      })
      .catch((e: unknown) => setFailed(String(e instanceof Error ? e.message : e)))
  }, [])

  useEffect(() => {
    if (selected === null) return
    setFailed(null)
    Promise.all([api.burndown(selected, unit), api.cycleProgress(selected)])
      .then(([b, p]) => {
        setBurndown(b)
        setProgress(p)
      })
      .catch((e: unknown) => setFailed(String(e instanceof Error ? e.message : e)))
  }, [selected, unit])

  const ink = INK[mode]

  if (failed !== null) {
    return (
      <div className="board-empty" data-cycles-error>
        <h3>周期数据取不到</h3>
        <p>{failed}</p>
      </div>
    )
  }

  if (cycles !== null && cycles.length === 0) {
    return (
      <div className="board-empty">
        <h3>还没有周期</h3>
        <p>周期是时间维度（"这两周做什么"），模块是范围维度（"这个功能做完了吗"）。两个都要有。</p>
      </div>
    )
  }

  // 未来的那些天是 null，`LineChart` 会把线断开而不是补成 0
  const rows: Row[] = (burndown?.points ?? []).map((point) => ({
    key: point.day.slice(5),
    实际剩余: point.remaining ?? '',
    理想线: point.ideal,
  }))

  return (
    <section className="cycles">
      <div className="analytics-controls">
        <label>
          周期
          <select
            value={selected ?? ''}
            onChange={(e) => setSelected(e.target.value)}
            data-control="cycle"
          >
            {(cycles ?? []).map((cycle) => (
              <option key={cycle.id} value={cycle.id}>
                {String(cycle.attributes['name'] ?? cycle.id)} · {cycle.status}
              </option>
            ))}
          </select>
        </label>
        <label>
          烧什么
          <select
            value={unit}
            onChange={(e) => setUnit(e.target.value as 'count' | 'points')}
            data-control="unit"
          >
            <option value="count">按条数</option>
            <option value="points">按估点</option>
          </select>
        </label>
      </div>

      {progress !== null && (
        <div className="cycle-summary">
          <RadialProgress
            value={progress.completionRate}
            mode={mode}
            label="完成率"
            color={GROUP_COLORS[mode]['Completed'] as string}
          />
          <div className="cycle-stats">
            <p style={{ color: ink['secondary'] }}>
              共 {progress.total} 条 · 已完成 {progress.completed} · 进行中 {progress.open} ·
              已取消 {progress.cancelled}
              {progress.points.total > 0 && (
                <>
                  {' · '}
                  估点 {progress.points.completed}/{progress.points.total}
                </>
              )}
            </p>
            {/* 完成率的分母不含取消掉的：砍了一半范围、剩下的做完了就是 100%。
                把取消的留在分母里，团队会学会不去取消任何东西 */}
            <LinearProgressIndicator
              mode={mode}
              segments={GROUP_ORDER.filter((group) => (progress.byGroup[group] ?? 0) > 0).map(
                (group) => ({
                  key: GROUP_LABELS[group] ?? group,
                  count: progress.byGroup[group] ?? 0,
                  color: GROUP_COLORS[mode][group] as string,
                }),
              )}
            />
          </div>
        </div>
      )}

      {burndown !== null && rows.length > 0 && (
        <div className="analytics-chart" data-chart="burndown">
          <h3 className="analytics-title">
            燃尽图 · {unit === 'points' ? '按估点' : '按条数'}
          </h3>
          <LineChart
            rows={rows}
            groups={['实际剩余', '理想线']}
            colors={colors}
            mode={mode}
            // 理想线画虚线：它是一条参考，不是观测到的事实
            dashed={['理想线']}
            unit={unit === 'points' ? '剩余估点' : '剩余条数'}
            xLabel="日期"
            height={300}
          />
          {burndown.truncated && (
            <p className="chart-caption" style={{ color: ink['muted'] }}>
              这个周期装了超过 500 条工作项，图上只算了前 500 条。
            </p>
          )}
          <table className="chart-table cycle-shapes">
            <caption>怎么读这张图</caption>
            <tbody>
              {SHAPES.map(([shape, meaning]) => (
                <tr key={shape}>
                  <th scope="row">{shape}</th>
                  <td>{meaning}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
