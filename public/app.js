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
  /** 当前视图：某个类型的看板、Dashboard、本体浏览器、流程编辑器 */
  /** @type {'board'|'dashboard'|'graph'|'process'|'health'|'ask'} */ view: 'board',
  /** 本体浏览器（FR-ONT-012）：从哪个对象出发、展开几跳 */
  /** @type {{start: string, depth: number, nodes: any[], edges: any[]}} */
  graph: { start: '', depth: 2, nodes: [], edges: [] },
  /** 流程编辑器（FR-WF-014）：正在编辑的那台状态机 */
  /** @type {any|null} */ editingLifecycle: null,
  /** 本体巡检（FR-ONT-010）：只看这一类问题。空串 = 全部 */
  /** @type {string} */ healthKind: '',
  /** 问答（FR-ONT-011 / FR-RES-009）：当前问题 */
  /** @type {string} */ question: '',
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
  const view = params.get('view')
  const views = ['dashboard', 'graph', 'process', 'health', 'ask']
  state.view = views.includes(view ?? '') ? /** @type {any} */ (view) : 'board'
  state.healthKind = params.get('kind') ?? ''
  state.question = params.get('ask') ?? ''
  state.graph.start = params.get('start') ?? ''
  state.graph.depth = Number(params.get('depth') ?? '2') || 2
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
  if (state.view !== 'board') {
    params.set('view', state.view)
    // 图浏览器的"从哪儿出发、展开几跳"也要进 URL：
    // 一张展开好的关系图，分享出去必须还是那一张
    if (state.view === 'graph' && state.graph.start !== '') {
      params.set('start', state.graph.start)
      params.set('depth', String(state.graph.depth))
    }
    // 筛到某一类问题也要能分享出去：「这是我说的那批孤儿对象」
    if (state.view === 'health' && state.healthKind !== '') params.set('kind', state.healthKind)
    // 一次问答的结果要能发给同事，所以问题本身进 URL
    if (state.view === 'ask' && state.question !== '') params.set('ask', state.question)
  } else if (state.activeType !== '') params.set('type', state.activeType)
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

  /** 非看板视图的标签。三个都长一样，只是切到不同的 view */
  const viewTab = (view, label) => {
    const btn = document.createElement('button')
    btn.className = 'type-tab'
    btn.textContent = label
    btn.dataset.view = view
    btn.setAttribute('aria-selected', String(state.view === view))
    btn.onclick = async () => {
      state.view = view
      syncUrl()
      renderTabs(types)
      closeDrawer()
      await refresh()
    }
    return btn
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
    viewTab('graph', '关系图'),
    viewTab('process', '流程'),
    viewTab('health', '巡检'),
    viewTab('ask', '问答'),
  )
}

// ── 看板 ────────────────────────────────────────────

