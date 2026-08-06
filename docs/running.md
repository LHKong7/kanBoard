# 怎么把这个项目跑起来

从零到能在浏览器里点，五步。

**这份文档里每条命令和每段输出都是实跑出来的**，不是照着代码推的。
凭记忆写的运行文档最典型的失败是"少了一步"——而少的那一步通常是
写文档的人机器上早就做过了，所以他不记得。

---

## 0. 需要什么

| 项 | 版本 | 怎么确认 |
| --- | --- | --- |
| Node.js | **22 LTS+** | `node -v` |
| pnpm | **10+** | `pnpm -v` |
| PostgreSQL | **16+** | `psql --version` |

Node 必须是 22：这个项目**直接跑 TypeScript 源码**
（`node --experimental-strip-types`），没有编译产物这一步。

---

## 1. 装依赖

```bash
pnpm install
```

## 2. 建库并迁移

```bash
createdb projectos_dev
export DATABASE_URL="postgresql://postgres@127.0.0.1:5432/projectos_dev"

pnpm migrate
```

跑通的样子：

```
applied: 001_foundation.sql, 002_search.sql, 003_project_containment.sql,
004_agent_runs.sql, 005_connector_calls.sql, 006_lifecycles.sql, 007_sla.sql,
008_audit_append_only.sql, 009_agent_memory.sql, 010_relation_rules.sql,
011_ontology_extensions.sql, 012_process_runs.sql, 013_archive.sql
```

再跑一次是**幂等**的，会输出 `already up to date`。

