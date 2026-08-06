# Plane 与 ProjectOS 的功能差距

配套 [plane-features.md](plane-features.md)。那份盘的是 Plane 有什么，这份回答
**差在哪、差多少、以及哪些差距是结构性的**。

## 口径

| 项 | Plane | ProjectOS |
| --- | --- | --- |
| 锚点 | commit `31853ab`（2026-08-05） | 本仓 `docs/prd-coverage.md` / `m1-status.md` |
| 阶段 | 成熟商业产品的开源版 | M1 进行中 |
| 形态 | 6 应用 + 15 包 | 单体：`src/` 后端 + `public/` 原生看板 + `web/` React 企业版 |

**只比开源版对开源版**：Plane 的付费功能（仪表盘、Wiki、Teamspaces、工时、
审批流、模板）不计入，否则差距会被算大一倍。

两边都不吹：下面每条都能在代码里核到。

---

## 一句话

**ProjectOS 在"系统怎么被建模、被授权、被 Agent 参与"上明显更深；
Plane 在"人怎么每天用它干活"上全面领先。**

差距不是均匀的。Plane 领先的那些，**大部分是补得上的体力活**；
ProjectOS 领先的那些，Plane 要补得动地基。但有一条例外——认证——
它不是体力活，是**现在挡着 ProjectOS 不能给真人用**的那道门。

---

## 一、Plane 领先的地方

按"挡不挡路"排序，不按功能大小。

### 1. 认证：ProjectOS 现在等于没有 ⛔

这是最要紧的一条，所以放第一。

ProjectOS 的身份**由请求头承载**（`src/api/auth.ts`）：

```
x-principal: user://alice
x-tenant: default
x-roles: Admin
x-capabilities: ...
```

文件顶上的注释写得很清楚：*"M0 用请求头承载身份，真实的 OIDC / Agent
Credential 在 M1 接入"*——**M1 还没接**。也就是说任何人手写一个
`x-roles: Admin` 就是管理员。五层权限模型、PDP、Deny 策略、租户 RLS
全都建在一个**任人自称**的身份上。

Plane 那边：邮箱密码、魔法链接、Google / GitHub / GitLab / Gitea OAuth，
外加实例级管理后台配置这些。

> 这条不补，后面所有功能都不能给真人用。它也是唯一一条
> **"差距大小"不重要、"有没有"才重要**的。

### 2. 协作层：几乎为零

> **这一节已部分过时。** 评论与 @提及已经补上（见文末「后续进展」），
> 下表保留原始判断并标出现状。附件、外链、订阅、实时协同仍然没有。

写这份对比时，在 ProjectOS 的本体里 grep `comment` / `attachment` /
`mention`——**命中 0 次**。也就是说：

| 能力 | Plane | ProjectOS |
| --- | --- | --- |
| 评论 | ✅ 含表情回应 | ✅ `Comment` 实体 + `commentsOn` 关系 |
| 附件 | ✅ | ❌ |
| @提及 | ✅ 联动通知 | ✅ 服务端解析正文，经自动化规则发通知 |
| 外链 | ✅ | ❌ |
| 订阅/关注 | ✅ | ❌ |
| 实时协同编辑 | ✅ 独立服务（Yjs） | ❌ |
| 活动流 | ✅ | 有**字段级变更历史**（更细），但没有人读得到的活动流 |

ProjectOS 有一份比 Plane 更严谨的 `resource_history`（带委派人和原因），
但那是审计口径，不是协作口径。**一个团队没法在一个不能评论的工具里协作。**

### 3. 工作项视图：1 种 vs 5 种

| | Plane | ProjectOS |
| --- | --- | --- |
| 看板 Kanban | ✅ 任意维度分组 | ✅ 但**只能按状态分列** |
| 列表 List | ✅ | ✅ |
| 表格 Spreadsheet | ✅ | ✅ 列由本体生成 |
| 日历 Calendar | ✅ | ✅ |
| 甘特 Gantt | ✅（**不画**依赖线） | ✅ **画依赖线** |

ProjectOS 的看板列**由状态机驱动**（换类型换列，终态自动标出），
这一点比 Plane 的写死列更干净——但**只有这一种看法**。
没有列表就没法快速扫，没有表格就没法批量看属性，没有日历和甘特
就完全没有时间轴。

