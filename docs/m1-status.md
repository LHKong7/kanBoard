# M1 · Domain & Workflow 进度

| 项 | 值 |
| --- | --- |
| 更新时间 | 2026-08-06 |
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
| 20 套默认生命周期 | FR-WF-001 | `src/workflow/defaults.ts` |
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
| **评论 + @提及**：`Comment` 实体 + `commentsOn` 关系；提及经自动化规则发通知 | FR-WF-005 | `src/ontology/defaults.ts`、`src/domain/collaboration/mentions.ts` |
| **列表 / 表格视图**：表格的列由本体生成 | ADR-0001 | `public/app.js` |
| **筛选器**：状态选项来自状态机，条件进 URL 可分享 | FR-RES-016 | `public/app.js` |
| **导出 CSV / JSON**：与列表同一次 `service.query` | — | `src/api/export.ts` |
| **计划日期**：Task / Story 加 `startDate` / `dueDate`，与状态机写的实际时刻分开 | FR-ONT-007（minor 升级） | `src/ontology/defaults.ts` |
| **日历视图**：按计划完成日落格，未排期的单独列出 | — | `public/app.js` |
| **甘特视图**：按计划区间画条，**并画依赖线**（关系名从本体查） | — | `public/app.js` |
| **企业级对象**：Teamspace / Initiative / Template / Worklog / SavedView / Baseline | 对照 Plane 付费档 | `src/ontology/defaults.ts` |
| **工时审批**：单独的 `Worklog.Approve` capability + 不能批自己那条的 Deny | FR-IAM-002 | `src/workflow/defaults.ts`、`src/identity/default-policies.ts` |
| **React 企业版界面** | — | `web/`，构建到 `public/app/` |
| 身份切换，用于观察权限过滤 | — | 同上 |
| **就地编辑属性**：表单由本体生成，乐观锁冲突显式处理 | FR-RES-003/005 | 同上 |
| **管理关系**：建立（类型由本体定义域筛选）、删除、确认/否决 | FR-ONT-006 | `unrelate` / `confirmRelation` |

### 第四轮：项目管理骨架（对照 0806planeFeatures 两份文档）

| 交付项 | 实现位置 |
| --- | --- |
| **状态组**：六组（Triage/Backlog/Unstarted/Started/Completed/Cancelled）进状态机定义，22 台生命周期逐个标注 | `src/workflow/types.ts`、`defaults.ts` |
| **周期 × 模块两个正交维度**：周期互斥（`cardinality: '0..1'`）、模块多对多，由本体声明驱动 | `src/ontology/defaults.ts`、`ResourceService#displaceSingleValued` |
| **Module / Intake / Label / Sticky** 四类对象 + 两台状态机 | `src/ontology/defaults.ts`、`src/workflow/defaults.ts` |
| **自定义分析**：16 维 × 9 指标 × 二次分组 × 四档时间粒度，一条 SQL 算完 | `src/domain/analytics/`、`src/infrastructure/analytics-repository.pg.ts` |
| **燃尽图 + 周期进度**，关闭时冻结快照 | `src/domain/analytics/burndown.ts`、`snapshotCycleProgress` 自动化动作 |
| **七种图表原语 + 四种进度指示器**，三套配色 × 亮暗，全部手写内联 SVG | `web/src/charts/` |
| **归档**：与状态正交的独立维度，不消耗乐观锁版本 | 迁移 013、`ResourceService.setArchived` |
| **自动归档 / 自动关闭**巡检，按项目配置 | `src/infrastructure/archive-sweeper.pg.ts` |
| 工作项**优先级**、评论**对内 / 对外**、估点两种制式、`duplicates` / `relatesTo` 关系 | `src/ontology/defaults.ts` |

**测试**：1041 项 vitest + 109 项真实浏览器 UI 测试。

> 数字是**跑出来的**，不是记的。这份文档此前写着 135 + 21，
> 而那是好几轮改动之前的事——一个没人核过的数字比没有数字更糟，
> 因为它看起来经过了核对。

### 四条内置自动化规则

| 规则 | 行为 |
| --- | --- |
| `notify-mentioned-on-comment` | 评论里 @ 到谁 → 给他发一条站内通知 |
| `story-starts-when-first-task-starts` | 第一个子任务进入 Doing → Story 推进到 InProgress |
| `story-done-when-all-tasks-done` | **全部**子任务到终态 → Story 推进到 Done |
| `freeze-cycle-progress-on-close` | 周期关闭 → 把进度冻进 `progressSnapshot`，供回顾使用 |

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

