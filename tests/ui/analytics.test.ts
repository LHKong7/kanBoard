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
import { defaultPolicies } from '../../src/identity/default-policies.ts'

/**
 * 分析与周期两屏。真实浏览器、真实数据、真实 SVG。
 *
 * 盯三件事：
 *
 * 1. **下拉里的选项来自服务端**，不是前端抄的一份清单。
 * 2. **图真的画出来了**——SVG 里有形状，不是一个空的 `<svg>`。
 *    只断言"组件挂上了"的用例，在图表画崩时照样是绿的。
 * 3. **每张图都配一份数据表**。那是色觉异常读者、读屏软件，
 *    以及"我想把这几个数抄出去"的唯一出路。
 */

const TENANT = 'default'
const AUTH = {
  'x-principal': 'user://alice',
  'x-tenant': TENANT,
  'x-roles': 'Admin',
  'content-type': 'application/json',
}

let pool: pg.Pool
let app: FastifyInstance
let browser: Browser
let page: Page
let baseUrl = ''

before(async () => {
  pool = await setupTestDb()
  await assertNotSuperuser(pool)
  app = buildServer({
    pool,
    registry: buildDefaultRegistry(),
    workflows: buildDefaultWorkflowRegistry(),
    policies: defaultPolicies(TENANT),
  })
  await app.listen({ port: 0, host: '127.0.0.1' })
  const address = app.server.address()
  if (address === null || typeof address === 'string') throw new Error('server did not bind a port')
  baseUrl = `http://127.0.0.1:${address.port}`

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

async function create(type: string, attributes: Record<string, unknown>): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/resources',
    headers: AUTH,
    payload: { type, workspace: 'ws', attributes },
  })
  if (res.statusCode !== 201) throw new Error(`create ${type}: ${res.body}`)
  return res.json().id as string
}

async function relate(type: string, fromId: string, toId: string): Promise<void> {
  await app.inject({
    method: 'POST',
    url: `/v1/resources/${fromId}/relations`,
    headers: AUTH,
    payload: { type, toId },
  })
}

async function move(id: string, to: string): Promise<void> {
  await app.inject({
    method: 'POST',
    url: `/v1/resources/${id}/transitions`,
    headers: AUTH,
    payload: { to },
  })
}

async function open(screen: string): Promise<void> {
  await page.goto(`${baseUrl}/app`)
  await page.evaluate(() =>
    localStorage.setItem(
      'projectos.identity',
      JSON.stringify({ principal: 'user://alice', roles: 'Admin', label: 'alice' }),
    ),
  )
  await page.reload()
  await page.waitForSelector('.type-tab')
  await page.click(`.type-tab[data-screen="${screen}"]`)
}

describe('分析屏', () => {
  it('维度与指标的下拉来自服务端，不是前端抄的一份', async () => {
    await create('Task', { title: 'a', priority: 'High' })
    await open('analytics')
    // `<option>` 在 Playwright 眼里不算"可见"，等它 attached 就够了
    await page.waitForSelector('[data-control="x"] option', { state: 'attached' })

    // 16 × 9 —— 数字对不上就说明某个维度在界面上不存在，
    // 而那不会报错，只会让人以为系统里没有这个看法
    assert.equal(await page.locator('[data-control="x"] option').count(), 16)
    assert.equal(await page.locator('[data-control="y"] option').count(), 9)
  })

  it('图真的画出来了 —— SVG 里有形状', async () => {
    await create('Task', { title: 'a', priority: 'Urgent' })
    await create('Task', { title: 'b', priority: 'Urgent' })
    await create('Task', { title: 'c', priority: 'Low' })

    await open('analytics')
    await page.waitForSelector('.chart-svg path, .chart-svg rect')
    // 两个优先级 → 两根柱子。断言"有 svg"是不够的：
    // 一个画崩的图表照样有 svg
    const bars = await page.locator('.chart-svg path[fill]:not([fill="none"])').count()
    assert.ok(bars >= 2, `expected at least 2 bars, got ${bars}`)
  })

  it('单序列不画图例，多序列一定画', async () => {
    // 两条落在**不同状态组**，二次分组才会产出两条序列。
    // 都在同一组的话图例只有一项，而那和"没画图例"分不开
    const doing = await create('Task', { title: 'a', priority: 'High', assignee: 'user://bob' })
    await create('Task', { title: 'b', priority: 'High' })
    await move(doing, 'Doing')

    await open('analytics')
    await page.waitForSelector('.chart-svg')
    // 一条序列时图例只是把标题又说了一遍
    assert.equal(await page.locator('.chart-legend').count(), 0)

    await page.selectOption('[data-control="group"]', 'STATE_GROUPS')
    await page.waitForSelector('.chart-legend')
    assert.equal(await page.locator('.chart-legend li').count(), 2)
  })

  it('每张图都配一份数据表', async () => {
    await create('Task', { title: 'a', priority: 'High' })
    await open('analytics')
    await page.waitForSelector('.chart-data')
    await page.click('.chart-data summary')
    await page.waitForSelector('.chart-table')
    const text = await page.locator('.chart-table').innerText()
    assert.match(text, /High/)
  })

  it('预设按钮一键换成指南里的高价值问题', async () => {
    await create('Task', { title: 'a', assignee: 'user://bob' })
    await open('analytics')
    await page.waitForSelector('[data-preset="并行任务过多的人"]')
    await page.click('[data-preset="并行任务过多的人"]')
    await page.waitForFunction(
      () =>
        (document.querySelector('[data-control="x"]') as HTMLSelectElement | null)?.value ===
        'ASSIGNEES',
      undefined,
      { timeout: 10_000 },
    )
    assert.equal(
      await page.locator('[data-control="y"]').inputValue(),
      'IN_PROGRESS_WORK_ITEM_COUNT',
    )
  })

  it('换配色只换颜色，不换数据', async () => {
    await create('Task', { title: 'a', priority: 'High' })
    await open('analytics')
    await page.waitForSelector('.chart-svg path[fill]')
    const before = await page.locator('.chart-svg path[fill]').first().getAttribute('fill')

    await page.selectOption('[data-control="palette"]', 'earthen')
    await page.waitForFunction(
      (previous) =>
        document.querySelector('.chart-svg path[fill]')?.getAttribute('fill') !== previous,
      before,
      { timeout: 10_000 },
    )
    const after = await page.locator('.chart-svg path[fill]').first().getAttribute('fill')
    assert.notEqual(after, before)
    // 柱子数量不变——换的是刻度不是数据
    assert.equal(await page.locator('.chart-svg path[fill]').count(), 1)
  })

  it('画不出来的组合说清楚原因，而不是白屏', async () => {
    await create('Task', { title: 'a' })
    await open('analytics')
    await page.waitForSelector('.chart-svg')
    // X 与 group_by 同一个维度：服务端会拒，界面要把话说出来
    await page.evaluate(() => {
      const select = document.querySelector('[data-control="group"]') as HTMLSelectElement
      const option = document.createElement('option')
      option.value = 'PRIORITY'
      select.append(option)
    })
    await page.selectOption('[data-control="x"]', 'PRIORITY')
    await page.selectOption('[data-control="group"]', 'PRIORITY')
    await page.waitForSelector('[data-analytics-error]', { timeout: 10_000 })
    assert.match(
      (await page.locator('[data-analytics-error]').innerText()) ?? '',
      /group_by must differ/,
    )
  })
})

