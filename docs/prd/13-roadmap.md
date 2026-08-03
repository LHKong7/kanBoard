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
| 租户隔离：`tenant` 列 + PG RLS（v1 单租户运行） | FR-ARCH-005, FR-IAM-015 |
| Domain Event（outbox）+ 审计日志 | FR-RES-006, FR-IAM-013 |
| 分层架构与 CI 依赖校验（dependency-cruiser） | FR-ARCH-001~003, 005, 010 |

**技术基线**（已定稿）：TypeScript / Node 22 LTS · Fastify · Zod · PostgreSQL 15+ · pg/Kysely ·
PG outbox · 递归 CTE 图查询
（[ADR-0007](../adr/0007-typescript-server-stack.md) / [ADR-0005](../adr/0005-tenancy-model.md)）

**出口标准**
- 至少 5 种 EntityType 通过同一套 API 完成全生命周期操作
- 绕过 PDP 的写路径为 0（自动化检查）
- 深度 5 图遍历 P95 < 500ms（100 万节点样本）
- **移除应用层 tenant 过滤后，RLS 仍能阻止跨租户读取**（ADR-0005 核心验收项）
- `tsc --strict` 零错误；所有外部输入边界具备 Zod 校验（FR-ARCH-010）
- NFR-PERF 基线在 Node 下重新标定并达标（未达标项须显式调整目标并记录）

---

### M1 · Domain & Workflow（领域）

**目标**：研发流程可完整跑通（无 AI）。

| 交付 | 关联需求 |
| --- | --- |
| 7 个限界上下文的核心聚合 | FR-DOM-001~008 |
| Workflow Engine：状态机 + guard + capability + SLA | FR-WF-001~004 |
| 自动化规则引擎（when/if/then） | FR-WF-005, 008, 009 |
| **Web UI：需求/迭代/任务/看板基础视图** | — |
| Outbox poller（消费事件、触发自动化） | FR-WF-005/006 |
| Dashboard 基础指标（Project + Team） | FR-DASH-001/002/005/006/010 |
| 按限界上下文重组模块 + BC 间依赖规则 | FR-ARCH-001, [ADR-0008](../adr/0008-modular-monolith.md) |

> **UI 在 M1 是必需项而非可选项**：[ADR-0011](../adr/0011-dogfooding-first.md) 决定先内部自用，
> 团队每天要用，只有 API 是用不起来的。

**出口标准**
- **ProjectOS 自身的一个真实迭代**在系统内从 Requirement 跑到 Release（[ADR-0011](../adr/0011-dogfooding-first.md)）
- 团队"绕开系统用别的工具"的次数被记录；绕开的地方即产品缺陷
- 全链路可追溯覆盖率 ≥ 90%

---

### M2 · Integration（集成）

**目标**：接入真实研发工具链，数据自动流入。

| 交付 | 关联需求 |
| --- | --- |
| Connector 统一契约与运行时 | FR-CON-001~005 |
| **GitHub Connector（PR/Commit/Review/CI）** | FR-CON-006 |
| MCP Connector | FR-CON-008 |
| ~~Jira Connector（双向同步）~~ → 移出 M2 | FR-CON-007 |
| 自动关系建立规则 | FR-ONT-008 |
| 外部事件触发自动化 | FR-WF-006 |
| 凭据管理与数据分级脱敏 | FR-CON-011/012 |

> **Jira Connector 移出 M2**：[ADR-0011](../adr/0011-dogfooding-first.md) 决定先内部自用，
> 而我们自己不用 Jira。双向同步改为按试点客户需求触发（M3 后）。
> 腾出的工作量投入 GitHub Connector 与自动关系建立——那是我们每天会用到的。

**出口标准**
- 我们自己的 PR 合并后自动推进 Task，无需人工操作
- Requirement → Commit → PR → Release 关系 100% 自动建立

---

### M3 · Intelligence（智能）

**目标**：Agent 真正承担交付工作。

| 交付 | 关联需求 |
| --- | --- |
| Agent Runtime（定义、执行、Memory、轨迹） | FR-AGT-001~008 |
| Agent Run worker 进程隔离 + AbortSignal 全链路取消 + 队列背压 | FR-ARCH-009/011 |
| 人机协作四模式 + 不可逆操作确认 | FR-AGT-009/010 |
| Agent 临时授权 + 护栏 + blastRadius | FR-IAM-006~009, 012, FR-AGT-012 |
| 首批 Agent：Requirement / PM / Meeting / Knowledge | FR-AI-001~003, 006/007/009/010 |
| 提示注入防护、PII 脱敏管道、模型供应商白名单与出境审计 | FR-AI-013/014, NFR-SEC-007, NFR-COMP-004/007 |
| Agent Dashboard（含 Automation Rate） | FR-DASH-003 |
| Browser Connector（白名单 + 敏感动作确认） | FR-CON-009/010 |

**出口标准**
- Automation Rate ≥ 15%（口径见 [11-dashboard §2](11-dashboard.md)，即 L3：零编辑 + 7 天未推翻）
- Agent 产出采纳率 ≥ 60%
- 零越权事件；100% Agent 行为可审计回放
- 出境审计完整：每次外部模型调用可查到租户、对象、最高分级、供应商

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
| Jira Connector（按试点客户需求） | FR-CON-007 |
| 引入 2–3 个外部试点团队 | [ADR-0011](../adr/0011-dogfooding-first.md) 过拟合缓解 |

**出口标准**
- Automation Rate ≥ 35%（北极星目标）
- 单交付项 Agent 成本季度环比下降 ≥ 15%
- 支撑 ≥ 10 个团队并行使用
- 源自自身工作流的假设已逐条在试点团队上检验（[ADR-0011](../adr/0011-dogfooding-first.md)）

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
