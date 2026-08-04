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

/**
 * 打开某个类型的看板。
 *
 * 直接用 URL 导航，而不是"打开首页再点标签页"。
 * 点击那条路径有一个真实的竞态：`renderTabs` 是同步的，
 * `refresh()` 是异步的，于是 `aria-selected` 已经变成新类型时，
 * 列还是旧类型的——`waitForSelector('.column')` 立刻命中旧列，
 * 断言读到上一个类型的列名。这条用例因此偶发性变红过两次。
 *
 * 视图现在由 URL 决定（自用日志 #5），整页加载后不存在中间态。
 * 点击切换本身另有一条专门的用例覆盖。
 */
async function openBoard(type = 'Task'): Promise<void> {
  await page.goto(`${baseUrl}/?type=${encodeURIComponent(type)}`)
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
    // AgentRun 在这里，是因为本体里注册了它并给了生命周期——**前端一行没改**。
    // 这是 ADR-0001「UI 是本体的渲染视图」最直接的一次兑现：
    // 新增一整类领域对象（一次 Agent 执行）不需要动界面代码
    for (const expected of [
      'Project', 'Requirement', 'Story', 'Task', 'Decision', 'Knowledge', 'Agent', 'AgentRun',
    ]) {
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

describe('编辑属性', () => {
  it('编辑表单只列可编辑属性，并回填当前值', async () => {
    await openBoard('Task')
    await page.click('#newBtn')
    await page.waitForSelector('#f_title')
    await page.fill('#f_title', '可编辑的任务')
    await page.fill('#f_description', '初始描述')
    await page.click('#modalSubmit')
    await page.waitForSelector('.card:has-text("可编辑的任务")')

    await page.click('.card:has-text("可编辑的任务")')
    await page.waitForSelector('#editAttrsBtn')
    await page.click('#editAttrsBtn')
    await page.waitForSelector('#editForm')

    // 当前值被回填，用户不必重新输入没打算改的内容
    assert.equal(await page.inputValue('#f_title'), '可编辑的任务')
    assert.equal(await page.inputValue('#f_description'), '初始描述')
    // derived 字段不在表单里，只作为只读说明出现
    assert.equal(await page.locator('#editForm #f_startedAt').count(), 0)
  })

  it('保存后看板与详情都更新', async () => {
    await page.fill('#f_title', '改过标题的任务')
    await page.fill('#f_assignee', 'user://bob')
    await page.click('#saveAttrsBtn')

    // 等**内容**出现，而不是等某个结构选择器：
    // 旧的 section 在重渲染前还留在 DOM 里，等结构会立刻通过，什么都没验到
    await page.waitForFunction(() =>
      document.querySelector('.drawer-body')?.textContent?.includes('改过标题的任务') === true,
    )

    await page.click('#drawerClose')
    await page.waitForSelector('.card:has-text("改过标题的任务")')
  })

  it('补上 assignee 之后，原先被守卫拦住的迁移变为可执行', async () => {
    // 编辑功能真正的价值：它让用户能自己满足守卫，而不是去开 curl
    await page.click('.card:has-text("改过标题的任务")')
    await page.waitForSelector('.transition')
    const doing = page.locator('.transition', { hasText: 'Doing' })
    assert.equal(await doing.isDisabled(), false)
  })

  it('并发冲突不静默覆盖，而是重新载入并说明', async () => {
    await openBoard('Task')
    await page.click('.card:has-text("改过标题的任务")')
    await page.waitForSelector('#editAttrsBtn')
    await page.click('#editAttrsBtn')
    await page.waitForSelector('#editForm')

    // 模拟他人在此期间改了同一条记录
    const id = await page.locator('.card:has-text("改过标题的任务")').getAttribute('data-id')
    await page.evaluate(
      async ([resourceId, auth]) => {
        const headers = { 'content-type': 'application/json', ...(auth as Record<string, string>) }
        const current = await fetch(`/v1/resources/${resourceId}`, { headers }).then((r) => r.json())
        await fetch(`/v1/resources/${resourceId}`, {
          method: 'PATCH',
          headers,
          body: JSON.stringify({
            expectedVersion: current.version,
            attributes: { ...current.attributes, description: '别人写的' },
          }),
        })
      },
      [id, AUTH] as const,
    )

    // 清掉此前残留的提示：错误提示会停留 6.5 秒，
    // 上一个用例的 toast 还在时，断言可能取到旧的那条
    await page.evaluate(() => {
      for (const node of document.querySelectorAll('.toast')) node.remove()
    })

    await page.fill('#f_description', '我写的')
    await page.click('#saveAttrsBtn')
    await page.waitForSelector('.toast.error')

    const toast = await page.locator('.toast.error').textContent()
    assert.match(toast ?? '', /已被他人修改/)

    // 提示是同步弹的，重新载入是异步的：不等抽屉真的画完就断言，
    // 读到的是「加载中…」而不是内容——这条用例会随机红一次
    await page.waitForSelector('.drawer-body .section')

    // 对方的修改必须还在——静默覆盖是这里最不能接受的失败方式
    const drawer = await page.locator('.drawer-body').textContent()
    assert.match(drawer ?? '', /别人写的/)
  })
})

describe('管理关系', () => {
  it('可选关系类型由本体的定义域决定', async () => {
    await openBoard('Story')
    await page.click('#newBtn')
    await page.waitForSelector('#f_title')
    await page.fill('#f_title', '要拆任务的故事')
    await page.click('#modalSubmit')
    await page.waitForSelector('.card:has-text("要拆任务的故事")')

    await page.click('.card:has-text("要拆任务的故事")')
    await page.waitForSelector('#addRelationBtn')
    await page.click('#addRelationBtn')
    await page.waitForSelector('#relType')

    const options = await page.locator('#relType option').allTextContents()
    // Story 能做起点的关系：decomposedInto、implements
    assert.ok(options.some((o) => o.startsWith('decomposedInto')))
    assert.ok(options.some((o) => o.startsWith('implements')))
    // contains 的定义域是 Project，不该出现
    assert.ok(!options.some((o) => o.startsWith('contains')))
  })

  it('建立关系后守卫得到满足，Story 可以进入 Ready', async () => {
    // Story → Ready 要求存在 decomposedInto。没有建关系的入口，
    // 这个守卫在界面上就是永远满足不了的
    await page.selectOption('#relType', 'decomposedInto')
    await page.waitForFunction(() => {
      const select = document.querySelector('#relTarget') as HTMLSelectElement | null
      return select !== null && select.options.length > 0
    })
    await page.click('#modalSubmit')
    await page.waitForSelector('.rel-row')

    const ready = page.locator('.transition', { hasText: 'Ready' })
    assert.equal(await ready.isDisabled(), false)
  })

  it('删除关系后守卫重新变为不满足', async () => {
    // 记住当前对象再操作：靠上一个用例留下的抽屉状态会让失败信息
    // 指向错误的地方——上一轮就是这样
    const storyId = await page.evaluate(
      () => document.querySelector('.drawer-body')?.textContent?.match(/story_[0-9A-HJKMNP-TV-Z]{26}/)?.[0] ?? '',
    )
    assert.ok(storyId !== '', '没能从抽屉里读到 Story id')

    await page.locator('.rel-row .link-btn.danger').first().click()
    await page.waitForFunction(
      () => document.querySelector('.rel-list') === null,
      undefined,
      { timeout: 10_000 },
    )

    const ready = page.locator('.transition', { hasText: 'Ready' })
    assert.equal(await ready.isDisabled(), true)
    const why = await ready.locator('.why').textContent()
    assert.match(why ?? '', /decomposedInto/)
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

/**
 * 检索（FR-RES-016 / 自用日志 #3）。
 *
 * 这组用例要锁住的关键点是：**过滤发生在服务端**。
 * 如果改成在已加载的那 200 条里做前端过滤，功能性断言照样全绿，
 * 但用户搜到的永远只是"最近 200 条里的"——一个会骗人的搜索框。
 * 所以第一条用例直接检查请求体里带没带 `filter.text`。
 */
describe('搜索', () => {
  /** 通过 HTTP 建对象，绕开表单——这里测的是搜索，不是新建 */
  async function seed(title: string): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/resources',
      headers: { ...AUTH, 'content-type': 'application/json' },
      payload: { type: 'Task', workspace: 'ws_ui', attributes: { title } },
    })
    return res.json().id as string
  }

  it('把检索词发给服务端，而不是在前端过滤已加载的那一页', async () => {
    await seed('锚定词 kanaria 的任务')
    await openBoard('Task')

    const urls: string[] = []
    const record = (request: import('playwright').Request) => {
      if (request.url().includes('/v1/resources?')) urls.push(request.url())
    }
    page.on('request', record)
    try {
      await page.fill('#searchInput', 'kanaria')
      await page.waitForFunction(() => document.querySelectorAll('.card').length === 1, undefined, {
        timeout: 5000,
      })
    } finally {
      page.off('request', record)
    }

    assert.ok(
      urls.some((u) => new URL(u).searchParams.get('text') === 'kanaria'),
      `没有一个读请求带上 text=，说明过滤是在前端做的：${JSON.stringify(urls)}`,
    )
  })

  it('搜中文——默认全文检索分词器切不开这些字', async () => {
    await seed('把状态机改成可配置')
    await openBoard('Task')
    await page.fill('#searchInput', '状态机')
    await page.waitForFunction(() => document.querySelectorAll('.card').length > 0, undefined, {
      timeout: 5000,
    })
    assert.match((await page.locator('.card').first().textContent()) ?? '', /状态机/)
  })

  it('搜不到时说清楚是什么没搜到，而不是显示一个空看板', async () => {
    await openBoard('Task')
    await page.fill('#searchInput', 'zzz-绝不存在的词-zzz')
    await page.waitForSelector('.board-empty')
    assert.match((await page.locator('.board-empty').first().textContent()) ?? '', /没有匹配/)
  })

  it('Esc 清空搜索并回到全量视图', async () => {
    await seed('清空搜索后应当还在')
    await openBoard('Task')
    await page.fill('#searchInput', 'zzz-绝不存在的词-zzz')
    await page.waitForSelector('.board-empty')

    await page.locator('#searchInput').press('Escape')
    await page.waitForSelector('.column')
    assert.equal(await page.locator('#searchInput').inputValue(), '')
    assert.ok((await page.locator('.card').count()) > 0)
  })
})

/**
 * 建关系时的候选对象选择。
 *
 * 以前这里写死"列出每种类型最近 50 条"——对象一多就选不到想要的那个，
 * 而且提示语无论列没列全都一样。这是自用日志 #3 的同一个缺失在另一处的表现。
 */
describe('建关系时能筛选候选对象', () => {
  it('筛选词交给服务端，候选列表跟着变', async () => {
    for (const title of ['候选甲 alpha', '候选乙 beta', '候选丙 gamma']) {
      await app.inject({
        method: 'POST',
        url: '/v1/resources',
        headers: { ...AUTH, 'content-type': 'application/json' },
        payload: { type: 'Task', workspace: 'ws_pick', attributes: { title } },
      })
    }
    const story = await app.inject({
      method: 'POST',
      url: '/v1/resources',
      headers: { ...AUTH, 'content-type': 'application/json' },
      payload: { type: 'Story', workspace: 'ws_pick', attributes: { title: '要挑任务的故事' } },
    })

    await openBoard('Story')
    await page.click(`.card[data-id="${story.json().id}"]`)
    await page.waitForSelector('#addRelationBtn')
    await page.click('#addRelationBtn')
    await page.waitForSelector('#relTargetSearch')
    await page.selectOption('#relType', 'decomposedInto')
    await page.waitForFunction(() => {
      const s = document.querySelector('#relTarget') as HTMLSelectElement | null
      return s !== null && s.options.length > 1
    })

    await page.fill('#relTargetSearch', 'beta')
    await page.waitForFunction(() => {
      const s = document.querySelector('#relTarget') as HTMLSelectElement | null
      return s !== null && s.options.length === 1
    }, undefined, { timeout: 5000 })

    const only = await page.locator('#relTarget option').first().textContent()
    assert.match(only ?? '', /候选乙/)

    // 列全了就说列全了——以前无论如何都说"最近 50 条"
    assert.match((await page.locator('#relTarget ~ .hint').textContent()) ?? '', /已列全/)
    await page.click('#modalClose')
  })

  it('筛不到时说清楚，而不是给一个空下拉', async () => {
    await page.click('#addRelationBtn')
    await page.waitForSelector('#relTargetSearch')
    await page.selectOption('#relType', 'decomposedInto')
    await page.fill('#relTargetSearch', 'zzz-绝不存在的候选-zzz')
    await page.waitForFunction(
      () => (document.querySelector('#relTarget ~ .hint')?.textContent ?? '').includes('没有匹配'),
      undefined,
      { timeout: 5000 },
    )
    await page.click('#modalClose')
  })
})

/**
 * 视图有 URL（docs/dogfooding-log.md #5）。
 *
 * 此前看板的类型和搜索词只活在内存里：分享不了、收藏不了、前进后退不工作。
 * 「把搜索结果发给同事」是最基本的协作动作，而它做不到。
 */
describe('看板视图可以分享', () => {
  it('把链接粘过来就是同一个视图', async () => {
    await app.inject({
      method: 'POST',
      url: '/v1/resources',
      headers: { ...AUTH, 'content-type': 'application/json' },
      payload: { type: 'Task', workspace: 'ws_url', attributes: { title: '可分享的目标 sharable' } },
    })

    // 完全模拟"收到一条链接直接打开"：不点任何东西
    await page.goto(`${baseUrl}/?type=Task&q=sharable`)
    await page.waitForFunction(() => document.querySelectorAll('.card').length === 1, undefined, {
      timeout: 5000,
    })

    assert.equal(await page.locator('#searchInput').inputValue(), 'sharable')
    assert.match((await page.locator('.card').first().textContent()) ?? '', /sharable/)
  })

  it('切换类型会写进地址栏，后退键能回去', async () => {
    // 这条同时覆盖点击切换本身——openBoard 已经改成直接用 URL 导航
    await openBoard('Task')
    await page.click('.type-tab:text-is("Requirement")')
    await page.waitForFunction(
      () => document.querySelector('.type-tab[aria-selected="true"]')?.textContent === 'Requirement',
    )
    assert.equal(new URL(page.url()).searchParams.get('type'), 'Requirement')

    await page.goBack()
    // 等列真的重画完再断言：标签页是同步更新的，refresh() 是异步的，
    // 只等标签页会读到上一个类型的列——openBoard 当初就栽在这里
    await page.waitForFunction(
      () => document.querySelector('.column .column-head > span')?.textContent === 'Todo',
      undefined,
      { timeout: 5000 },
    )
    assert.deepEqual(await columnNames(), [
      'Todo', 'Doing', 'Review', 'Testing', 'Blocked', 'Done', 'Cancelled',
    ])
  })

  it('搜索不会在历史里堆一串记录', async () => {
    // 每敲一个字都 pushState 的话，后退键要按二十次才出得去
    await openBoard('Task')
    await page.fill('#searchInput', 'abc')
    await page.waitForFunction(() => new URL(location.href).searchParams.get('q') === 'abc', undefined, {
      timeout: 5000,
    })
    await page.fill('#searchInput', 'abcd')
    await page.waitForFunction(() => new URL(location.href).searchParams.get('q') === 'abcd', undefined, {
      timeout: 5000,
    })

    // 一次后退就该跳过中间那次输入。断言"不是 abc"而不是断言具体退到了哪儿——
    // 上一条历史是什么取决于前面的用例，钉死它只会让用例互相牵连
    await page.goBack()
    assert.notEqual(new URL(page.url()).searchParams.get('q'), 'abc')
  })

  it('URL 里写了不存在的类型时退回第一个，而不是留在空白看板', async () => {
    await page.goto(`${baseUrl}/?type=Wormhole`)
    await page.waitForSelector('.column')
    const selected = await page.locator('.type-tab[aria-selected="true"]').textContent()
    assert.ok(selected !== null && selected !== '')
  })
})

/**
 * 长度上限出现在表单上（docs/dogfooding-log.md #7）。
 *
 * 上限只在服务端拦住的话，用户会一直写下去、提交时才被拒，
 * 而在那之前他并不知道边界在哪。这条同时也是 ADR-0001 的检验：
 * 前端不自己写一份上限，而是照本体渲染。
 */
describe('表单上能看到长度上限', () => {
  it('输入框的 maxlength 来自本体，不是前端写死的', async () => {
    const catalogue = await app.inject({
      method: 'GET',
      url: '/v1/ontology/entity-types',
      headers: AUTH,
    })
    const expected = (
      catalogue.json().items as Array<{
        name: string
        attributes: Array<{ name: string; maxLength?: number }>
      }>
    )
      .find((t) => t.name === 'Task')
      ?.attributes.find((a) => a.name === 'description')?.maxLength

    await openBoard('Task')
    await page.click('#newBtn')
    await page.waitForSelector('#f_description')

    const actual = await page.locator('#f_description').getAttribute('maxlength')
    assert.equal(actual, String(expected))
    await page.click('#modalClose')
  })

  it('正文类字段把上限写在提示里', async () => {
    await openBoard('Task')
    await page.click('#newBtn')
    await page.waitForSelector('#f_description')
    const hint = await page.locator('[data-name="description"] .hint').textContent()
    assert.match(hint ?? '', /最多 [\d,]+ 字/)
    await page.click('#modalClose')
  })
})

/**
 * Dashboard（FR-DASH-005/006）。
 *
 * 要盯住的是两件事：**口径和数字一起显示**，以及**点开的明细与数字一致**。
 * 只断言"能显示一个数"没有价值——错的数字也是数字。
 */
describe('Dashboard', () => {
  it('每个指标都把口径显示在数字旁边', async () => {
    await page.goto(`${baseUrl}/?view=dashboard`)
    await page.waitForSelector('.metric-card')

    const cards = await page.locator('.metric-card').count()
    assert.ok(cards > 0, '一个指标都没有')
    // 没有口径的数字，两个人会读出两个意思
    assert.equal(await page.locator('.metric-definition').count(), cards)
  })

  it('点开一个数字，明细条数与它相同', async () => {
    for (const title of ['被阻塞的任务 A', '被阻塞的任务 B']) {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/resources',
        headers: { ...AUTH, 'content-type': 'application/json' },
        payload: {
          type: 'Task',
          workspace: 'ws_dash',
          attributes: { title, assignee: 'user://bob', blockReason: '等依赖' },
        },
      })
      const id = res.json().id
      for (const to of ['Doing', 'Blocked']) {
        await app.inject({
          method: 'POST',
          url: `/v1/resources/${id}/transitions`,
          headers: { ...AUTH, 'content-type': 'application/json' },
          payload: { to },
        })
      }
    }

    await page.goto(`${baseUrl}/?view=dashboard`)
    await page.waitForSelector('[data-metric="project.tasks.blocked"] .metric-value')

    const shown = Number(
      await page.locator('[data-metric="project.tasks.blocked"] .metric-value').textContent(),
    )
    assert.ok(shown >= 2, `期望至少 2，实际 ${shown}`)

    await page.click('[data-metric="project.tasks.blocked"] .metric-value')
    await page.waitForSelector('.drawer-body .rel-row')
    assert.equal(await page.locator('.drawer-body .rel-row').count(), shown)
  })

  it('Dashboard 视图有自己的 URL', async () => {
    await openBoard('Task')
    await page.click('.type-tab:text-is("Dashboard")')
    await page.waitForSelector('.metric-card')
    assert.equal(new URL(page.url()).searchParams.get('view'), 'dashboard')
  })
})