describe('周期屏', () => {
  async function cycleWithWork(): Promise<string> {
    const cycle = await create('Sprint', {
      name: 'S1',
      startAt: '2026-08-01T00:00:00.000Z',
      endAt: '2026-08-05T00:00:00.000Z',
    })
    await move(cycle.valueOf() as string, 'Active')
    const done = await create('Task', { title: 'done', assignee: 'user://bob' })
    const open2 = await create('Task', { title: 'open' })
    await relate('plans', cycle, done)
    await relate('plans', cycle, open2)
    await move(done, 'Doing')
    await move(done, 'Done')
    return cycle
  }

  it('燃尽图画两条线：实际是实线，理想是虚线', async () => {
    await cycleWithWork()
    await open('cycle')
    await page.waitForSelector('[data-chart="burndown"] .chart-svg')

    const solid = await page.locator('[data-chart="burndown"] path[stroke]:not([stroke-dasharray])').count()
    const dashed = await page.locator('[data-chart="burndown"] path[stroke-dasharray]').count()
    assert.ok(solid >= 1, '实际剩余应当是实线')
    // 理想线是**参考**不是观测，所以画虚线
    assert.ok(dashed >= 1, '理想线应当是虚线')
  })

  it('进度按状态组拼色块，完成率的分母不含取消掉的', async () => {
    await cycleWithWork()
    await open('cycle')
    await page.waitForSelector('.progress-linear-track span')
    assert.ok((await page.locator('.progress-linear-track span').count()) >= 2)
    // 两条里完成一条 → 50%
    assert.match(await page.locator('.progress-radial').innerText(), /50%/)
  })

  it('图旁边就写着怎么读它', async () => {
    await cycleWithWork()
    await open('cycle')
    await page.waitForSelector('.cycle-shapes')
    const text = await page.locator('.cycle-shapes').innerText()
    // 指南 §5.1 那四种形态。一张读不懂的图和没有图是一样的，
    // 而没有人会为了看一眼进度先去翻文档
    assert.match(text, /进度落后/)
    assert.match(text, /健康/)
  })

  it('按估点烧和按条数烧是两回事', async () => {
    await cycleWithWork()
    await open('cycle')
    await page.waitForSelector('[data-chart="burndown"]')
    await page.selectOption('[data-control="unit"]', 'points')
    await page.waitForFunction(
      () => document.querySelector('.analytics-title')?.textContent?.includes('按估点') === true,
      undefined,
      { timeout: 10_000 },
    )
    assert.match(await page.locator('.analytics-title').innerText(), /按估点/)
  })

  it('一个周期都没有时说清楚为什么，而不是给一张空图', async () => {
    await open('cycle')
    await page.waitForSelector('.board-empty')
    const text = await page.locator('.board-empty').innerText()
    assert.match(text, /时间维度/)
  })
})

describe('本体加一类对象，界面就自己长出来', () => {
  it('模块 / 意见收集 / 标签 / 便签四屏没有一行专属代码', async () => {
    // 这四屏走的是同一个 ObjectScreen——它按本体渲染表格与新建表单。
    // 断言的是"表头来自本体"，而不是某个写死的列名
    await create('Module', { name: '支付重构', lead: 'user://bob' })
    await open('module')
    await page.waitForSelector('[data-screen-for] table th')
    const headers = await page.locator('[data-screen-for] table th').allTextContents()
    assert.ok(headers.some((h) => h.includes('name')), `headers: ${headers.join(', ')}`)
    assert.ok(headers.some((h) => h.includes('lead')), `headers: ${headers.join(', ')}`)
  })

  it('便签没有状态列 —— 它在本体里就没有生命周期', async () => {
    await create('Sticky', { body: '本周关注点' })
    await open('sticky')
    await page.waitForSelector('[data-screen-for] table')
    const headers = await page.locator('[data-screen-for] table th').allTextContents()
    // 便签刻意没有 lifecycle：它不是任务系统。界面据此自动不显示状态
    assert.ok(!headers.some((h) => h.trim() === 'status'), `headers: ${headers.join(', ')}`)
  })
})
