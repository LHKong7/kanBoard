import { useState } from 'react'
import { useResources } from '../useResources.ts'
import type { EntityTypeDef } from '../api.ts'
import { ObjectForm } from './ObjectForm.tsx'

/** 通用的企业级对象界面：表格 + 新建。列同样来自本体 */
export function ObjectScreen({ def }: { def: EntityTypeDef }) {
  const { items, error, loading, reload } = useResources(def.name)
  const [creating, setCreating] = useState(false)
  const columns = def.attributes.map((a) => a.name)

  return (
    <section data-screen-for={def.name}>
      <div className="screen-actions">
        <button className="btn" data-action="new" onClick={() => setCreating((v) => !v)}>
          {creating ? '收起' : `+ 新建 ${def.name}`}
        </button>
        <span className="screen-count">{items.length} 条</span>
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
          <h3>看不了 {def.name}</h3>
          <p>{error}</p>
        </div>
      )}
      {error === null && loading && <div className="board-empty">加载中…</div>}
      {error === null && !loading && items.length === 0 && (
        <div className="board-empty">
          <h3>还没有 {def.name}</h3>
          <p>用上面的按钮加一个。</p>
        </div>
      )}
      {error === null && items.length > 0 && (
        <table className="item-table">
          <thead>
            <tr>
              {def.lifecycle !== undefined && <th>状态</th>}
              {columns.map((c) => (
                <th key={c}>{c}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.id} data-id={item.id}>
                {def.lifecycle !== undefined && <td>{item.status}</td>}
                {columns.map((c) => (
                  <td key={c}>{cell(item.attributes[c])}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}

function cell(value: unknown): string {
  if (value === undefined || value === null) return ''
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}
