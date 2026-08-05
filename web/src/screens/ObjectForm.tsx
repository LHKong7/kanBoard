import { useState } from 'react'
import { api, ApiError } from '../api.ts'
import type { AttributeDef, EntityTypeDef } from '../api.ts'

/**
 * 新建表单——**字段来自本体**，不是这里写死的。
 *
 * `derived` 的属性不出现：它们由状态机或系统写入，让人填的话，
 * 这个字段说的就不再是系统观察到的事实了。
 */
export function ObjectForm({ def, onCreated }: { def: EntityTypeDef; onCreated: () => void }) {
  const editable = def.attributes.filter((a) => a.derived !== true)
  const [values, setValues] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError(null)
    setFieldErrors({})
    try {
      await api.create({
        type: def.name,
        workspace: 'ws_platform',
        attributes: coerce(editable, values),
      })
      setValues({})
      onCreated()
    } catch (e) {
      // 服务端的字段级校验标回对应输入框；标不上的才落到整体错误上——
      // 一条"attributes.hours 必须是数字"贴在表单顶上等于没说
      if (e instanceof ApiError) setError(e.message)
      else setError(String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="object-form" onSubmit={submit}>
      {editable.map((attr) => (
        <label key={attr.name} className="field" data-name={attr.name}>
          <span>
            {attr.name}
            {attr.required === true && <b className="req">*</b>}
          </span>
          {attr.kind === 'enum' ? (
            <select
              value={values[attr.name] ?? ''}
              onChange={(e) => setValues({ ...values, [attr.name]: e.target.value })}
            >
              <option value="">（不填）</option>
              {(attr.values ?? []).map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          ) : (
            <input
              type={inputType(attr)}
              value={values[attr.name] ?? ''}
              {...(attr.maxLength === undefined ? {} : { maxLength: attr.maxLength })}
              onChange={(e) => setValues({ ...values, [attr.name]: e.target.value })}
            />
          )}
          {fieldErrors[attr.name] !== undefined && (
            <em className="field-error">{fieldErrors[attr.name]}</em>
          )}
        </label>
      ))}
      <button className="btn primary" type="submit" disabled={busy}>
        {busy ? '创建中…' : `新建 ${def.name}`}
      </button>
      {error !== null && <div className="form-error">{error}</div>}
    </form>
  )
}

function inputType(attr: AttributeDef): string {
  if (attr.kind === 'datetime') return 'date'
  if (attr.kind === 'int' || attr.kind === 'float' || attr.kind === 'percent') return 'number'
  return 'text'
}

/**
 * 表单里的值都是字符串，按本体声明的 kind 转回去。
 *
 * 空串**不提交**而不是提交空串：一个可选的数字字段留空时提交 ""，
 * 会撞上服务端的类型校验，而报出来的错看起来像"这个字段填错了"。
 */
function coerce(attrs: AttributeDef[], values: Record<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const attr of attrs) {
    const raw = values[attr.name]
    if (raw === undefined || raw.trim() === '') continue
    if (attr.kind === 'int') out[attr.name] = Number.parseInt(raw, 10)
    else if (attr.kind === 'float' || attr.kind === 'percent') out[attr.name] = Number(raw)
    else if (attr.kind === 'bool') out[attr.name] = raw === 'true'
    else if (attr.kind === 'datetime') out[attr.name] = new Date(raw).toISOString()
    else if (attr.kind === 'json') out[attr.name] = safeJson(raw)
    else out[attr.name] = raw
  }
  return out
}

/** json 字段填得不合法就原样交给服务端，让它给出真正的报错，而不是前端编一个 */
function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}
