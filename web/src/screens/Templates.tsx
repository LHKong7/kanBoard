import { useState } from 'react'
import { api, ApiError } from '../api.ts'
import type { EntityTypeDef, Resource } from '../api.ts'
import { useResources } from '../useResources.ts'
import { ObjectForm } from './ObjectForm.tsx'

/**
 * 模板：预填好的一份属性，套用时生成目标对象
 * （对照 Plane pro 档的工作项模板 / business 档的项目模板）。
 *
 * **套用发生在前端**，不是一个服务端的"执行模板"端点。理由是套用等价于
 * "读出 draft，合并调用方的覆盖，走普通的创建"——放到服务端就多了一条
 * 能凭模板 id 创建任意类型对象的路径，而它的权限判定要重写一遍。
 * 走普通创建的话，权限、校验、审计全都是现成那一套。
 */
export function Templates({ def, allTypes }: { def: EntityTypeDef; allTypes: EntityTypeDef[] }) {
  const { items, error, loading, reload } = useResources(def.name)
  const [creating, setCreating] = useState(false)

  return (
    <section data-screen-for="Template">
      <div className="screen-actions">
        <button className="btn" data-action="new" onClick={() => setCreating((v) => !v)}>
          {creating ? '收起' : '+ 新建模板'}
        </button>
        <span className="screen-count">{items.length} 个模板</span>
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
          <h3>看不了模板</h3>
          <p>{error}</p>
        </div>
      )}
      {error === null && loading && <div className="board-empty">加载中…</div>}
      {error === null && !loading && items.length === 0 && (
        <div className="board-empty">
          <h3>还没有模板</h3>
          <p>
            模板的 draft 填一段 JSON，比如 <code>{'{"title":"例行巡检"}'}</code>。
          </p>
        </div>
      )}
      <div className="template-list">
        {items.map((t) => (
          <TemplateCard key={t.id} template={t} allTypes={allTypes} />
        ))}
      </div>
    </section>
  )
}

function TemplateCard({ template, allTypes }: { template: Resource; allTypes: EntityTypeDef[] }) {
  const [result, setResult] = useState<string | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const targetType = String(template.attributes['targetType'] ?? '')
  const draft = template.attributes['draft']
  const known = allTypes.some((t) => t.name === targetType)

  const apply = async () => {
    setBusy(true)
    setFailed(null)
    setResult(null)
    try {
      const created = await api.create({
        type: targetType,
        workspace: template.workspace,
        // draft 是字面量，不做插值。一个能算表达式的模板等于在配置里嵌了代码
        attributes: typeof draft === 'object' && draft !== null ? draft : {},
        labels: ['from-template'],
      })
      setResult(created.id)
    } catch (e) {
      setFailed(e instanceof ApiError ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <article className="template-card" data-id={template.id}>
      <h4>{String(template.attributes['name'] ?? template.id)}</h4>
      <div className="template-meta">
        生成 <code>{targetType}</code>
        {/* 目标类型不在本体里就别让人点：点下去必然失败，
            而失败信息会指向"创建被拒"，指不到"模板写错了" */}
        {!known && <span className="field-error"> · 本体里没有这个类型</span>}
      </div>
      <pre className="template-draft">{JSON.stringify(draft, null, 2)}</pre>
      <button
        className="btn primary"
        data-action="apply"
        disabled={busy || !known}
        onClick={() => void apply()}
      >
        {busy ? '套用中…' : '套用'}
      </button>
      {result !== null && (
        <div className="template-result" data-created={result}>
          已生成 {result}
        </div>
      )}
      {failed !== null && <div className="form-error">{failed}</div>}
    </article>
  )
}
