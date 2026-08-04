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
| `pnpm lint:lockfile` | lockfile 与 package.json 一致（CI 的第一步） |
| `pnpm check` | 上述全部，等同 CI |
| `pnpm mutate` | 变异测试：往代码里种缺陷，看用例会不会红 |
| `pnpm migrate` | 执行未应用的迁移 |

### `pnpm mutate`：覆盖率答不了的那个问题

覆盖率回答"这行代码跑到了吗"，回答不了"**这行代码写错了会有人知道吗**"。
两个问题的答案经常不一样，而这个项目反复栽在后一个上：

- `actionableItems` 把同一个条件写了两遍、方向相反。改坏一处，覆盖率仍是
  100%、用例全绿——而调用方拿到的是一份少了一条的清单加一句"全都有负责人"。
- 阻塞原因的断言写成"含 CI 两个字"，于是把原因换成光秃秃的「CI 失败：」
  照样通过，而那对着手修的人一点用没有。
- `decide` 里一个永远不成立的分支——删掉它全部用例照样绿。

这三条都是被这个工具真的逮到的，不是假想的。

变异写在 `tools/mutations/*.json` 里，**是版本控制下的、可评审的东西**：
"这个模块保证了什么"于是有一份能读的清单，而不是散在某个人的记忆里。

    pnpm mutate                     # 全跑
    pnpm mutate migration-sync jira # 只跑这两份

活下来一条就非零退出。**活下来不代表要改代码**——它说明的是
"这个缺陷没人拦得住"，修法可能是补断言，也可能是删掉那段永远不执行的代码。

不进 `pnpm check`：每个变异要跑一遍完整用例，放进去的结果是有人加个
跳过参数，然后再没人跑。它属于"改完一个模块之后手动跑一次"的那一类。

### 迁移权限与运行权限要分开

建表要 DDL 权限，跑业务不要。两者用同一个连接串意味着 API 进程常驻着一个
能 `DROP TABLE` 的身份——RLS 的 `FORCE` 挡得住 owner 绕过读写，挡不住一次 DDL。

```bash
# 迁移用管理员，业务用只有 DML 权限的角色
export MIGRATE_DATABASE_URL="postgresql://postgres@127.0.0.1:5432/projectos_dev"
export DATABASE_URL="postgresql://projectos_dev_app@127.0.0.1:5432/projectos_dev"
```

| 变量 | 说明 |
| --- | --- |
| `MIGRATE_DATABASE_URL` | 迁移用的连接；不设则退回 `DATABASE_URL` |
| `PROJECTOS_SKIP_MIGRATE` | `true` 时启动不跑迁移，迁移由部署流水线单独执行 |
| `PROJECTOS_LIFECYCLE_TTL_MS` | 状态机定义的缓存有效期，默认 5000。写入进程立刻生效，其余进程最迟晚这么久 |

应用角色这样建（和 `tests/helpers/db.ts` 一致）：

```sql
CREATE ROLE projectos_dev_app LOGIN;              -- 无 SUPERUSER、无 BYPASSRLS
GRANT projectos_app TO projectos_dev_app;
GRANT USAGE ON SCHEMA public TO projectos_dev_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO projectos_dev_app;
```

进程角色（[ADR-0008](adr/0008-modular-monolith.md)）由 `PROJECTOS_ROLE` 控制：

| 值 | 行为 |
| --- | --- |
| `all`（默认） | API + poller + agent runner 同进程，本地开发用 |
| `api` | 只起 HTTP，不消费 outbox、不跑 Agent |
| `poller` | 只消费 outbox |

Agent Runner 另外要 `PROJECTOS_MODEL`：

| 值 | 行为 |
| --- | --- |
| `none`（默认） | **不启动 runner**。没有模型凭据时明确地什么都不做 |
| `scripted` | 用确定性模型跑通链路，不做真实推理 |

默认不启动是刻意的：退回到某个"看起来能跑"的假实现，会让线上安静地
产出一堆无意义的草稿——而草稿是会被人当真的。

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