async function refresh() {
  // 看板之外的三个视图不是"列"。容器的布局跟着视图走，
  // 否则它们会被那套横向列布局裁掉下半截（见 style.css 里 .board-plain）
  el.board.classList.toggle('board-plain', state.view !== 'board')

  if (state.view === 'dashboard') return refreshDashboard()
  if (state.view === 'graph') return refreshGraph()
  if (state.view === 'process') return refreshProcess()
  if (state.view === 'health') return refreshHealth()
  if (state.view === 'ask') return refreshAsk()
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
      row.textContent = `${item.type} · ${displayTitle(item)} · ${item.status}`
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
  title.textContent = displayTitle(item)

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
    el.drawerTitle.textContent = displayTitle(item)

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
    // 重开是把一件已经完成的事重新打开（ADR-0012）。
    // 渲染成和"推进到下一步"一样的按钮，等于把它藏了回去
    arrow.textContent = t.reopen ? '↩' : '→'

    const name = document.createElement('span')
    name.textContent = t.reopen ? `重开 → ${t.to}` : t.to

    if (t.reopen) btn.classList.add('reopen')
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
      const title = displayTitle(candidate)
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
 * 一个对象在界面上叫什么。
 *
 * 本体不强制每种类型都有 `title`——Question 用 `question`，
 * 有些类型用 `name`。挨个 `??` 下来，最后落到 id：**宁可显示 id
 * 也不显示空白**，空白的那一行点不动也搜不着。
 *
 * 这段话原来在四个地方各写了一遍，而且写得不一样：关系行和下拉框
 * 漏了 `question`，于是同一个 Question 在卡片上有标题、在关系列表里
 * 是一串 id。同一个问题只该有一个答案。
 */
function displayTitle(item) {
  return item.attributes.title ?? item.attributes.name ?? item.attributes.question ?? item.id
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

// ── 本体可视化浏览器（FR-ONT-012） ───────────────────
//
// 验收标准：**可从任一实体出发展开 N 跳关系图。**
//
// 用 SVG 手画而不是引一个图库：这张图要显示的东西很少
// （节点、边、类型、方向），而一个图库会带着自己的版本节奏、
// 主题系统和一套需要学的布局 API 进来。真需要力导向布局时再说。

/** 一次展开最多取多少个节点。服务端还会再夹一次，这里只是别白要 */
const GRAPH_LIMIT = 200

async function refreshGraph() {
  const form = document.createElement('form')
  form.className = 'graph-controls'
  form.onsubmit = async (e) => {
    e.preventDefault()
    state.graph.start = /** @type {HTMLInputElement} */ (form.querySelector('#graphStart')).value.trim()
    state.graph.depth = Number(/** @type {HTMLInputElement} */ (form.querySelector('#graphDepth')).value)
    syncUrl()
    await refresh()
  }
  form.innerHTML = `
    <label>起点 <input id="graphStart" value="${escapeAttr(state.graph.start)}"
      placeholder="粘贴一个对象 id" autocomplete="off"></label>
    <label>展开 <input id="graphDepth" type="number" min="1" max="6" value="${state.graph.depth}"> 跳</label>
    <button class="btn primary" type="submit">展开</button>`

  const canvas = document.createElement('div')
  canvas.className = 'graph-canvas'
  canvas.id = 'graphCanvas'
  el.board.replaceChildren(form, canvas)

  if (state.graph.start === '') {
    canvas.replaceChildren(hint('从任一对象出发', '粘贴一个 id，或在看板上点开一张卡片再回来'))
    return
  }

  canvas.replaceChildren(hint('展开中…', '', true))
  // **不传 follow**：沿本体里声明的每一种关系走。
  // 前端一旦开始列关系名，这张图能看见什么就变成了前端的知识——
  // 本体里新加一种关系，图上不会出现，也不会有人发现
  let result
  try {
    result = await api('/v1/graph:subgraph', {
      method: 'POST',
      body: JSON.stringify({
        start: state.graph.start,
        maxDepth: state.graph.depth,
        direction: 'both',
        limit: GRAPH_LIMIT,
      }),
    })
  } catch (error) {
    canvas.replaceChildren(hint('展开失败', String(error.message)))
    return
  }

  state.graph.nodes = result.nodes ?? []
  state.graph.edges = result.edges ?? []
  // 起点自己总在节点里，所以"只有一个节点"才是"没有关系"。
  // 判 length === 0 的话，一个孤立对象会渲染出一张只有圆心的图，
  // 看起来像是加载失败
  if (state.graph.nodes.length <= 1) {
    canvas.replaceChildren(hint('没有可展开的关系', '这个对象还没有任何关系'))
    return
  }
  canvas.replaceChildren(drawGraph(state.graph.nodes, state.graph.edges, result.truncated === true))
}

/**
 * 画图。按**距起点的跳数**分层——同心圆布局。
 *
 * 分层而不是随机撒点：跳数是这张图里唯一有意义的空间语义，
 * 让它对应半径，"谁离得近"一眼就能看出来。
 */
function drawGraph(nodes, edges, truncated) {
  const wrap = document.createElement('div')
  if (truncated) {
    // 截断必须说。不说的话用户看到的就是"全部"
    wrap.append(hint('只显示了前 200 个节点', '缩小跳数，或从更具体的对象出发'))
  }

  const byId = new Map(nodes.map((n) => [n.id, n]))
  const rings = new Map()
  for (const n of nodes) {
    const d = n.depth ?? 0
    rings.set(d, [...(rings.get(d) ?? []), n])
  }
  const maxDepth = Math.max(...rings.keys(), 1)
  const size = 640
  const centre = size / 2
  const pos = new Map()
  for (const [depth, ring] of [...rings].sort((a, b) => a[0] - b[0])) {
    const radius = depth === 0 ? 0 : (depth / maxDepth) * (centre - 60)
    ring.forEach((n, i) => {
      const angle = (i / ring.length) * Math.PI * 2 - Math.PI / 2
      pos.set(n.id, { x: centre + radius * Math.cos(angle), y: centre + radius * Math.sin(angle) })
    })
  }

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', `0 0 ${size} ${size}`)
  svg.setAttribute('class', 'graph-svg')
  svg.setAttribute('role', 'img')
  svg.setAttribute('aria-label', `关系图：${nodes.length} 个对象，${edges.length} 条关系`)

  for (const e of edges) {
    const a = pos.get(e.fromId)
    const b = pos.get(e.toId)
    if (a === undefined || b === undefined) continue
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line')
    line.setAttribute('x1', String(a.x))
    line.setAttribute('y1', String(a.y))
    line.setAttribute('x2', String(b.x))
    line.setAttribute('y2', String(b.y))
    line.setAttribute('class', e.confirmed === false ? 'graph-edge rejected' : 'graph-edge')
    const title = document.createElementNS('http://www.w3.org/2000/svg', 'title')
    title.textContent = e.type
    line.append(title)
    svg.append(line)
  }

  for (const n of nodes) {
    const p = pos.get(n.id)
    if (p === undefined) continue
    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g')
    g.setAttribute('class', 'graph-node')
    g.setAttribute('data-id', n.id)
    g.setAttribute('data-type', n.type)
    g.setAttribute('tabindex', '0')
    g.setAttribute('role', 'button')

    const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle')
    circle.setAttribute('cx', String(p.x))
    circle.setAttribute('cy', String(p.y))
    circle.setAttribute('r', n.depth === 0 ? '14' : '9')
    svg.append(g)
    g.append(circle)

    const label = document.createElementNS('http://www.w3.org/2000/svg', 'text')
    label.setAttribute('x', String(p.x))
    label.setAttribute('y', String(p.y - 16))
    label.setAttribute('text-anchor', 'middle')
    label.textContent = String(displayTitle(n)).slice(0, 12)
    g.append(label)

    // 点一个节点就以它为新起点。**这就是"从任一实体出发"**——
    // 起点不是配置项，是你正在看的那个东西
    const recentre = () => {
      state.graph.start = n.id
      syncUrl()
      refresh().catch(() => {})
    }
    g.addEventListener('click', recentre)
    g.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault()
        recentre()
      }
    })
  }

  wrap.append(svg)
  const legend = document.createElement('p')
  legend.className = 'graph-legend'
  legend.textContent = `${nodes.length} 个对象 · ${edges.length} 条关系 · 点节点可换起点`
  wrap.append(legend)
  return wrap
}

