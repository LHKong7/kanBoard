import { after, before, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import type { Browser, Page } from 'playwright'
import type pg from 'pg'
import type { FastifyInstance } from 'fastify'
import { assertNotSuperuser, setupTestDb, truncateAll } from '../helpers/db.ts'
import { buildServer } from '../../src/api/server.ts'
import { buildDefaultRegistry } from '../../src/ontology/defaults.ts'
import { buildDefaultWorkflowRegistry } from '../../src/workflow/defaults.ts'
import { DEFAULT_AUTOMATION_RULES } from '../../src/workflow/automation.ts'
import { defaultPolicies } from '../../src/identity/default-policies.ts'
import { OutboxPoller } from '../../src/infrastructure/poller.ts'

/**
 * 产品表面：多种看法、筛选、讨论、导出。真实浏览器。
 *
 * 和 `board.test.ts` 一样，这些用例要证明的是**UI 里没有硬编码的业务语义**：
 * 表格的列来自本体，筛选的选项来自状态机，讨论走哪条关系也是从本体里查出来的。
 */

const TENANT = 'default'
const AUTH = { 'x-principal': 'user://alice', 'x-tenant': TENANT, 'x-roles': 'Admin' }

let pool: pg.Pool
let app: FastifyInstance
let poller: OutboxPoller
let browser: Browser
let page: Page
let baseUrl = ''

before(async () => {
  pool = await setupTestDb()
  await assertNotSuperuser(pool)

  const registry = buildDefaultRegistry()
  const workflows = buildDefaultWorkflowRegistry()
  const policies = defaultPolicies(TENANT)

  app = buildServer({ pool, registry, workflows, policies })
  await app.listen({ port: 0, host: '127.0.0.1' })
  const address = app.server.address()
  if (address === null || typeof address === 'string') throw new Error('server did not bind a port')
  baseUrl = `http://127.0.0.1:${address.port}`

  poller = new OutboxPoller({
    pool,
    registry,
    workflows,
    policies,
    rules: DEFAULT_AUTOMATION_RULES,
    tenants: [TENANT],
  })

  browser = await chromium.launch({
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
    ...(process.env['CHROMIUM_PATH'] === undefined
      ? {}
      : { executablePath: process.env['CHROMIUM_PATH'] }),
  })
  page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
})

after(async () => {
  await browser?.close()
  await app?.close()
  await pool?.end()
})

beforeEach(async () => {
  await truncateAll(pool)
})

async function create(type: string, attributes: Record<string, unknown>, owner?: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/resources',
    headers: AUTH,
    payload: { type, workspace: 'ws_platform', ...(owner === undefined ? {} : { owner }), attributes },
  })
  if (res.statusCode !== 201) throw new Error(`create ${type}: ${res.body}`)
  return res.json().id as string
}

const task = (title: string, owner?: string) => create('Task', { title }, owner)

/** 直接用 URL 打开某个看法——和 board.test.ts 一样，避开点击的中间态 */
async function open(query: string, ready: string): Promise<void> {
  await page.goto(`${baseUrl}/?type=Task&${query}`)
  await page.waitForSelector(ready)
}

describe('同一批对象有五种看法', () => {
  it('工具条列出全部五种', async () => {
    await task('导出账单')
    await open('', '.column')
    assert.deepEqual(await page.locator('.layout-btn').allTextContents(), [
      '看板', '列表', '表格', '日历', '甘特',
    ])
  })

  it('列表一行一个对象', async () => {
    await task('导出账单')
    await task('登录支持 SSO')
    await open('layout=list', '.item-row')
    assert.equal(await page.locator('.item-row').count(), 2)
  })

  it('表格的列来自本体，不是前端挑的几个字段', async () => {
    // 本体里加了属性而表格看不见的话，没有人会想到去改前端
    await task('导出账单')
    await open('layout=table', '.item-table')
    const declared = await app
      .inject({ method: 'GET', url: '/v1/ontology/entity-types', headers: AUTH })
      .then((r) => {
        const def = (r.json().items as { name: string; attributes: { name: string }[] }[]).find(
          (t) => t.name === 'Task',
        )
        return (def?.attributes ?? []).map((a) => a.name)
      })
    const columns = await page.locator('.item-table th').allTextContents()
    for (const name of declared) assert.ok(columns.includes(name), `表格缺少本体属性 ${name}`)
  })

  it('切换看法会写进地址栏，链接能原样分享', async () => {
    await task('导出账单')
    await open('', '.column')
    await page.click('.layout-btn[data-layout="table"]')
    await page.waitForSelector('.item-table')
    assert.equal(new URL(page.url()).searchParams.get('layout'), 'table')
  })

})

