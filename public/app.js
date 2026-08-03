// @ts-check
/**
 * ProjectOS 看板。
 *
 * 一条贯穿始终的原则：**前端不硬编码任何业务语义**。
 *   - 列是什么          → GET /v1/workflows        （状态机定义）
 *   - 卡片能拖到哪       → GET .../transitions       （引擎算出来的）
 *   - 新建表单有哪些字段 → GET /v1/ontology/entity-types（本体）
 *
 * 这是 ADR-0001 的"UI 是本体的渲染视图"落到实处的地方：
 * 给 Task 加一个属性、给状态机加一个状态，前端一行都不用改。
 */

const state = {
  /** @type {{principal: string, roles: string, label: string}} */
  identity: loadIdentity(),
  /** @type {any[]} */ entityTypes: [],
  /** @type {any[]} */ lifecycles: [],
  /** @type {string} */ activeType: '',
  /** @type {any[]} */ items: [],
  /** @type {string|null} */ selectedId: null,
  /** @type {Set<string>} */ dropReady: new Set(),
  /** @type {Map<string,string>} */ dropBlocked: new Map(),
  /** @type {string|null} */ draggingId: null,
}

const el = {
  board: /** @type {HTMLElement} */ (document.getElementById('board')),
  typeTabs: /** @type {HTMLElement} */ (document.getElementById('typeTabs')),
  identityBtn: /** @type {HTMLElement} */ (document.getElementById('identityBtn')),
  identityLabel: /** @type {HTMLElement} */ (document.getElementById('identityLabel')),
  newBtn: /** @type {HTMLElement} */ (document.getElementById('newBtn')),
  pollDot: /** @type {HTMLElement} */ (document.getElementById('pollDot')),
  drawer: /** @type {HTMLElement} */ (document.getElementById('drawer')),
  drawerType: /** @type {HTMLElement} */ (document.getElementById('drawerType')),
  drawerTitle: /** @type {HTMLElement} */ (document.getElementById('drawerTitle')),
  drawerBody: /** @type {HTMLElement} */ (document.getElementById('drawerBody')),
  drawerClose: /** @type {HTMLElement} */ (document.getElementById('drawerClose')),
  backdrop: /** @type {HTMLElement} */ (document.getElementById('modalBackdrop')),
  modalTitle: /** @type {HTMLElement} */ (document.getElementById('modalTitle')),
  modalForm: /** @type {HTMLFormElement} */ (document.getElementById('modalForm')),
  modalSubmit: /** @type {HTMLElement} */ (document.getElementById('modalSubmit')),
  modalCancel: /** @type {HTMLElement} */ (document.getElementById('modalCancel')),
  modalClose: /** @type {HTMLElement} */ (document.getElementById('modalClose')),
  toasts: /** @type {HTMLElement} */ (document.getElementById('toasts')),
}

// ── 身份 ────────────────────────────────────────────

function loadIdentity() {
  try {
    const raw = localStorage.getItem('projectos.identity')
    if (raw !== null) return JSON.parse(raw)
  } catch {
    // 存坏了就退回默认身份，不值得为此让整个页面打不开
  }
  return { principal: 'user://alice', roles: 'Admin', label: 'alice · Admin' }
}

function saveIdentity(identity) {
  state.identity = identity
  localStorage.setItem('projectos.identity', JSON.stringify(identity))
  el.identityLabel.textContent = identity.label
}

function headers() {
  return {
    'content-type': 'application/json',
    'x-principal': state.identity.principal,
    // v1 单租户运行（ADR-0005），界面上不出现租户概念
    'x-tenant': 'default',
    'x-roles': state.identity.roles,
    'x-capabilities': '',
  }
}

// ── HTTP ────────────────────────────────────────────

/**
 * 统一请求。
 *
 * 失败时把服务端的 `message` 原样抛出——那是我们特意设计成人类可读的：
 * 「attribute "assignee" must be set」比「操作失败」有用得多。
 */
async function api(path, init = {}) {
  const res = await fetch(path, { ...init, headers: { ...headers(), ...(init.headers ?? {}) } })
  if (res.status === 204) return null
  const text = await res.text()
  const body = text === '' ? null : JSON.parse(text)
  if (!res.ok) {
    const error = new Error(body?.message ?? `HTTP ${res.status}`)
    // @ts-ignore 附带字段级细节，供表单逐字段标红
    error.details = body?.details ?? null
    // @ts-ignore
    error.code = body?.error ?? 'error'
    throw error
  }
  return body
}

