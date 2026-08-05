import { after, before, describe, it } from 'node:test'
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
 * 本体可视化浏览器与流程编辑器（FR-ONT-012 / FR-WF-014）。
 *
 *   FR-ONT-012 验收：**可从任一实体出发展开 N 跳关系图**
 *   FR-WF-014  验收：**拖拽编辑状态机并保存**
 *
 * 和看板那组同一个主题：**UI 里没有硬编码的业务语义。**
 * 图上跟哪些关系、编辑器里有哪些状态，全部来自服务端的本体与状态机。
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
  await truncateAll(pool)

  app = buildServer({
    pool,
    registry: buildDefaultRegistry(),
    workflows: buildDefaultWorkflowRegistry(),
    // Agent 的授权是两步的：有 Capability 还不够，还要有 Policy 允许。
    // 图上要出现一条"被否决的推断边"，就得先有一个能推断的 Agent
    policies: [
      ...defaultPolicies(TENANT),
      {
        id: 'pol-knowledge-agent',
        effect: 'Allow' as const,
        subject: 'agent://knowledge@1.0.0',
        action: 'Knowledge.*' as const,
        scope: { kind: 'tenant' as const, tenant: TENANT },
      },
    ],
    tenant: TENANT,
  })
  await app.listen({ port: 0, host: '127.0.0.1' })
  const address = app.server.address()
  baseUrl = typeof address === 'object' && address !== null ? `http://127.0.0.1:${address.port}` : ''

  browser = await chromium.launch({
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
    ...(process.env['CHROMIUM_PATH'] === undefined
      ? {}
      : { executablePath: process.env['CHROMIUM_PATH'] }),
  })
  page = await browser.newPage()
  await page.addInitScript((identity) => {
    localStorage.setItem('projectos.identity', identity)
  }, JSON.stringify({ principal: 'user://alice', roles: 'Admin', label: 'alice' }))
})

after(async () => {
  await page?.close()
  await browser?.close()
  await app?.close()
  await pool?.end()
})

async function create(type: string, attributes: Record<string, unknown>): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/resources',
    headers: { ...AUTH, 'content-type': 'application/json' },
    payload: { type, workspace: 'ws_ui', attributes },
  })
  assert.equal(res.statusCode, 201, res.body)
  return res.json().id as string
}

async function relate(fromId: string, type: string, toId: string): Promise<void> {
  const res = await app.inject({
    method: 'POST',
    url: `/v1/resources/${fromId}/relations`,
    headers: { ...AUTH, 'content-type': 'application/json' },
    payload: { type, toId },
  })
  assert.equal(res.statusCode, 201, res.body)
}

describe('本体可视化浏览器（FR-ONT-012）', () => {
  it('从任一实体出发展开 N 跳关系图', async () => {
    const story = await create('Story', { title: '导出账单' })
    const taskA = await create('Task', { title: '打通接口' })
    const taskB = await create('Task', { title: '写 UI' })
    await relate(story, 'decomposedInto', taskA)
    await relate(story, 'decomposedInto', taskB)

    await page.goto(`${baseUrl}/?view=graph&start=${story}&depth=2`)
    await page.waitForSelector('.graph-svg', { timeout: 15_000 })

    // 三个对象都在图上——起点自己 + 两个任务
    const nodes = await page.locator('.graph-node').count()
    assert.equal(nodes, 3, '起点与两个子任务都该出现')
    // 两条关系
    assert.equal(await page.locator('.graph-edge').count(), 2)
  })

  it('点一个节点就以它为新起点', async () => {
    const story = await create('Story', { title: '重心切换' })
    const task = await create('Task', { title: '被点的那个' })
    await relate(story, 'decomposedInto', task)

    await page.goto(`${baseUrl}/?view=graph&start=${story}&depth=2`)
    await page.waitForSelector('.graph-svg')
    await page.locator(`.graph-node[data-id="${task}"]`).click()

    // 起点换了，而且**写进了地址栏**——这张图分享出去还是这一张
    await page.waitForFunction((id) => location.search.includes(id), task, { timeout: 10_000 })
  })

  it('起点还没有任何关系时说清楚，而不是给一张空白图', async () => {
    const lonely = await create('Task', { title: '孤零零' })
    await page.goto(`${baseUrl}/?view=graph&start=${lonely}&depth=2`)
    await page.waitForSelector('.graph-canvas')
    const text = await page.locator('.graph-canvas').innerText()
    assert.match(text, /没有可展开的关系/)
  })

  it('被否决的关系画成虚线，而不是从图上消失', async () => {
    // 否决 ≠ 删除。抹掉它的后果是下周有人再推断一次同样的边，
    // 而图上没有任何痕迹说明这事发生过
    const project = await create('Project', { key: 'PZ', name: '虚线' })
    const task = await create('Task', { title: '被牵连的' })
    const knowledge = await create('Knowledge', { title: 'k', body: 'b' })
    await relate(project, 'contains', task)
    await relate(project, 'contains', knowledge)

    const inferred = await app.inject({
      method: 'POST',
      url: `/v1/resources/${knowledge}/relations`,
      headers: {
        'x-principal': 'agent://knowledge@1.0.0',
        'x-tenant': TENANT,
        'x-roles': 'AIAgent',
        'x-capabilities': 'Knowledge.Update,Knowledge.Read,Task.Read',
        'content-type': 'application/json',
      },
      payload: { type: 'derivedFrom', toId: task, confidence: 0.8 },
    })
    assert.equal(inferred.statusCode, 201, inferred.body)
    await app.inject({
      method: 'POST',
      url: `/v1/relations/${inferred.json().id}/confirmation`,
      headers: { ...AUTH, 'content-type': 'application/json' },
      payload: { confirmed: false },
    })

    await page.goto(`${baseUrl}/?view=graph&start=${project}&depth=2`)
    await page.waitForSelector('.graph-svg')
    assert.equal(await page.locator('.graph-edge.rejected').count(), 1)
  })

  it('跟的是本体里声明的关系，不是写死的一张名单', async () => {
    // 这一条是整组的意义所在：**UI 不认识任何具体的关系类型。**
    //
    // 断言写成"从服务端拿到的关系名一个都不许出现在前端源码里"，
    // 而不是匹配某一句写法——本体里加一种关系时，这条会自己跟上。
    const declared = await app
      .inject({ method: 'GET', url: '/v1/ontology/relation-types', headers: AUTH })
      .then((r) => (r.json().items as { name: string }[]).map((t) => t.name))
    // 只挑驼峰的那些。`contains`/`owns`/`plans` 这类单词在任何一份
    // JS 源码里都可能因为别的原因出现，拿它们做断言只会得到假红
    const unambiguous = declared.filter((n) => /[a-z][A-Z]/.test(n))
    assert.ok(unambiguous.length >= 5, `可用于断言的关系名太少：${declared.join(',')}`)

    const source = await page.goto(`${baseUrl}/app.js`).then((r) => r?.text() ?? '')
    // 找的是**字符串字面量**。硬编码一个关系类型只有这一种写法；
    // 而 `t.blockedBy` 这样的属性读取是迁移接口的字段，同名纯属巧合，
    // 把它算成"写死了关系名"是假红
    const leaked = unambiguous.filter((n) => new RegExp(`['"\`]${n}['"\`]`).test(source))
    assert.deepEqual(leaked, [], '关系类型不该以字面量出现在前端源码里')
  })
})

