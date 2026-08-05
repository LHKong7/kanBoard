# 05 · Agent Layer 与 Agent Runtime

| 项 | 值 |
| --- | --- |
| 版本 | v1.0 |
| 状态 | Draft |
| 更新时间 | 2026-08-03 |

> 这是整个系统区别于 Jira 最大的一层。
> ProjectOS 内所有工作，都可以交给 Agent。

---

## 1. Agent 抽象

**Agent 不是 LLM。**
LLM 只是 Agent 的推理器之一。Agent 是一个**统一的能力体**。

```
Agent
├── Identity      身份（可被授权、被审计、被追责）
├── Skill         技能（可复用的做事方法）
├── Memory        记忆（短期 / 长期 / 项目级）
├── Workflow      工作流（可编排的执行图）
├── Tool          工具（函数 / MCP / 内部 API）
├── Connector     连接器（访问外部系统的唯一通道）
├── Permission    权限（Capability 集合，最低权限）
└── Context       上下文（本体子图 + 相关知识）
```

### Agent 定义示例

```yaml
agent: coding-agent
version: 2.1.0
description: 承接 Task，产出可评审的 PR
identity:
  principal: agent://coding-agent
  owner: team-platform
skills:
  - skill://read-codebase
  - skill://write-patch
  - skill://run-tests
tools:
  - connector://github
  - connector://ci
  - tool://ontology-query
capabilities:                 # 最低权限，见 07
  - Code.Read
  - Code.Write
  - PR.Create
  - Task.Update:own
memory:
  episodic: { scope: run, ttl: 7d }
  semantic: { scope: project, source: knowledge-bc }
modelPolicy:
  default: tier-high
  fallback: tier-mid
  maxTokensPerRun: 400000
budget:
  maxCostPerRun: 2.00 USD
guardrails:
  requireHumanApproval: [PR.Merge, Release.Promote]
  forbidden: [Project.Delete, Permission.Grant]
```

---

## 2. 内置 Agent 目录

| Agent | 职责 | 主要产出 |
| --- | --- | --- |
| **Requirement Agent** | 澄清需求、生成结构化 Requirement 与 Acceptance | Requirement / Acceptance |
| **Architecture Agent** | 影响面分析、方案对比、ADR 草案、API 契约评审 | Architecture / Decision |
| **Coding Agent** | 承接 Task、改代码、跑测试、提 PR | PR / Patch |
| **QA Agent** | 生成用例、执行验证、缺陷归因 | TestCase / Issue |
| **PM Agent** | WBS、Story 拆分、估点、Sprint 规划、风险发现 | Story / Sprint / Risk |
| **Research Agent** | 技术调研、竞品分析、方案取证（含 Browser） | Research / Knowledge |
| **Meeting Agent** | 会议转写、纪要、行动项抽取 | Meeting / Task |
| **Release Agent** | 发布单编排、变更清单、灰度检查 | Release / Checklist |
| **Knowledge Agent** | 知识抽取、去重、时效复核、关系补全 | Knowledge / Relation |

所有 Agent 共享**同一个 Runtime**。

---

## 3. Agent Runtime

### 3.1 执行模型

```
Trigger（事件 / 定时 / 人工 / 另一个 Agent）
   │
   ▼
Goal 解析 ──► 计划（Plan）
   │
   ▼
┌──────────── Loop ────────────┐
│  Context 装配                 │  ← 本体子图 + Memory + Knowledge
│      ▼                        │
│  Reasoning（模型推理）        │  ← 记录 Reasoning 实体
│      ▼                        │
│  Tool / Connector 调用        │  ← 每次调用先过 PDP
│      ▼                        │
│  Observation（观察结果）      │  ← 记录 Observation 实体
│      ▼                        │
│  终止条件判断                 │
└───────────────────────────────┘
   │
   ▼
Artifact 产出 ──► 写回 Domain Object ──► 人工审阅（可选）
   │
   ▼
Memory 固化 + 成本结算 + 审计
```

### 3.2 Context 装配（关键差异点）

Agent 的上下文**不是**把文档塞进 prompt，而是从本体图中**按需检索**：

```
给定 Task:123
  ├─ 沿 implementedBy 逆向 → Story → Requirement（为什么做）
  ├─ 沿 constrains → Architecture（怎么做的约束）
  ├─ 沿 explains → Decision（历史上怎么定的）
  ├─ 沿 derivedFrom → Knowledge（相似问题的经验）
  └─ Memory（本 Agent 在此项目的历史）
```

每一段上下文都带**出处实体 ID**，产出可回溯。

### 3.3 Memory 模型

| 类型 | 作用域 | 生命周期 | 存储 |
| --- | --- | --- | --- |
| Working Memory | 单次 Run | Run 结束即释放 | 内存 |
| Episodic Memory | Agent × Project | 可配置 TTL（默认 30d） | 关系库 + 向量 |
| Semantic Memory | Project / Workspace | 长期 | Knowledge BC（共享） |
| Procedural Memory | Agent | 长期 | Skill / Prompt 实体 |

**规则**：Semantic Memory 必须落到 Knowledge BC，不允许 Agent 私藏项目知识。

