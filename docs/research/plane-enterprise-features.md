# Plane 企业级（付费档）功能盘点

[plane-features.md](plane-features.md) 盘的是开源版有什么。这份盘的是
**付费档才有的那些**，以及其中哪些 ProjectOS 已经有了。

## 口径

来源不是官网定价页（它 403），是 Plane 自己仓库里的对照表：

| 项 | 值 |
| --- | --- |
| 文件 | `apps/web/core/components/workspace/billing/comparison/plans.tsx` |
| commit | `makeplane/plane@main`（2026-08-05 取） |
| 规模 | **14 组 87 条** |
| 档位 | free / one / pro / business / enterprise |

也就是说，下面每一格都是 Plane 自己写下的口径，不是我从功能描述里推的。

> 一处解析上的说明：`Estimates` 在源码里落在第一组的末尾，
> 但按语义属于第二组。除此之外分组与源码一致。

---

## 一、完整对照表

`Y` = 该档包含 · `—` = 不包含 · 其余为该档的具体口径

### 1. Project + work tracking（免费档就有）

| 功能 | free | one | pro | business | enterprise |
| --- | :--: | :--: | :--: | :--: | :--: |
| Projects / Work items / Comments / Cycles / Modules / Intake | Y | Y | Y | Y | Y |

### 2. Project + work management（付费的主战场）

| 功能 | free | one | pro | business | enterprise |
| --- | --- | --- | --- | --- | --- |
| Estimates 估点 | Basic | Basic | Advanced | Advanced | Advanced |
| **Bulk Ops 批量操作** | — | 有限属性 | 全部属性 | Y | Y |
| **Time Tracking + Worklogs 工时** | — | 基础 | 历史工时单 | 工时单 + 审批 | 工时单 + 审批 |
| Active Cycles 活跃周期 | — | Y | Y | Y | Y |
| Work item Types 工作项类型 | — | — | Y | Y | Y |
| **Custom Properties 自定义属性** | — | — | 项目级 | 工作区级 | 工作区级 |
| **Dependencies in Gantt 甘特依赖** | — | — | Y | Y | Y |
| Work item Transfers 工作项转移 | — | — | Y | Y | Y |
| Auto-transfer Cycle Work items 周期未完成项自动转移 | — | — | Y | Y | Y |
| **Epics 史诗** | — | — | Y | Y | Y |
| **Initiatives 举措**（跨项目） | — | — | Y | Y | Y |
| Checkpoints 检查点 | — | — | Y | Y | Y |
| Module Overview 模块总览 | — | — | Y | Y | Y |
| Auto-assignment In Modules 自动指派 | — | — | 线性 | 轮询 + 容量 | 轮询 + 容量 |
| Public / Private / Secret projects 项目可见性三档 | — | — | Y | Y | Y |
| State Of Projects 项目状态 | — | — | Y | Y | Y |
| **Pre-defined work item Templates 工作项模板** | — | — | Y | Y | Y |
| Teamspace Cycles 团队空间周期 | — | — | — | Y | Y |
| **Project Templates 项目模板** | — | — | — | Y | Y |
| **Baselines And Deviations 基线与偏差** | — | — | — | Y | Y |
| Scheduled Comms 定时播报 | — | — | — | Y | Y |
| Intake Assignees 收件箱指派人 | — | — | — | Y | Y |
| **Custom SLAs 自定义 SLA** | — | — | — | Y | Y |
| Intake Forms 收件箱表单 | — | — | — | Y | Y |
| Emails For Intake 邮件提报 | — | — | — | Y | Y |

### 3. Visualization

| 功能 | free | one | pro | business | enterprise |
| --- | :--: | :--: | :--: | :--: | :--: |
| Layouts / Views | Y | Y | Y | Y | Y |
| **Shared Views 共享视图** | — | — | Y | Y | Y |
| **Publish Views 发布视图** | — | — | Y | Y | Y |
| **Dashboards and Widgets 仪表盘** | — | — | Y | Y | Y |

### 4. Analytics + reports

