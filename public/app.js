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
  /** @type {any[]} */ relationTypes: [],
  /**
   * 正在编辑的对象。
   *
   * 定时刷新必须避开它：正在填的表单被重新渲染，输入就没了。
   * 这是"自动刷新"最容易伤到人的地方，而且伤得很隐蔽——
   * 用户会以为是自己手滑。
   */
  /** @type {{id: string, version: number}|null} */ editing: null,
  /** 当前检索词。空串表示不过滤。 */
  /** @type {string} */ search: '',
  /** 当前视图：某个类型的看板，或 Dashboard */
  /** @type {'board'|'dashboard'} */ view: 'board',
  /** @type {any[]} */ metrics: [],
  /**
   * 这一页是否被截断了。
   *
   * 看板一次最多取 200 条。不说的话，用户看到的就是"全部"——
   * 而这正是这个项目反复栽跟头的那种失败：没报错，只是答案不完整。
   */
  /** @type {boolean} */ truncated: false,
}

const el = {
  board: /** @type {HTMLElement} */ (document.getElementById('board')),
  typeTabs: /** @type {HTMLElement} */ (document.getElementById('typeTabs')),
  identityBtn: /** @type {HTMLElement} */ (document.getElementById('identityBtn')),
  identityLabel: /** @type {HTMLElement} */ (document.getElementById('identityLabel')),
  newBtn: /** @type {HTMLElement} */ (document.getElementById('newBtn')),
  searchInput: /** @type {HTMLInputElement} */ (document.getElementById('searchInput')),
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
  // content-type 只在真的有请求体时才带。
  // 无 body 却声明 application/json 会被服务端当成"空的 JSON"而报 500——
  // DELETE 就是这么炸的。
  const contentType = init.body === undefined ? {} : { 'content-type': 'application/json' }
  const res = await fetch(path, {
    ...init,
    headers: { ...headers(), ...contentType, ...(init.headers ?? {}) },
  })
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
  const [types, flows, relations] = await Promise.all([
    api('/v1/ontology/entity-types'),
    api('/v1/workflows'),
    api('/v1/ontology/relation-types'),
  ])
  state.entityTypes = types.items
  state.lifecycles = flows.items
  state.relationTypes = relations.items

  // 只展示有生命周期的类型：没有状态机的对象没有列可分
  const boardable = state.entityTypes.filter((t) => lifecycleFor(t.name) !== undefined)
  boardableTypes = boardable

  // URL 决定初始视图，不是代码里的默认值。粘一条链接过来要能看到同样的东西
  applyUrl(new URLSearchParams(location.search), boardable)
  renderTabs(boardable)
  await refresh()
}

/** 当前可上看板的类型。前进后退时要重新渲染标签页，所以存下来 */
let boardableTypes = []

/**
 * URL ⇄ 视图状态（docs/dogfooding-log.md #5）。
 *
 * 此前看板的类型和搜索词只活在内存里：一个视图没有 URL，
 * 分享不了、收藏不了、前进后退不工作。
 * URL 是**唯一事实来源**——先改地址栏，再由它决定渲染什么，
 * 两边各存一份状态迟早会对不上。
 */
function applyUrl(params, boardable) {
  state.view = params.get('view') === 'dashboard' ? 'dashboard' : 'board'
  const wanted = params.get('type')
  const valid = boardable.some((t) => t.name === wanted)
  // URL 里写了个不存在的类型就退回第一个，而不是留在空白看板上
  state.activeType = valid ? wanted : (boardable[0]?.name ?? '')
  state.search = params.get('q') ?? ''
  el.searchInput.value = state.search
}

/** 把当前视图写回地址栏。`replace` 用于不该在历史里留一条记录的变化（如输入中的搜索） */
function syncUrl(replace = false) {
  const params = new URLSearchParams()
  if (state.view === 'dashboard') params.set('view', 'dashboard')
  else if (state.activeType !== '') params.set('type', state.activeType)
  if (state.search !== '' && state.view === 'board') params.set('q', state.search)
  const qs = params.toString()
  const url = qs === '' ? location.pathname : `${location.pathname}?${qs}`
  if (url === location.pathname + location.search) return
  history[replace ? 'replaceState' : 'pushState']({}, '', url)
}

// 前进/后退：地址变了就照着地址重新渲染
window.addEventListener('popstate', async () => {
  applyUrl(new URLSearchParams(location.search), boardableTypes)
  renderTabs(boardableTypes)
  closeDrawer()
  await refresh()
})