// ── 提示 ────────────────────────────────────────────

function toast(title, detail = '', kind = 'ok') {
  const node = document.createElement('div')
  node.className = `toast ${kind}`
  node.innerHTML = `<div class="title"></div>${detail ? '<div class="detail"></div>' : ''}`
  node.querySelector('.title').textContent = title
  if (detail) node.querySelector('.detail').textContent = detail
  el.toasts.append(node)
  // 错误留久一点：守卫原因往往是一句需要读完的话
  setTimeout(() => node.remove(), kind === 'error' ? 6500 : 3000)
}

// ── 引导 ────────────────────────────────────────────

async function bootstrap() {
  saveIdentity(state.identity)
  const [types, flows] = await Promise.all([
    api('/v1/ontology/entity-types'),
    api('/v1/workflows'),
  ])
  state.entityTypes = types.items
  state.lifecycles = flows.items

  // 只展示有生命周期的类型：没有状态机的对象没有列可分
  const boardable = state.entityTypes.filter((t) => lifecycleFor(t.name) !== undefined)
  state.activeType = boardable[0]?.name ?? ''
  renderTabs(boardable)
  await refresh()
}

function lifecycleFor(typeName) {
  return state.lifecycles.find((l) => l.entityType === typeName)
}

function renderTabs(types) {
  el.typeTabs.replaceChildren(
    ...types.map((t) => {
      const btn = document.createElement('button')
      btn.className = 'type-tab'
      btn.textContent = t.name
      btn.setAttribute('aria-selected', String(t.name === state.activeType))
      btn.onclick = async () => {
        state.activeType = t.name
        renderTabs(types)
        closeDrawer()
        await refresh()
      }
      return btn
    }),
  )
}

// ── 看板 ────────────────────────────────────────────

async function refresh() {
  if (state.activeType === '') return
  const result = await api('/v1/resources:query', {
    method: 'POST',
    body: JSON.stringify({ type: state.activeType, page: { size: 200 } }),
  })
  state.items = result.items
  renderBoard()
}

function renderBoard() {
  const lifecycle = lifecycleFor(state.activeType)
  if (lifecycle === undefined) {
    el.board.replaceChildren(hint('没有可展示的类型', '本体里还没有绑定生命周期的对象'))
    return
  }

  const byStatus = new Map(lifecycle.states.map((s) => [s.name, []]))
  for (const item of state.items) {
    // 状态机改过之后，历史对象可能停在已被删除的状态上。
    // 与其丢掉它们，不如单独列一列——看不见的数据比难看的数据危险。
    if (!byStatus.has(item.status)) byStatus.set(item.status, [])
    byStatus.get(item.status).push(item)
  }

  el.board.replaceChildren(
    ...[...byStatus.entries()].map(([status, items]) => {
      const def = lifecycle.states.find((s) => s.name === status)
      return renderColumn(status, def, items)
    }),
  )
}

function renderColumn(status, def, items) {
  const column = document.createElement('section')
  column.className = 'column'
  column.dataset['status'] = status

  const head = document.createElement('div')
  head.className = 'column-head'
  head.innerHTML = `<span></span><span class="count"></span>`
  head.querySelector('span').textContent = status
  head.querySelector('.count').textContent = String(items.length)
  if (def?.terminal) {
    const tag = document.createElement('span')
    tag.className = 'terminal'
    tag.textContent = '终态'
    head.append(tag)
  }
  if (def === undefined) {
    const tag = document.createElement('span')
    tag.className = 'terminal'
    tag.textContent = '未定义状态'
    head.append(tag)
  }

  const body = document.createElement('div')
  body.className = 'column-body'
  if (items.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'empty'
    empty.textContent = '空'
    body.append(empty)
  } else {
    body.append(...items.map(renderCard))
  }

  column.append(head, body)

  column.addEventListener('dragover', (event) => {
    if (state.draggingId === null) return
    if (!state.dropReady.has(status)) return
    event.preventDefault() // 只有可放的列才接受，浏览器据此显示不同光标
  })

  column.addEventListener('drop', async (event) => {
    event.preventDefault()
    const id = state.draggingId
    if (id === null) return
    await moveTo(id, status)
  })

  return column
}

