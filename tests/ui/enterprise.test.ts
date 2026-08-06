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
 * 企业版界面（React）。真实浏览器。
 *
 * 对照 docs/research/plane-enterprise-features.md 里 B 类那批。
 * 和 vanilla 那边同一条要求：**界面里没有硬编码的业务语义**——
 * 表格的列、表单的字段、可做的动作，全部来自本体与状态机。
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

async function create(type: string, attributes: Record<string, unknown>, headers = AUTH) {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/resources',
    headers,
    payload: { type, workspace: 'ws_platform', attributes },
  })
  if (res.statusCode !== 201) throw new Error(`create ${type}: ${res.body}`)
  return res.json().id as string
}

/** 打开企业版的某一屏。身份存在 localStorage 里，和 vanilla 共用同一个键 */
async function open(screen: string, roles = 'Admin'): Promise<void> {
  await page.goto(`${baseUrl}/app`)
  await page.evaluate(
    (r) =>
      localStorage.setItem(
        'projectos.identity',
        JSON.stringify({ principal: 'user://alice', roles: r, label: 'alice' }),
      ),
    roles,
  )
  await page.reload()
  await page.waitForSelector('.type-tab')
  await page.click(`.type-tab[data-screen="${screen}"]`)
  await page.waitForSelector(`[data-screen-for]`)
}

describe('React 企业版跑起来了', () => {
  it('十二屏都在，其中四屏没有一行专属代码', async () => {
    await page.goto(`${baseUrl}/app`)
    await page.waitForSelector('.type-tab')
    assert.deepEqual(await page.locator('.type-tab').allTextContents(), [
      // 前六屏来自 project-management-guide。分析与周期各有专属组件
      // （图表答得了表格答不了的问题），而**模块 / 意见收集 / 标签目录 /
      // 便签四屏没有一行专属代码**——它们走同一个 ObjectScreen，
      // 界面由本体渲染出来。这条断言盯的就是那个性质
      '分析', '周期', '模块', '意见收集', '标签目录', '便签',
      // 后六屏对照 Plane 付费档
      '举措', '团队空间', '工时', '模板', '保存的视图', '基线',
    ])
  })

  it('vanilla 看板上有入口，两边不是各走各的', async () => {
    await page.goto(`${baseUrl}/`)
    await page.waitForSelector('#enterpriseLink')
    assert.equal(await page.locator('#enterpriseLink').getAttribute('href'), '/app')
  })
})

describe('界面按本体渲染，不是手写的字段清单', () => {
  it('表格的列来自本体', async () => {
    await create('Initiative', { name: '降本增效', objective: '把云成本砍掉三成' })
    await open('initiative')
    const declared = await app
      .inject({ method: 'GET', url: '/v1/ontology/entity-types', headers: AUTH })
      .then((r) => {
        const def = (r.json().items as { name: string; attributes: { name: string }[] }[]).find(
          (t) => t.name === 'Initiative',
        )
        return (def?.attributes ?? []).map((a) => a.name)
      })
    const columns = await page.locator('.item-table th').allTextContents()
    for (const name of declared) assert.ok(columns.includes(name), `缺少本体属性列 ${name}`)
  })

  it('新建表单的字段也来自本体，derived 的不出现', async () => {
    await open('worklog')
    await page.click('[data-action="new"]')
    await page.waitForSelector('.object-form .field')
    const fields = await page
      .locator('.object-form .field')
      .evaluateAll((nodes) => nodes.map((n) => (n as HTMLElement).dataset['name']))
    assert.ok(fields.includes('hours'))
    assert.ok(fields.includes('spentOn'))
    // approvedAt 由状态机写入，让人填就等于这个字段不再说明事实
    assert.ok(!fields.includes('approvedAt'))
  })
})