> **五种看法已经补齐**（见文末「后续进展」），且甘特这一格**反超**：
> Plane 开源版有 `enableDependency` 开关却没有任何画线的代码，
> ProjectOS 把本体里已有的阻塞关系画了出来。

顺带：**看板上没有筛选器**。`public/app.js` 里 18 处 `filter` 全是
JS 数组方法，唯二面向用户的筛选是"建关系时筛候选对象"和健康巡检视图的
问题筛选——工作项本身只能全文搜索。Plane 那边是一整套筛选 + 显示属性 +
可保存视图（项目级和工作区级两层）。

> **列表、表格、筛选器都已补上**（见文末「后续进展」）。
> 可保存视图仍然没有。

### 4. 文档

Plane 的 Page 是完整的富文本文档：实时协同、版本历史、标签、
可挂多个项目。

ProjectOS 有 `Knowledge` 实体（title / body / confidence / validUntil），
**但没有编辑器**——body 是个表单里的文本域。知识的**语义**做得比 Plane 深
（有置信度、有效期、`distills` / `evidencedBy` 关系、还进检索问答），
但作为"写东西的地方"完全不可用。

> **导出已补上**（CSV / JSON）。下表其余各条仍然成立。

### 5. 其余成规模的缺口

| 能力 | Plane | ProjectOS |
| --- | --- | --- |
| 对外公开分享 | ✅ 独立 `space` 应用，外部人可看/评论/投票 | ❌ |
| 邮件通知 | ✅ + 偏好设置 | ❌ 有 `Notification` 实体和 SLA 通知端口，没有邮件通道 |
| 国际化 | ✅ 19 种语言 | ❌ 中文硬编码 |
| 数据导出 | ✅ CSV / JSON / XLSX | ✅ CSV / JSON（无 XLSX） |
| 归档 | ✅ 工作项/周期/模块 | ⚠️ 只有 Knowledge 生命周期上的 `Archived` 终态，没有通用归档 |
| 命令面板 | ✅ | ❌ |
| 收藏 / 最近访问 | ✅ | ❌ |
| 草稿 | ✅ 独立模型 | ❌ |
| 便签 | ✅ | ❌ |
| 移动端适配 | ✅ | ❌ |
| Webhook | ✅ + 调用日志 | ❌ 有 outbox，没有对外 webhook |
| API Token | ✅ + 调用留痕 | ❌ |

---

## 二、ProjectOS 领先的地方

这些不是"功能多一个"，是**地基不一样**。

### 1. 本体可配置 vs 模型写死

Plane 的对象模型是 Django 模型类——加一个字段要改代码、写迁移、发版。
它的"自定义"只到 `IssueType` 和标签。

ProjectOS 的本体是**元模型**：25 类实体、38 类关系都是数据
（`src/ontology/defaults.ts`，注册表实测），且有

- 租户扩展（`ontology_extensions` 表，租户自己加类型和属性）
- 关系规则可配置（`relation_rules`）
- 版本化与兼容性投影（FR-ONT-007）
- **一致性巡检**（孤儿、断链、环，每日报告）
- 本体 → Zod 校验器自动生成

Plane 里没有任何一样对应物。

### 2. Agent 是一等公民 vs 编辑器里的一个按钮

这是两个产品最根本的差异。

Plane CE 的 AI 只有一个：编辑器里的 `ASK_ANYTHING`。

ProjectOS 的 Agent 是**领域对象**，有：

| 能力 | 在哪 |
| --- | --- |
| 独立身份 `agent://`，审计记在 Agent 头上 | FR-AGT-003 |
| 上下文从图上装配，**每段带出处** | FR-AGT-004 |
| Run 轨迹逐步可回放 | FR-AGT-007 |
| 四种协作模式（Suggest/Draft/ExecuteWithReview/Autonomous） | FR-AGT-009 |
| 预算熔断（token / 成本 / 步数） | FR-AGT-012 |
| 影响面上限 blastRadius | FR-IAM-012 |
| 出境控制 + 提示注入中和 | FR-AI-012/013/014 |
| 不可逆操作强制人工（配不掉的 Deny） | FR-AGT-010 |
| 分级模型路由，供应商可插拔（底座 pi） | FR-AGT-013 |
| 成本与 token 结算到 Run | FR-AGT-014（部分） |