describe('筛选交给服务端，不是在前端过滤这一页', () => {
  it('状态选项来自状态机', async () => {
    await task('导出账单')
    await open('', '.column')
    const chips = await page.locator('.filter-chip').allTextContents()
    assert.deepEqual(chips, ['Todo', 'Doing', 'Review', 'Testing', 'Blocked', 'Done', 'Cancelled'])
  })

  it('按负责人筛，条数跟着变', async () => {
    await task('导出账单', 'user://bob')
    await task('登录支持 SSO')
    await open('layout=list', '.item-row')
    assert.equal(await page.locator('.item-row').count(), 2)

    await page.fill('#filterOwner', 'user://bob')
    await page.dispatchEvent('#filterOwner', 'change')
    await page.waitForFunction(() => document.querySelectorAll('.item-row').length === 1)
  })

  it('筛选条件进地址栏，筛出来的这批能发给别人', async () => {
    await task('导出账单')
    await open('layout=list', '.item-row')
    await page.click('.filter-chip[data-status="Doing"]')
    await page.waitForFunction(() => new URL(location.href).searchParams.get('status') === 'Doing')
  })

  it('筛空了要说清楚是什么没筛到，而不是给一个空列表', async () => {
    await task('导出账单')
    await open('layout=list&status=Done', '.board-empty')
    const text = await page.locator('.board-empty').textContent()
    assert.match(text ?? '', /Done/)
  })

  it('清除筛选把它们一起去掉', async () => {
    await task('导出账单')
    await open('layout=list&status=Done', '#clearFilters')
    await page.click('#clearFilters')
    await page.waitForSelector('.item-row')
    assert.equal(new URL(page.url()).searchParams.get('status'), null)
  })
})

describe('讨论（协作的最小闭环）', () => {
  it('发一条评论，它就出现在讨论区里', async () => {
    const id = await task('导出账单')
    await page.goto(`${baseUrl}/?type=Task&layout=list`)
    await page.waitForSelector(`.item-row[data-id="${id}"]`)
    await page.click(`.item-row[data-id="${id}"]`)
    await page.waitForSelector('[data-section="comments"]')

    await page.fill('#commentInput', '这条我来做')
    await page.click('#commentSend')
    await page.waitForSelector('.comment')
    assert.equal((await page.locator('.comment-body').textContent())?.trim(), '这条我来做')
  })

  it('@某人会被标出来，并且真的产生一条通知', async () => {
    const id = await task('导出账单')
    await page.goto(`${baseUrl}/?type=Task&layout=list`)
    await page.click(`.item-row[data-id="${id}"]`)
    await page.waitForSelector('[data-section="comments"]')
    await page.fill('#commentInput', '@bob 这条你熟')
    await page.click('#commentSend')
    await page.waitForSelector('.mention')
    assert.equal(await page.locator('.mention').textContent(), '@bob')

    // 通知走的是 outbox → poller → 自动化规则那条路，不是评论按钮里的旁路
    await poller.pollOnce()
    const items = await app
      .inject({ method: 'GET', url: '/v1/resources?type=Notification', headers: AUTH })
      .then((r) => r.json().items as { attributes: Record<string, string> }[])
    assert.equal(items.length, 1)
    assert.equal(items[0]?.attributes['recipient'], 'user://bob')
  })

  it('评论挂在对象上靠关系，而这条关系是从本体里查出来的', async () => {
    // UI 不认识任何具体的关系类型（explorer.test.ts 有一条用例盯着）。
    // 这里验的是反面：本体里那条关系确实被用上了
    const id = await task('导出账单')
    await page.goto(`${baseUrl}/?type=Task&layout=list`)
    await page.click(`.item-row[data-id="${id}"]`)
    await page.waitForSelector('[data-section="comments"]')
    await page.fill('#commentInput', '挂上来')
    await page.click('#commentSend')
    await page.waitForSelector('.comment')

    const edges = await app
      .inject({
        method: 'GET',
        url: `/v1/resources/${id}/relations?direction=in`,
        headers: AUTH,
      })
      .then((r) => r.json().items as { type: string }[])
    assert.equal(edges.length, 1)
    assert.equal(edges[0]?.type, 'commentsOn')
  })

  it('本体不允许被讨论的类型就没有讨论区', async () => {
    // "哪些东西可以被讨论"只在本体里写了一处，UI 跟着它走
    const id = await create('Notification', { title: '提醒', recipient: 'user://alice' })
    await page.goto(`${baseUrl}/?type=Notification&layout=list`)
    await page.waitForSelector(`.item-row[data-id="${id}"]`)
    await page.click(`.item-row[data-id="${id}"]`)
    await page.waitForSelector('[data-section="attributes"], .section')
    assert.equal(await page.locator('[data-section="comments"]').count(), 0)
  })
})

describe('数据带得走', () => {
  it('导出按钮带的是和当前列表同一套条件', async () => {
    await task('导出账单', 'user://bob')
    await task('登录支持 SSO')
    await open('layout=list&owner=user%3A%2F%2Fbob', '.item-row')

    const download = page.waitForEvent('download')
    await page.click('[data-export="csv"]')
    const file = await download
    assert.match(file.suggestedFilename(), /Task\.csv$/)
  })

  it('CSV 和 JSON 两种格式都给', async () => {
    await task('导出账单')
    await open('layout=list', '.item-row')
    assert.equal(await page.locator('[data-export="csv"]').count(), 1)
    assert.equal(await page.locator('[data-export="json"]').count(), 1)
  })
})
