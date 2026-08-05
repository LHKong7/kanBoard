import { useEffect, useState } from 'react'
import { api, ApiError, currentIdentity } from '../api.ts'
import type { EntityTypeDef, Resource, TransitionOption } from '../api.ts'
import { useResources } from '../useResources.ts'
import { ObjectForm } from './ObjectForm.tsx'

/**
 * 工时：报 + 审批（对照 Plane business 档的"历史工时单 + 审批"）。
 *
 * 可用动作**由工作流引擎给出**，不是这里按状态硬编码的。于是
 * "谁都不能批自己那一条"这条策略在界面上是自动生效的——
 * 服务端不给这个动作，按钮就不出现，而不需要前端也记一遍规则。
 */
export function Worklogs({ def }: { def: EntityTypeDef }) {
  const { items, error, loading, reload } = useResources(def.name)
  const [creating, setCreating] = useState(false)

  const total = items
    .filter((w) => w.status === 'Approved')
    .reduce((sum, w) => sum + toHours(w.attributes['hours']), 0)

  return (
    <section data-screen-for="Worklog">
      <div className="screen-actions">
        <button className="btn" data-action="new" onClick={() => setCreating((v) => !v)}>
          {creating ? '收起' : '+ 报工时'}
        </button>
        {/* 只汇总**已批准**的：把待审的算进去，这个数字每天都在变，
            而没有人知道它什么时候算数 */}
        <span className="screen-count" data-approved-hours={total}>
          已批准 {total} 小时 · 共 {items.length} 条
        </span>
      </div>

      {creating && (
        <ObjectForm
          def={def}
          onCreated={() => {
            setCreating(false)
            void reload()
          }}
        />
      )}

      {error !== null && (
        <div className="board-empty" data-error="1">
          <h3>看不了工时</h3>
          <p>{error}</p>
        </div>
      )}
      {error === null && loading && <div className="board-empty">加载中…</div>}
      {error === null && !loading && items.length === 0 && (
        <div className="board-empty">
          <h3>还没有工时记录</h3>
          <p>报一条试试——报出来是草稿，提交之后才进待审。</p>
        </div>
      )}
      {items.length > 0 && (
        <table className="item-table">
          <thead>
            <tr>
              <th>状态</th>
              <th>工时</th>
              <th>日期</th>
              <th>说明</th>
              <th>报的人</th>
              <th>可做的</th>
            </tr>
          </thead>
          <tbody>
            {items.map((w) => (
              <WorklogRow key={w.id} worklog={w} onChanged={reload} />
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}

function WorklogRow({ worklog, onChanged }: { worklog: Resource; onChanged: () => void }) {
  const [options, setOptions] = useState<TransitionOption[]>([])
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState<string | null>(null)

  useEffect(() => {
    api
      .transitions(worklog.id)
      .then((r) => setOptions(r.items))
      // 取不到可用动作就显示不出按钮，但不该让整行消失
      .catch(() => setOptions([]))
  }, [worklog.id, worklog.version])

  const run = async (to: string) => {
    setBusy(true)
    setFailed(null)
    try {
      await api.transition(worklog.id, to, '工时流转')
      onChanged()
    } catch (e) {
      setFailed(e instanceof ApiError ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const mine = worklog.owner === currentIdentity().principal

  return (
    <tr data-id={worklog.id} data-status={worklog.status}>
      <td>{worklog.status}</td>
      <td>{toHours(worklog.attributes['hours'])}</td>
      <td>{String(worklog.attributes['spentOn'] ?? '').slice(0, 10)}</td>
      <td>{String(worklog.attributes['note'] ?? '')}</td>
      <td>
        {worklog.owner ?? ''}
        {mine && <span className="mine-badge">我报的</span>}
      </td>
      <td>
        {options.map((t) => (
          <button
            key={t.to}
            className="btn ghost"
            data-transition={t.to}
            disabled={busy || !t.ready}
            title={t.ready ? '' : `未就绪：${t.blockedBy ?? '条件未满足'}`}
            onClick={() => void run(t.to)}
          >
            {t.reopen === true ? `重开 → ${t.to}` : t.to}
          </button>
        ))}
        {/* 服务端没给审批动作时说明原因，而不是让按钮凭空消失。
            自己报的自己批不了，是一条**故意**的规则，该被看见 */}
        {mine && !options.some((t) => t.to === 'Approved') && worklog.status === 'Submitted' && (
          <span className="hint-inline" data-no-self-approve="1">
            自己报的工时不能自己批
          </span>
        )}
        {failed !== null && <em className="field-error">{failed}</em>}
      </td>
    </tr>
  )
}

function toHours(value: unknown): number {
  return typeof value === 'number' ? value : Number(value ?? 0) || 0
}
