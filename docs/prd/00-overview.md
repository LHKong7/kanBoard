# 00 · 产品愿景与定位

| 项 | 值 |
| --- | --- |
| 版本 | v1.0 |
| 状态 | Draft |
| 更新时间 | 2026-08-03 |

---

## 1. 愿景（Vision）

构建一个面向 AI 时代的软件研发项目管理平台。

ProjectOS 不仅管理任务（Task），而是管理整个研发生命周期中的**所有领域对象（Domain Object）**，
通过 **DDD（领域驱动设计）+ Ontology（本体）+ AI Agent**，建立统一的数据模型，
让 AI 与人共同参与项目交付。

最终实现的生命周期闭环：

```
Idea
  │
Objective
  │
Requirement
  │
Architecture
  │
Implementation
  │
Verification
  │
Release
  │
Knowledge
  └──────────► 反哺 Idea / Objective
```

整个生命周期**持续可追踪、可推理、可沉淀**。

---

## 2. 产品定位

**不是**：

```
Jira + Confluence + Notion
```

**而是**：

```
ProjectOS —— 统一的项目运行时（Project Runtime）
```

统一管理：

- 人（Human）
- Agent（AI 智能体）
- 数据（Data）
- 文档（Document）
- 工作流（Workflow）
- 权限（Permission）
- 知识（Knowledge）
- 生命周期（Lifecycle）

### 2.1 与既有形态的差异

| 维度 | 传统工具（Jira / Confluence / Notion） | ProjectOS |
| --- | --- | --- |
| 基本单元 | Issue / Page / Block | Domain Object（统一 Resource） |
| 需求形态 | Markdown / 富文本 | 结构化领域对象，可查询、可推理 |
| 关联方式 | 人工挂链接 | 本体关系天然生成 |
| 自动化 | 规则引擎（if-then） | Agent Runtime（目标驱动） |
| 权限 | RBAC | Identity + Role + Capability + Resource + Policy |
| AI 形态 | 侧边栏 Chat 插件 | AI 作为一等公民参与生命周期 |
| 知识 | 独立 Wiki（文档孤岛） | Knowledge 是领域对象，与执行同源 |

### 2.2 "Jira + AI" 为什么不够

在 Jira 上加 AI，AI 只能看到**任务的影子**：标题、描述、状态。
它看不到需求为什么存在、架构为什么这样设计、上次相似决策的结论是什么。
于是 AI 只能做摘要和润色，无法真正承担交付。

ProjectOS 的前提是：**先让世界可被机器理解，再让 AI 参与。**

---

## 3. 核心理念

> 整个系统不存在"文档孤岛"。所有信息都是领域对象。

| 传统认知 | ProjectOS 中的形态 |
| --- | --- |
| Requirement 是一份 Markdown | Requirement 是 **Domain Object** |
| Architecture 是一张图片 | Architecture 是 **Domain Object** |
| Meeting 是一段录音/纪要 | Meeting 是 **Domain Object** |
| Task | 只是 Domain Object 的**一种** |

推论：

1. 任何对象都可被查询、订阅、授权、编排、推理。
2. 任何对象都有 ID / Owner / Status / Permission / Relation / History。
3. 任何对象都可以被 Agent 读写——在权限允许的范围内。

---

## 4. 目标用户与核心场景

### 4.1 用户画像

| 角色 | 关键诉求 | ProjectOS 提供 |
| --- | --- | --- |
| 产品经理 (PM) | 需求拆解、优先级、进度可见 | AI 拆 Epic→Story、自动 Roadmap、风险预警 |
| 研发工程师 (RD) | 少填表、上下文完整 | Commit/PR 自动回写、需求上下文直达 IDE |
| 架构师 | 设计一致性、决策可追溯 | Architecture 对象化、ADR 与需求双向关联 |
| 测试 (QA) | 验收标准清晰、覆盖可量化 | Acceptance 结构化、需求-用例-缺陷可追溯 |
| 技术负责人 / Leader | 交付确定性、容量与成本 | Project Intelligence、Agent 成本与自动化率 |
| 平台/安全管理员 | 可审计、最小权限 | 五层权限模型、Agent 临时授权与全量审计 |
| **AI Agent** | 明确目标、可用工具、受限权限 | Agent Runtime + Connector + Capability |

### 4.2 北极星场景