### 编辑的价值不在"能改字段"，在"能自己满足守卫"

Story 推进到 Ready 要求存在 `decomposedInto` 关系。在补上关系管理之前，
这个守卫在界面上**永远满足不了**——用户只能去开 curl。
所以编辑功能的最小可用集不是"改属性"，是"改属性 + 建关系"。

可选的关系类型由**本体的定义域**筛出来：当前对象能做起点的关系才列出。
让用户从全部关系类型里挑、再被 422 打回来，等于把本体知识丢给用户去记。

### 并发冲突不静默覆盖

编辑时带上读到的版本号。若这期间他人改过，服务端返回 409，
UI **重新载入最新内容并说明发生了什么**，而不是自动重试。
自动重试等于让后写的人默默抹掉先写的人的修改——那是最坏的一种"成功"。

### 自动刷新避开正在编辑的表单

看板每 4 秒刷新一次以显示自动化联动。正在编辑时必须跳过：
表单被重新渲染，用户填了一半的内容就没了，而且看起来像是自己手滑。

### 状态组是所有统计的地基，所以它必填

指南把「自定义状态归错状态组」列为反模式，后果是"燃尽图、进度条、
所有统计全部失真"。所以 `group` 是 `StateDef` 上的**必填字段**，
不填就注册不进去。

做成可选并"猜一个默认值"的话，猜错不会报错——它只会让燃尽图
少烧掉一批工作项，而看图的人不会知道图是错的。
让定义状态的人当场回答一次，比让读指标的人事后怀疑一辈子便宜。

还有一条机器能查的规则：**终态必须归 Completed 或 Cancelled**。
一个终态被归进 Started 组，燃尽图就永远烧不到零，而图本身
看不出任何异常——它只是显示"还有 7 件事没做完"。
反过来不检查：`Decision.Accepted` 属于 Completed 组但**不是终态**
（决策做完了，但还可能被后来的决策取代），那是合法建模。

### 周期互斥、模块多对多 —— 判据来自本体，不是关系名

指南第一节的核心是这处不对称：一件事只能在一个时间盒里做，
但它可以同时服务于多个交付目标。

落点是 `ResourceService#displaceSingleValued`，而那里**没有一处
`'plannedIn'` 字面量**——它读的是本体上的 `cardinality`。
写死名字的话，下一个单值关系加进来时不会有任何报错，
只会安静地允许一个工作项挂在两个地方。

两个存储方向都要清：同一件事既可以存成 `Task ─plannedIn→ Sprint`，
也可以存成 `Sprint ─plans→ Task`（从周期那侧拖进来时就是后者）。
只清一个方向的话，一半的操作会绕过互斥。

### 归档是第三个维度，不是状态也不是删除

|  | 含义 | 指标怎么算 |
| --- | --- | --- |
| 删除 `deleted_at` | 东西没了 | 不出现 |
| 状态 `status` | 在流程的哪一步 | 参与 |
| 归档 `archived_at` | 还在、还算数，只是不在日常视图里 | **照常参与** |

做成状态的话，每台状态机都要加一个 `Archived`，而完成率的分母
会因此凭空变化。做成删除的话，"上个季度完成了多少件事"会随着
归档而变少。

它也**不消耗乐观锁的版本号**：归档一条别人正在编辑的工作项时，
对方的保存不该因此冲突——两个人改的根本不是同一件事。
为此加了一个只改归档标记的仓储方法，而不是复用 `update`。

### 分析下推到 SQL，不是拉回内存再分组

`countGrouped` 的注释里立过这条：把行拉回来在内存里数，
一个百万行的租户会把进程打死。分析这条路径上更严重——它还带二次分组，
而且没有分页。

所以 16 维 × 9 指标 × 二次分组是**一条 SQL**。代价是这条 SQL 不短，
收益是它的复杂度有上界：加一个维度是加一个 `CASE`，不是加一条新路径。

状态组的对照表由服务层从工作流注册表装配后**传进 SQL**（一个 `VALUES` 子句），
而且带上类型：`Accepted` 在 Decision 上是 Completed，在 Risk 上是
Cancelled（"接受这个风险，不再缓解"）。只按状态名映射的话，
这两者会被算成同一件事，而没有任何迹象。

### 按形状猜语义，形状迟早会撞车

这一轮抓到一个现成的例子。甘特图判断"该画哪条依赖线"用的判据是
**「自反且有逆关系」**——形状对了，含义没管。