function lifecycleFor(typeName) {
  return state.lifecycles.find((l) => l.entityType === typeName)
}

function renderTabs(types) {
  const dashboard = document.createElement('button')
  dashboard.className = 'type-tab'
  dashboard.textContent = 'Dashboard'
  dashboard.setAttribute('aria-selected', String(state.view === 'dashboard'))
  dashboard.onclick = async () => {
    state.view = 'dashboard'
    syncUrl()
    renderTabs(types)
    closeDrawer()
    await refresh()
  }

  el.typeTabs.replaceChildren(
    ...types.map((t) => {
      const btn = document.createElement('button')
      btn.className = 'type-tab'
      btn.textContent = t.name
      btn.setAttribute('aria-selected', String(state.view === 'board' && t.name === state.activeType))
      btn.onclick = async () => {
        state.view = 'board'
        state.activeType = t.name
        // 切换类型是一次导航，该在历史里留一条——后退键要能回到上一个看板
        syncUrl()
        renderTabs(types)
        closeDrawer()
        await refresh()
      }
      return btn
    }),
    dashboard,
  )
}

// ── 看板 ────────────────────────────────────────────

async function refresh() {
  if (state.view === 'dashboard') return refreshDashboard()
  if (state.activeType === '') return
  // 走 GET 而不是 POST :query。
  //
  // 一是我们自己就该用那条可分享的读路径——加了不用等于没加；
  // 二是检索交给服务端做，不在前端过滤已加载的 200 条：
  // 那样搜到的永远只是"最近 200 条里的"，而用户以为搜的是全部。
  const params = new URLSearchParams({ type: state.activeType, size: '200' })
  if (state.search !== '') params.set('text', state.search)
  const result = await api(`/v1/resources?${params}`)
  state.items = result.items
  state.truncated = result.nextCursor !== null
  renderBoard()
}

/**
 * Dashboard（FR-DASH-005/006）。
 *
 * 每张卡片显示一个指标，并把**口径**一起显示出来——
 * 一个没有口径的数字，两个人会读出两个意思。
 * 点开就是下钻：同一个 filter 不做聚合再跑一遍，所以条数必然对得上。
 */
async function refreshDashboard() {
  if (state.metrics.length === 0) {
    state.metrics = (await api('/v1/metrics')).items
  }
  el.board.replaceChildren(hint('加载指标…', '', true))

  const values = await Promise.all(
    state.metrics.map(async (m) => {
      try {
        return await api(`/v1/metrics/${m.id}`)
      } catch (error) {
        // 一个指标算不出来不该让整块面板空白。把失败显示成失败，
        // 而不是显示成 0——0 是个会被当真的数字
        return { id: m.id, title: m.title, failed: String(error.message) }
      }
    }),
  )

  const grid = document.createElement('div')
  grid.className = 'metric-grid'
  grid.append(...values.map(renderMetricCard))
  el.board.replaceChildren(grid)
}

function renderMetricCard(value) {
  const card = document.createElement('section')
  card.className = 'metric-card'
  card.dataset['metric'] = value.id

  const title = document.createElement('div')
  title.className = 'metric-title'
  title.textContent = value.title
  card.append(title)

  if (value.failed !== undefined) {
    const failed = document.createElement('div')
    failed.className = 'metric-failed'
    failed.textContent = `算不出来：${value.failed}`
    card.append(failed)
    return card
  }

  if (value.groups.length === 0) {
    const big = document.createElement('button')
    big.className = `metric-value ${value.direction}`
    big.textContent = String(value.total)
    big.onclick = () => void openBreakdown(value)
    card.append(big)
  } else {
    const list = document.createElement('div')
    list.className = 'metric-groups'
    for (const g of value.groups) {
      const row = document.createElement('button')
      row.className = 'metric-group'
      row.dataset['group'] = g.key
      row.innerHTML = '<span></span><span class="count"></span>'
      row.querySelector('span').textContent = g.key
      row.querySelector('.count').textContent = String(g.count)
      row.onclick = () => void openBreakdown(value, g.key)
      list.append(row)
    }
    card.append(list)
  }

  // 口径跟着数字走，不放在别处的文档里
  const definition = document.createElement('div')
  definition.className = 'metric-definition'
  definition.textContent = value.definition
  card.append(definition)
  return card
}

