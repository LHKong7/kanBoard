# 03 · 领域模型（DDD）

| 项 | 值 |
| --- | --- |
| 版本 | v1.0 |
| 状态 | Draft |
| 更新时间 | 2026-08-03 |

---

## 1. 限界上下文总览

```
┌──────────────┐   ┌──────────────────┐   ┌──────────────┐
│  Project BC  │──►│  Requirement BC  │──►│ Execution BC │
└──────────────┘   └──────────────────┘   └──────────────┘
        │                   │                     │
        │                   ▼                     ▼
        │          ┌──────────────────┐   ┌──────────────┐
        └─────────►│ Architecture BC  │   │ Knowledge BC │
                   └──────────────────┘   └──────────────┘
                            ▲                     ▲
                            └─────────┬───────────┘
                                 ┌────────┐
                                 │  AI BC │
                                 └────────┘
                                      ▲
                                 ┌──────────┐
                                 │Identity BC│
                                 └──────────┘
```

| BC | 职责 | 聚合根 |
| --- | --- | --- |
| Project | 项目目标、里程碑、预算、风险 | `Project` |
| Requirement | 需求全生命周期与验收 | `Requirement` |
| Architecture | 系统设计资产 | `Architecture` |
| Execution | 迭代与执行 | `Sprint`, `Task`, `Release` |
| Knowledge | 知识与决策沉淀 | `Knowledge`, `Decision` |
| AI | Agent 及其运行资产 | `Agent`, `AgentRun` |
| Identity | 身份与权限 | `Identity`, `Policy` |

---

## 2. Project Context

```
Project
├── Vision        愿景陈述
├── Goal          目标 / OKR
├── Milestone     里程碑
├── Roadmap       路线图
├── Budget        预算（人力 / Token / 云成本）
└── Risk          风险登记册
```

| 对象 | 关键属性 | 不变量 |
| --- | --- | --- |
| `Project` | key, name, workspace, owner, status, period | 同一 Workspace 下 key 唯一 |
| `Goal` | title, metric, target, current, dueDate | metric 必须可量化 |
| `Milestone` | name, dueDate, scopeRefs[], status | dueDate 不早于 Project 开始 |
| `Roadmap` | horizon, items[] | item 必须引用 Milestone 或 Requirement |
| `Budget` | type(headcount/token/cloud), planned, consumed | consumed ≤ hardLimit 否则触发策略 |
| `Risk` | description, probability, impact, mitigation, owner | 高风险必须有 owner 与 mitigation |

**领域事件**：`ProjectCreated` `GoalUpdated` `MilestoneShifted` `RiskRaised` `BudgetThresholdCrossed`

---

## 3. Requirement Context

```
Requirement
├── Epic
├── Feature
├── Story
├── Acceptance    验收标准（结构化）
├── Dependency    依赖
└── Priority      优先级
```

层级：`Epic → Feature → Story`（Story 是可进入执行的最小需求单元）

| 对象 | 关键属性 | 不变量 |
| --- | --- | --- |
| `Requirement` | level(Epic/Feature/Story), title, statement, source, status | Story 必须有至少 1 条 Acceptance |
| `Acceptance` | given, when, then, verifiedBy | 通过后才允许 Requirement 进入 Finished |
| `Dependency` | fromRef, toRef, type(blocks/relatesTo) | 不允许成环 |
| `Priority` | method(MoSCoW/WSJF/RICE), value, rationale | 变更需记录 rationale |

**领域事件**：`RequirementDrafted` `RequirementApproved` `RequirementDecomposed` `AcceptanceVerified` `RequirementChanged`

**关键规则**
- `RequirementChanged` 若发生在 Approved 之后，必须生成变更影响分析（影响到的 Story/Task/Release）。
- Requirement 的状态**不由** Execution BC 直接修改（原则 P2.1）。

---

## 4. Architecture Context

```
Architecture
├── API
├── MicroService
├── Database
├── Event
└── Ontology（本体资产引用）
```

| 对象 | 关键属性 |
| --- | --- |
| `Architecture` | name, view(logical/deployment/data), diagramRef, ownerTeam |
| `API` | name, protocol, spec(OpenAPI/GraphQL SDL), version, owner |
| `MicroService` | name, repoRef, runtime, dependsOn[] |
| `Database` | name, engine, schemaRef, dataClassification |
| `Event` | name, schemaRef, producer, consumers[] |

**领域事件**：`ArchitectureProposed` `ArchitectureReviewed` `ApiContractChanged` `BreakingChangeDetected`

**关键规则**
- `ApiContractChanged` 若为破坏性变更，必须关联一条 `Decision`（ADR）。
- Architecture 对象与 `MicroService`/`Repo` 通过 Connector 保持双向同步（漂移可检测）。

---

## 5. Execution Context

```
Sprint    Task    Issue    Review    Release
```