本轮往本体里加了 `duplicates`（同样自反、同样有逆关系，而且在数组里
排得更靠前），于是依赖线**静默地改成画"重复"关系了**：
图还在，线还在，只是它说的不再是"A 做完 B 才能开始"。

`tests/ui/timeline.test.ts` 那条用例抓到了它。修法不是调整顺序，
而是把语义写进本体：`RelationTypeDef.blocking`。注册时还会拒绝
一个类型上出现两条 blocking 关系——否则界面又要在运行期挑一条，
而那正是这个标记要消灭的东西。

### 图表：颜色是算出来的，不是挑出来的

三套配色六组色值全部跑过六项检查（明度带、色度下限、CVD 相邻分离度、
常视力分离度、对比度）。两处因此与原文档不同，都记在
`web/src/charts/palette.ts` 里：

1. **每套 8 色而不是 10 色。** 第 9、10 个色相在相邻分离度上无解。
   超过 8 条序列时折叠成「其他」，不循环取色——循环取色的后果是
   第 9 条和第 1 条同色，读图的人会把它们当成同一件事。
2. **Earthen 的首色比原文档饱和。** 原文档给的 `#386641` 色度只有 0.077，
   低于 0.10 的下限，那个绿在图上会读成灰。低饱和是审美偏好，
   可辨识是功能要求；冲突时让路的是前者。

渲染出来看过：第一版的 Y 轴顶格算错（`max=34` 配上 `0/10/20/30` 的刻度），
最高的那条线被画到绘图区外面、压在标题上。**验算器只检查颜色，
布局要靠眼睛。**

### Poller 逐个租户消费，不绕过 RLS

给后台任务开 BYPASSRLS 是最省事的做法，也是 [ADR-0005](adr/0005-tenancy-model.md)
的保证被悄悄侵蚀的典型方式。poller 按租户开事务消费，隔离没有例外通道。

---

## 实现过程中发现并修正的问题

| 问题 | 后果 | 处理 |
| --- | --- | --- |
| DELETE 请求带了 `content-type: application/json` 却没有请求体 | Fastify 报 500「Body cannot be empty」，删除关系全线失败 | 只在真有 body 时才加 content-type。浏览器测试点删除点不动才发现 |
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
| ~~1~~ | ~~性能基线未标定~~ | — | ✅ 已完成，见 [性能基线](perf-baseline.md) |
| ~~2~~ | ~~UI 无编辑功能~~ | — | ✅ 已交付：属性编辑 + 关系管理 |
| ~~3~~ | ~~没有搜索~~ | — | ✅ 已交付：`filter.text`（FR-RES-016）+ trigram 索引 + UI 搜索框，见[自用日志 #3](dogfooding-log.md) |
| ~~4~~ | ~~图可以不完整而系统不出声~~ | — | ✅ 已交付：`create()` 维持 project↔contains 不变式 + 外键 + 迁移 003 回填，见[自用日志 #6](dogfooding-log.md) |
| ~~5~~ | ~~读路径只有 `POST :query`~~ | — | ✅ 已交付：`GET /v1/resources` + UI 视图状态进地址栏，见[自用日志 #5](dogfooding-log.md) |
| ~~6~~ | ~~文本属性的长度上限只能靠猜~~ | — | ✅ 已交付：`maxLength` 进本体并随类型定义发布 + `check-ontology-fit`，见[自用日志 #7](dogfooding-log.md) |
| 7 | 状态机只能改代码，无配置 API | FR-WF-001 要求"改定义即时生效" | M1 内 |
| 8 | SLA 超时动作未实现 | 定义已支持，poller 尚未巡检 | FR-WF-013 |
| 9 | 7 个限界上下文的聚合与不变量未拆 | FR-DOM-001 | M1 核心 |
| 10 | 按 BC 重组目录 | ADR-0008 | M1 |
| 11 | 认证仍是请求头方案 | 生产不可用 | M1 |
| 12 | 无图视图、无 Dashboard | FR-DASH-* 未开始 | M1 内 |

第 4–6 项来自第一次真实自用，完整记录见[自用日志](dogfooding-log.md)。
第一轮自用记下的 9 条**已全部处理完**：长度上限不可发现、读路径没有 URL、没有搜索、图可以静默不完整（及其牵出的
悬空 project 引用、重复建边返回假 id）、接口静默吞掉写错的字段、
自动化停滞无痕迹、以非特权角色启动起不来、一个 UI 用例偶发性失败。

关系目标选择器仍只列每种类型最近 50 条——检索能力已经有了，
把选择器接上去是下一步的小改动。