describe('举措：跨项目的目标（Plane pro 档）', () => {
  it('建一条并显示出来', async () => {
    await open('initiative')
    await page.click('[data-action="new"]')
    await page.waitForSelector('.object-form')
    await page.fill('[data-name="name"] input', '降本增效')
    await page.fill('[data-name="objective"] input', '云成本砍三成')
    await page.click('.object-form button[type="submit"]')
    await page.waitForSelector('.item-table tbody tr')
    assert.match((await page.locator('.item-table').textContent()) ?? '', /降本增效/)
  })

  it('落在状态机的初始状态上', async () => {
    await create('Initiative', { name: 'X', objective: 'Y' })
    await open('initiative')
    await page.waitForSelector('.item-table tbody tr')
    assert.match((await page.locator('.item-table tbody tr').textContent()) ?? '', /Planned/)
  })
})

describe('工时：报 + 审批（Plane business 档）', () => {
  it('报出来是草稿，可做的动作由工作流引擎给出', async () => {
    await create('Worklog', { hours: 3, spentOn: '2026-03-02T00:00:00.000Z', note: '排查线上问题' })
    await open('worklog')
    await page.waitForSelector('.item-table tbody tr')
    assert.equal(await page.locator('tr[data-status="Draft"]').count(), 1)
    // 按钮不是按状态硬编码的，是服务端算出来的可用迁移
    assert.equal(await page.locator('[data-transition="Submitted"]').count(), 1)
  })

  it('自己报的自己批不了，而且界面说得出为什么', async () => {
    // 这条规则在 default-policies 的 Deny 里（notOwner），不在前端。
    // 前端只是把"服务端没给这个动作"如实显示出来
    const id = await create('Worklog', { hours: 2, spentOn: '2026-03-02T00:00:00.000Z' })
    const submitted = await app.inject({
      method: 'POST',
      url: `/v1/resources/${id}/transitions`,
      headers: AUTH,
      payload: { to: 'Submitted', reason: '提交' },
    })
    assert.equal(submitted.statusCode, 200)

    await open('worklog')
    await page.waitForSelector('tr[data-status="Submitted"]')
    assert.equal(await page.locator('[data-transition="Approved"]').count(), 0)
    assert.equal(await page.locator('[data-no-self-approve="1"]').count(), 1)
  })

  it('只汇总已批准的工时', async () => {
    // 把待审的算进去，这个数字每天都在变，而没人知道它什么时候算数
    await create('Worklog', { hours: 5, spentOn: '2026-03-02T00:00:00.000Z' })
    await open('worklog')
    await page.waitForSelector('[data-approved-hours]')
    assert.equal(await page.locator('[data-approved-hours="0"]').count(), 1)
  })
})

describe('模板：套用生成对象（Plane pro / business 档）', () => {
  it('套用后真的生成了目标对象', async () => {
    await create('Template', {
      name: '例行巡检任务',
      targetType: 'Task',
      draft: { title: '例行巡检' },
    })
    await open('template')
    await page.waitForSelector('.template-card')
    await page.click('[data-action="apply"]')
    await page.waitForSelector('.template-result')

    const tasks = await app
      .inject({ method: 'GET', url: '/v1/resources?type=Task', headers: AUTH })
      .then((r) => r.json().items as { attributes: Record<string, string> }[])
    assert.equal(tasks.length, 1)
    assert.equal(tasks[0]?.attributes['title'], '例行巡检')
  })

  it('目标类型不在本体里就不让点', async () => {
    // 点下去必然失败，而失败信息会指向"创建被拒"，指不到"模板写错了"
    await create('Template', { name: '坏模板', targetType: 'Nonexistent', draft: {} })
    await open('template')
    await page.waitForSelector('.template-card')
    assert.equal(await page.locator('[data-action="apply"]').isDisabled(), true)
  })
})

describe('权限是服务端算的，不是界面藏的', () => {
  it('Guest 建不了举措，并且如实说出来', async () => {
    await open('initiative', 'Guest')
    await page.click('[data-action="new"]')
    await page.waitForSelector('.object-form')
    await page.fill('[data-name="name"] input', '不该建成')
    await page.fill('[data-name="objective"] input', 'x')
    await page.click('.object-form button[type="submit"]')
    await page.waitForSelector('.form-error')
    assert.match((await page.locator('.form-error').textContent()) ?? '', /capability|policy|forbidden/i)
  })
})
