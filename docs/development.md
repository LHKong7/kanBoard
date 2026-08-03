# 开发指南

## 环境要求

| 项 | 版本 |
| --- | --- |
| Node.js | 22 LTS+ |
| pnpm | 10+ |
| PostgreSQL | 16+ |

技术选型见 [ADR-0007](adr/0007-typescript-server-stack.md)。

## 起步

```bash
pnpm install

# 起一个本地 Postgres（任意方式），然后：
createdb projectos_dev
export DATABASE_URL="postgresql://postgres@127.0.0.1:5432/projectos_dev"

pnpm migrate     # 执行迁移
pnpm dev         # 启动，默认 :3000
```

## 常用命令

| 命令 | 作用 |
| --- | --- |
| `pnpm typecheck` | `tsc --strict`，零容忍 |
| `pnpm lint:layers` | 分层依赖方向校验（FR-ARCH-001） |
| `pnpm test` | 单元 + 集成测试 |
| `pnpm test:ui` | 看板 UI，真实浏览器（见 [tests/ui/README.md](../tests/ui/README.md)） |
| `pnpm check` | 上述全部，等同 CI |
| `pnpm migrate` | 执行未应用的迁移 |

进程角色（[ADR-0008](adr/0008-modular-monolith.md)）由 `PROJECTOS_ROLE` 控制：

| 值 | 行为 |
| --- | --- |
| `all`（默认） | API + poller 同进程，本地开发用 |
| `api` | 只起 HTTP，不消费 outbox |
| `poller` | 只消费 outbox，不监听端口 |

集成测试需要一个可连的 Postgres：

```bash
export TEST_ADMIN_DATABASE_URL="postgresql://postgres@127.0.0.1:5432/postgres"
pnpm test
```

测试会自建 `projectos_test` 库并**以非超级用户连接**——超级用户绕过 RLS，
用它跑测试等于把租户隔离的验证全部作废。

## 目录结构与分层

```
src/
├── platform/        纯工具：id / clock / errors。不依赖任何业务层
├── ontology/        本体元模型、注册表、本体 → Zod 校验器
├── workflow/        状态机引擎、守卫、自动化规则定义（纯层）
├── identity/        五层权限模型与 PDP（纯函数）
├── domain/          领域模型、端口（ports）、应用服务
├── infrastructure/  Postgres 适配器、迁移、outbox、审计
└── api/             Fastify 路由与 HTTP 边界校验
```

依赖方向自下而上，反向禁止：

```
platform → ontology → identity → workflow → domain → infrastructure → api
```

`pnpm lint:layers` 在 CI 中强制这条。最关键的一条是
**domain 层不得 import fastify / kysely / pg**——一旦破了，
所有关于"存储可替换"的说法都不成立。

## 几条不要绕过的约定

### 1. 新增领域对象先改本体，不要直接建表

```ts
// src/ontology/defaults.ts
{
  name: 'Sprint',
  version: '1.0.0',
  context: 'Execution',
  attributes: [{ name: 'goal', kind: 'text', required: true }],
}
```

注册完就能通过 `/v1/resources` 完成全生命周期操作，**不需要新增端点、表或权限规则**。
这是 [ADR-0002](adr/0002-unified-resource-model.md) 的收益兑现处。

### 2. 所有数据库访问都走 `withTenant`

```ts
await withTenant(db, tenant, async (trx) => { /* ... */ })
```

它在事务内 `SET LOCAL projectos.tenant`，RLS 据此过滤。
不走它的查询会因为租户上下文为空而返回空集——失败方式是"查不到"而不是"查到别人的"。

### 3. 新建表必须启用并强制 RLS

```sql
ALTER TABLE new_table ENABLE ROW LEVEL SECURITY;
ALTER TABLE new_table FORCE ROW LEVEL SECURITY;   -- 少了 FORCE，表 owner 就能绕过
CREATE POLICY tenant_isolation ON new_table
  USING (tenant = current_tenant()) WITH CHECK (tenant = current_tenant());
```

`tests/integration/tenant-isolation.test.ts` 里有一条用例会遍历所有表检查这两个开关。

### 4. 迁移一旦合并就不可修改

需要改动就新增一个迁移文件。已应用的迁移被改写会让不同环境的 schema 悄悄分叉。

### 5. 状态只能通过迁移端点修改

有生命周期的对象，`PATCH` 改 `status` 会被拒绝（409）。用：

```bash
POST /v1/resources/{id}/transitions   {"to": "Doing", "reason": "开工"}
GET  /v1/resources/{id}/transitions   # 当前可用迁移，含未就绪的与原因
```

留一个能绕过守卫的口子，守卫就只是建议。

### 6. UI 不硬编码业务语义

`public/` 是三个文件的原生页面，没有构建工具。它遵守一条规则：

| UI 上的东西 | 必须来自 |
| --- | --- |
| 看板的列 | `GET /v1/workflows` |
| 卡片能做什么动作 | `GET /v1/resources/:id/transitions` |
| 新建表单的字段 | `GET /v1/ontology/entity-types` |
| 哪些字段不让人填 | 本体属性上的 `derived` 标记 |

在前端写死状态名、动作列表或字段清单，等于把业务语义搬到了 UI 层
（违反 [ADR-0001](adr/0001-ontology-first.md) 的 P1.4）。
需要"某个字段不显示"时，改本体，不要改前端的 if。

### 7. 自动化不享有特权

自动化以 `system://internal` 身份调用和人**完全相同的** `transition()`。
它的权限刻意很窄（只能推进状态和读取），`*.Delete` 是显式 Deny。

### 8. 审计不写在业务事务里

授权被拒时业务事务会回滚。审计如果在同一个事务里，被拒绝的尝试就一起消失了——
而那恰恰是最需要留痕的。服务层把审计记录收集在内存，
由 API 层在业务事务结束后用独立事务落盘。

## 认证（M1 临时方案）

用请求头承载身份，OIDC / Agent Credential 尚未接入。
UI 右上角可以切换身份，用来观察权限过滤——那是 PDP 在起作用，不是界面在隐藏按钮。

| 头 | 说明 |
| --- | --- |
| `x-principal` | `user://alice` 或 `agent://coding@2.1.0` |
| `x-tenant` | 租户；v1 恒为 `default` |
| `x-roles` | 逗号分隔，如 `PM,Leader` |
| `x-capabilities` | 逗号分隔的直接授予能力 |
| `x-on-behalf-of` | 受限委派来源（Agent 代表用户执行） |
| `x-run-id` | 绑定的 AgentRun，用于临时授权失效判定 |
| `x-trace-id` | 全链路追踪 |

```bash
curl -X POST localhost:3000/v1/resources \
  -H 'content-type: application/json' \
  -H 'x-principal: user://alice' -H 'x-tenant: default' -H 'x-roles: PM' \
  -d '{"type":"Requirement","workspace":"ws1",
       "attributes":{"title":"t","level":"Feature","statement":"s"}}'
```

## 当前进度

- [M0 状态](m0-status.md)：地基层（本体、统一模型、权限、隔离）
- [M1 状态](m1-status.md)：工作流引擎、自动化、看板 UI