function renderCard(item) {
  const card = document.createElement('article')
  card.className = 'card'
  card.draggable = true
  card.dataset['id'] = item.id

  const title = document.createElement('div')
  title.className = 'card-title'
  title.textContent = item.attributes.title ?? item.attributes.name ?? item.attributes.question ?? item.id

  const meta = document.createElement('div')
  meta.className = 'card-meta'
  for (const chip of cardChips(item)) meta.append(chip)

  card.append(title)
  if (meta.childElementCount > 0) card.append(meta)

  card.addEventListener('click', () => openDrawer(item.id))

  card.addEventListener('dragstart', async (event) => {
    state.draggingId = item.id
    card.classList.add('dragging')
    event.dataTransfer?.setData('text/plain', item.id)
    // 拖起来的瞬间就问引擎：这张卡现在能去哪、去不了的地方缺什么。
    // 前端不推理流程，只把引擎的答案画出来。
    await loadDropTargets(item.id)
    paintDropTargets()
  })

  card.addEventListener('dragend', () => {
    card.classList.remove('dragging')
    state.draggingId = null
    state.dropReady.clear()
    state.dropBlocked.clear()
    clearDropPaint()
  })

  return card
}

function cardChips(item) {
  const chips = []
  const a = item.attributes

  if (typeof a.assignee === 'string' && a.assignee !== '') {
    chips.push(chip(a.assignee.replace(/^(user|agent):\/\//, ''), 'accent'))
  }
  if (typeof a.storyPoint === 'number') chips.push(chip(`${a.storyPoint} 点`))
  if (typeof a.level === 'string') chips.push(chip(a.level))
  if (typeof a.priority === 'string') chips.push(chip(a.priority))
  if (typeof a.blockReason === 'string' && a.blockReason !== '') {
    chips.push(chip(`阻塞：${a.blockReason}`, 'warn'))
  }
  for (const label of item.labels ?? []) chips.push(chip(label))
  return chips
}

function chip(text, variant = '') {
  const node = document.createElement('span')
  node.className = `chip ${variant}`.trim()
  node.textContent = text
  return node
}

async function loadDropTargets(id) {
  state.dropReady.clear()
  state.dropBlocked.clear()
  try {
    const result = await api(`/v1/resources/${id}/transitions`)
    for (const t of result.items) {
      if (t.ready) state.dropReady.add(t.to)
      else state.dropBlocked.set(t.to, t.blockedBy ?? '条件未满足')
    }
  } catch (error) {
    toast('读取可用迁移失败', String(error.message), 'error')
  }
}

function paintDropTargets() {
  for (const column of el.board.querySelectorAll('.column')) {
    const status = column.dataset['status']
    if (state.dropReady.has(status)) column.classList.add('drop-ok')
    else column.classList.add('drop-no')
  }
}

function clearDropPaint() {
  for (const column of el.board.querySelectorAll('.column')) {
    column.classList.remove('drop-ok', 'drop-no')
  }
}

async function moveTo(id, to) {
  try {
    await api(`/v1/resources/${id}/transitions`, {
      method: 'POST',
      body: JSON.stringify({ to }),
    })
    toast(`已推进到 ${to}`)
    await refresh()
    if (state.selectedId === id) await openDrawer(id)
    // 自动化是异步的（poller 下一轮才消费），稍后再刷一次让联动可见
    setTimeout(() => void refresh(), 1200)
  } catch (error) {
    // 守卫原因原样呈现：它已经说清了缺什么
    toast('无法推进', String(error.message), 'error')
  }
}

// ── 详情抽屉 ────────────────────────────────────────

async function openDrawer(id) {
  state.selectedId = id
  el.drawer.hidden = false
  el.drawerBody.replaceChildren(hint('加载中…', '', true))

  try {
    const [item, transitions, history, relations] = await Promise.all([
      api(`/v1/resources/${id}`),
      api(`/v1/resources/${id}/transitions`),
      api(`/v1/resources/${id}/history?size=20`),
      api(`/v1/resources/${id}/relations?direction=both`),
    ])

    el.drawerType.textContent = `${item.type} · ${item.status}`
    el.drawerTitle.textContent =
      item.attributes.title ?? item.attributes.name ?? item.attributes.question ?? item.id

    el.drawerBody.replaceChildren(
      sectionTransitions(id, transitions.items),
      sectionAttributes(item),
      sectionRelations(id, relations.items),
      sectionHistory(history.items),
    )
  } catch (error) {
    el.drawerBody.replaceChildren(hint('加载失败', String(error.message), true))
  }
}

function closeDrawer() {
  el.drawer.hidden = true
  state.selectedId = null
}

function sectionTransitions(id, transitions) {
  const section = document.createElement('div')
  section.className = 'section'
  section.append(heading('可用迁移'))

  if (transitions.length === 0) {
    section.append(hint('没有可执行的迁移', '可能已是终态，或当前身份没有权限', true))
    return section
  }

  const list = document.createElement('div')
  list.className = 'transition-list'

  for (const t of transitions) {
    const btn = document.createElement('button')
    btn.className = 'transition'
    btn.disabled = !t.ready

    const arrow = document.createElement('span')
    arrow.className = 'arrow'
    arrow.textContent = '→'

    const name = document.createElement('span')
    name.textContent = t.to

    btn.append(arrow, name)

    // 未就绪的也列出来，并说明差什么。
    // 只显示能点的会让用户以为"就这些了"，而不知道下一步需要先做什么。
    if (!t.ready) {
      const why = document.createElement('span')
      why.className = 'why'
      why.textContent = t.blockedBy ?? '条件未满足'
      btn.append(why)
    }

    btn.onclick = () => void moveTo(id, t.to)
    list.append(btn)
  }

  section.append(list)
  return section
}

function sectionAttributes(item) {
  const section = document.createElement('div')
  section.className = 'section'
  section.append(heading('属性'))

  const dl = document.createElement('dl')
  dl.className = 'kv'

  const rows = [
    ['ID', item.id],
    ['负责人', item.owner],
    ['本体版本', item.ontologyVersion],
    ['版本', String(item.version)],
    ['更新于', formatTime(item.updatedAt)],
  ]
  for (const [key, value] of Object.entries(item.attributes)) {
    rows.push([key, typeof value === 'object' ? JSON.stringify(value) : String(value)])
  }

  for (const [key, value] of rows) {
    const dt = document.createElement('dt')
    dt.textContent = key
    const dd = document.createElement('dd')
    dd.textContent = value
    dl.append(dt, dd)
  }

  section.append(dl)
  return section
}

function sectionRelations(id, relations) {
  const section = document.createElement('div')
  section.className = 'section'
  section.append(heading(`关系（${relations.length}）`))

  if (relations.length === 0) {
    section.append(hint('暂无关系', '', true))
    return section
  }

  const list = document.createElement('div')
  list.className = 'rel-list'
  for (const r of relations) {
    const outgoing = r.fromId === id
    const otherId = outgoing ? r.toId : r.fromId
    const row = document.createElement('div')

    const label = document.createElement('span')
    label.textContent = `${outgoing ? '→' : '←'} ${r.type} `

    const link = document.createElement('a')
    link.textContent = otherId
    link.onclick = () => void openDrawer(otherId)

    row.append(label, link)

    // Agent 推断的关系标注置信度与待确认状态（FR-ONT-006）
    if (r.confidence !== null) {
      row.append(chip(`置信 ${Math.round(r.confidence * 100)}%`, r.confirmed === null ? 'warn' : ''))
    }
    list.append(row)
  }

  section.append(list)
  return section
}

function sectionHistory(entries) {
  const section = document.createElement('div')
  section.className = 'section'
  section.append(heading('变更历史'))

  const list = document.createElement('div')
  list.className = 'timeline'

  for (const entry of entries) {
    const item = document.createElement('div')
    item.className = 'timeline-item'

    const when = document.createElement('div')
    when.className = 'when'
    when.textContent = formatTime(entry.changedAt)

    const who = document.createElement('span')
    const isSystem = entry.changedBy.startsWith('system://')
    who.className = `who${isSystem ? ' system' : ''}`
    // 自动化改的东西必须一眼看得出是自动化改的
    who.textContent = isSystem ? '自动化' : entry.changedBy.replace(/^(user|agent):\/\//, '')

    const change = document.createElement('div')
    change.className = 'change'
    change.textContent = entry.changes
      .map((c) => (c.path === '(created)' ? '创建' : `${c.path}: ${fmt(c.from)} → ${fmt(c.to)}`))
      .join('；')

    item.append(when, who, change)

    if (entry.reason !== null && entry.reason !== '') {
      const reason = document.createElement('div')
      reason.className = 'reason'
      reason.textContent = entry.reason
      item.append(reason)
    }
    list.append(item)
  }

  section.append(list)
  return section
}

function fmt(value) {
  if (value === null || value === undefined) return '空'
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

function formatTime(iso) {
  const date = new Date(iso)
  return date.toLocaleString('zh-CN', { hour12: false })
}

// ── 新建（表单由本体生成） ─────────────────────────

function openCreateModal() {
  const def = state.entityTypes.find((t) => t.name === state.activeType)
  if (def === undefined) return

  el.modalTitle.textContent = `新建 ${def.name}`
  el.modalForm.replaceChildren()

  // 只渲染人要填的属性。`derived` 是本体里的标记，不是前端的判断——
  // 前端一旦开始自己决定"哪些字段该显示"，语义就漏到 UI 层了。
  const editable = def.attributes.filter((a) => a.derived !== true)
  for (const attr of editable) el.modalForm.append(fieldFor(attr))

  el.modalSubmit.onclick = async () => {
    const attributes = collectForm(editable)
    try {
      await api('/v1/resources', {
        method: 'POST',
        body: JSON.stringify({ type: def.name, workspace: 'ws_default', attributes }),
      })
      closeModal()
      toast(`已创建 ${def.name}`)
      await refresh()
    } catch (error) {
      showFormErrors(error)
    }
  }

  el.backdrop.hidden = false
}

/** 由本体属性生成一个输入控件 */
function fieldFor(attr) {
  const wrap = document.createElement('div')
  wrap.className = attr.kind === 'bool' ? 'field checkbox' : 'field'
  wrap.dataset['name'] = attr.name

  const label = document.createElement('label')
  label.textContent = attr.name
  label.htmlFor = `f_${attr.name}`
  if (attr.required === true) {
    const req = document.createElement('span')
    req.className = 'req'
    req.textContent = '*'
    label.append(req)
  }

  let input
  switch (attr.kind) {
    case 'enum': {
      input = document.createElement('select')
      const blank = document.createElement('option')
      blank.value = ''
      blank.textContent = attr.required === true ? '请选择' : '（不设置）'
      input.append(blank)
      for (const value of attr.values ?? []) {
        const option = document.createElement('option')
        option.value = value
        option.textContent = value
        input.append(option)
      }
      break
    }
    case 'text':
    case 'richtext':
    case 'json':
      input = document.createElement('textarea')
      break
    case 'bool':
      input = document.createElement('input')
      input.type = 'checkbox'
      break
    case 'int':
    case 'float':
    case 'percent':
      input = document.createElement('input')
      input.type = 'number'
      if (attr.kind === 'int') input.step = '1'
      break
    case 'datetime':
      input = document.createElement('input')
      input.type = 'datetime-local'
      break
    default:
      input = document.createElement('input')
      input.type = 'text'
  }

  input.id = `f_${attr.name}`
  input.dataset['kind'] = attr.kind

  if (attr.kind === 'bool') {
    wrap.append(input, label)
  } else {
    wrap.append(label, input)
  }

  if (typeof attr.description === 'string') {
    const hintNode = document.createElement('div')
    hintNode.className = 'hint'
    hintNode.textContent = attr.description
    wrap.append(hintNode)
  }

  return wrap
}

function collectForm(attrs) {
  /** @type {Record<string, unknown>} */
  const out = {}
  for (const attr of attrs) {
    const input = /** @type {HTMLInputElement} */ (document.getElementById(`f_${attr.name}`))
    if (input === null) continue

    if (attr.kind === 'bool') {
      if (input.checked) out[attr.name] = true
      continue
    }

    const raw = input.value.trim()
    // 空值一律不提交，让本体的必填校验来报错——
    // 前端再实现一遍必填规则，就成了两份会漂移的真相
    if (raw === '') continue

    if (attr.kind === 'int' || attr.kind === 'float' || attr.kind === 'percent') {
      out[attr.name] = Number(raw)
    } else if (attr.kind === 'datetime') {
      out[attr.name] = new Date(raw).toISOString()
    } else if (attr.kind === 'json') {
      try {
        out[attr.name] = JSON.parse(raw)
      } catch {
        out[attr.name] = raw
      }
    } else {
      out[attr.name] = raw
    }
  }
  return out
}

/** 把服务端返回的字段级错误标到对应输入框上（FR-ONT-002 的收益兑现处） */
function showFormErrors(error) {
  for (const node of el.modalForm.querySelectorAll('.field-error')) node.remove()

  const fields = error.details?.fields
  if (!Array.isArray(fields)) {
    toast('创建失败', String(error.message), 'error')
    return
  }

  for (const field of fields) {
    const wrap = el.modalForm.querySelector(`[data-name="${CSS.escape(field.path)}"]`)
    const message = document.createElement('div')
    message.className = 'field-error'
    message.textContent = field.message
    if (wrap === null) el.modalForm.append(message)
    else wrap.append(message)
  }
  toast('创建失败', '有字段未通过本体校验', 'error')
}

// ── 身份切换 ────────────────────────────────────────

const PRESETS = [
  { principal: 'user://alice', roles: 'Admin', label: 'alice · Admin' },
  { principal: 'user://pat', roles: 'PM', label: 'pat · PM' },
  { principal: 'user://bob', roles: 'RD', label: 'bob · RD' },
  { principal: 'user://quinn', roles: 'QA', label: 'quinn · QA' },
  { principal: 'user://guest', roles: 'Guest', label: 'guest · Guest' },
]

function openIdentityModal() {
  el.modalTitle.textContent = '切换身份'
  el.modalForm.replaceChildren()

  const note = document.createElement('div')
  note.className = 'hint'
  note.textContent =
    'M1 用请求头承载身份，OIDC 尚未接入。切换后可以看到可用迁移随权限变化——那是 PDP 在起作用，不是界面在隐藏按钮。'
  el.modalForm.append(note)

  for (const preset of PRESETS) {
    const row = document.createElement('div')
    row.className = 'field checkbox'
    const radio = document.createElement('input')
    radio.type = 'radio'
    radio.name = 'identity'
    radio.value = preset.principal
    radio.id = `id_${preset.principal}`
    radio.checked = preset.principal === state.identity.principal
    const label = document.createElement('label')
    label.htmlFor = radio.id
    label.textContent = preset.label
    row.append(radio, label)
    el.modalForm.append(row)
  }

  el.modalSubmit.onclick = async () => {
    const picked = /** @type {HTMLInputElement|null} */ (
      el.modalForm.querySelector('input[name="identity"]:checked')
    )
    const preset = PRESETS.find((p) => p.principal === picked?.value)
    if (preset !== undefined) saveIdentity(preset)
    closeModal()
    closeDrawer()
    await refresh()
  }

  el.backdrop.hidden = false
}

function closeModal() {
  el.backdrop.hidden = true
  el.modalForm.replaceChildren()
}

// ── 杂项 ────────────────────────────────────────────

function heading(text) {
  const h = document.createElement('h3')
  h.textContent = text
  return h
}

/**
 * 空状态 / 提示。
 *
 * `inline` 用于抽屉内部：看板级的大号居中样式放进抽屉会盖过真正的内容。
 */
function hint(title, detail = '', inline = false) {
  const node = document.createElement('div')
  node.className = inline ? 'hint-inline' : 'board-empty'

  const head = document.createElement(inline ? 'div' : 'h2')
  head.textContent = title
  node.append(head)

  if (detail !== '') {
    const body = document.createElement(inline ? 'div' : 'p')
    body.className = inline ? 'detail' : ''
    body.textContent = detail
    node.append(body)
  }
  return node
}

// ── 启动 ────────────────────────────────────────────

el.newBtn.onclick = openCreateModal
el.identityBtn.onclick = openIdentityModal
el.drawerClose.onclick = closeDrawer
el.modalCancel.onclick = closeModal
el.modalClose.onclick = closeModal
el.backdrop.onclick = (event) => {
  if (event.target === el.backdrop) closeModal()
}
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    if (!el.backdrop.hidden) closeModal()
    else if (!el.drawer.hidden) closeDrawer()
  }
})

/**
 * 定时刷新。
 *
 * 自动化是异步的：拖动一张卡之后，Story 的联动要等 poller 下一轮。
 * 不刷新的话用户会以为规则没生效。页面不可见时暂停，别空转。
 */
setInterval(async () => {
  if (document.hidden || state.activeType === '') return
  el.pollDot.classList.add('active')
  try {
    await refresh()
  } catch {
    // 刷新失败不打扰用户：下一轮会再试
  } finally {
    setTimeout(() => el.pollDot.classList.remove('active'), 220)
  }
}, 4000)

bootstrap().catch((error) => {
  el.board.replaceChildren(hint('启动失败', String(error.message)))
})
