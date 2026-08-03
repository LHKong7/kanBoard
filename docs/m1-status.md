# M1 · Domain & Workflow 进度

| 项 | 值 |
| --- | --- |
| 更新时间 | 2026-08-03 |
| 状态 | 进行中 |

M0 交付的是地基，没有任何面向用户的功能。M1 开始产出可用的东西。

---

## 已交付

| 交付项 | 关联需求 | 实现位置 |
| --- | --- | --- |
| 工作流引擎：可配置状态机 | FR-WF-001 | `src/workflow/engine.ts` |
| 守卫求值，失败返回具体缺什么 | FR-WF-002/003 | `src/workflow/guards.ts` |
| 迁移所需 Capability 由迁移定义决定 | FR-WF-002/004 | `resolveTransition` |
| 进入状态的 entry action（时间戳、清字段） | FR-WF-002 | `applyActions` |
| 7 套默认生命周期 | FR-WF-001 | `src/workflow/defaults.ts` |
| `POST /v1/resources/:id/transitions` | FR-WF-002 | `src/api/server.ts` |
| `GET /v1/resources/:id/transitions`，按权限过滤 | FR-RES-008 | `ResourceService.transitionsOf` |
| 状态只能经迁移端点修改 | FR-WF-002 | `ResourceService.update` 拒绝直改 |
| 自动化规则引擎 when/if/then | FR-WF-005 | `src/workflow/automation.ts` |
| Outbox poller（第二种进程角色） | FR-WF-005/006 | `src/infrastructure/poller.ts` |
| 触发链深度上限防环 | FR-WF-008 | `AutomationRunner` |
| 自动化执行留痕（含失败） | FR-WF-009 | `AutomationOutcome` |
| 逆关系在查询与遍历中真正等价 | FR-ONT-003 | `ResourceService.relationsOf` / `traverse` |
| **看板 UI**：列由状态机驱动，表单由本体生成 | ADR-0011 的必需项 | `public/` |
| 详情抽屉：可用迁移（含未就绪原因）、属性、关系、变更历史 | FR-RES-008 | `public/app.js` |
| 身份切换，用于观察权限过滤 | — | 同上 |

**测试**：127 项 vitest + 14 项真实浏览器 UI 测试。

### 两条内置自动化规则

| 规则 | 行为 |
| --- | --- |
| `story-starts-when-first-task-starts` | 第一个子任务进入 Doing → Story 推进到 InProgress |
| `story-done-when-all-tasks-done` | **全部**子任务到终态 → Story 推进到 Done |

规则集应当长得很慢：每条自动化都是一次"系统替我做了决定"，
多到看不懂时用户就不再信任系统的任何自动行为。

---

## 设计要点

### 状态不能绕过状态机修改

`PATCH /v1/resources/:id` 修改有生命周期对象的 `status` 会被拒绝（409）。
留一个能绕过守卫的口子，守卫就只是建议。

### 自动化不享有特权

自动化以 `system://internal` 身份调用**和人完全相同的** `transition()`，
因此守卫、权限、审计、事件一个都不少。它的权限刻意很窄：
只能推进状态和读取，`*.Delete` 是一条显式 Deny——
自动化以机器速度铺开错误，删除必须由人决定。

### 跨上下文的规则归订阅方所有

"Task 完成后推进 Story" 属于 **Requirement BC**（它拥有 Story），
不属于 Execution BC（它只是发出了事件）。原则 P2.1 禁止跨上下文维护状态。
`AutomationRule.owningContext` 记录归属，[ADR-0008](adr/0008-modular-monolith.md)
要求 M1 按 BC 重组模块时规则跟着搬。

### UI 里没有硬编码的业务语义

| UI 上的东西 | 数据来源 |
| --- | --- |
| 看板的列 | `GET /v1/workflows` |
| 卡片能做什么 | `GET /v1/resources/:id/transitions` |
| 新建表单的字段 | `GET /v1/ontology/entity-types` |
| 哪些字段不让人填 | 本体上的 `derived` 标记 |

给 Task 加一个属性、给状态机加一个状态，**前端一行都不用改**。
这是 [ADR-0001](adr/0001-ontology-first.md)「UI 是本体的渲染视图」落到实处的地方。

未就绪的迁移也会列出来并说明差什么。只显示能点的会让用户以为"就这些了"，
而不知道下一步需要先做什么。

### Poller 逐个租户消费，不绕过 RLS

给后台任务开 BYPASSRLS 是最省事的做法，也是 [ADR-0005](adr/0005-tenancy-model.md)
的保证被悄悄侵蚀的典型方式。poller 按租户开事务消费，隔离没有例外通道。

---

## 实现过程中发现并修正的问题

| 问题 | 后果 | 处理 |
| --- | --- | --- |
| 抽屉从屏幕顶端开始，盖住了顶栏 | 打开详情后就点不到「新建」和身份切换 | 抽屉改为从顶栏下方开始。这条是浏览器测试点不到按钮才发现的 |
| **逆关系只是本体里的声明，查询时并不生效** | 边存为 `decomposedInto`，从另一头查 `partOf` 什么都查不到。依赖它的自动化规则**静默地什么都不做**——不报错，只是没反应 | 服务层在查询与遍历时解析逆关系，并把结果翻转成请求方向。已加回归测试 |
| 状态机的 entry action 想写本体未声明的字段 | `startedAt` 等会绕过本体校验落库 | 补进本体（按 04-ontology 的兼容矩阵递增 minor 到 1.1.0），而不是让副作用绕过校验 |
| Poller 事务未设租户，RLS 挡住了它 | 一条事件都消费不到 | 改为逐租户消费。**没有**给它 BYPASSRLS |

第一条值得记住：它不是崩溃，是**静默失效**。本体声明了逆关系、
测试也验过"正反向查询"，但那条测试查的是同名的 out/in，没查逆名。
一个只在真实功能上才暴露的缺口。

---

## 未完成

| # | 项 | 影响 | 计划 |
| --- | --- | --- | --- |
| 1 | 性能基线仍未标定（M0 遗留） | M0 出口标准两条未验证 | 待补 |
| 2 | UI 只有看板与详情：无搜索、无图视图、无 Dashboard | 日常够用，但 FR-DASH-* 未开始 | M1 内 |
| 3 | UI 无编辑功能：改属性只能走 API | 自用时会立刻别扭 | 下一步 |
| 3 | 状态机只能改代码，无配置 API | FR-WF-001 要求"改定义即时生效" | M1 内 |
| 4 | SLA 超时动作未实现 | 定义已支持，poller 尚未巡检 | FR-WF-013 |
| 5 | 7 个限界上下文的聚合与不变量未拆 | FR-DOM-001 | M1 核心 |
| 6 | 按 BC 重组目录 | ADR-0008 | M1 |
| 7 | 认证仍是请求头方案 | 生产不可用 | M1 |