// ── 带出处的问答（FR-ONT-011 / FR-RES-009） ───────────
//
// 两条需求的验收标准都落在**出处**上：
//   FR-ONT-011  抽样问答中 ≥ 90% 返回可点击的来源实体
//   FR-RES-009  结果含来源实体 ID，可点击跳转
//
// 所以这个界面的重点不是答案好不好看，是**每一段都指得回它的来源，
// 而且点得开**。一段读起来像答案、却点不进任何对象的文字，
// 会被复制进周报，然后没有人能追溯它是从哪儿来的。

async function refreshAsk() {
  const form = document.createElement('form')
  form.className = 'ask-controls'
  form.onsubmit = async (e) => {
    e.preventDefault()
    state.question = /** @type {HTMLInputElement} */ (form.querySelector('#askInput')).value.trim()
    syncUrl()
    await refresh()
  }
  form.innerHTML = `
    <input id="askInput" value="${escapeAttr(state.question)}" autocomplete="off"
      placeholder="问一句话，比如「灰度失败怎么回滚」">
    <button class="btn primary" type="submit">问</button>`

  const panel = document.createElement('div')
  panel.className = 'ask-results'
  panel.id = 'askResults'
  el.board.replaceChildren(form, panel)

  if (state.question === '') {
    panel.replaceChildren(hint('问一个问题', '答案会带着来源，每一条都点得开'))
    return
  }

  panel.replaceChildren(hint('检索中…', '', true))
  let result
  try {
    result = await api(`/v1/search:answer?q=${encodeURIComponent(state.question)}`)
  } catch (error) {
    panel.replaceChildren(hint('检索失败', String(error.message)))
    return
  }

  if (result.grounded !== true) {
    // **答不出来是一个正确的答案。** 这里刻意不给任何"也许你想问"的
    // 补白——那种补白正是把人引向一段没有出处的文字的地方
    panel.replaceChildren(
      hint('答不出来', `在 ${result.candidates} 个候选对象里没有找到能支持这个问题的内容`),
    )
    return
  }

  const list = document.createElement('div')
  list.className = 'ask-list'
  for (const passage of result.passages) {
    const item = document.createElement('div')
    item.className = 'ask-passage'
    item.dataset.source = passage.sourceId

    const body = document.createElement('p')
    body.className = 'ask-text'
    body.textContent = passage.text
    item.append(body)

    const foot = document.createElement('div')
    foot.className = 'ask-source'

    // 出处按钮：**这就是验收标准里那个"可点击跳转"**
    const open = document.createElement('button')
    open.className = 'ask-open'
    open.dataset.id = passage.sourceId
    open.textContent = `${passage.sourceType} · ${passage.sourceTitle}`
    open.onclick = () => void openDrawer(passage.sourceId)
    foot.append(open)

    // 哪一路召回的。调参时要知道是哪一路在起作用；
    // 对读的人来说，它也说明了"为什么这条会出现在这里"
    const via = document.createElement('span')
    via.className = 'ask-via'
    via.textContent = passage.via.join(' + ')
    foot.append(via)

    item.append(foot)
    list.append(item)
  }

  const note = document.createElement('p')
  note.className = 'ask-note'
  note.id = 'askNote'
  note.textContent = `${result.passages.length} 段，来自 ${result.sourceIds.length} 个对象（候选 ${result.candidates} 个）`

  panel.replaceChildren(note, list)
}