| 对象 | 关键属性 | 不变量 |
| --- | --- | --- |
| `Sprint` | name, goal, startAt, endAt, capacity | 时间区间不重叠（同一团队） |
| `Task` | title, assignee(User\|Agent), estimate, sprintRef, storyRef | 必须归属某个 Story 或显式标记为 Chore |
| `Issue` | type(bug/incident), severity, foundIn, relatedTaskRef | severity=P0 时必须有 owner |
| `Review` | targetRef(PR/Design/Doc), reviewers[], verdict | verdict ∈ {approve, request-changes, comment} |
| `Release` | version, scope[], channel(gray/prod), status | 只能包含已 Done 的 Task |

**领域事件**：`TaskAssigned` `TaskCompleted` `IssueOpened` `ReviewSubmitted` `ReleasePromoted`

**关键规则**
- `assignee` 可以是 Agent；Agent 承接 Task 时走同一套分配与权限流程。
- Task 完成不自动完成 Story；Story 完成由 Requirement BC 依据 Acceptance 判定。

---

## 6. Knowledge Context

```
Knowledge   Decision   ADR   Meeting   Research   Prompt   Skill
```

| 对象 | 关键属性 |
| --- | --- |
| `Knowledge` | title, body, sourceRefs[], confidence, validUntil |
| `Decision` | question, options[], chosen, rationale, consequences |
| `ADR` | number, status(proposed/accepted/superseded), supersedes |
| `Meeting` | title, participants[], transcriptRef, actionItems[] |
| `Research` | question, findings[], sources[] |
| `Prompt` | name, template, variables[], version, evalScore |
| `Skill` | name, description, steps/toolRefs[], owner |

**领域事件**：`KnowledgeCaptured` `DecisionMade` `AdrSuperseded` `MeetingSummarized`

**关键规则**
- 每条 `Knowledge` 必须有 `sourceRefs`（来自哪个 Task/PR/Meeting），无来源的知识不可信。
- `Knowledge.validUntil` 到期后进入待复核，避免知识腐化。
- `Prompt` 与 `Skill` 是知识资产，版本化并可被 Agent 引用。

---

## 7. AI Context

```
Agent   Memory   Tool   Workflow   Observation   Reasoning   Artifact
```

| 对象 | 关键属性 |
| --- | --- |
| `Agent` | name, type, skillRefs[], capabilities[], modelPolicy, owner |
| `AgentRun` | agentRef, goal, status, cost, startedAt, endedAt |
| `Memory` | scope(run/agent/project), kind(episodic/semantic), content, ttl |
| `Tool` | name, kind(connector/function/mcp), schema, requiredCapabilities[] |
| `Observation` | runRef, source, payload, timestamp |
| `Reasoning` | runRef, step, rationale, modelRef, tokens |
| `Artifact` | runRef, type(pr/doc/patch/report), ref, acceptedBy |

详见 [05-agent-runtime.md](05-agent-runtime.md)。

---

## 8. Identity Context

```
Identity   Role   Capability   Resource   Policy   Grant   AuditLog
```

详见 [07-identity-permission.md](07-identity-permission.md)。

---

## 9. 上下文映射（Context Map）

| 上游 → 下游 | 关系模式 | 交互方式 |
| --- | --- | --- |
| Project → Requirement | Customer-Supplier | 事件 + 只读引用 |
| Requirement → Execution | Customer-Supplier | `RequirementApproved` 事件触发拆分 |
| Execution → Requirement | Conformist（反馈） | `TaskCompleted` 事件，Requirement 自行判定 |
| Architecture ↔ Execution | Partnership | 双向事件；API 变更触发 Task |
| * → Knowledge | Published Language | 任何 BC 可发布知识候选，Knowledge BC 裁定 |
| AI → * | Open Host Service | Agent 通过统一 Resource API 访问，无特权 |
| Identity → * | Shared Kernel（PDP） | 同步调用授权决策 |

---

## 10. 需求条目

| ID | 需求 | 优先级 | 验收标准 |
| --- | --- | --- | --- |
| FR-DOM-001 | 实现 7 个限界上下文的聚合与不变量 | M | 每个聚合有单元测试覆盖其不变量，覆盖率 ≥ 85% |
| FR-DOM-002 | 跨 BC 仅通过事件或只读引用交互 | M | 静态检查：跨 BC 直接写操作 = 0 |
| FR-DOM-003 | Requirement 支持 Epic/Feature/Story 三级 | M | 可创建三级并进行拆分与回溯 |
| FR-DOM-004 | Story 必须含结构化 Acceptance 才能进入执行 | M | 无 Acceptance 的 Story 状态迁移被拒绝并给出原因 |
| FR-DOM-005 | Dependency 环检测 | M | 构造环形依赖被拒绝，返回环路径 |
| FR-DOM-006 | Task 的 assignee 支持 User 与 Agent | M | Agent 可被分配并完成 Task，审计可查 |
| FR-DOM-007 | Release 只允许包含 Done 的 Task | M | 加入未完成 Task 被拒绝 |
| FR-DOM-008 | Knowledge 必须有来源引用 | M | 无 sourceRefs 的 Knowledge 无法发布 |
| FR-DOM-009 | 需求变更生成影响面分析 | S | 变更 Approved 需求后，返回受影响对象清单 |
| FR-DOM-010 | 架构漂移检测（Architecture vs 实际仓库） | C | 每日巡检输出漂移报告 |
