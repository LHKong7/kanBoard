# Plane 产品功能清单

> 本文档基于代码库实际实现整理（`apps/` + `packages/`），而非官网营销материал。
> 项目定位：**开源的现代项目管理平台**（Jira / Linear / Asana 的开源替代品），采用 AGPL-3.0 协议。

---

## 一、整体架构与产品形态

项目是一个 pnpm + Turborepo 单体仓库，由 6 个可独立部署的应用组成：

| 应用 | 路径 | 技术栈 | 产品职责 |
| --- | --- | --- | --- |
| **Web 主应用** | `apps/web` | React Router v7 + Vite + MobX | 面向团队成员的核心工作台（工作区 / 项目 / 工作项 / 周期 / 模块 / 页面 / 分析） |
| **Space 公开站** | `apps/space` | React Router v7 | 对外公开发布的只读站点（公开看板、公开工作项、公开页面、外部意见收集） |
| **Admin 管理后台** | `apps/admin` | React Router v7 | 「上帝模式」实例级管理控制台（自托管场景下的全局配置） |
| **API 服务** | `apps/api` | Django + DRF + Celery | 业务主干、权限、后台任务、Webhook、公开 REST API |
| **Live 协同服务** | `apps/live` | Node + Hocuspocus (Yjs) | 文档实时协同编辑、光标同步、标题同步、PDF 导出 |
| **Proxy** | `apps/proxy` | Nginx | 反向代理与统一入口 |

共享能力沉淀在 `packages/` 中：`editor`（富文本编辑器）、`propel`（设计系统组件库，40+ 组件）、`ui`、`types`、`constants`、`services`、`i18n`（19 种语言）、`hooks`、`utils`、`logger`、`shared-state`、`decorators`、`codemods`。

**部署形态**：Plane Cloud（SaaS）与自托管（Docker Compose / Kubernetes / 托管平台）。

---

## 二、核心产品功能

### 1. 工作项（Work Items / Issues）

产品最核心的实体，对应 `apps/api/plane/db/models/issue.py`。

**基础属性**
- 名称、富文本描述（支持 JSON / HTML / 二进制三种存储，用于协同编辑）
- **优先级**：Urgent / High / Medium / Low / None
- **状态**：可自定义状态，归属 6 大状态组 —— Backlog、Unstarted、Started、Completed、Cancelled、Triage（分诊）
- **人员**：多指派人（Assignee）、创建人
- **时间**：开始日期、截止日期、完成时间
- **序列号**：项目内自增编号（如 `PROJ-123`），基于 `IssueSequence` 保证唯一
- **工时估点**（Estimate Point）
- **父子层级**：父工作项 / 子工作项（Sub-issues）

**协作与追踪能力**
| 能力 | 模型 | 说明 |
| --- | --- | --- |
| 标签 | `IssueLabel` | 多标签，项目级可配置颜色 |
| 评论 | `IssueComment` | 富文本，支持 `INTERNAL` / `EXTERNAL` 可见范围区分 |
| 表情回应 | `IssueReaction` / `CommentReaction` | 工作项与评论均可回应 |
| 附件 | `IssueAttachment` | 文件上传（S3 兼容对象存储） |
| 外链 | `IssueLink` | 关联外部 URL |
| 关系 | `IssueRelation` | blocking / blocked_by / duplicate / relates_to 等关系类型 |
| 订阅 | `IssueSubscriber` | 关注工作项变更 |
| @提及 | `IssueMention` | 提及成员触发通知 |
| 活动流 | `IssueActivity` | 记录每个字段的 old_value → new_value 变更 |
| 投票 | `IssueVote` | 公开看板上的 upvote / downvote |
| 版本历史 | `IssueVersion` / `IssueDescriptionVersion` | 工作项快照与描述版本回溯 |

**工作项类型与 Epic**
- `IssueType` 支持工作区级自定义工作项类型（Bug / Feature / Task 等），可按项目启用（`ProjectIssueType`）
- `is_epic` 标记支持 **Epic（史诗）** 层级
- 项目级开关 `is_issue_type_enabled` 控制是否启用