文本类属性会按 `kind` 自动获得一个长度上限（`string` 1,024 / `text` 20,000 /
`richtext` 200,000 / `json` 100,000），需要另设时在属性上写 `maxLength` 覆盖。
它会随 `GET /v1/ontology/entity-types` 发给客户端——**上限是语义的一部分，
藏在校验器里等于逼每个客户端各猜一个数**（[自用日志 #7](dogfooding-log.md)）。

**收紧任何约束之前先跑一次**，别猜它是不是破坏性变更：

```bash
MIGRATE_DATABASE_URL=… node --experimental-strip-types tools/check-ontology-fit.ts
```

它用当前本体校验库里每一行，有越界就非零退出。规则见
[04-ontology §6](prd/04-ontology.md#6-本体版本与演进)。

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

### 6. `project` 与 contains 边由服务层保持一致，不要手工补

写了 `project` 字段，`create()` 就会建好 `Project --contains--> 对象` 这条边。
**不要自己再建一次**，也不要以为只写字段就够了。

这两者是同一个事实的两种存储。此前没有不变式约束，于是自用一轮之后
26 个对象声称属于某个项目、在图里却完全不可达，而系统一声没吭
（[自用日志 #6](dogfooding-log.md)）。指望调用方每次记得补边行不通——
写导入脚本的人就漏了一整类。

```ts
// 够了。边会被自动建好，事件也会发出
POST /v1/resources {"type":"Task","project":"prj_…","attributes":{…}}
```

三条相关约束：

- `project` 必须指向一个**活着的 Project**，否则 422。数据库层还有一个
  `NOT VALID` 外键兜底，和 `relations.from_id / to_id` 一直以来的做法一致。
- 本体不允许 Project 装下的类型会被**直接拒绝**，而不是"存字段但不建边"。
  要让 Project 装下新类型，改本体（见上面第 1 条），不要在服务里开特例。
- 重复建同一条边是幂等的，返回的是**库里那一条**（`created: false`），
  不会再发一次 `RelationCreated`。幂等的意思是"再来一次结果相同"，
  不是"假装刚刚创建了一条"。

### 7. 读用 GET，写和复杂查询用 POST

```bash
GET /v1/resources?type=Requirement&text=状态机&labels=WF&size=50
```

这条路径存在的唯一理由是**让视图有 URL**：分享、收藏、前进后退、HTTP 缓存，
少了它一样都做不到（[自用日志 #5](dogfooding-log.md)）。
"把搜索结果发给同事"是最基本的协作动作。

| | GET `/v1/resources` | POST `/v1/resources:query` |
| --- | --- | --- |
| 类型 / 工作区 / 项目 / 负责人 | ✅ | ✅ |
| 状态 / 标签 / 检索词 / 分页 | ✅ | ✅ |
| `attributes` 任意匹配 | ❌ | ✅ |
| 有 URL 可分享 | ✅ | ❌ |

两者调用**同一个** `service.query`，行为不会分叉。前端读数据一律走 GET——
自己都不用那条可分享的路径，加它就没有意义。

几个细节：

- 列表参数两种写法都收：`?labels=a&labels=b` 与 `?labels=a,b` 等价。
- **标签是"与"语义**（底层是数组包含 `@>`），不是"或"。容易想反。
- 查询串同样 `.strict()`：`?stauts=Done` 直接 400 并指名参数，
  不会静默忽略后返回全部结果。
- `includeDeleted` 是 `'true'|'false'` 枚举而不是布尔强转——
  `z.coerce.boolean()` 会把字符串 `"false"` 判为真。

### 8. 检索走服务端，不要在前端过滤

```bash
POST /v1/resources:query
{"type":"Requirement","filter":{"text":"状态机"},"page":{"size":50}}
```

匹配的是**标签与属性的值**，不含属性名——用 `attributes::text` 建索引会把
`title`、`level` 这些键名也带进去，于是搜 "title" 命中全表。
一个永远返回一切的搜索框比没有搜索框更糟。

三件要知道的事：

1. **用 trigram 而不是 `to_tsvector`**。语料中英混排，默认分词器不切中文，
   整段中文会变成一个 token。取舍与代价写在 `002_search.sql` 里。
2. **查询串短于 3 个字符时走另一条路**。抽不出三元组时规划器仍可能选 trigram 索引，
   而它会把整表当候选返回再逐行 recheck。100 万行实测 `状态`：带 `type` 过滤
   14.0ms → 0.4ms，不带 1259ms → 734ms。所以短查询改用 `strpos()` 避开该索引。
   中文两字词太常见，是换路径而不是拒绝。无 type/project 收窄的短查询仍然慢，会打 warn 日志。
3. **排序始终按 id 倒序，不按相关度**。游标分页依赖 id 的全序；
   换成相关度就得换一套游标方案，而"翻页会漏条目"比"排序不够聪明"严重得多。

前端不得在已加载的那一页里做过滤——那样搜到的永远只是"最近 200 条里的"，
而用户以为搜的是全部。`tests/ui/board.test.ts` 里有一条用例直接检查
请求体带没带 `filter.text`。

### 9. UI 不硬编码业务语义

`public/` 是三个文件的原生页面，没有构建工具。它遵守一条规则：

| UI 上的东西 | 必须来自 |
| --- | --- |
| 看板的列 | `GET /v1/workflows` |
| 卡片能做什么动作 | `GET /v1/resources/:id/transitions` |
| 新建表单的字段 | `GET /v1/ontology/entity-types` |
| 哪些字段不让人填 | 本体属性上的 `derived` 标记 |
| 建关系时能选哪些类型 | 本体的定义域（`domain`） |

在前端写死状态名、动作列表或字段清单，等于把业务语义搬到了 UI 层
（违反 [ADR-0001](adr/0001-ontology-first.md) 的 P1.4）。
需要"某个字段不显示"时，改本体，不要改前端的 if。

### 10. 自动化不享有特权

自动化以 `system://internal` 身份调用和人**完全相同的** `transition()`。
它的权限刻意很窄（只能推进状态和读取），`*.Delete` 是显式 Deny。

### 11. 审计不写在业务事务里

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
- [PRD 覆盖情况](prd-coverage.md)：102 条 Must 的交付进度，以及差得最远的两块
- [Agent 层状态](agent-status.md)：Agent Runtime、Run 轨迹、协作模式与预算