**Plane 要长出这一套，等于重做一遍权限和审计。**

### 3. 权限模型

| | Plane | ProjectOS |
| --- | --- | --- |
| 模型 | 工作区/项目两层成员角色 | **五层 PDP**，默认拒绝 |
| 细粒度 | 角色枚举 | Capability（`Story.Create` 这种） |
| 兜底 | — | **配不掉的 Deny 策略** |
| 临时授权 | — | ✅ 绑 Run 失效 |
| 委派 | — | ✅ 变更历史里记委派人 |
| 租户隔离 | 应用层 | **Postgres RLS + FORCE**，测试以非超级用户跑 |

### 4. 工作流引擎

Plane：状态分组固定六类，自动化只有两条（N 个月自动归档 / 自动关闭）。

ProjectOS：

- 可配置状态机，**热加载**（库里的定义覆盖内置）
- 守卫求值，失败**返回具体差什么**（UI 上直接显示"未就绪，因为缺 assignee"）
- 进入状态的 entry action
- 自动化规则 when/if/then + 触发链深度上限防环 + 执行留痕
- **多步骤流程编排**，带失败补偿（`src/domain/orchestration/`）
- 状态**只能经迁移端点改**，PATCH 直改会被拒

### 5. 可追溯性

- 字段级变更历史，含委派人与原因
- 审计日志**追加写**（`REVOKE UPDATE, DELETE` + 触发器）
- Agent 上下文每段带出处，出处清单进 Run 轨迹
- 带出处的检索问答（`/v1/search:answer`）

### 6. 指标

ProjectOS 有 **30 个指标**（`src/domain/dashboard/metrics.ts`），
包括 Plane CE 完全没有的一类：

> Agent 成本、Token 消耗、Run 成功率、**产出采纳率**、Run 平均时延、
> **Human vs Agent 产出占比**

传统项目指标也齐：Burn Down、Velocity、Cycle Time、Lead Time、WIP、
Capacity、Review Time、Milestone 按期率、Scope Change。

Plane CE 有 Analytics（工作区级 + 项目级 + 可保存视图 + 导出），
覆盖面不如这 30 个，但**可保存和可导出这两点 ProjectOS 没有**。

### 7. 迁移路径

Plane 的 Jira 导入是**一次性**的（`Importer.service`）。

ProjectOS 的迁移是**三阶段**的（`src/domain/migration/sync.ts`）：
`mirror`（只读镜像）→ `parallel`（双写）→ `cutover`（切换），
每阶段允许的同步方向不同，还有演练报告。这是为"从 Jira 搬家而不停机"
设计的，比一次性导入认真得多。

---

## 三、逐项对照

✅ 有 · ⚠️ 部分 · ❌ 无 · 💰 Plane 要付费才有