**草稿**
- `DraftIssue` 独立模型，支持未提交的工作项草稿，草稿也可预设指派人、标签、周期、模块

**归档**
- 工作项支持归档，项目设置中可配置 `archive_in`（N 个月后自动归档）与 `close_in`（N 个月后自动关闭）自动化规则

---

### 2. 视图与布局（Layouts & Views）

`apps/web/core/components/issues/issue-layouts/` 提供 **5 种工作项布局**：

1. **List（列表）** —— 分组列表视图
2. **Kanban（看板）** —— 拖拽式泳道看板
3. **Spreadsheet（表格）** —— 类电子表格，可配置列
4. **Calendar（日历）** —— 按日期排布
5. **Gantt Chart（甘特图）** —— 时间线视图，支持拖拽调整起止日期、块间依赖关系、周/月/季三档缩放（详见 [图表与可视化体系](#三图表与可视化体系)）

**筛选与分组**
- 支持按状态、状态组、优先级、指派人、创建人、标签、周期、模块、开始/截止日期等维度筛选
- 支持 group_by / sub_group_by 二级分组、排序、显示空分组、显示子工作项
- `rich-filters` 提供复合筛选器构建能力

**保存视图**
- **项目视图**（Project Views）：项目内保存并共享的筛选组合
- **工作区视图**（Workspace / Global Views）：跨项目的全局视图（`IssueView` 模型为 `WorkspaceBaseModel`）
- 每个用户在周期、模块、项目上都有独立的 `UserProperties` 保存个人视图偏好

---

### 3. 周期（Cycles）

对应敏捷开发中的 Sprint。

- 名称、描述、开始/结束日期、负责人（owned_by）、时区
- **进度快照**（`progress_snapshot`）：周期结束时冻结数据用于回顾
- **燃尽图**（Burn-down chart）与进度统计
- **Active Cycles** 工作区级页面：跨项目查看所有进行中的周期
- 支持归档（`archived_at`）、排序（sort_order）、自定义图标（logo_props）
- 项目级开关：`cycle_view`

---

### 4. 模块（Modules）

将大项目拆分为可管理的子模块 / 里程碑。

- 名称、富文本描述、开始日期、目标日期
- **状态机**：Backlog / Planned / In Progress / Paused / Completed / Cancelled
- 模块负责人（lead）+ 模块成员（members，多对多）
- 模块外链（`ModuleLink`）、归档、排序、自定义图标
- 项目级开关：`module_view`

---

### 5. 页面 / Wiki（Pages）

基于 TipTap 的富文本知识库。

- **实时协同编辑**：通过 `apps/live` 的 Hocuspocus + Yjs 实现多人同时编辑与光标同步
- **访问控制**：Public（工作区可见）/ Private（仅自己）
- **嵌套页面**：`parent` 字段支持父子页面树
- **工作区级页面**（`is_global`）与**项目级页面**（`ProjectPage` 多对多，一个页面可归属多个项目）
- 页面标签（`PageLabel`）、锁定（`is_locked`）、归档、排序
- **版本历史**（`PageVersion`）与操作日志（`PageLog`）
- **页面移动**：`moved_to_page` / `moved_to_project` 支持跨项目迁移
- **PDF 导出**（`apps/live/src/controllers/pdf-export.controller.ts`）
- 项目级开关：`page_view`（默认开启）

**编辑器能力**（`packages/editor/src/core/extensions/`）：
标题（含大纲导航）、有序/无序/任务列表、表格、代码块与行内代码、引用、Callout 提示块、图片上传与拖拽、自定义链接、水平分割线、文字颜色与对齐、Emoji、**@提及成员**、**斜杠命令（Slash Commands）**、**工作项内嵌（Work Item Embed）**、拖拽侧边菜单、快捷键映射。

---

### 6. 意见收集 / Intake（原 Inbox）

外部或内部提交的工作项进入待分诊队列。

- 状态流转：`Pending`（待处理）/ `Accepted`（接受）/ `Rejected`（拒绝）/ `Snoozed`（延后）/ `Duplicate`（重复）
- 支持标记重复项、延后到指定时间
- 可通过公开发布链接接收外部提交
- 项目级开关：`intake_view`

---

### 7. 分析与报表（Analytics）

- **默认分析**（Default Analytics）：工作区总览指标
- **进阶分析**（Advance Analytics）：`overview` 与 `work-items` 两个标签页，提供统计端点与图表端点
- **项目分析**（Project Analytics / Project Stats）：项目维度统计
- **自定义分析视图**：`AnalyticViewViewset` 支持保存分析视图
- **分析导出**：`ExportAnalyticsEndpoint` + 后台任务 `analytic_plot_export.py`

图表能力详见下一章节。

---

### 8. 通知系统（Notifications）

- **站内通知**：`Notification` 模型，支持已读（read_at）、延后（snoozed_till）、归档（archived_at）
- **邮件通知**：`EmailNotificationLog` + Celery 任务 `email_notification_task.py`
- **通知偏好设置**（`UserNotificationPreference`）：可按工作区/项目分别开关
  - 属性变更（property_change）
  - 状态变更（state_change）
  - 评论（comment）
  - @提及（mention）
  - 工作项完成（issue_completed）
- 工作区级通知中心页面：`/:workspaceSlug/notifications`

---

### 9. 公开发布（Deploy Boards / Public Space）

通过 `DeployBoard` 模型将内容发布到公网（由 `apps/space` 承载）。

- **可发布实体**：项目、工作项、模块、周期、页面、视图、Intake
- 每个发布生成唯一 `anchor` 匿名访问链接
- **可配置的公开互动开关**：
  - 评论（`is_comments_enabled`）
  - 表情回应（`is_reactions_enabled`）
  - 投票（`is_votes_enabled`）
  - 活动流（`is_activity_enabled`）
- 可随时禁用（`is_disabled`）
- 公开成员记录：`ProjectPublicMember`

---

### 10. 便签（Stickies）

工作区级的轻量笔记面板。

- 富文本内容、自定义文字色与背景色、图标、排序
- 独立页面：`/:workspaceSlug/stickies`

---

## 三、图表与可视化体系

> 底层库：**Recharts**（`packages/propel/package.json`）。
> 所有图表原语封装在 `packages/propel/src/charts/`，类型定义在 `packages/types/src/charts/index.ts`。

### 3.1 七种图表原语

| 图表 | 目录 | 关键可配置项 | 适用场景 |
| --- | --- | --- | --- |
| **AreaChart 面积图** | `area-chart/` | `areas[]`（多序列）、`stackId` 堆叠、`fillOpacity`、`smoothCurves` 平滑曲线、`showDot` 数据点、`comparisonLine` 对比基准线（可虚线） | 燃尽图、创建 vs 解决趋势、累积量随时间变化 |
| **BarChart 柱状图** | `bar-chart/` | `bars[]`、`stackId` 堆叠、`barSize`、`shapeVariant`（`bar` / `lollipop` / `lollipop-dotted` 三种形态）、`showPercentage` 百分比标签、`showTopBorderRadius` / `showBottomBorderRadius` 圆角控制、`fill` 支持函数动态取色 | 优先级分布、按人/按状态的数量对比 |
| **LineChart 折线图** | `line-chart/` | `lines[]`、`dashedLine` 虚线、`smoothCurves`、`showDot`、`stroke` | 多序列趋势对比、速率曲线 |
| **PieChart 饼图 / 环形图** | `pie-chart/` | `innerRadius`（设置后即环形图）、`outerRadius`、`cornerRadius` 圆角、`paddingAngle` 扇区间隙、`centerLabel` 中心文案、`customLabel`、`customLegend`、`activeShape` 悬停放大 | 状态分布、构成占比 |
| **RadarChart 雷达图** | `radar-chart/` | `radars[]`、`angleAxis` 角度轴、`fillOpacity`、`dot` | 多维能力/负载对比 |
| **ScatterChart 散点图** | `scatter-chart/` | `scatterPoints[]`、`fill` / `stroke` | 二维相关性分析（如估点 vs 实际耗时） |
| **TreeMap 矩形树图** | `tree-map/` | `data[]`（name / value / label / icon）、`fillColor` 或 `fillClassName`、自适应内容显隐（`TContentVisibility`：图标、名称、数值、标签按可用面积逐级降级） | 项目/模块体量占比，层级化容量视图 |

**所有图表共享的基础能力**（`TBaseChartProps`）：
- `legend` —— 图例位置可控（align: left/center/right，verticalAlign: top/middle/bottom，layout: horizontal/vertical）
- `margin` —— 四向边距（默认 `top/right/bottom/left = 50`）
- `showTooltip` —— 悬浮提示（默认开启）
- `customTooltipContent` —— 完全自定义 tooltip 渲染

**带坐标轴的图表额外支持**（`TAxisChartProps`，适用于 Area / Bar / Line / Scatter）：
- `xAxis` / `yAxis`：key、label、strokeColor、偏移量（dx / dy / offset）
- `yAxis.domain` 值域锁定、`allowDecimals` 小数控制
- `tickCount` 刻度数量、`customTicks` 自定义刻度渲染组件

### 3.2 图表配色方案

`packages/constants/src/chart.ts` 定义了 **3 套调色板**，每套含 10 个亮色 + 10 个暗色（自动跟随主题切换）：

| 方案 | key | 风格 | 首色（亮/暗） |
| --- | --- | --- | --- |
| **Modern** | `modern` | 蓝紫冷调，科技感 | `#6172E8` / `#6B7CDE` |
| **Horizon** | `horizon` | 橙青撞色，暖对比 | `#E76E50` / `#E05A3A` |
| **Earthen** | `earthen` | 大地绿棕，低饱和 | `#386641` / `#497752` |

图表主题变量（`packages/constants/src/graph.ts`）全部走 CSS 变量（`--text-color-secondary`、`--border-color-subtle` 等），因此亮色 / 暗色模式下自动适配。

### 3.3 图表模型（Chart Models）

`EChartModels` 定义了图表的组织形态：

| 模型 | 含义 |
| --- | --- |
| `BASIC` | 单序列基础图 |
| `STACKED` | 堆叠（同一 stackId 累加） |
| `GROUPED` | 分组并列 |
| `MULTI_LINE` | 多折线叠加 |
| `COMPARISON` | 对比（实际 vs 基准，如燃尽图的理想线） |
| `PROGRESS` | 进度型 |

### 3.4 分析维度：X 轴 16 种 × Y 轴 9 种

**X 轴可选维度**（`ChartXAxisProperty`）：

| 分类 | 维度 |
| --- | --- |
| 状态类 | `STATES` 状态名、`STATE_GROUPS` 状态组 |
| 属性类 | `PRIORITY` 优先级、`LABELS` 标签、`ESTIMATE_POINTS` 估点、`WORK_ITEM_TYPES` 工作项类型 |
| 人员类 | `ASSIGNEES` 指派人、`CREATED_BY` 创建人 |
| 归属类 | `CYCLES` 周期、`MODULES` 模块、`PROJECTS` 项目、`EPICS` 史诗 |
| 时间类 | `START_DATE` 开始日期、`TARGET_DATE` 截止日期、`CREATED_AT` 创建时间、`COMPLETED_AT` 完成时间 |

时间类维度支持二次聚合粒度（`ChartXAxisDateGrouping`）：**DAY / WEEK / MONTH / YEAR**。

**Y 轴可选指标**（`ChartYAxisMetric`）：

| 指标 | 含义 |
| --- | --- |
| `WORK_ITEM_COUNT` | 工作项总数 |
| `ESTIMATE_POINT_COUNT` | 估点总和 |
| `PENDING_WORK_ITEM_COUNT` | 待办数 |
| `IN_PROGRESS_WORK_ITEM_COUNT` | 进行中数 |
| `COMPLETED_WORK_ITEM_COUNT` | 已完成数 |
| `WORK_ITEM_DUE_TODAY_COUNT` | 今日到期数 |
| `WORK_ITEM_DUE_THIS_WEEK_COUNT` | 本周到期数 |
| `BLOCKED_WORK_ITEM_COUNT` | 被阻塞数 |
| `EPIC_WORK_ITEM_COUNT` | 史诗数 |

此外还支持 `group_by` 做二次分组（同样取值自 16 种 X 轴维度），从而构造出堆叠 / 分组图。

**时间范围筛选**（`ANALYTICS_DURATION_FILTER_OPTIONS`）：昨天 / 近 7 天 / 近 30 天 / 近 3 个月。

### 3.5 产品中实际落地的图表

| 位置 | 图表 | 实现文件 |
| --- | --- | --- |
| 周期 / 模块侧边栏、Active Cycles | **燃尽图**（面积图 + 理想线对比） | `components/core/sidebar/progress-chart.tsx` |
| 分析 → 工作项 | **Created vs Resolved** 双序列面积图 | `components/analytics/work-items/created-vs-resolved.tsx` |
| 分析 → 工作项 | **优先级分布**柱状图 | `components/analytics/work-items/priority-chart.tsx` |
| 分析 → 工作项 | **自定义分析图**（X/Y 轴自由组合） | `components/analytics/work-items/customized-insights.tsx` |
| 分析 → 总览 | **项目洞察 / 活跃项目**卡片 | `components/analytics/overview/` |
| 分析（全部） | **指标卡 + 趋势徽标**（同环比涨跌） | `insight-card.tsx`、`trend-piece.tsx` |
| 分析（全部） | **洞察数据表**（可排序表格） | `components/analytics/insight-table/` |
| 成员资料页 | **优先级分布**柱状图 | `components/profile/overview/priority-distribution.tsx` |
| 成员资料页 | **状态分布**饼图 | `components/profile/overview/state-distribution.tsx` |
| 成员资料页 | **工作负载**（workload） | `components/profile/overview/workload.tsx` |
| 周期列表 / 模块卡片 | **径向进度环**、**线性进度条** | `packages/ui/src/progress/` |

**燃尽图的具体算法**（`progress-chart.tsx`）：
- `current` 序列 = 每日剩余工作项实际值
- `ideal` 序列 = `总工作项数 × (1 - 当前天索引 / 总天数)`，即匀速理想线，渲染为虚线（`strokeDasharray: "6, 3"`）
- 两条线叠加即为标准燃尽图

### 3.6 进度指示器（非图表类可视化）

`packages/ui/src/progress/` 提供 4 种：

| 组件 | 形态 | 典型用法 |
| --- | --- | --- |
| `RadialProgress` | 径向环形进度 | 周期完成度 |
| `CircularProgressIndicator` | 圆形进度（可含中心文案） | 子任务完成比 |
| `LinearProgressIndicator` | 线性分段条（多状态组按色块拼接） | Active Cycle 状态分布条 |
| `ProgressBar` | 基础进度条 | 附件上传进度 |

### 3.7 甘特图（独立可视化引擎）

甘特图不走 Recharts，而是 `apps/web/core/components/gantt-chart/` 下的自研实现：

- **三档缩放视图**：Week（周）/ Month（月）/ Quarter（季度）
- **块操作**：拖拽移动（`enableBlockMove`）、拉伸改期（resizable）、拖拽排序（`enableReorder`）
- **依赖关系**：`enableDependency` —— 工作项甘特布局中默认开启，支持拖拽建立块间依赖
- **批量选择**：`enableSelection`（配合批量操作）
- **快速添加**：`quickAdd` 内联新建
- **滚动加载**：`loadMoreBlocks` 分页加载
- **应用范围**：工作项甘特布局、模块甘特布局（`GANTT_TIMELINE_TYPE.ISSUE` / `MODULE`）

### 3.8 导出

- 分析数据导出：`ExportAnalyticsEndpoint` + Celery 任务 `analytic_plot_export.py`
- 工作项数据导出：`Exporter` 模型，支持 **JSON / CSV / XLSX** 三种格式
- 页面导出：PDF（`apps/live/src/controllers/pdf-export.controller.ts`）

---

## 四、工作区与项目管理

### 工作区（Workspace）
- 工作区创建、Slug、Logo、时区
- **成员管理**：邀请（`WorkspaceMemberInvite`，邮件邀请流程）、角色分配、成员移除
- **角色权限**：Admin(20) / Member(15) / Guest(5)
- **团队**（`Team`）：工作区内的成员分组
- **主题定制**（`WorkspaceTheme`）
- **首页偏好**（`WorkspaceHomePreference`）：可配置首页展示的模块
- **用户偏好**（`WorkspaceUserPreference`、`WorkspaceUserProperties`）
- **快捷链接**（`WorkspaceUserLink`）
- **收藏夹**（`UserFavorite`）：可收藏项目、周期、模块、视图、页面
- **最近访问**（`recent_visit.py` + `recent_visited_task.py`）

### 项目（Project）
- 项目标识符（Identifier，如 `PROJ`，用于工作项编号）
- **可见性**：Public（工作区可见）/ Secret（仅成员可见）
- 封面图、Emoji / 自定义图标、描述
- 项目负责人（project_lead）、默认指派人（default_assignee）、默认状态
- 时区设置（默认继承工作区）
- **功能开关**（项目设置 → Features）：
  - Cycles（周期）
  - Modules（模块）
  - Views（视图）
  - Pages（页面）
  - Intake（意见收集）
  - Time Tracking（工时追踪，`is_time_tracking_enabled`）
  - Issue Types（工作项类型，`is_issue_type_enabled`）
  - Guest 可见全部功能（`guest_view_all_features`）
- **自动化**（Automations）：N 个月后自动归档 / 自动关闭
- 项目成员管理与邀请（`ProjectMemberInvite`）
- 项目归档（`archived_at`）与归档项目列表页

### 项目配置项
- **状态（States）**：自定义状态名称、颜色、所属状态组、顺序
- **标签（Labels）**：支持标签分组（parent）
- **估点（Estimates）**：两种类型 —— Categories（类别，如 XS/S/M/L）与 Points（斐波那契点数）

---

## 五、平台与集成能力

### 认证与账户
- 邮箱 + 密码登录
- **魔法链接登录**（Magic Code）
- **OAuth 第三方登录**：Google、GitHub、GitLab、**Gitea**
- 忘记密码 / 重置密码 / 设置密码流程
- 用户引导流程（Onboarding）
- 个人资料设置：`/settings/profile/:tabId`（含头像、通知、主题、API Token 等）
- 用户资料页与活动记录：`/:workspaceSlug/profile/:userId`

### API 与自动化
- **公开 REST API**（`apps/api/plane/api/`）：覆盖 project、work_item、cycle、module、state、label、member、intake、estimate、sticky、asset、invite、user，并提供 OpenAPI schema
- **API Token**：个人设置中生成，用于外部调用
- **Webhook**：
  - 可订阅事件：project、issue、module、cycle、issue_comment
  - 支持工作区级与项目级（`ProjectWebhook`）
  - 带调用日志（`WebhookLog`）与重试机制
- **导入 / 导出**：
  - 导出格式：JSON / CSV / XLSX（`Exporter` 模型 + `export_task.py`）
  - 导入器框架（`importer.py`），配合 `external_source` / `external_id` 字段支持外部系统数据映射
- **集成**：GitHub、Slack（`apps/web/core/components/integration/`）

### 实例管理（God Mode / Admin）
`apps/admin` 提供自托管实例的全局配置：
- **General**：实例基础信息
- **Authentication**：开关注册（ENABLE_SIGNUP）、禁止创建工作区、Google / GitHub / GitLab / Gitea 开关、魔法链接开关、邮箱密码登录开关
- **Email**：SMTP 配置
- **AI**：LLM API Key 配置
- **Image**：Unsplash 图库配置
- **Workspace**：实例内工作区管理
- 其他：PostHog 埋点、Slack Client ID 配置

### 其他平台能力
- **全局搜索**（`app/views/search/`）：跨实体搜索
- **命令面板 Power-K**（`apps/web/core/components/power-k/`）：全局快捷键与命令菜单
- **国际化**：19 种语言 —— 简体中文、繁体中文、英语、日语、韩语、法语、德语、西班牙语、意大利语、葡萄牙语(巴西)、俄语、乌克兰语、波兰语、捷克语、斯洛伐克语、罗马尼亚语、土耳其语、印尼语、越南语
- **主题**：亮色 / 暗色 / 自定义主题
- **AI 助手**：编辑器内 "Ask Anything"（Pi）
- **软删除**：全模型 `deleted_at` 软删除 + 定时清理任务
- **后台任务**（Celery）：通知分发、邮件、活动记录、Webhook 投递、导出、版本同步、文件资源清理、存储元数据统计等 30+ 任务

---

## 六、商业版本功能分层

代码中 `packages/constants/src/subscription.ts` 定义了版本能力划分（社区版之外的付费能力）：

| 版本 | 主要功能 |
| --- | --- |
| **One** | OIDC + SAML SSO、Active Cycles、实时协同 + 公开视图与页面、工作项与页面互链、工时追踪 + 有限批量操作、Docker/K8s 部署 |
| **Pro** | 仪表盘与报表、完整工时追踪 + 批量操作、**Teamspaces**、触发器与动作、Wiki、常用集成 |
| **Business** | 项目模板、工作流与审批、决策与循环自动化、自定义报表、嵌套页面、Intake 表单 |
| **Enterprise** | 私有 + 托管部署、GAC、LDAP、数据库 + 公式、无限自动化流、全套专业服务 |

> 注：本仓库为社区版（AGPL-3.0），上述付费功能的具体实现位于闭源的 EE 仓库，本仓库中仅保留了 license / payment / subscription 相关的接入点与升级引导 UI。

---

## 七、功能全景速查

```
工作区 Workspace
├── 首页 / 概览（可配置模块）
├── 项目 Projects
│   ├── 工作项 Work Items（列表/看板/表格/日历/甘特）
│   │   ├── 子工作项、关系、附件、外链、评论、回应、订阅、活动流、版本
│   │   └── 工作项类型 / Epic
│   ├── 周期 Cycles（燃尽图、进度快照、归档）
│   ├── 模块 Modules（状态机、负责人、成员）
│   ├── 视图 Views（保存筛选组合）
│   ├── 页面 Pages（协同编辑、嵌套、版本、PDF 导出）
│   ├── 意见收集 Intake（分诊队列）
│   ├── 归档区 Archives（工作项 / 周期 / 模块）
│   └── 项目设置（成员、功能开关、状态、标签、估点、自动化）
├── 全局工作区视图 Workspace Views
├── 进行中的周期 Active Cycles
├── 分析 Analytics（总览 / 工作项 / 项目）
├── 草稿 Drafts
├── 便签 Stickies
├── 通知中心 Notifications
├── 成员资料 Profile（含活动记录）
└── 工作区设置（成员、账单、导出、Webhook）

公开站 Space —— 公开项目看板 / 工作项 / 页面 / 视图 / Intake（评论、投票、回应可控）
管理后台 Admin —— 实例配置（通用 / 认证 / 邮件 / AI / 图库 / 工作区）
个人设置 —— 资料、外观、通知、API Token
```

---

*文档生成时间：2026-08-06 · 基于代码库实际实现整理*