/** 下钻：把构成这个数字的对象列出来 */
async function openBreakdown(value, group) {
  el.drawer.hidden = false
  el.drawerType.textContent = '指标下钻'
  el.drawerTitle.textContent = group === undefined ? value.title : `${value.title} · ${group}`
  el.drawerBody.replaceChildren(hint('加载中…', '', true))

  try {
    const qs = group === undefined ? '' : `?group=${encodeURIComponent(group)}`
    const result = await api(`/v1/metrics/${value.id}/items${qs}`)
    const section = document.createElement('div')
    section.className = 'section'

    const count = document.createElement('div')
    count.className = 'hint'
    count.textContent = `${result.items.length} 项${result.nextCursor === null ? '' : '（还有更多）'}`
    section.append(count)

    for (const item of result.items) {
      const row = document.createElement('button')
      row.className = 'rel-row'
      row.dataset['id'] = item.id
      row.textContent = `${item.type} · ${item.attributes.title ?? item.attributes.name ?? item.id} · ${item.status}`
      row.onclick = () => void openDrawer(item.id)
      section.append(row)
    }
    el.drawerBody.replaceChildren(section)
  } catch (error) {
    el.drawerBody.replaceChildren(hint('下钻失败', String(error.message), true))
  }
}

function renderBoard() {
  const lifecycle = lifecycleFor(state.activeType)
  if (lifecycle === undefined) {
    el.board.replaceChildren(hint('没有可展示的类型', '本体里还没有绑定生命周期的对象'))
    return
  }

  if (state.search !== '' && state.items.length === 0) {
    el.board.replaceChildren(hint(`没有匹配「${state.search}」的 ${state.activeType}`, '换个词，或切到别的类型试试'))
    return
  }

  const byStatus = new Map(lifecycle.states.map((s) => [s.name, []]))
  for (const item of state.items) {
    // 状态机改过之后，历史对象可能停在已被删除的状态上。
    // 与其丢掉它们，不如单独列一列——看不见的数据比难看的数据危险。
    if (!byStatus.has(item.status)) byStatus.set(item.status, [])
    byStatus.get(item.status).push(item)
  }

  const columns = [...byStatus.entries()].map(([status, items]) => {
    const def = lifecycle.states.find((s) => s.name === status)
    return renderColumn(status, def, items)
  })

  el.board.replaceChildren(...columns)
  renderTruncationNotice()
}