describe('可视化流程编辑器（FR-WF-014）', () => {
  it('把状态机画出来，状态与迁移都来自服务端', async () => {
    await page.goto(`${baseUrl}/?view=process`)
    await page.waitForSelector('.process-state', { timeout: 15_000 })

    const names = await page.locator('.process-state strong').allInnerTexts()
    // Task 的默认状态机（第一台）里有这些状态
    assert.ok(names.includes('Todo'), `期望包含 Todo，实际 ${names.join(',')}`)
    assert.ok(names.includes('Done'))
  })

  it('把一个状态拖到另一个上面就新增一条迁移', async () => {
    await page.goto(`${baseUrl}/?view=process`)
    await page.waitForSelector('.process-state')

    // Todo → Done 在默认 Task 状态机里**不存在**（必须先 Doing）
    const before = await page.locator('.process-state[data-state="Todo"] .process-edge').allInnerTexts()
    assert.ok(!before.some((t) => t.includes('Done')), `拖之前不该有 Todo → Done：${before.join(',')}`)

    await page
      .locator('.process-state[data-state="Todo"]')
      .dragTo(page.locator('.process-state[data-state="Done"]'))

    const after = await page.locator('.process-state[data-state="Todo"] .process-edge').allInnerTexts()
    assert.ok(after.some((t) => t.includes('Done')), `拖之后应当有 Todo → Done：${after.join(',')}`)
  })

  it('× 只摘掉这一个来源，不是删掉整条迁移', async () => {
    // 一条迁移可以有多个 from（`from: ['Doing','Review','Testing'] → Blocked`）。
    // 整条删掉的话，点一次 × 会顺手切断另外两个状态的路
    await page.goto(`${baseUrl}/?view=process`)
    await page.waitForSelector('.process-state')

    const reviewBefore = await page
      .locator('.process-state[data-state="Review"] .process-edge')
      .allInnerTexts()
    assert.ok(reviewBefore.some((t) => t.includes('Blocked')))

    // 从 Doing 上摘掉 → Blocked
    await page
      .locator('.process-state[data-state="Doing"] .process-edge', { hasText: 'Blocked' })
      .locator('button')
      .click()

    const reviewAfter = await page
      .locator('.process-state[data-state="Review"] .process-edge')
      .allInnerTexts()
    assert.ok(
      reviewAfter.some((t) => t.includes('Blocked')),
      'Review → Blocked 不该被顺手删掉',
    )
  })

  it('没有配置状态机存储时，保存失败要说清楚而不是假装成功', async () => {
    // 这个测试服务器**没有** lifecycles 存储，服务端会返回 501。
    // UI 必须把它显示出来——一个静默失败的保存按钮是最糟的那种
    await page.goto(`${baseUrl}/?view=process`)
    await page.waitForSelector('#processSave')
    await page.locator('#processSave').click()
    await page.waitForSelector('.toasts', { timeout: 10_000 })
    const toast = await page.locator('.toasts').innerText()
    assert.match(toast, /保存失败|no store|not_configured/i, `实际提示：${toast}`)
  })
})