| | Plane | ProjectOS |
| --- | :---: | :---: |
| **认证与账号** | ✅ | ⛔ 请求头身份 |
| 评论 / @提及 | ✅ | ✅ |
| 附件 | ✅ | ❌ |
| 实时协同编辑 | ✅ | ❌ |
| 看板 | ✅ | ⚠️ 仅按状态分列 |
| 列表 / 表格 | ✅ | ✅ |
| 日历 | ✅ | ✅ |
| 甘特 | ⚠️ 不画依赖线 | ✅ 画依赖线 |
| 筛选器 | ✅ | ✅ 状态 + 负责人，条件进 URL |
| 可保存视图 | ✅ | ⚠️ 有 `SavedView` 实体与界面，还不能一键套回看板 |
| **状态组** | ✅ 六组 | ✅ 六组，**必填**且终态归组有校验 |
| **模块 Module** | ✅ | ✅ 含状态机、进度守卫，与周期正交 |
| **意见收集 Intake** | ✅ | ✅ 接受必须产出工作项、延后必须写明日期（两条守卫） |
| **便签 Stickies** | ✅ | ✅ |
| **标签目录** | ✅ 父子分组 | ✅ 目录 + 前缀命名法 |
| **归档** | ✅ | ✅ 独立维度，且有自动归档 / 自动关闭 |
| 文档编辑 | ✅ | ⚠️ 有对象无编辑器 |
| 对外公开分享 | ✅ | ❌ |
| 邮件通知 | ✅ | ❌ |
| 国际化 | ✅ 19 语言 | ❌ |
| 导出 | ✅ | ✅ CSV / JSON |
| Webhook / API Token | ✅ | ❌ **仍然没有** |
| 周期 / Sprint | ✅ 含燃尽图 | ✅ **专属界面 + 燃尽图 + 关闭时冻结快照**；互斥由本体基数强制 |
| 工时 / 工时审批 | 💰 one / business | ✅ `Worklog` + 审批流 + 不能批自己那条 |
| 团队空间 Teamspace | 💰 business | ✅ |
| 举措 Initiative（跨项目） | 💰 pro | ✅ |
| 模板 Template | 💰 pro / business | ✅ |
| 基线 Baseline | 💰 business | ✅ |
| 批量操作 Bulk Ops | 💰 one / pro | ❌ |
| 图表原语 | ✅ Recharts 七种 | ✅ 七种，手写 SVG，配色经 CVD 验算 |
| 估点 | ✅ 两种制式 | ✅ 两种制式共用一个数值字段，换制式不丢历史 |
| 外部集成 | ✅ GitHub / Slack | ✅ GitHub / Jira / MCP / Browser |
| 数据迁移 | ⚠️ 一次性导入 | ✅ 三阶段 |
| **本体可配置** | ❌ | ✅ |
| **Agent 运行时** | ❌ | ✅ |
| **五层权限 / Deny** | ❌ | ✅ |
| **可配置工作流** | ❌ | ✅ |
| **流程编排 + 补偿** | ❌ | ✅ |
| 租户隔离 RLS | ❌ | ✅ |
| 字段级历史 / 追加写审计 | ⚠️ 活动流 | ✅ |
| 关系图可视化 | ❌ | ✅ |
| 带出处的问答 | ❌ | ✅ |
| 一致性巡检 | ❌ | ✅ |
| 项目指标 | ⚠️ Analytics | ✅ 30 个定好口径的 + **16 × 9 自由组合** |
| Agent 成本 / 采纳率指标 | ❌ | ✅ |

---

## 四、怎么看这个差距

**三类差距，性质完全不同：**

**第一类 · 挡路的（1 项）** —— 认证。不补就不能给真人用，
而且它不难，是"还没做"不是"做不了"。

**第二类 · 体力活（大部分）** —— 视图布局、筛选器、评论附件、
编辑器、导出、国际化、邮件。这些 Plane 领先得多，但**都是明确的、
有成熟做法的工作量**，不需要改地基。粗估这是 ProjectOS 与
"一个团队能日常用起来的工具"之间的主要距离。

其中**评论**值得单说：它看起来只是一个对象，但它是协作工具的
最小闭环。没有它，工具只能一个人用。

**第三类 · 结构性的（ProjectOS 这边）** —— 本体、Agent 运行时、
权限模型、工作流引擎。Plane 补这些要动 Django 模型层和权限层，
成本远高于 ProjectOS 补一个甘特图。

所以差距的形状是：

> **ProjectOS 欠的是产品表面，Plane 欠的是产品地基。
> 表面比地基好补——但表面是用户唯一看得见的东西。**

## 五、如果要缩小差距，顺序建议

只列判断依据，不替产品做决定：

1. **真实认证**（OIDC）—— 唯一一条挡着"能不能用"的
2. **评论 + @提及** —— 协作的最小闭环，一个对象换来"能多人用"
3. **列表视图 + 筛选器** —— 看板之外最常用的看法，且筛选器复用现有查询能力
4. **富文本编辑器** —— 让 `Knowledge` 从数据变成人写得动的东西
5. 之后再谈日历、甘特、导出、国际化

前四条做完，ProjectOS 从"架构演示"变成"小团队能真用"。
第三类那些结构性优势，只有在有人真的每天用它的时候才开始兑现。

---

## 后续进展（2026-08-05）

这份对比写完当天补了一轮"产品表面"，`git log` 可查。**只记真的能跑
且有用例锁住的**：