> 迁移要建表，所以这个连接串需要 DDL 权限。生产上迁移和业务应该用
> **两个不同的角色**，见 [development.md](development.md#迁移权限与运行权限要分开)。

## 3. 构建前端

```bash
pnpm build:web
```

**这一步不能跳。** 企业版界面（`/app`）是 React 构建产物，没构建时
访问它是 **HTTP 500**——不是 404，因为路由注册了但文件读不到：

```
未构建 /app  -> 500
看板 /       -> 200      # 看板是原生 JS，不需要构建，一直能开
构建后 /app  -> 200
```

看板那一套（`/`）是手写的原生 JS，不经过构建，所以只想看看板可以跳过这步。

## 4. 启动

```bash
pnpm start        # 或 pnpm dev（带 --watch，改了源码自动重启）
```

启动日志会**把当前配置全说出来**，照着读就知道什么开着、什么没开：

```
migrations skipped (PROJECTOS_SKIP_MIGRATE=true)
agent runner disabled: no model configured (set PROJECTOS_MODEL=pi with PROJECTOS_AI_PROVIDERS, or =scripted for a dry run)
ProjectOS listening on :3000 (tenant=default, role=all)
outbox poller started (3 automation rules)
sla sweeper started (every 60s)
ontology health sweep started (every 24h)
process timeout sweep started (every 60s)
```

第二行是有意的：**没配模型时 Agent Runner 不启动**，并且说清楚怎么打开。
详见下面第 7 节。

## 5. 打开

| 地址 | 是什么 |
| --- | --- |
| <http://localhost:3000/> | **看板**：看板 / 列表 / 表格 / 日历 / 甘特、Dashboard、关系图、流程编辑器、巡检、问答 |
| <http://localhost:3000/app> | **企业版**（React）：举措、团队空间、工时、模板、保存的视图、基线 |
| <http://localhost:3000/health> | 健康检查，返回 `{"status":"ok"}` |

两边顶栏各有一个互相跳转的入口，不用记地址。

---

## 6. 关于身份——**上线前必读** ⛔

这个系统现在的身份**由请求头承载**：

```bash
curl -X POST http://localhost:3000/v1/resources \
  -H 'content-type: application/json' \
  -H 'x-principal: user://alice' \
  -H 'x-tenant: default' \
  -H 'x-roles: Admin' \
  -H 'x-capabilities:' \
  -d '{"type":"Task","workspace":"ws_platform","attributes":{"title":"第一个任务"}}'
```

不带这些头就是 **401**：

```
缺身份头 -> 401
```

界面上的身份存在 `localStorage` 的 `projectos.identity` 里，
两个前端共用同一个键；看板右上角可以切换，企业版顶栏可以切角色，
**用来观察权限过滤的效果**（切成 Guest 就会看到按钮消失、创建被拒）。

> ### 这意味着什么
>
> **任何人手写一个 `x-roles: Admin` 就是管理员。**
> 五层权限模型、PDP、Deny 策略、租户 RLS 全都建在这个头上。
>
> 所以：**可以本地跑、可以内网演示，不要放到公网上。**
> 真实认证（OIDC）还没接——这是当前最优先的一条缺口，
> 见 [research/plane-vs-projectos.md](research/plane-vs-projectos.md) 第一节。

---

## 7. 可选：让 Agent 真的跑起来

默认不启动。想接真实模型：

```bash
export PROJECTOS_MODEL=pi
export PROJECTOS_AI_PROVIDERS=anthropic     # 已批准的供应商白名单
export ANTHROPIC_API_KEY=sk-...
pnpm start
```

只想验证链路通不通、不花钱：

```bash
export PROJECTOS_MODEL=scripted             # 确定性回复，不出网
```

三件事会让进程**起不来**而不是带病运行：路由指向白名单外的供应商、
模型 id 不存在、该供应商没有凭据。完整说明见
[development.md 的「接真实模型」](development.md#接真实模型)。

发起一次 Agent 执行**不需要专用接口**——建一个 `AgentRun` 资源即可：

```bash
curl -X POST http://localhost:3000/v1/resources -H 'content-type: application/json' \
  -H 'x-principal: user://alice' -H 'x-tenant: default' -H 'x-roles: Admin' -H 'x-capabilities:' \
  -d '{"type":"AgentRun","workspace":"ws_platform","attributes":{
        "goal":"把这条需求拆成 Story","agent":"<agent 的 id>",
        "mode":"Draft","trigger":"human"}}'
```

---

## 8. 出错了怎么办

按**实际会撞上的顺序**排：

| 现象 | 原因 | 怎么办 |
| --- | --- | --- |
| `/app` 返回 **500**，`/` 正常 | 前端没构建 | `pnpm build:web` |
| 启动或迁移报 `connect ECONNREFUSED` + 一段 Node 栈 | Postgres 没起来，或端口不对 | 确认 `pg_isready`，核对 `DATABASE_URL` 的端口 |
| `DATABASE_URL is not set` | 环境变量没导出 | `export DATABASE_URL=…` |
| 任何 `/v1/*` 返回 **401** | 没带身份头 | 见第 6 节的四个头 |
| **403** `subject … lacks capability "Task.Create"` | 当前角色没这个能力 | 换个角色，或看 `src/identity/pdp.ts` 的角色能力表 |
| **409** `Task cannot enter "Doing": attribute "assignee" must be set` | 状态机守卫没满足 | 报错**直接写了缺什么**，照着补即可 |
| **409** `status of Task is governed by lifecycle "task-default"; use the transition endpoint instead of a direct update` | 拿 PATCH 直接改 `status` | 用 `POST /v1/resources/:id/transitions` |
| 浏览器用例起不来，提示 Chromium 版本对不上 | 本机 Playwright 与浏览器不匹配 | `CHROMIUM_PATH=/path/to/chrome pnpm test:ui` |

---

## 9. 跑测试

```bash
# 集成测试要一个可连的 Postgres（会自建 projectos_test 库）
export TEST_ADMIN_DATABASE_URL="postgresql://postgres@127.0.0.1:5432/postgres"

pnpm test        # 984 项：单元 + 集成，带覆盖率门槛
pnpm test:ui     # 95 项：真实浏览器（会先自动构建前端）
pnpm check       # 上面全部 + 类型检查 + 分层校验，等同 CI
```

测试**以非超级用户连接**——超级用户会绕过 RLS，用它跑测试等于把
租户隔离的验证全部作废。

---

## 10. 部署时的三种进程角色

同一份代码，靠 `PROJECTOS_ROLE` 决定这个进程干什么
（[ADR-0008](adr/0008-modular-monolith.md)）：

| 值 | 行为 | 用在哪 |
| --- | --- | --- |
| `all`（默认） | API + poller + agent runner 同进程 | 本地开发 |
| `api` | 只起 HTTP | 生产：后台积压不影响请求时延 |
| `poller` | 只消费 outbox、跑巡检 | 生产：可独立扩容 |

生产上还应该：`PROJECTOS_SKIP_MIGRATE=true`（迁移交给部署流水线单独跑），
以及迁移与业务用两个不同的数据库角色。

---

## 常用环境变量一览

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `DATABASE_URL` | —（必填） | 业务连接串 |
| `MIGRATE_DATABASE_URL` | 同 `DATABASE_URL` | 迁移用；生产上应是有 DDL 权限的另一个角色 |
| `PORT` | `3000` | HTTP 端口 |
| `PROJECTOS_TENANT` | `default` | v1 单租户（[ADR-0005](adr/0005-tenancy-model.md)） |
| `PROJECTOS_ROLE` | `all` | 进程角色，见第 10 节 |
| `PROJECTOS_SKIP_MIGRATE` | `false` | `true` 时启动不跑迁移 |
| `PROJECTOS_MODEL` | `none` | `none` / `scripted` / `pi` |
| `PROJECTOS_AI_PROVIDERS` | 空 | 已批准的模型供应商。**空 = 一个都没批准** |
| `PROJECTOS_AI_MAX_CLASSIFICATION` | `confidential` | 允许出境的最高数据分级 |
| `PROJECTOS_MODEL_TIER_LOW/MID/HIGH` | Anthropic 三档 | 形如 `anthropic/claude-opus-5` |
| `PROJECTOS_SLA_SWEEP_MS` | `60000` | SLA 巡检间隔，`0` 关闭 |
| `PROJECTOS_ARCHIVE_SWEEP_MS` | `3600000` | 自动归档 / 自动关闭巡检间隔，`0` 关闭。项目没配 `archiveInMonths` / `closeInMonths` 时它什么都不做 |
| `PROJECTOS_HEALTH_SWEEP_MS` | 24 小时 | 本体一致性巡检间隔，`0` 关闭 |
| `PROJECTOS_PROCESS_SWEEP_MS` | `60000` | 流程超时巡检间隔，`0` 关闭 |
| `PROJECTOS_LIFECYCLE_TTL_MS` | `5000` | 状态机定义缓存有效期 |
| `TEST_ADMIN_DATABASE_URL` | `…:55432/postgres` | 仅测试用 |
| `CHROMIUM_PATH` | 空 | 仅浏览器用例用，指定 Chromium 可执行文件 |

关掉巡检是**显式的选择**：启动日志会打印它在不在跑——
一个悄悄没起来的巡检，表现出来和"一切正常"一模一样。
