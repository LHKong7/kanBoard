# 13 · 路线图与交付计划

| 项 | 值 |
| --- | --- |
| 版本 | v1.0 |
| 状态 | Draft |
| 更新时间 | 2026-08-03 |

---

## 1. 交付策略

**先立地基，再放 Agent。**

顺序不可颠倒：
本体与统一数据模型 → 权限 → 工作流 → Connector → Agent → 智能。
在没有本体与权限的前提下引入 Agent，等于在没有地基的地上盖楼。

```
M0 基础  →  M1 领域  →  M2 集成  →  M3 智能  →  M4 规模化
```

---

## 2. 里程碑

### M0 · Foundation（地基）

**目标**：本体 + 统一 Resource + 权限 PDP 可用。

| 交付 | 关联需求 |
| --- | --- |
| Ontology Registry（类型注册、校验、版本化） | FR-ONT-001/002/007 |
| 统一 Resource 模型与 CRUD/Query API | FR-RES-001~005, 012 |
| 关系存储与图遍历（PG 递归 CTE） | FR-ONT-003/004/005, FR-RES-007 |
| Identity + 五层权限 PDP（deny-by-default） | FR-IAM-001~005, 010, 015 |
| Domain Event（outbox）+ 审计日志 | FR-RES-006, FR-IAM-013 |
| 分层架构与 CI 依赖校验 | FR-ARCH-001~003, 005 |

**出口标准**
- 至少 5 种 EntityType 通过同一套 API 完成全生命周期操作
- 绕过 PDP 的写路径为 0（自动化检查）
- 深度 5 图遍历 P95 < 500ms（100 万节点样本）

---

### M1 · Domain & Workflow（领域）

**目标**：研发流程可完整跑通（无 AI）。

| 交付 | 关联需求 |
| --- | --- |
| 7 个限界上下文的核心聚合 | FR-DOM-001~008 |
| Workflow Engine：状态机 + guard + capability + SLA | FR-WF-001~004 |
| 自动化规则引擎（when/if/then） | FR-WF-005, 008, 009 |
| Web UI：需求/迭代/任务/看板基础视图 | — |
| Dashboard 基础指标（Project + Team） | FR-DASH-001/002/005/006/010 |

**出口标准**
- 一个真实项目从 Requirement 到 Release 全流程在系统内跑通
- 全链路可追溯覆盖率 ≥ 90%

---

### M2 · Integration（集成）

**目标**：接入真实研发工具链，数据自动流入。

| 交付 | 关联需求 |
| --- | --- |
| Connector 统一契约与运行时 | FR-CON-001~005 |
| GitHub Connector（PR/Commit/Review/CI） | FR-CON-006 |
| Jira Connector（双向同步 + 并行运行） | FR-CON-007 |
| MCP Connector | FR-CON-008 |
| 自动关系建立规则 | FR-ONT-008 |
| 外部事件触发自动化 | FR-WF-006 |
| 凭据管理与数据分级脱敏 | FR-CON-011/012 |

**出口标准**
- PR 合并自动推进 Task，无需人工操作
- Jira 双向同步 7 天无数据丢失与回环
- Requirement → Commit → PR → Release 关系 100% 自动建立

---

### M3 · Intelligence（智能）

**目标**：Agent 真正承担交付工作。

| 交付 | 关联需求 |
| --- | --- |
| Agent Runtime（定义、执行、Memory、轨迹） | FR-AGT-001~008 |
| 人机协作四模式 + 不可逆操作确认 | FR-AGT-009/010 |
| Agent 临时授权 + 护栏 + blastRadius | FR-IAM-006~009, 012, FR-AGT-012 |
| 首批 Agent：Requirement / PM / Meeting / Knowledge | FR-AI-001~003, 006/007/009/010 |
| 提示注入防护与出境控制 | FR-AI-013/014, NFR-SEC-007 |
| Agent Dashboard（含 Automation Rate） | FR-DASH-003 |
| Browser Connector（白名单 + 敏感动作确认） | FR-CON-009/010 |

**出口标准**
- Automation Rate ≥ 15%
- Agent 产出采纳率 ≥ 60%
- 零越权事件；100% Agent 行为可审计回放

---

### M4 · Scale（规模化）

**目标**：多团队、多租户、成本可控。

| 交付 | 关联需求 |
| --- | --- |
| 第二批 Agent：Coding / QA / Architecture / Release / Research | FR-AI-004/005/008, FR-AGT-002 |
| 多步骤编排与补偿 | FR-WF-010~013 |
| Knowledge 视角与本体健康度 | FR-DASH-004, FR-ONT-010 |
| 成本归因、模型分级、缓存 | FR-AGT-013/014, NFR-COST-001~004 |
| 独立图/向量存储演进 | FR-RES-015, FR-ONT-011 |
| 自定义 Agent 与租户本体扩展 | FR-AGT-016, FR-ONT-009 |
| 混合语义检索问答（带出处） | FR-RES-009, FR-ONT-011 |

**出口标准**
- Automation Rate ≥ 35%（北极星目标）
- 单交付项 Agent 成本季度环比下降 ≥ 15%
- 支撑 ≥ 10 个团队并行使用

---

## 3. 里程碑依赖

```
M0 ──► M1 ──► M2 ──► M3 ──► M4
 │              │       │
 └──────────────┴───────┘
   权限与本体是 M2/M3 的硬前置
```

**不允许的并行**：
- Agent Runtime（M3）不得早于权限模型（M0）与 Connector 契约（M2）
- 自动关系建立（M2）不得早于本体关系定义（M0）

---

## 4. 每个里程碑的通用门禁

| 门禁 | 要求 |
| --- | --- |
| 需求可追溯 | 里程碑内每个交付项关联到具体 FR/NFR ID |
| 测试 | 核心模块单测 ≥ 80%，领域不变量 ≥ 85%，关键路径 E2E |
| 安全 | 依赖扫描无高危；权限相关变更经安全评审 |
| 性能 | 对应 NFR 指标压测达标 |
| 文档 | PRD 与 ADR 同步更新；破坏性变更有迁移说明 |
| 可观测 | 新增能力具备日志、指标、trace |

---

## 5. 度量回顾节奏

| 频率 | 内容 |
| --- | --- |
| 每迭代 | Velocity、Cycle Time、风险列表 |
| 每月 | Automation Rate、采纳率、成本趋势、本体健康度 |
| 每里程碑 | 出口标准逐条核对，未达标项显式记录为债务并排期 |
