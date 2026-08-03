# UI 测试

```bash
export TEST_ADMIN_DATABASE_URL="postgresql://postgres@127.0.0.1:5432/postgres"
pnpm test:ui
```

## 为什么不用 vitest

其余测试都跑在 vitest 上，UI 这一套用 Node 内置的 `node --test`。

原因很具体：**vitest 的 worker 池在驱动浏览器子进程时会卡在启动阶段**——
不报错、不超时，只是永远停在 `RUN` 那一行。同一段代码用 `node --test` 两秒跑完。
`pool: 'forks'` 也没能解决。

与其为此长期跟测试运行器较劲，不如让 UI 套件用一个更简单的运行器。
`node:test` + `node:assert` 是标准库，不引入新依赖，报告格式是 TAP。

`vitest.config.ts` 中排除了 `tests/ui/**`，两套互不干扰。

## 环境变量

| 变量 | 说明 |
| --- | --- |
| `TEST_ADMIN_DATABASE_URL` | 建库用的管理员连接 |
| `TEST_DB_NAME` | 测试库名，默认 `projectos_test` |
| `CHROMIUM_PATH` | Chromium 可执行文件路径；不设则用 Playwright 默认查找 |

## 这些用例在证明什么

只有一件事：**UI 里没有硬编码的业务语义**。

| 断言 | 数据来源 |
| --- | --- |
| 看板的列 | `GET /v1/workflows` 的状态机定义 |
| 卡片能做什么动作 | `GET /v1/resources/:id/transitions` |
| 新建表单有哪些字段 | `GET /v1/ontology/entity-types` |
| 哪些字段不该让人填 | 本体上的 `derived` 标记 |
| 必填校验的错误文案 | 服务端的本体校验 |
| 谁能看到哪些动作 | PDP |

改本体、改状态机、改权限，这些用例的期望值会跟着变——
**它们变了而前端代码不用变，正是要证明的东西**。