// ── 本体一致性巡检（FR-ONT-010） ─────────────────────
//
// 验收标准：**每日报告，问题对象可在 UI 中筛选。**
// 「每日」在服务端（main.ts 的定时任务），这里是「可筛选」那一半。
//
// 这个视图本身就是一份筛过的清单：它只显示有问题的对象，
// 再按问题种类收窄一次。点一行直接打开那个对象——
// 一份说得出"哪儿不对"却点不进去的报告，读完还是不知道该动哪里。

/** 问题种类。名字来自服务端，中文只是显示 */
const HEALTH_KINDS = [
  { key: 'orphan', label: '孤儿对象' },
  { key: 'broken-link', label: '断链' },
  { key: 'cycle', label: '环' },
]

async function refreshHealth() {
  el.board.replaceChildren(hint('巡检中…', '', true))

  let report
  try {
    report = await api('/v1/ontology/health')
  } catch (error) {
    el.board.replaceChildren(hint('巡检失败', String(error.message)))
    return
  }

  const wrap = document.createElement('div')
  wrap.className = 'health-panel'
  wrap.id = 'healthPanel'

  // 分母永远和结论一起出现。"发现 0 个问题"在 10 个对象和 10 万个对象里
  // 是完全不同的两句话
  const summary = document.createElement('p')
  summary.className = 'health-summary'
  summary.id = 'healthSummary'
  summary.textContent =
    `扫描了 ${report.scanned.resources} 个对象、${report.scanned.relations} 条关系，` +
    `发现 ${report.findings.length} 个问题`
  wrap.append(summary)

  if (report.complete !== true) {
    // 扫不完必须说。不说的话，一份"0 个问题"会被当成"一切正常"
    wrap.append(
      hint('这份报告不完整', '对象或关系的数量超过了单次扫描上限，下面只是其中一部分', true),
    )
  }

  const filters = document.createElement('div')
  filters.className = 'health-filters'
  const chipFor = (key, label, count) => {
    const btn = document.createElement('button')
    btn.className = 'health-chip'
    btn.dataset.kind = key
    btn.textContent = count === null ? label : `${label} ${count}`
    btn.setAttribute('aria-pressed', String(state.healthKind === key))
    btn.onclick = async () => {
      state.healthKind = key
      syncUrl()
      await refresh()
    }
    return btn
  }
  filters.append(chipFor('', '全部', report.findings.length))
  for (const kind of HEALTH_KINDS) {
    filters.append(
      chipFor(kind.key, kind.label, report.findings.filter((f) => f.kind === kind.key).length),
    )
  }
  wrap.append(filters)

  const shown =
    state.healthKind === ''
      ? report.findings
      : report.findings.filter((f) => f.kind === state.healthKind)

  if (shown.length === 0) {
    wrap.append(
      hint(
        report.findings.length === 0 ? '没有发现问题' : '这一类没有问题',
        report.findings.length === 0 ? '孤儿对象、断链、环都没有' : '换一个筛选看看',
      ),
    )
    el.board.replaceChildren(wrap)
    return
  }

  const list = document.createElement('div')
  list.className = 'health-list'
  for (const finding of shown) {
    list.append(healthRow(finding))
  }
  wrap.append(list)
  el.board.replaceChildren(wrap)
}

