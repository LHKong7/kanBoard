import { useEffect, useState } from 'react'
import { api, currentIdentity, setIdentity } from './api.ts'
import type { EntityTypeDef } from './api.ts'
import { ObjectScreen } from './screens/ObjectScreen.tsx'
import { Worklogs } from './screens/Worklogs.tsx'
import { Templates } from './screens/Templates.tsx'

/**
 * 企业版界面（React）。
 *
 * 屏与屏之间的共同点比差异多，所以除了工时和模板这两个有专属动作的，
 * 其余都走同一个 `ObjectScreen`——它按**本体**渲染表格与新建表单。
 * 每类对象手写一个界面的话，本体里加个属性就得改 N 处，
 * 而漏掉的那一处不会报错，只会少显示一列。
 */

type Screen = { key: string; label: string; type: string; note: string }

const SCREENS: Screen[] = [
  {
    key: 'initiative',
    label: '举措',
    type: 'Initiative',
    note: '跨项目的目标。一件事要动三个项目才做得成时，它是那个"一件事"。',
  },
  {
    key: 'teamspace',
    label: '团队空间',
    type: 'Teamspace',
    note: '跨项目的人的集合：这些项目归谁管。',
  },
  { key: 'worklog', label: '工时', type: 'Worklog', note: '报工时与审批。谁都不能批自己那一条。' },
  { key: 'template', label: '模板', type: 'Template', note: '预填好的一份属性，套用时生成对象。' },
  {
    key: 'savedview',
    label: '保存的视图',
    type: 'SavedView',
    note: '存下来的一组筛选条件，可以分享给同租户的人。',
  },
  {
    key: 'baseline',
    label: '基线',
    type: 'Baseline',
    note: '某一刻的计划快照。没有它，改完计划之后偏差永远是零。',
  },
]

export function App() {
  const [active, setActive] = useState<Screen>(SCREENS[0] as Screen)
  const [types, setTypes] = useState<EntityTypeDef[] | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const [identity, setLocalIdentity] = useState(currentIdentity())

  useEffect(() => {
    api
      .entityTypes()
      .then((r) => setTypes(r.items))
      .catch((e: unknown) => setFailed(String(e instanceof Error ? e.message : e)))
  }, [identity])

  const def = types?.find((t) => t.name === active.type)

  return (
    <>
      <header className="topbar">
        <div className="brand">
          <span className="mark">◈</span>
          <span>ProjectOS 企业版</span>
        </div>
        <nav className="types" aria-label="企业级对象">
          {SCREENS.map((s) => (
            <button
              key={s.key}
              className="type-tab"
              data-screen={s.key}
              aria-selected={active.key === s.key}
              onClick={() => setActive(s)}
            >
              {s.label}
            </button>
          ))}
        </nav>
        <div className="topbar-right">
          <a className="btn ghost" href="/">
            ← 回看板
          </a>
          <select
            className="filter-owner"
            id="rolePicker"
            aria-label="切换角色"
            value={identity.roles}
            onChange={(e) => {
              const next = { ...identity, roles: e.target.value }
              setIdentity(next)
              setLocalIdentity(next)
            }}
          >
            {['Admin', 'PM', 'RD', 'QA', 'Leader', 'Guest'].map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </div>
      </header>

      <main className="board board-plain" aria-live="polite">
        {failed !== null && (
          <div className="board-empty">
            <h3>本体加载失败</h3>
            <p>{failed}</p>
          </div>
        )}
        {failed === null && types === null && <div className="board-empty">加载本体…</div>}
        {def !== undefined && (
          <>
            <p className="screen-note">{active.note}</p>
            {active.type === 'Worklog' ? (
              <Worklogs def={def} />
            ) : active.type === 'Template' ? (
              <Templates def={def} allTypes={types ?? []} />
            ) : (
              <ObjectScreen def={def} />
            )}
          </>
        )}
        {types !== null && def === undefined && failed === null && (
          <div className="board-empty">
            <h3>本体里没有 {active.type}</h3>
            <p>这一屏依赖的类型没有注册，界面不猜它长什么样。</p>
          </div>
        )}
      </main>
    </>
  )
}