**场景 A：从一句话到可交付的 Sprint**
PM 输入一段业务想法 → Requirement Agent 生成结构化 Requirement 与验收标准 →
Architecture Agent 提出影响面与 ADR 草案 → PM Agent 生成 WBS / Story / 估点 / Sprint →
人工审阅确认 → 进入执行。

**场景 B：执行链路自动闭环**
Task 进入 Doing → Coding Agent 通过 Connector 读取仓库、产出 PR →
CI 结果回写 Verification → 合并后自动关联 Release →
Knowledge Agent 沉淀本次决策与经验为 Knowledge 对象。

**场景 C：知识可推理**
提问"我们为什么放弃了方案 X？" → 系统沿本体检索
`Decision --explains--> Requirement --implementedBy--> Task` ，
返回带出处的答案，而非语义相似的段落拼接。

---

## 5. 成功指标（North Star & KPI）

| 层级 | 指标 | 目标（GA 后 6 个月） |
| --- | --- | --- |
| 北极星 | **Automation Rate**：由 Agent 独立完成并被人类接受的工作项占比 | ≥ 35% |
| 效率 | 需求 → 可执行 Story 的平均耗时 | 下降 ≥ 60% |
| 质量 | 需求变更导致的返工率 | 下降 ≥ 30% |
| 追溯 | Requirement → Release 全链路可追溯覆盖率 | ≥ 95% |
| 知识 | Decision Coverage（重大决策有 ADR 记录的比例） | ≥ 80% |
| 知识 | Knowledge Reuse Rate（被复用的知识对象占比） | ≥ 25% |
| 成本 | 单个交付工作项的 Agent Token 成本 | 持续下降，季度环比 -15% |
| 信任 | Agent 产出的人工采纳率 | ≥ 70% |

---

## 6. 范围（Scope）

### 6.1 v1.0 In Scope

- Ontology Layer：本体定义、注册、版本化、关系推理（基础）
- 统一 Resource 模型与统一 CRUD / Query / Relation API
- 六大限界上下文的核心领域对象
- Workflow Engine：可配置状态机 + 自动化触发
- Agent Runtime：Agent 定义、执行、记忆、可观测
- Connector：GitHub / GitLab / Jira / 数据库 / REST / MCP / Browser
- 五层权限模型 + Agent 临时授权
- Project Intelligence Dashboard
- AI PM 能力集（WBS / Story 拆分 / 估点 / Roadmap / 风险 / 会议纪要）

### 6.2 Out of Scope（v1.0 明确不做）

| 项 | 原因 |
| --- | --- |
| 自研 LLM / 模型训练 | 以模型无关（model-agnostic）方式接入外部模型 |
| 完整 IM / 即时通讯 | 通过 Connector 接入现有 IM |
| 代码托管 / CI 引擎自研 | 通过 Connector 接入 GitHub/GitLab/CI |
| 财务与 HR 系统 | 通过 Connector 接入 ERP/HR |
| 富文本协同编辑器（多人实时光标） | v1.1 起评估；v1.0 使用结构化编辑 + 块级锁 |
| 移动端原生 App | v1.0 提供响应式 Web |

---

## 7. 关键假设与风险

| # | 假设 / 风险 | 影响 | 缓解 |
| --- | --- | --- | --- |
| R1 | 本体建模成本高，团队难以上手 | 高 | 提供开箱即用的默认本体包；本体可渐进扩展 |
| R2 | Agent 产出质量不稳定，损害信任 | 高 | 全链路 human-in-the-loop；Agent 产出默认为"建议"，需审阅 |
| R3 | Connector 侧第三方 API 变更 | 中 | Connector 契约化 + 版本化 + 契约测试 |
| R4 | Agent 权限泄露导致越权操作 | 极高 | 最低权限 + 临时授权 + 强制过期 + 全量审计（见 07） |
| R5 | 迁移成本：存量 Jira/Confluence 数据 | 中 | 双向 Connector 同步，允许并行运行期 |
| R6 | Token 成本失控 | 中 | 预算配额、成本看板、模型分级路由 |

---

## 8. 关联文档

- 设计原则 → [01-principles.md](01-principles.md)
- 总体架构 → [02-architecture.md](02-architecture.md)
- 路线图 → [13-roadmap.md](13-roadmap.md)