| 补上的 | 落在哪 | 用例 |
| --- | --- | --- |
| 评论 | `Comment` 实体 + `commentsOn` 关系（不是挂在资源上的一个数组） | `tests/integration/collaboration.test.ts` |
| @提及 | 服务端从正文解析，经**自动化规则**发通知，不是评论端点里的旁路 | 同上 + `tests/mentions.test.ts` |
| 列表视图 | `public/app.js` `renderList` | `tests/ui/collaboration.test.ts` |
| 表格视图 | `renderTable`，**列由本体生成** | 同上 |
| 筛选器 | 状态（选项来自状态机）+ 负责人，条件进 URL 可分享 | 同上 |
| 导出 | `POST /v1/resources:export`，CSV / JSON | `tests/export.test.ts` |

三条实现上的取舍值得记：

1. **评论走关系不走属性。** `runtime.ts` 里那句"可点击到实体在这个系统里
   的意思是关系，不是属性"对评论同样成立。代价是发一条评论要两次写入
   （建对象 + 挂边），换来的是评论进关系图、能被 Agent 沿边读进上下文、
   引用完整性由关系层统一管。
2. **UI 不认识关系名。** 讨论区走哪条关系是**从本体里查**出来的
   （找 domain 是 Comment、range 含当前类型的那条）。
   `tests/ui/explorer.test.ts` 有一条用例专门盯着这件事，
   而它在这次改动中**真的抓到了一次违规**——第一版写死了关系名。
   白拿的性质：本体里那条关系的值域是白名单，所以
   **不允许被讨论的类型自动就没有讨论区**，这个判断只写了一处。
3. **@提及不存副本。** 存一份 `mentions` 属性更好查，但正文可以改，
   改完两份就对不上，而对不上的那份会继续决定通知发给谁。

### 第二轮：时间维度

| 补上的 | 落在哪 | 用例 |
| --- | --- | --- |
| 计划日期 | Task / Story 加 `startDate` / `dueDate`（本体 minor 升级） | `tests/ui/timeline.test.ts` |
| 日历视图 | 按计划完成日落格，可翻月且月份进 URL | 同上 |
| 甘特视图 | 按计划区间画条，**并画依赖线** | 同上 |
| 逾期高亮 | 到期未完成标红，**终态不标** | 同上 |

三处判断：

1. **计划日期和实际时刻是两个东西。** 本体里 `startDate` / `dueDate` 是人填的，
   `startedAt` / `completedAt` 是状态机写的（`derived`，不进表单）。
   混成一对的话，"这条延期了吗"就永远问不出来——延期正是两者之差。
2. **甘特画依赖线，这一格反超 Plane 开源版。** 用的是本体里本来就有的
   `blockedBy`，关系名同样**从本体里查**不写死（找一条自反且有逆关系的边）。
   Plane 那边把开关一路传到了 `ChartDraggable`，但整个 gantt 目录里
   没有 `<svg>`、没有 `<path>`、没有 `stroke`。
3. **没排期的对象列出来，不隐藏。** 藏起来的话日历看着很空，
   而使用者会以为这个月真的没什么事。

### 第三轮：企业级对象 + React

对照的是 [plane-enterprise-features.md](plane-enterprise-features.md)——
Plane **付费档**那 87 条。

| 补上的 | Plane 要什么档 | 落在哪 |
| --- | --- | --- |
| Teamspace 团队空间 | business | 本体 + React 界面 |
| Initiative 举措（跨项目） | pro | 同上，带生命周期 |
| Template 模板 | pro / business | 同上，套用在前端做 |
| Worklog 工时 + 审批 | one / business | 同上，审批走单独 capability |
| SavedView 保存的视图 | pro | 同上（还不能套回看板） |
| Baseline 基线 | business | 同上 |
| **React 成为前端技术栈** | — | `web/`，企业版挂 `/app` |

两处判断：

1. **这些在这套架构里主要是"声明"不是"代码"。** 统一 Resource 模型
   让新增一类对象自带 CRUD、查询、权限、审计、历史与图关系。
   六类企业对象加起来是一段本体声明 + 两套生命周期 + 八条关系。