/**
 * 一条问题。
 *
 * 环那一类没有单一的"问题对象"——它是一串对象。所以它的行给出整条环，
 * 每个环节都能点。只挑第一个来点的话，看的人会以为问题出在那一个身上。
 */
function healthRow(finding) {
  const row = document.createElement('div')
  row.className = 'health-row'
  row.dataset.kind = finding.kind

  const kind = document.createElement('span')
  kind.className = 'health-kind'
  kind.textContent = HEALTH_KINDS.find((k) => k.key === finding.kind)?.label ?? finding.kind
  row.append(kind)

  const detail = document.createElement('span')
  detail.className = 'health-detail'
  detail.textContent = finding.detail
  row.append(detail)

  const targets = document.createElement('span')
  targets.className = 'health-targets'
  const ids = finding.kind === 'cycle' ? finding.resourceIds : [finding.resourceId]
  for (const id of ids) {
    const btn = document.createElement('button')
    btn.className = 'health-target'
    btn.dataset.id = id
    // 显示短 id：整串 26 位的 ULID 会把这一行挤没
    btn.textContent = id.slice(0, id.indexOf('_') + 5)
    btn.title = id
    btn.onclick = () => void openDrawer(id)
    targets.append(btn)
  }
  row.append(targets)
  return row
}

// ── 可视化流程编辑器（FR-WF-014） ────────────────────
//
// 验收标准：**拖拽编辑状态机并保存。**
//
// 拖的是"从哪个状态到哪个状态"——把一个状态拖到另一个上面就是加一条迁移。
// 拖坐标（把方框摆好看）在这里没有意义：状态机的语义是**边**，
// 不是布局，而存一份布局意味着还要维护它。

