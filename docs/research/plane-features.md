# Plane 产品功能盘点

对 [makeplane/plane](https://github.com/makeplane/plane) 的功能梳理。

## 这份文档的口径

**对着源码写，不抄官网。** 锚点：

| 项 | 值 |
| --- | --- |
| 仓库 | `makeplane/plane` |
| commit | `31853ab2b8b7810c59dc30d22e52c8f4b5a71a47`（2026-08-05） |
| 许可 | AGPL-3.0 |
| 形态 | pnpm + turbo 单仓，6 个应用 + 15 个包 |

之所以不抄官网：**Plane 的 README 只列了 6 项功能**（Work Items / Cycles /
Modules / Views / Pages / Analytics），而实际交付的东西远不止。反过来，
官网列的功能里有相当一部分**不在这个开源仓库里**——它们属于付费版。
两头都会误导，所以下面每一条都标了出处，可以自己去翻。

凡是**没有在这个仓库里找到实现**的，一律记在第 15 节，不混进功能表里冒充已有。

---

## 1. 一句话

面向研发团队的开源项目管理工具，对标 Jira / Linear。
核心是**工作项（Work Item）**，外面套两种组织方式——**周期（Cycle）**按时间切，
**模块（Module）**按功能切——再配五种视图布局、文档、收件箱和分析。

## 2. 六个应用

`apps/` 下是六个独立部署单元，这个划分本身说明了产品边界：

| 应用 | 是什么 | 技术 |
| --- | --- | --- |
| `web` | 主应用 | React Router v7 |
| `api` | 后端 | Django + DRF + Celery |
| `space` | **公开分享站**：把看板/视图/页面公开给外部人 | React |
| `admin` | **实例管理**（官方叫 God mode），自托管时配置全局设置 | React |
| `live` | **实时协作服务器**，驱动富文本编辑器（Hocuspocus/Yjs + Redis） | Node |
| `proxy` | 反向代理 | nginx |

`packages/` 里值得单拎出来的：`editor`（富文本编辑器）、`propel` 与 `ui`
（两套组件库）、`i18n`、`types`、`constants`。

---

## 3. 对象模型

```
Workspace 工作区
 └── Project 项目
      ├── Work Item 工作项 ── 可自引用形成父子（sub-issue）
      │    └── Issue Type / Epic 工作项类型（含史诗）
      ├── Cycle 周期      按时间盒切（相当于 Sprint）
      ├── Module 模块      按功能域切
      ├── View 视图        存下来的筛选条件
      ├── Page 页面        文档
      ├── Intake 收件箱    外部提报的入口，先分诊再进项目
      └── State / Label / Estimate  状态、标签、估点
```

出处：`apps/api/plane/db/models/`。

一处结构上的选择值得留意：**Page 挂在 Workspace 上，通过 `ProjectPage`
中间表多对多关联到 Project**（`page.py:30/52/135`）。也就是说一个页面可以同时属于
多个项目，也可以谁都不属于——文档不是项目的附属品。

## 4. 五种视图布局

同一批工作项，五种看法（`packages/constants/src/issue/layout.ts`）：

| 布局 | 说明 |
| --- | --- |
| **List 列表** | 按分组维度纵向铺开 |
| **Kanban 看板** | 列＝分组维度，拖拽改值。不只按状态分列，任何分组维度都能当列 |
| **Calendar 日历** | 按到期日落在日历格子里 |
| **Spreadsheet 表格** | 电子表格式，一行一项、一列一属性 |
| **Gantt 甘特** | 时间轴条形图，可拖拽改起止日期 |

**分组维度**（决定看板的列、列表的分组，`packages/constants/src/issue/filter.ts`）：
状态、状态组、优先级、标签、负责人、创建人、周期、模块、项目、工作项类型、
开始日期、到期日期、子项，或不分组。

**甘特图**有三档时间缩放：周 / 月 / 季
（`apps/web/core/components/gantt-chart/views/`，分别是 `week-view.ts`
`month-view.ts` `quarter-view.ts`）。侧栏与图区分离，条形块可拖动、可左右拉伸
改起止日期。

关于依赖连线，这里要说准一点：代码里有一个 `enableDependency` 开关一路传到
`ChartDraggable`，工作项的甘特视图也确实把它打开了
（`issue-layouts/gantt/base-gantt-root.tsx:149`）。**但整个 `gantt-chart/`
目录里没有任何画线的东西**——没有 `<svg>`、没有 `<path>`、没有 `stroke`，
也没有引用任何一种关联类型。所以：**开源版的甘特图不画依赖箭头**，
那是留给商业版的挂点（和第 15 节里 Epic、工时的情况是同一个套路）。

> 注意：**公开分享站（`space`）只支持 List 和 Kanban 两种**
> （`SITES_ISSUE_LAYOUTS`）。对外分享时甘特、日历、表格都看不到。

## 5. 工作项能做什么

字段（`apps/api/plane/db/models/issue.py`）：

- 父子关系（`parent` 自引用）、状态、估点、**富文本描述**（同时存
  json / html / stripped / binary 四种形态，binary 那份是给实时协作用的）
- 优先级：urgent / high / medium / low / none
- 开始日期、到期日期、多负责人、多标签
- `sequence_id` 项目内递增编号（就是 `PROJ-123` 里的 123）
- `sort_order` 手工排序、完成时间、归档时间、草稿标记
- `external_source` / `external_id` —— 从外部系统导入时留的来源指针

**六种关联类型**（`IssueRelationChoices`），且都有反向边：

| 正向 | 反向 |
| --- | --- |
| `blocked_by` 被阻塞于 | `blocking` 阻塞 |
| `relates_to` 相关 | 对称 |
| `duplicate` 重复 | 对称 |
| `start_before` 早于…开始 | `start_after` |
| `finish_before` 早于…完成 | `finish_after` |
| `implemented_by` 由…实现 | `implements` |

后四种是排期语义（早于开始 / 早于完成），本体上是给时间轴用的——
但如上所述，**开源版的甘特图并不把它们画出来**。

工作项周边还有一串对象：附件、外链、评论（评论可加表情回应）、@提及、
订阅者、表情回应、**投票**（`IssueVote`，给公开看板上外部人投票用）、
活动流（`IssueActivity`）、以及**版本历史**（`IssueVersion` /
`IssueDescriptionVersion`）。

**状态分组**固定六类：backlog / unstarted / started / completed / cancelled /
**triage（分诊）**。最后一个是收件箱进来的东西的落脚点。

**估点**两种制式（`EstimateType`）：categories（如 T恤尺码）或 points（数值）。

## 6. 周期与模块

两种正交的组织方式，都可以在项目设置里单独关掉：

- **Cycle 周期**：带起止日期，就是 Sprint。工作区级还有一个
  **Active Cycles** 页面（`/:workspaceSlug/active-cycles`），横跨所有项目
  看当前在跑的周期，另带一个"团队产出"面板（`active-cycle/productivity.tsx`）。
- **Module 模块**：按功能域切，有自己的负责人（`ModuleMember`）、外链、
  状态（`ModuleStatus`）。

**燃尽图两边都有**：`cycles/analytics-sidebar/issue-progress.tsx` 与
`modules/analytics-sidebar/issue-progress.tsx` 是对称的两份——周期和模块
各自有进度侧栏和完成度统计。README 只提了周期有燃尽图，实际模块也有。

两者都可以归档（`archives/cycles`、`archives/modules`）。

## 7. 视图、页面、收件箱

- **View 视图**：把筛选条件存下来复用。分**项目级**（`IssueView`）和
  **工作区级**（`workspace-views`，跨项目查）。
- **Page 页面**：富文本文档，支持标签、版本历史（`PageVersion`）、
  实时协同编辑。
- **Intake 收件箱**：外部提报先落在这里，经分诊（accept / reject /
  snooze / duplicate）才进项目。CE 里来源只有 `IN_APP` 一种
  （`intake.py` 的 `SourceType`）——表单、邮件那些来源是付费版的。

## 8. 分析与主页

**Analytics**（`apps/api/plane/app/views/analytic/`）分两代并存：

- 旧的：`AnalyticsEndpoint` + **可保存的分析视图**（`AnalyticViewViewset`）
  + 导出（`ExportAnalyticsEndpoint`）
- 新的 **Advance Analytics**：`AdvanceAnalyticsStatsEndpoint`（统计数字）
  与 `AdvanceAnalyticsChartEndpoint`（图表），**工作区级和项目级各一套**
  （`advance.py` / `project_analytics.py`）

**工作区主页**（`home/widgets/`）在 CE 里只有三块：快捷链接、最近访问、
管理入口——**不是**可自定义的仪表盘。仪表盘是付费版的（见第 15 节）。

另有 **Stickies 便签**（`/:workspaceSlug/stickies`）和 **Drafts 草稿**
（`/:workspaceSlug/drafts`，草稿有独立的模型 `DraftIssue`，不污染正式工作项）。

## 9. 协作与通知

- **实时协同编辑**：`apps/live` 是独立服务，Hocuspocus（Yjs）+ Redis。
  工作项描述和页面都走它——这也是工作项描述要存一份 `description_binary` 的原因。
- **通知**：应用内 + 邮件两条通道（`Notification` /
  `UserNotificationPreference` / `EmailNotificationLog`），可按类型配置偏好。
  工作区级通知中心在 `/:workspaceSlug/notifications`。
- 评论、@提及、表情回应、订阅。
- **命令面板**（`components/power-k/`）：全局快捷操作。

## 10. 项目配置与自动化

`Project` 模型上的开关（`project.py`），逐项决定这个项目开哪些功能：

| 字段 | 控制 |
| --- | --- |
| `cycle_view` / `module_view` / `issue_views_view` / `page_view` / `intake_view` | 五个功能模块各自的开关 |
| `is_time_tracking_enabled` | 时间跟踪（**开关在 CE，实现不在**，见第 15 节） |
| `is_issue_type_enabled` | 自定义工作项类型 |
| `guest_view_all_features` | 访客能看到多少 |
| `default_assignee` / `project_lead` / `default_state` | 默认值 |
| `timezone` | 项目时区 |

**自动化**在 CE 里只有两条（`components/automation/`）：

- `archive_in`：N 个月没动的已完成项自动归档
- `close_in`：N 个月没动的项自动关闭

其余自动化（触发器/动作、审批流、循环）都是付费版。

## 11. 权限与公开分享

- 三层成员关系：`WorkspaceMember` / `ProjectMember` / 角色枚举 `ROLE`，
  邀请走 `WorkspaceMemberInvite` / `ProjectMemberInvite`。
- 项目可见性 `ProjectNetwork`：私有 / 工作区公开。
- **对外公开**：`DeployBoard` / `ProjectDeployBoard` 把项目发布到 `space` 应用，
  外部人可看、可评论、可投票（`IssueVote`），身份记在 `ProjectPublicMember`。

## 12. 认证与实例管理

CE 自带的登录方式（`apps/api/plane/authentication/provider/`）：

- 邮箱密码、**魔法链接**（magic code）
- OAuth：Google、GitHub、GitLab、**Gitea**

**OIDC 与 SAML 不在 CE**，是付费版起步档的卖点。

自托管的实例级配置走 `apps/admin`（God mode）：开关注册、配置邮件、
配置各 OAuth 应用、AI 配置等。

## 13. 集成、导入导出、API

| 能力 | 范围 |
| --- | --- |
| **GitHub 集成** | 仓库同步、Issue 双向同步、评论同步（`integration/github.py`） |
| **Slack 集成** | 项目级同步（`SlackProjectSync`） |
| **导入** | GitHub、Jira（`Importer.service` 只有这两个枚举值） |
| **导出** | CSV / JSON / XLSX |
| **REST API** | 公开 v1：project / issue / cycle / module / state / estimate / intake / member / asset / sticky / user / invite（`apps/api/plane/api/views/`） |
| **API Token** | `APIToken` + `APIActivityLog`（调用留痕） |
| **Webhook** | `Webhook` / `ProjectWebhook` / `WebhookLog`，工作区设置里配 |

## 14. 国际化与 AI

**19 种语言**（`packages/i18n/src/locales/`）：

```
cs de en es fr id it ja ko pl pt-BR ro ru sk tr-TR ua vi-VN zh-CN zh-TW
```

简体、繁体中文都有。

**AI**：编辑器内的助手叫 **Pi**，CE 里只有一个任务类型
`ASK_ANYTHING`（`packages/constants/src/ai.ts`）。

---

## 15. 开源版与付费版的分界线

**这一节是这份文档里最值得看的部分**，因为它最容易被弄错：官网列的功能
不等于开源仓库里的功能。

分界线在代码里有一个很直白的证据——`apps/web/app/routes/extended.ts`：

```ts
export const extendedRoutes: RouteConfigEntry[] = [];
```

CE 的"扩展路由"是个**空数组**。主路由文件把它和 `coreRoutes` 合并
（`mergeRoutes(coreRoutes, extendedRoutes)`）。也就是说，商业版是通过
替换这个文件往里注入整块整块的功能的。同样地，`packages/editor/src/ee/`
是编辑器里唯一的 `ee` 目录。

各档卖点（原文抄自 `packages/constants/src/subscription.ts`）：

| 档位 | 相对上一档新增 |
| --- | --- |
| **Free** | 本仓库的全部内容 |
| **One** | OIDC + SAML SSO、Active Cycles、实时协作与公开视图/页面、页面与工作项互链、时间跟踪（有限批量操作）、Docker/K8s 部署 |
| **Pro** | **仪表盘与报表**、完整时间跟踪 + 批量操作、**Teamspaces**、触发器与动作、**Wiki**、常用集成 |
| **Business** | **项目模板**、**工作流与审批**、决策与循环自动化、自定义报表、**嵌套页面**、**收件箱表单** |
| **Enterprise** | 私有/托管部署、GAC、LDAP、数据库与公式、无限自动化流、专业服务 |

有几处在 CE 里留了"半截"，看代码时容易误判：

| 东西 | CE 里有什么 | 实际 |
| --- | --- | --- |
| **时间跟踪** | `Project.is_time_tracking_enabled` 开关、导出类型 `issue_worklogs`、一个空状态插画 | **没有 Worklog 模型、没有 API、没有 UI**。开关是给付费版用的挂点 |
| **Epic 史诗** | `IssueType.is_epic` 字段、`epic-modal` 组件、甘特里的 epic 分支 | **没有 `/epics` 路由**，导航入口由商业版注入 |
| **仪表盘** | `dashboard.ts` 里的时间筛选枚举、`home/widgets/` 三个组件 | 主页只有快捷链接和最近访问，不是可配置仪表盘 |

所以判断"某个功能是不是开源的"，光看有没有相关字段不够——**要看有没有路由、
有没有模型、有没有 API**。

## 16. 几处值得注意的设计选择

不是功能清单，是看代码时觉得有意思的地方：

1. **周期与模块是正交的两把刀。** 时间盒和功能域各切一次，一个工作项可以
   同时属于一个周期和一个模块。Jira 里 Sprint 和 Epic 是混在一起谈的，
   Plane 把它拆干净了。

2. **排期约束建在关联上，没有另设一套结构。** `start_before` /
   `finish_before` 这四种是排期语义，和 `blocked_by`、`relates_to` 共用
   同一张 `IssueRelation` 表。数据结构上已经备好了做依赖排期——只是开源版的
   甘特图还没把它画出来。

3. **文档不属于项目。** Page 挂在工作区上，通过中间表关联到项目——
   一份文档可以同时服务多个项目，也可以不属于任何项目。

4. **描述存四份。** json / html / stripped / binary。最后一份是 Yjs 的
   二进制状态，实时协作要它；`stripped` 是纯文本，搜索要它。用空间换了
   协同编辑和搜索这两件事。

5. **草稿有独立模型。** `DraftIssue` 及其一整套关联表，而不是在 `Issue`
   上加个 `is_draft`——虽然 `Issue` 上**也**有 `is_draft` 字段。两套并存，
   看起来是历史演进留下的。

6. **收件箱的落点是一个状态组。** `triage` 是六个状态组之一，不是项目外的
   独立区域。于是分诊中的东西天然出现在同一套视图和筛选里。

7. **商业版靠"路由注入"而不是代码分叉。** 空的 `extendedRoutes` 是一个
   干净的扩展点，CE 与商业版共用同一份核心代码。

---

## 附：功能速查表

| 分类 | 功能 |
| --- | --- |
| 视图布局 | 列表、**看板**、日历、表格、**甘特图** |
| 工作组织 | 工作区、项目、工作项、子项、周期（Sprint）、模块、工作项类型 |
| 工作项能力 | 富文本描述、六种关联、附件、外链、评论、表情回应、@提及、订阅、投票、活动流、版本历史、草稿、归档 |
| 属性 | 状态（六组）、优先级（五档）、标签、多负责人、估点（两种制式）、起止日期、项目内编号 |
| 文档 | 页面（富文本 + 实时协同 + 版本历史 + 标签） |
| 流程 | 收件箱分诊、自动归档、自动关闭 |
| 洞察 | Analytics（工作区级 + 项目级）、可保存分析视图、分析导出、燃尽图、Active Cycles |
| 协作 | 实时协同编辑、应用内通知、邮件通知、通知偏好、命令面板、便签 |
| 分享 | 公开看板/视图/页面（`space` 应用）、外部评论与投票 |
| 权限 | 工作区/项目双层成员与角色、项目可见性、访客可见范围 |
| 认证 | 邮箱密码、魔法链接、Google、GitHub、GitLab、Gitea |
| 集成 | GitHub（双向同步）、Slack |
| 数据 | GitHub/Jira 导入，CSV/JSON/XLSX 导出，REST API，API Token，Webhook |
| 运维 | 实例管理（God mode）、Docker / Kubernetes 自托管 |
| 其他 | 19 种语言（含简繁中文）、AI 助手 Pi、收藏、最近访问、归档 |