### 3.4 可观测性

每次 Run 产出完整轨迹：

| 记录 | 内容 |
| --- | --- |
| `AgentRun` | goal, status, 起止时间, 触发源 |
| `Reasoning[]` | 每步推理、使用模型、token 数、耗时 |
| `Observation[]` | 每次工具调用的入参与结果（敏感字段脱敏） |
| `Artifact[]` | 产出物及其被采纳情况 |
| `AuditLog[]` | 每次权限决策（Allow/Deny/Ask） |

轨迹在 UI 中可回放；失败可从任意步骤重放（replay）。

---

## 4. 人机协作模式（Human-in-the-loop）

| 模式 | 说明 | 默认适用 |
| --- | --- | --- |
| **Suggest** | Agent 只给建议，人工采纳 | 需求生成、估点、风险 |
| **Draft** | Agent 产出草稿对象（状态=Draft），人工审阅后生效 | PRD、ADR、Story 拆分 |
| **Execute-with-review** | Agent 执行并产出可评审物（PR），人工合并 | Coding、QA |
| **Autonomous** | Agent 全自动，仅事后审计 | 会议纪要、知识去重、指标物化 |

**规则**：
- 默认模式由 Agent 定义中的 `guardrails` 决定，可按项目覆盖。
- 任何不可逆操作（合并、发布、删除、授权）**永远**需要人工确认或显式的项目级豁免。

---

## 5. 多 Agent 协作（Agent Graph）

Agent 之间通过**领域对象**协作，而不是直接对话：

```
PM Agent  ──创建──► Story ──事件──► Coding Agent
                       │
Architecture Agent ──评审──► Decision ──约束──► Coding Agent
                                                    │
                                                产出 PR
                                                    │
                                              QA Agent 验证
                                                    │
                                          Knowledge Agent 沉淀
```

优点：

- 协作过程本身就是可审计的领域数据
- 任一 Agent 可被替换（人或另一个 Agent），协议不变
- 无需维护脆弱的 Agent 间私有消息协议

**编排**：由 Workflow Engine 承载（见 [08](08-workflow-engine.md)），
支持串行、并行、条件分支、人工节点、超时与补偿。

---

## 6. 成本与模型策略

| 机制 | 说明 |
| --- | --- |
| 模型分级 | tier-high / tier-mid / tier-low，按任务复杂度路由 |
| 预算 | Agent 级、项目级、租户级三层预算，超限 Deny 或降级 |
| 缓存 | 上下文前缀缓存、相同 Goal 的结果缓存 |
| 成本归因 | 每次 Run 的成本归因到 Task / Requirement / Project |
| 熔断 | 单 Run 超 `maxTokensPerRun` 或 `maxCostPerRun` 即终止并告警 |

---

## 7. 需求条目

| ID | 需求 | 优先级 | 验收标准 |
| --- | --- | --- | --- |
| FR-AGT-001 | Agent 以声明式定义（YAML/JSON）注册并版本化 | M | 可注册、查询、回滚 Agent 版本 |
| FR-AGT-002 | 统一 Agent Runtime 执行所有内置 Agent | M | 9 个内置 Agent 共用同一执行入口，无专用分支 |
| FR-AGT-003 | Agent 具备独立 Identity，可被授权与审计 | M | 审计日志中 Agent 行为主体可精确定位到 Agent 版本 |
| FR-AGT-004 | Context 从本体图按需装配，每段带出处 | M | Run 轨迹中可查看上下文来源实体清单 |
| FR-AGT-005 | 四级 Memory 模型实现 | M | Working/Episodic/Semantic/Procedural 均可读写并遵守 TTL |
| FR-AGT-006 | Semantic Memory 必须落 Knowledge BC | M | 不存在 Agent 私有的项目级长期知识存储 |
| FR-AGT-007 | 完整 Run 轨迹记录与 UI 回放 | M | 任一 Run 可逐步回放推理、工具调用与产出 |
| FR-AGT-008 | 支持从任意步骤 replay | S | replay 后产生新 Run 并关联原 Run |
| FR-AGT-009 | 四种人机协作模式可配置 | M | 按 Agent + 项目两级配置，生效即时 |
| FR-AGT-010 | 不可逆操作强制人工确认 | M | 未确认时操作被拒绝并记录 Ask 决策 |
| FR-AGT-011 | Agent 通过领域对象协作，不使用私有消息通道 | M | 代码审查确认无 Agent 间直连通道 |
| FR-AGT-012 | 三层预算与熔断 | M | 超预算触发终止 + 告警，测试可验证 |
| FR-AGT-013 | 模型分级路由，供应商可插拔 | S | 切换模型仅需修改 modelPolicy |
| FR-AGT-014 | 成本归因到业务对象 | S | Dashboard 可按 Project/Requirement 查看 Agent 成本 |
| FR-AGT-015 | Agent 产出采纳率统计 | S | Dashboard 展示每个 Agent 的采纳率趋势 |
| FR-AGT-016 | 自定义 Agent（租户自建） | C | 用户可基于模板创建 Agent 并受同样权限约束 |