async function refreshProcess() {
  const lifecycles = state.lifecycles.length > 0 ? state.lifecycles : (await api('/v1/workflows')).items
  state.lifecycles = lifecycles

  const picker = document.createElement('div')
  picker.className = 'graph-controls'
  const select = document.createElement('select')
  select.id = 'processPicker'
  select.append(
    ...lifecycles.map((l) => {
      const o = document.createElement('option')
      o.value = l.id
      o.textContent = `${l.entityType} · ${l.id}`
      return o
    }),
  )
  const current = state.editingLifecycle ?? lifecycles[0]
  if (current !== undefined) select.value = current.id
  select.onchange = () => {
    state.editingLifecycle = structuredClone(lifecycles.find((l) => l.id === select.value))
    renderProcessEditor()
  }
  picker.append(select)

  const save = document.createElement('button')
  save.className = 'btn primary'
  save.id = 'processSave'
  save.textContent = '保存'
  save.onclick = async () => {
    const draft = state.editingLifecycle
    if (draft === null) return
    try {
      await api(`/v1/workflows/${draft.id}`, { method: 'PUT', body: JSON.stringify(draft) })
      toast('已保存', '下一批新实例即时生效')
      state.lifecycles = (await api('/v1/workflows')).items
    } catch (error) {
      // 保存失败要说清是哪条规则不让存——服务端会返回原因
      toast('保存失败', String(error.message), 'error')
    }
  }
  picker.append(save)

  const canvas = document.createElement('div')
  canvas.className = 'process-canvas'
  canvas.id = 'processCanvas'
  el.board.replaceChildren(picker, canvas)

  state.editingLifecycle = structuredClone(current ?? null)
  renderProcessEditor()
}

function renderProcessEditor() {
  const canvas = document.getElementById('processCanvas')
  if (canvas === null) return
  const lc = state.editingLifecycle
  if (lc === null || lc === undefined) {
    canvas.replaceChildren(hint('没有可编辑的状态机', ''))
    return
  }

  const grid = document.createElement('div')
  grid.className = 'process-grid'

  for (const st of lc.states) {
    const box = document.createElement('div')
    box.className = 'process-state'
    box.draggable = true
    box.dataset.state = st.name
    box.tabIndex = 0

    const name = document.createElement('strong')
    name.textContent = st.name
    box.append(name)

    if (st.terminal === true) box.append(chip('终态'))
    for (const t of lc.transitions.filter((x) => x.from.includes(st.name))) {
      const edge = document.createElement('div')
      edge.className = 'process-edge'
      edge.textContent = `→ ${t.to}`
      const remove = document.createElement('button')
      remove.className = 'icon-btn'
      remove.textContent = '×'
      remove.title = `删除 ${st.name} → ${t.to}`
      remove.onclick = () => {
        // 只摘掉这一个来源，不是删掉整条迁移：一条迁移可以有多个 from
        t.from = t.from.filter((f) => f !== st.name)
        lc.transitions = lc.transitions.filter((x) => x.from.length > 0)
        renderProcessEditor()
      }
      edge.append(remove)
      box.append(edge)
    }

    box.addEventListener('dragstart', (ev) => {
      ev.dataTransfer?.setData('text/plain', st.name)
    })
    box.addEventListener('dragover', (ev) => {
      ev.preventDefault()
      box.classList.add('drop-target')
    })
    box.addEventListener('dragleave', () => box.classList.remove('drop-target'))
    box.addEventListener('drop', (ev) => {
      ev.preventDefault()
      box.classList.remove('drop-target')
      const from = ev.dataTransfer?.getData('text/plain') ?? ''
      addTransition(lc, from, st.name)
    })
    grid.append(box)
  }

  canvas.replaceChildren(grid)
  const note = document.createElement('p')
  note.className = 'graph-legend'
  note.textContent = '把一个状态拖到另一个上面即可新增迁移；× 删除。改完点保存'
  canvas.append(note)
}

/** 新增一条迁移。**同一对状态只留一条**，否则保存时会被服务端拒 */
function addTransition(lc, from, to) {
  if (from === '' || from === to) return
  const exists = lc.transitions.some((t) => t.from.includes(from) && t.to === to)
  if (exists) {
    toast('已经有这条迁移了', `${from} → ${to}`)
    return
  }
  const sameTarget = lc.transitions.find((t) => t.to === to)
  if (sameTarget === undefined) lc.transitions.push({ from: [from], to })
  else sameTarget.from = [...sameTarget.from, from]
  renderProcessEditor()
}

function escapeAttr(value) {
  return String(value).replace(/"/g, '&quot;')
}

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