/** 只显示了一部分就得说出来——静默截断会被当成"就这么多" */
function renderTruncationNotice() {
  const existing = document.getElementById('truncationNotice')
  if (existing !== null) existing.remove()
  if (!state.truncated) return

  const notice = document.createElement('div')
  notice.id = 'truncationNotice'
  notice.className = 'truncation'
  notice.textContent =
    state.search === ''
      ? `只显示了最新的 ${state.items.length} 条，还有更多——用搜索框缩小范围`
      : `匹配「${state.search}」的结果超过 ${state.items.length} 条，只显示了最新的这些`
  el.board.append(notice)
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
      sectionRelations(item, relations.items),
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

  const head = document.createElement('div')
  head.className = 'section-head'
  head.append(heading('属性'))
  const editBtn = document.createElement('button')
  editBtn.className = 'link-btn'
  editBtn.id = 'editAttrsBtn'
  editBtn.textContent = '编辑'
  editBtn.onclick = () => startEditing(item)
  head.append(editBtn)
  section.append(head)

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

function sectionRelations(item, relations) {
  const id = item.id
  const section = document.createElement('div')
  section.className = 'section'

  const head = document.createElement('div')
  head.className = 'section-head'
  head.append(heading(`关系（${relations.length}）`))
  const addBtn = document.createElement('button')
  addBtn.className = 'link-btn'
  addBtn.id = 'addRelationBtn'
  addBtn.textContent = '+ 关联'
  addBtn.onclick = () => void openRelationModal(item)
  head.append(addBtn)
  section.append(head)

  if (relations.length === 0) {
    section.append(hint('暂无关系', '守卫常常要求某种关系存在，可以从这里建立', true))
    return section
  }

  const list = document.createElement('div')
  list.className = 'rel-list'
  for (const r of relations) {
    const outgoing = r.fromId === id
    const otherId = outgoing ? r.toId : r.fromId
    const row = document.createElement('div')
    row.className = 'rel-row'
    row.dataset['relationId'] = r.id

    const label = document.createElement('span')
    label.textContent = `${outgoing ? '→' : '←'} ${r.type} `

    const link = document.createElement('a')
    link.textContent = otherId
    link.onclick = () => void openDrawer(otherId)

    row.append(label, link)

    // Agent 推断的关系标注置信度，并提供确认 / 否决（FR-ONT-006）
    if (r.confidence !== null) {
      row.append(chip(`置信 ${Math.round(r.confidence * 100)}%`, r.confirmed === null ? 'warn' : ''))
    }
    if (r.confirmed === null) {
      row.append(relAction('确认', () => void confirmRelation(id, r.id, true)))
      row.append(relAction('否决', () => void confirmRelation(id, r.id, false)))
    } else if (r.confirmed === false) {
      row.append(chip('已否决', 'warn'))
    }

    row.append(relAction('删除', () => void removeRelation(id, r.id), 'danger'))
    list.append(row)
  }

  section.append(list)
  return section
}

function relAction(text, onClick, variant = '') {
  const btn = document.createElement('button')
  btn.className = `link-btn ${variant}`.trim()
  btn.textContent = text
  btn.onclick = onClick
  return btn
}

async function removeRelation(ownerId, relationId) {
  try {
    await api(`/v1/relations/${relationId}`, { method: 'DELETE' })
    toast('关系已删除')
    await openDrawer(ownerId)
  } catch (error) {
    toast('删除失败', String(error.message), 'error')
  }
}

async function confirmRelation(ownerId, relationId, confirmed) {
  try {
    await api(`/v1/relations/${relationId}/confirmation`, {
      method: 'POST',
      body: JSON.stringify({ confirmed }),
    })
    // 否决不是删除：被否决的推断是负样本，删掉就丢了
    toast(confirmed ? '已确认' : '已否决，该关系不再参与遍历与守卫')
    await openDrawer(ownerId)
  } catch (error) {
    toast('操作失败', String(error.message), 'error')
  }
}

/**
 * 建立关系。
 *
 * 可选的关系类型由**本体的定义域**决定：当前对象类型能做起点的关系才列出来。
 * 让用户从全部关系类型里挑，然后被 422 打回来，是把本体知识留给了用户去记。
 */
async function openRelationModal(item) {
  const candidates = state.relationTypes.filter((r) => r.domain.includes(item.type))
  if (candidates.length === 0) {
    toast('没有可用的关系类型', `本体里没有以 ${item.type} 为起点的关系`, 'error')
    return
  }

  el.modalTitle.textContent = `为 ${item.type} 建立关系`
  el.modalForm.replaceChildren()

  const typeField = document.createElement('div')
  typeField.className = 'field'
  const typeLabel = document.createElement('label')
  typeLabel.textContent = '关系类型'
  typeLabel.htmlFor = 'relType'
  const typeSelect = document.createElement('select')
  typeSelect.id = 'relType'
  for (const r of candidates) {
    const option = document.createElement('option')
    option.value = r.name
    option.textContent = `${r.name} → ${r.range.join(' / ')}`
    typeSelect.append(option)
  }
  typeField.append(typeLabel, typeSelect)

  const targetField = document.createElement('div')
  targetField.className = 'field'
  const targetLabel = document.createElement('label')
  targetLabel.textContent = '目标对象'
  targetLabel.htmlFor = 'relTarget'
  // 搜索框：只列"最近 50 条"时，对象一多就根本选不到想要的那个。
  // 检索能力有了（FR-RES-016），这里直接用上
  const targetSearch = document.createElement('input')
  targetSearch.type = 'search'
  targetSearch.id = 'relTargetSearch'
  targetSearch.className = 'search'
  targetSearch.autocomplete = 'off'
  targetSearch.placeholder = '筛选候选对象'
  const targetSelect = document.createElement('select')
  targetSelect.id = 'relTarget'
  const targetHint = document.createElement('div')
  targetHint.className = 'hint'
  targetField.append(targetLabel, targetSearch, targetSelect, targetHint)

  /** 按所选关系的值域拉候选对象；有检索词就交给服务端过滤 */
  const loadTargets = async () => {
    const def = candidates.find((r) => r.name === typeSelect.value)
    const term = targetSearch.value.trim()
    targetSelect.replaceChildren()
    targetHint.textContent = '加载中…'
    const options = []
    let truncated = false
    for (const type of def?.range ?? []) {
      const picker = new URLSearchParams({ type, size: '50' })
      if (term !== '') picker.set('text', term)
      const result = await api(`/v1/resources?${picker}`)
      if (result.nextCursor !== null) truncated = true
      for (const candidate of result.items) {
        if (candidate.id === item.id) continue // 自环被数据库约束挡住，不如先别列出来
        options.push(candidate)
      }
    }
    for (const candidate of options) {
      const option = document.createElement('option')
      option.value = candidate.id
      const title = candidate.attributes.title ?? candidate.attributes.name ?? candidate.id
      option.textContent = `${candidate.type} · ${title}`
      targetSelect.append(option)
    }
    // 列不全就说出来。以前这里写死"最近 50 条"，现在如实反映有没有被截断
    targetHint.textContent =
      options.length === 0
        ? term === ''
          ? '没有可选对象'
          : `没有匹配「${term}」的候选对象`
        : truncated
          ? `${options.length} 个候选，还有更多——用上面的框缩小范围`
          : `${options.length} 个候选（已列全）`
  }

  let targetSearchTimer = 0
  targetSearch.addEventListener('input', () => {
    clearTimeout(targetSearchTimer)
    targetSearchTimer = setTimeout(() => void loadTargets(), 200)
  })
  typeSelect.onchange = () => void loadTargets()
  el.modalForm.append(typeField, targetField)
  await loadTargets()

  el.modalSubmit.onclick = async () => {
    try {
      await api(`/v1/resources/${item.id}/relations`, {
        method: 'POST',
        body: JSON.stringify({ type: typeSelect.value, toId: targetSelect.value }),
      })
      closeModal()
      toast('关系已建立')
      await openDrawer(item.id)
    } catch (error) {
      toast('建立失败', String(error.message), 'error')
    }
  }

  el.backdrop.hidden = false
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

/**
 * 就地编辑属性。
 *
 * 表单复用 `fieldFor`——和新建走同一个生成器。两份表单生成器迟早会长歪，
 * 而"新建能填的字段"和"编辑能改的字段"本来就该是同一套。
 */
function startEditing(item) {
  const def = state.entityTypes.find((t) => t.name === item.type)
  if (def === undefined) return

  // 记下版本号：保存时带上，服务端据此判断这期间有没有被别人改过
  state.editing = { id: item.id, version: item.version }

  const section = document.createElement('div')
  section.className = 'section'
  section.id = 'editForm'
  section.append(heading(`编辑 ${item.type}`))

  const editable = def.attributes.filter((a) => a.derived !== true)
  for (const attr of editable) {
    const field = fieldFor(attr)
    const input = /** @type {HTMLInputElement} */ (field.querySelector(`#f_${attr.name}`))
    const current = item.attributes[attr.name]
    if (input !== null && current !== undefined && current !== null) {
      if (attr.kind === 'bool') input.checked = current === true
      else if (attr.kind === 'datetime') input.value = String(current).slice(0, 16)
      else if (attr.kind === 'json') input.value = JSON.stringify(current)
      else input.value = String(current)
    }
    section.append(field)
  }

  // derived 字段只读展示：它们由状态机写入，让人改会造成
  // "改了但下一次迁移又被覆盖"，那种不一致比不让改更让人困惑
  const derived = def.attributes.filter((a) => a.derived === true && item.attributes[a.name] != null)
  if (derived.length > 0) {
    const note = document.createElement('div')
    note.className = 'hint'
    note.textContent = `由系统写入，不可编辑：${derived.map((a) => a.name).join('、')}`
    section.append(note)
  }

  const actions = document.createElement('div')
  actions.className = 'form-actions'

  const save = document.createElement('button')
  save.className = 'btn primary'
  save.id = 'saveAttrsBtn'
  save.textContent = '保存'
  save.onclick = () => void saveEditing(item, editable)

  const cancel = document.createElement('button')
  cancel.className = 'btn ghost'
  cancel.id = 'cancelAttrsBtn'
  cancel.textContent = '取消'
  cancel.onclick = () => {
    state.editing = null
    void openDrawer(item.id)
  }

  actions.append(save, cancel)
  section.append(actions)

  // 只替换属性区，保留迁移/关系/历史：编辑属性时那些信息仍然有用，
  // 尤其是"还差什么才能推进"——它往往正是要改这个字段的原因
  const sections = [...el.drawerBody.children]
  el.drawerBody.replaceChildren(
    sections[0] ?? document.createElement('div'),
    section,
    ...sections.slice(2),
  )
}

async function saveEditing(item, editableAttrs) {
  for (const node of el.drawerBody.querySelectorAll('.field-error')) node.remove()
  const attributes = collectForm(editableAttrs)

  // derived 字段必须原样带回：attributes 是整体替换而非合并，
  // 漏掉它们等于顺手把 startedAt 之类的时间戳删了
  const def = state.entityTypes.find((t) => t.name === item.type)
  for (const attr of def?.attributes ?? []) {
    if (attr.derived === true && item.attributes[attr.name] != null) {
      attributes[attr.name] = item.attributes[attr.name]
    }
  }

  try {
    await api(`/v1/resources/${item.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ expectedVersion: state.editing?.version ?? item.version, attributes }),
    })
    state.editing = null
    toast('已保存')
    await openDrawer(item.id)
    await refresh()
  } catch (error) {
    if (error.code === 'version_conflict') {
      // 并发冲突绝不能静默覆盖：说清发生了什么，并把最新内容摆到面前。
      // 直接重试等于让后写的人默默抹掉先写的人的修改。
      state.editing = null
      toast('保存失败：这条记录已被他人修改', '已重新载入最新内容，请确认后再改', 'error')
      await openDrawer(item.id)
      return
    }
    showFormErrors(error, el.drawerBody)
  }
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

  // 长度上限来自本体，不在前端另写一份（ADR-0001 P1.4）。
  // 服务端本来就在按这个数校验；不告诉用户的话，他只能一直写下去，
  // 提交时才被拒——而在那之前他并不知道边界在哪
  // （docs/dogfooding-log.md #7）。json 的上限算的是序列化后的长度，
  // 和输入框里的字符数不是一回事，所以不往上加 maxlength。
  if (typeof attr.maxLength === 'number' && attr.kind !== 'json') {
    input.maxLength = attr.maxLength
  }

  if (attr.kind === 'bool') {
    wrap.append(input, label)
  } else {
    wrap.append(label, input)
  }

  // 只有正文类字段才提示上限：一个 1024 字的标题写不满，说了只是噪声
  const limitHint =
    typeof attr.maxLength === 'number' && (attr.kind === 'text' || attr.kind === 'richtext')
      ? `最多 ${attr.maxLength.toLocaleString()} 字`
      : ''
  const description = typeof attr.description === 'string' ? attr.description : ''
  const hintText = [description, limitHint].filter((t) => t !== '').join(' · ')

  if (hintText !== '') {
    const hintNode = document.createElement('div')
    hintNode.className = 'hint'
    hintNode.textContent = hintText
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
function showFormErrors(error, container = el.modalForm) {
  for (const node of container.querySelectorAll('.field-error')) node.remove()

  const fields = error.details?.fields
  if (!Array.isArray(fields)) {
    toast('操作失败', String(error.message), 'error')
    return
  }

  for (const field of fields) {
    const wrap = container.querySelector(`[data-name="${CSS.escape(field.path)}"]`)
    const message = document.createElement('div')
    message.className = 'field-error'
    message.textContent = field.message
    if (wrap === null) container.append(message)
    else wrap.append(message)
  }
  toast('操作失败', '有字段未通过本体校验', 'error')
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

/**
 * 搜索。
 *
 * 每次按键都发请求会把服务端打满，所以做防抖；但**不做前端过滤**——
 * 在已加载的 200 条里过滤，搜到的永远只是"最近 200 条里的"，
 * 而用户以为搜的是全部。宁可慢 200 毫秒，也不要一个会骗人的搜索框。
 */
let searchTimer = 0
el.searchInput.addEventListener('input', () => {
  clearTimeout(searchTimer)
  searchTimer = setTimeout(async () => {
    state.search = el.searchInput.value.trim()
    // replace 而不是 push：每敲一个字都进历史的话，后退键要按二十次才出得去
    syncUrl(true)
    try {
      await refresh()
    } catch (error) {
      toast('搜索失败', String(error.message), 'error')
    }
  }, 200)
})

// Esc 清空搜索：搜完之后要回到全量视图，不该逼人手动删干净
el.searchInput.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || el.searchInput.value === '') return
  event.stopPropagation()
  el.searchInput.value = ''
  state.search = ''
  syncUrl(true)
  void refresh()
})
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
  // 正在编辑就别刷：重新渲染会把用户填了一半的内容清掉。
  // 自动刷新的价值不值得用"输入突然消失"来换。
  if (state.editing !== null) return
  if (!el.backdrop.hidden) return
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