| 功能 | free | one | pro | business | enterprise |
| --- | :--: | :--: | :--: | :--: | :--: |
| Progress Charts 进度图 | — | — | Y | Y | Y |
| Cycle Reports 周期报表 | — | — | Y | Y | Y |
| Insights 洞察 | — | — | Y | Y | Y |
| Advanced Pages Analytics | — | — | — | Y | Y |
| **Custom Reports 自定义报表** | — | — | — | Y | Y |

### 5. Navigation

| 功能 | free | one | pro | business | enterprise |
| --- | :--: | :--: | :--: | :--: | :--: |
| Power K 命令面板 | Y | Y | Y | Y | Y |
| **PQL 查询语言** | — | — | Y | Y | Y |

### 6. Workspace and user management

| 功能 | free | one | pro | business | enterprise |
| --- | --- | --- | --- | --- | --- |
| Member limit 成员数 | 12 | — | 无限 | 无限 | 无限 |
| **Roles 角色模型** | 基础 | 基础 | 预定义角色 | **RBAC** | **GAC** |
| Guests 访客 | — | 每付费成员 5 名 | 同左 | 同左 | 同左 |
| **Approvals 审批** | — | — | — | Y | Y |
| Admin Interface 管理界面 | — | — | — | Y | Y |
| Workspace Activity Logs 活动日志 | — | — | — | Y | Y |
| **API-enabled Audit Logs 可调用的审计日志** | — | — | — | Y | Y |

### 7. Automations and workflows

| 功能 | free | one | pro | business | enterprise |
| --- | --- | --- | --- | --- | --- |
| **Trigger And Action 触发器与动作** | — | — | Y | Y | Y |
| **Decisions And Loops 决策与循环** | — | — | — | Y | Y |
| Number of automations 自动化条数 | — | — | 5 | 10 | 无限 |

### 8. Knowledge management

| 功能 | free | one | pro | business | enterprise |
| --- | --- | --- | --- | --- | --- |
| Pages 页面 | Y | Y | Y | Y | Y |
| **Real-time Collab 实时协同** | — | Y | Y | Y | Y |
| Work item Embeds 工作项嵌入 | — | Y | Y | Y | Y |
| Link-to-work items 页面与工作项互链 | — | Y | Y | Y | Y |
| Publish 发布 | — | Y | Y | Y | Y |
| **Wiki 工作区知识库** | — | Y | Y | Y | Y |
| Exports 导出 | — | — | 一次一个 | 排队下载 | 排队下载 |
| Templates 页面模板 | — | — | Y | Y | Y |
| **Versions 版本保留** | — | — | 2 天 | 3 个月 | 无限 |
| Databases + Formulas 数据库与公式 | — | — | — | Y | Y |
| Nested Pages 嵌套页面 | — | — | — | Y | Y |

### 9–14. 其余

| 组 | 付费才有的 |
| --- | --- |
| Importers | Jira / GitHub 导入**带自定义属性**（pro 起） |
| Integrations | GitHub / Slack / Zapier / Zendesk / Freshdesk（pro 起） |
| Storage | 空间 5GB → 1TB → 5TB → 定制；单文件 5MB → 100MB → 200MB |
| Security | **SAML / OIDC**（one 起）、域名安全 / 2FA / 密码策略（pro 起）、**LDAP**（仅 enterprise） |
| Self-hosted | 一键部署、DO / Heroku / AWS 镜像（one 起）、**私有部署**（仅 enterprise） |
| Support | SLA（pro 起）、全套专业服务（business 起） |

---

## 二、对 ProjectOS 意味着什么

把 87 条按"我们的处境"重新分堆。**这一节是这份文档的用处所在。**

### A. ProjectOS 已经有了，而且是 Plane 收费的（12 条）

这些不需要补——有些还做得更深：

