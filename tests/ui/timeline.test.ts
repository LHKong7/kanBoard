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
 * 时间维度：日历与甘特。真实浏览器。
 *
 * 这两个看法此前完全没有——没有它们，"这周要交什么"和"谁挡着谁"
 * 都只能靠人脑记。
 *
 * 用的是**计划日期**（startDate / dueDate），不是状态机写的实际时刻：
 * 两者混用的话，一条延期的任务会画在它真正开始的那天，
 * 于是甘特图上永远看不到延期。
 */

const TENANT = 'default'
const AUTH = { 'x-principal': 'user://alice', 'x-tenant': TENANT, 'x-roles': 'Admin' }

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

/** 用固定日期，不用「今天 +N」——跨月跑的时候那种写法会偶发性变红 */
const MONTH = '2026-03'
const day = (d: number) => `2026-03-${String(d).padStart(2, '0')}T00:00:00.000Z`

async function task(title: string, dates: { startDate?: string; dueDate?: string } = {}) {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/resources',
    headers: AUTH,
    payload: { type: 'Task', workspace: 'ws_platform', attributes: { title, ...dates } },
  })
  if (res.statusCode !== 201) throw new Error(`create Task: ${res.body}`)
  return res.json().id as string
}

async function relate(fromId: string, type: string, toId: string) {
  const res = await app.inject({
    method: 'POST',
    url: `/v1/resources/${fromId}/relations`,
    headers: AUTH,
    payload: { type, toId },
  })
  if (res.statusCode !== 201) throw new Error(`relate: ${res.body}`)
}

describe('计划日期是承诺，和状态机写的实际时刻分开', () => {
  it('本体里两者并存，且计划日期不是 derived', async () => {
    // derived 的字段不出现在人填的表单里。计划日期是**人许下的**，
    // 必须能填——混进 derived 就等于这个功能不存在
    const res = await app.inject({
      method: 'GET',
      url: '/v1/ontology/entity-types',
      headers: AUTH,
    })
    const def = (res.json().items as { name: string; attributes: { name: string; derived?: boolean }[] }[])
      .find((t) => t.name === 'Task')
    const byName = new Map((def?.attributes ?? []).map((a) => [a.name, a]))
    assert.equal(byName.get('dueDate')?.derived ?? false, false)
    assert.equal(byName.get('startDate')?.derived ?? false, false)
    // 实际时刻仍然是 derived
    assert.equal(byName.get('completedAt')?.derived, true)
  })
})

describe('日历', () => {
  it('按计划完成日落到格子里', async () => {
    const id = await task('交账单', { dueDate: day(12) })
    await page.goto(`${baseUrl}/?type=Task&layout=calendar&month=${MONTH}`)
    await page.waitForSelector('.calendar-grid')
    const cell = page.locator('.calendar-day[data-day="2026-03-12"]')
    assert.equal(await cell.locator(`.calendar-item[data-id="${id}"]`).count(), 1)
  })

  it('没排期的列在下面，而不是消失', async () => {
    // 藏起来的话，日历看着很空，而使用者以为这个月真的没什么事
    await task('还没定日子')
    await page.goto(`${baseUrl}/?type=Task&layout=calendar&month=${MONTH}`)
    await page.waitForSelector('.calendar-unscheduled')
    assert.equal(await page.locator('.calendar-unscheduled .calendar-item').count(), 1)
  })

  it('翻月进地址栏，翻到的那个月能分享', async () => {
    await task('交账单', { dueDate: day(12) })
    await page.goto(`${baseUrl}/?type=Task&layout=calendar&month=${MONTH}`)
    await page.waitForSelector('.calendar-grid')
    await page.click('#calNext')
    await page.waitForFunction(() => new URL(location.href).searchParams.get('month') === '2026-04')
  })

  it('逾期的标出来，但终态的不标', async () => {
    // 已经结束的事情再标红只会让人学会忽略红色
    await task('早该交了', { dueDate: day(1) })
    await page.goto(`${baseUrl}/?type=Task&layout=calendar&month=${MONTH}`)
    await page.waitForSelector('.calendar-grid')
    assert.equal(await page.locator('.calendar-item.overdue').count(), 1)
  })
})

describe('甘特', () => {
  it('一根条一个对象，宽度按计划区间', async () => {
    await task('做导出', { startDate: day(2), dueDate: day(6) })
    await task('做登录', { startDate: day(8), dueDate: day(9) })
    await page.goto(`${baseUrl}/?type=Task&layout=gantt`)
    await page.waitForSelector('.gantt-bar')
    assert.equal(await page.locator('.gantt-bar').count(), 2)
  })

  it('画依赖线——Plane 开源版有开关但没有线', async () => {
    const first = await task('先做这个', { startDate: day(2), dueDate: day(5) })
    const second = await task('再做这个', { startDate: day(7), dueDate: day(9) })
    await relate(second, 'blockedBy', first)

    await page.goto(`${baseUrl}/?type=Task&layout=gantt`)
    await page.waitForSelector('.gantt-link')
    assert.ok((await page.locator('.gantt-link').count()) >= 1)
  })

  it('一条都没排期时说清楚要填什么，而不是给一张白图', async () => {
    await task('没日子')
    await page.goto(`${baseUrl}/?type=Task&layout=gantt`)
    await page.waitForSelector('.board-empty')
    assert.match((await page.locator('.board-empty').textContent()) ?? '', /开始日/)
  })
})