2. **审批走单独的 `Worklog.Approve` capability。** 有了它"不能批自己
   报的工时"才写得出来——挂在通用的 `Worklog.Transition` 上，那条 Deny
   会连"提交"一起挡掉，而提交本来就该由本人做。为此给 `PolicyCondition`
   加了 `notOwner`（`ownerOnly` 说的是"只有本人能做"，正好相反）。

顺带一个反直觉的发现：**Plane 拿去卖 pro/business 的能力里，有 12 条
ProjectOS 早就有且更严谨**（审批、触发器与动作、决策与循环、自定义 SLA、
可调用的审计日志、RBAC/GAC、工作项类型、自定义属性、甘特依赖线、
周期报表、不限条数的自动化）。它们不是被实现出来的，是权限模型和
工作流引擎顺带产出的。

**仍然没补**：认证（第一节那条仍然全部成立，仍然是唯一挡着"能不能给
真人用"的）、附件、实时协同编辑、富文本编辑器、批量操作、国际化、
邮件通知、对外公开分享、Webhook / API Token、命令面板、收藏与最近访问、
草稿、便签、移动端适配、周期专属界面。


---

## 第四轮（2026-08-06）：项目管理骨架

对照的是 [`docs/0806planeFeatures/`](../0806planeFeatures/) 那两份文档——
一份是 Plane 的产品功能清单，一份是拿它做项目管理的实践指南。

| 补上的 | 落在哪 | 用例 |
| --- | --- | --- |
| **状态组**（六组，必填） | `src/workflow/types.ts` + 22 台生命周期 | `tests/workflow.test.ts` |
| **模块**（范围维度）+ 状态机 | 本体 + `module-default` | `tests/integration/cycles.test.ts` |
| **周期互斥**（本体基数驱动） | `ResourceService#displaceSingleValued` | 同上 |
| **意见收集 Intake** + 两条守卫 | 本体 + `intake-default` | `tests/integration/analytics.test.ts` 等 |
| **标签目录 / 便签 / 优先级 / 评论内外部** | 本体 | — |
| **自定义分析 16 × 9** | `src/domain/analytics/` + 一条 SQL | `tests/integration/analytics.test.ts`（17 条） |
| **燃尽图 + 周期进度 + 关闭冻结** | `burndown.ts` + `snapshotCycleProgress` | `tests/burndown.test.ts`、`tests/integration/cycles.test.ts` |
| **七种图表原语 + 四种进度指示器** | `web/src/charts/` | `tests/ui/analytics.test.ts` |
| **归档 + 自动归档 / 自动关闭** | 迁移 013 + `archive-sweeper.pg.ts` | `tests/integration/archive.test.ts`（13 条） |

三条值得记的判断：

1. **状态组必填，不猜默认值。** 指南把"归错状态组"列为反模式，
   而猜错不会报错——它只让燃尽图少烧掉一批工作项。
2. **周期与模块的区别只写在本体里**（`cardinality`），服务层读它，
   代码里没有一处 `'plannedIn'` 字面量。
3. **归档是第三个维度**，不是状态也不是删除，因此指标照常统计归档的对象。

### 这一轮暴露的一个老问题

甘特图判断"画哪条依赖线"用的是**形状**判据（自反 + 有逆关系）。
本体里一加 `duplicates`（形状完全相同，且排得更靠前），
依赖线就静默地改成画"重复"关系了。浏览器用例抓到了它。

修法是把语义写进本体（`RelationTypeDef.blocking`），并在注册时
拒绝一个类型上出现两条 blocking 关系。**按形状猜语义，形状迟早会撞车。**

### 仍然没补

认证（第一节那条仍然全部成立，仍然是唯一挡着"能不能给真人用"的）、
附件、实时协同编辑、富文本编辑器、批量操作、国际化、邮件通知、
对外公开分享、**Webhook / API Token**、命令面板、收藏与最近访问、草稿、
移动端适配。

Webhook 与 API Token 这一轮**有意没做**：它们各自要一套新的存储、
投递重试与凭证哈希，而且 Token 那一半绕不开认证——
而认证正是第一节里那条"不是体力活"的结构性欠账。
把 Token 建在请求头身份之上，等于给一道本来就没锁的门配一把新钥匙。
