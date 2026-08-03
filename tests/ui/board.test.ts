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
import { DEFAULT_AUTOMATION_RULES } from '../../src/workflow/automation.ts'
import { defaultPolicies } from '../../src/identity/default-policies.ts'
import { OutboxPoller } from '../../src/infrastructure/poller.ts'

/**
 * 看板 UI，真实浏览器。
 *
 * 用 Node 内置 runner 而不是 vitest：vitest 的 worker 池在驱动
 * 浏览器子进程时会卡在启动阶段。同一段代码用 `node --test` 两秒跑完。
 * 见 tests/ui/README.md。
 *
 * 这些用例要证明的只有一件事：**UI 里没有硬编码的业务语义**。
 * 列、可用动作、表单字段全部来自服务端的本体与状态机。
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
  await truncateAll(pool)

  const registry = buildDefaultRegistry()
  const workflows = buildDefaultWorkflowRegistry()
  const policies = defaultPolicies(TENANT)

  app = buildServer({ pool, registry, workflows, policies })
  // 端口由系统分配：固定端口一旦被上次残留的进程占住，整个套件会卡死
  await app.listen({ port: 0, host: '127.0.0.1' })
  const address = app.server.address()
  if (address === null || typeof address === 'string') throw new Error('server did not bind a port')
  baseUrl = `http://127.0.0.1:${address.port}`

  poller = new OutboxPoller({
    pool, registry, workflows, policies,
    rules: DEFAULT_AUTOMATION_RULES,
    tenants: [TENANT],
  })

  // 容器里以 root 运行时 Chromium 的沙箱起不来。这只影响测试环境。
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

async function openBoard(type = 'Task'): Promise<void> {
  await page.goto(`${baseUrl}/`)
  await page.waitForSelector('.column')
  await page.click(`.type-tab:text-is("${type}")`)
  await page.waitForFunction(
    (t) => document.querySelector('.type-tab[aria-selected="true"]')?.textContent === t,
    type,
  )
  await page.waitForSelector('.column')
}

async function columnNames(): Promise<string[]> {
  return page.locator('.column-head > span:first-child').allTextContents()
}

describe('看板的列来自状态机，不是前端写死的', () => {
  it('每个生命周期状态一列，顺序与定义一致', async () => {
    await openBoard('Task')
    assert.deepEqual(await columnNames(), [
      'Todo', 'Doing', 'Review', 'Testing', 'Blocked', 'Done', 'Cancelled',
    ])
  })

  it('换一个类型，列跟着换', async () => {
    await openBoard('Requirement')
    assert.deepEqual(await columnNames(), [
      'Draft', 'Review', 'Approved', 'Planning', 'InProgress', 'Finished', 'Rejected', 'Superseded',
    ])
  })

  it('终态被标出来', async () => {
    await openBoard('Task')
    const terminal = await page.locator('.column:has-text("Done") .terminal').first().textContent()
    assert.equal(terminal, '终态')
  })

  it('每个有生命周期的类型都有一个标签页', async () => {
    const tabs = await page.locator('.type-tab').allTextContents()
    for (const expected of ['Project', 'Requirement', 'Story', 'Task', 'Decision', 'Knowledge', 'Agent']) {
      assert.ok(tabs.includes(expected), `缺少标签页：${expected}`)
    }
  })
})

describe('新建表单由本体生成', () => {
  it('可编辑属性各一个字段，必填有标记，derived 的不出现', async () => {
    await openBoard('Task')
    await page.click('#newBtn')
    await page.waitForSelector('#modalForm .field')

    const names = await page
      .locator('#modalForm .field')
      .evaluateAll((nodes) => nodes.map((n) => (n as HTMLElement).dataset['name']))

    assert.deepEqual(names, ['title', 'description', 'assignee', 'estimate', 'blockReason'])
    // 状态机写入的时间戳在本体里标了 derived，不该让人填
    assert.ok(!names.includes('startedAt'))
    assert.ok(!names.includes('completedAt'))
    assert.equal(await page.locator('[data-name="title"] .req').textContent(), '*')

    await page.click('#modalClose')
  })

  it('enum 属性渲染成下拉，选项来自本体', async () => {
    await openBoard('Requirement')
    await page.click('#newBtn')
    await page.waitForSelector('#f_level')
    assert.deepEqual(await page.locator('#f_level option').allTextContents(), [
      '请选择', 'Epic', 'Feature', 'Story',
    ])
    await page.click('#modalClose')
  })

  it('服务端的字段级校验标在对应输入框上', async () => {
    await openBoard('Task')
    await page.click('#newBtn')
    await page.waitForSelector('#modalForm .field')
    await page.fill('#f_description', '没填标题')
    await page.click('#modalSubmit')
    // 前端不重复实现必填规则——两份规则必然漂移
    await page.waitForSelector('[data-name="title"] .field-error')
    const message = await page.locator('[data-name="title"] .field-error').textContent()
    assert.match(message ?? '', /required|Required/)
    await page.click('#modalClose')
  })
})

describe('可用动作由工作流引擎给出', () => {
  it('新建的卡片落在初始状态列', async () => {
    await openBoard('Task')
    await page.click('#newBtn')
    await page.waitForSelector('#f_title')
    await page.fill('#f_title', '渲染 PDF')
    await page.click('#modalSubmit')
    await page.waitForSelector('.card')

    const first = page.locator('.column').first()
    assert.equal(await first.locator('.card-title').first().textContent(), '渲染 PDF')
  })

  it('未就绪的迁移也列出来，并说明差什么', async () => {
    await page.click('.card:has-text("渲染 PDF")')
    await page.waitForSelector('.transition')

    const doing = page.locator('.transition', { hasText: 'Doing' })
    assert.equal(await doing.isDisabled(), true)
    // 只显示能点的，用户会以为"就这些了"，不知道下一步要先做什么
    const why = await doing.locator('.why').textContent()
    assert.match(why ?? '', /assignee/)
  })

  it('守卫满足后迁移变为可执行，点击后卡片换列', async () => {
    const id = await page.locator('.card:has-text("渲染 PDF")').getAttribute('data-id')
    await page.evaluate(
      async ([resourceId, auth]) => {
        const headers = { 'content-type': 'application/json', ...(auth as Record<string, string>) }
        const current = await fetch(`/v1/resources/${resourceId}`, { headers }).then((r) => r.json())
        await fetch(`/v1/resources/${resourceId}`, {
          method: 'PATCH',
          headers,
          body: JSON.stringify({
            expectedVersion: current.version,
            attributes: { ...current.attributes, assignee: 'user://bob' },
          }),
        })
      },
      [id, AUTH] as const,
    )

    await openBoard('Task')
    await page.click('.card:has-text("渲染 PDF")')
    await page.waitForSelector('.transition')

    const doing = page.locator('.transition', { hasText: 'Doing' })
    assert.equal(await doing.isDisabled(), false)

    await doing.click()
    await page.waitForSelector('.toast')
    await page.waitForFunction(() => {
      const columns = document.querySelectorAll('.column')
      return columns[1]?.querySelector('.card-title')?.textContent === '渲染 PDF'
    })
  })

  it('终态没有可执行的迁移', async () => {
    const id = await page.locator('.card:has-text("渲染 PDF")').getAttribute('data-id')
    await page.evaluate(
      async ([resourceId, auth]) => {
        const headers = { 'content-type': 'application/json', ...(auth as Record<string, string>) }
        await fetch(`/v1/resources/${resourceId}/transitions`, {
          method: 'POST', headers, body: JSON.stringify({ to: 'Done' }),
        })
      },
      [id, AUTH] as const,
    )
    await openBoard('Task')
    await page.click('.card:has-text("渲染 PDF")')
    await page.waitForSelector('.drawer-body .section')
    assert.equal(await page.locator('.transition').count(), 0)
  })
})

describe('权限是 PDP 过滤的结果，不是界面藏了按钮', () => {
  it('Guest 看不到任何可执行迁移', async () => {
    await openBoard('Task')
    // 顺带验证抽屉不会盖住顶栏——盖住的话身份切换按钮就点不到了
    await page.click('.card')
    await page.waitForSelector('.drawer-body .section')
    await page.click('#identityBtn')
    await page.waitForSelector('#id_user\\:\\/\\/guest')
    await page.click('#id_user\\:\\/\\/guest')
    await page.click('#modalSubmit')
    await page.waitForSelector('.card')

    await page.click('.card')
    // 等到内容真的渲染出来，而不是还停在「加载中…」
    await page.waitForSelector('.drawer-body .section')
    assert.equal(await page.locator('.transition').count(), 0)
    const body = await page.locator('.drawer-body').textContent()
    assert.match(body ?? '', /没有可执行的迁移/)
  })

  it('换回有权限的身份，迁移又出现', async () => {
    await page.click('#identityBtn')
    await page.waitForSelector('#id_user\\:\\/\\/alice')
    await page.click('#id_user\\:\\/\\/alice')
    await page.click('#modalSubmit')
    await page.waitForSelector('.card')

    // 建一张确定处于初始状态的卡片再断言。
    // 直接点 `.card` 会落到前一个用例留下的终态卡片上——那种顺序依赖
    // 会让失败信息指向错误的地方
    const id = await page.evaluate(async ([auth]) => {
      const headers = { 'content-type': 'application/json', ...(auth as Record<string, string>) }
      const task = await fetch('/v1/resources', {
        method: 'POST',
        headers,
        body: JSON.stringify({ type: 'Task', workspace: 'ws_default', attributes: { title: '权限回归' } }),
      }).then((r) => r.json())
      return task.id as string
    }, [AUTH])

    await openBoard('Task')
    await page.click(`.card[data-id="${id}"]`)
    await page.waitForSelector('.transition')
    assert.ok((await page.locator('.transition').count()) > 0)
  })
})

describe('自动化在界面上看得见', () => {
  it('Story 被自动推进，并在历史里标为自动化', async () => {
    const ids = await page.evaluate(async ([auth]) => {
      const headers = { 'content-type': 'application/json', ...(auth as Record<string, string>) }
      const post = (url: string, body: unknown) =>
        fetch(url, { method: 'POST', headers, body: JSON.stringify(body) }).then((r) => r.json())

      const story = await post('/v1/resources', {
        type: 'Story', workspace: 'ws_default', attributes: { title: '发票导出' },
      })
      const task = await post('/v1/resources', {
        type: 'Task', workspace: 'ws_default', attributes: { title: '子任务', assignee: 'user://bob' },
      })
      await post(`/v1/resources/${story.id}/relations`, { type: 'decomposedInto', toId: task.id })
      await post(`/v1/resources/${story.id}/transitions`, { to: 'Ready' })
      await post(`/v1/resources/${task.id}/transitions`, { to: 'Doing' })
      return { story: story.id }
    }, [AUTH])

    await poller.pollOnce()
    await poller.pollOnce()

    await openBoard('Story')
    await page.click(`.card[data-id="${ids.story}"]`)
    await page.waitForSelector('.timeline-item')

    const drawerType = await page.locator('.drawer-type').textContent()
    assert.match(drawerType ?? '', /InProgress/)

    // 自动化改的东西必须一眼看得出是自动化改的
    const who = await page.locator('.timeline-item .who.system').first().textContent()
    assert.equal(who, '自动化')
    const reason = await page.locator('.timeline-item .reason').first().textContent()
    assert.match(reason ?? '', /automation:/)
  })
})