| Plane 收费项 | ProjectOS 对应 | 谁更深 |
| --- | --- | --- |
| Approvals（business） | `Approval` 实体 + 审批策略 + 配不掉的 Deny | ProjectOS |
| Trigger And Action（pro） | 自动化规则 when/if/then + 防环 + 留痕 | ProjectOS |
| Decisions And Loops（business） | 多步骤流程编排 + 失败补偿 | ProjectOS |
| Number of automations（限 5/10 条） | **不限条数** | ProjectOS |
| Custom SLAs（business） | SLA 定义 + 巡检 + 违约记录 | 相当 |
| API-enabled Audit Logs（business） | 追加写审计（`REVOKE UPDATE,DELETE` + 触发器） | ProjectOS |
| Roles → RBAC / GAC（business/ent） | 五层 PDP + Capability + 临时授权 + 委派 | ProjectOS |
| Work item Types（pro） | 本体里 18 类实体，且可扩展 | ProjectOS |
| **Custom Properties（pro/business）** | **租户扩展**：租户自己加类型和属性 | ProjectOS |
| **Dependencies in Gantt（pro）** | 已实现，且 Plane **开源版根本不画线** | ProjectOS |
| Cycle Reports / Progress Charts（pro） | 30 个指标含 Burn Down / Velocity / Cycle Time | ProjectOS |
| Estimates Advanced（pro） | `storyPoint` + AI 估点带类比依据 | 相当 |

**一句话：Plane 拿去卖 pro/business 的那批"高级"能力，有一半在
ProjectOS 里是免费且更严谨的地基。** 这不是巧合——那些能力都长在
权限模型和工作流引擎上，而那正是 ProjectOS 一开始就做的部分。

### B. ProjectOS 没有，值得补（本轮实现）

挑的判据是"在这套架构里代价小、对企业场景价值大"：

| 企业功能 | Plane 档位 | 在 ProjectOS 里要做什么 |
| --- | --- | --- |
| **Teamspace 团队空间** | business | 一个实体 + 两条关系 |
| **Initiative 举措**（跨项目） | pro | 一个实体 + 关系 |
| **Template 模板**（项目/工作项） | pro / business | 一个实体 + 一次"套用" |
| **Worklog 工时** | one / pro | 一个实体 + 关系 + 汇总 |
| **SavedView 可保存 / 可分享视图** | pro | 一个实体（筛选条件本来就能序列化） |
| **Baseline 基线与偏差** | business | 一个实体 + 与计划日期比对 |
| **Bulk Ops 批量操作** | one / pro | 一个自定义方法 |

**关键判断：这些在 ProjectOS 里主要是"声明"，不是"代码"。**
统一 Resource 模型（ADR-0002）意味着新增一类对象不需要新端点、
不需要迁移、不需要新权限体系——写进本体就有了 CRUD、查询、权限、
审计、历史、图关系。这正是当初那套地基要换的东西，现在到了兑现的时候。

### C. ProjectOS 没有，但这轮不做（说明理由）

| 企业功能 | 为什么不做 |
| --- | --- |
| SAML / OIDC / LDAP / 2FA / 密码策略 | 属于认证那条线。它是**独立的一大块**，不该混在功能补齐里顺手做 |
| Real-time Collab / Nested Pages / Databases + Formulas | 需要协同编辑服务（Yjs）与文档引擎，是另一个子系统 |
| Storage 配额 / 附件 | 需要对象存储 |
| Zapier / Zendesk / Freshdesk | 连接器层已经有契约，加一个适配器是重复劳动而非架构问题 |
| Scheduled Comms / Intake Forms / Emails For Intake | 依赖邮件通道 |
| PQL 查询语言 | 现有筛选 + 全文检索覆盖了主要场景；自造一门查询语言要先有人真的被现有能力卡住 |
| Publish Views / 对外分享 | 需要一个面向匿名访问者的独立前端（Plane 用的是单独的 `space` 应用） |

---

## 三、一条结构性观察

Plane 的付费分层是**按功能切**的：同一个对象模型，pro 解锁 Epics，
business 解锁审批。因此它的开源版必然要留下大量"半截"——
字段在、路由不在（Epic）、开关在、实现不在（工时、甘特依赖线）。

ProjectOS 没有这个约束，于是可以反过来：**先把地基做厚，功能是地基的
自然结果**。上面 A 类那 12 条就是证据——它们不是被"实现"出来的，
是权限模型和工作流引擎顺带产出的。

这也解释了 B 类为什么便宜：统一资源模型 + 本体元模型，让"加一个
企业级对象"退化成"写一段声明"。
