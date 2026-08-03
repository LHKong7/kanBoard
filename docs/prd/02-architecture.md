# 02 · 总体架构

| 项 | 值 |
| --- | --- |
| 版本 | v1.0 |
| 状态 | Draft |
| 更新时间 | 2026-08-03 |

---

## 1. 分层视图

```
┌───────────────────────────────────────────────────────┐
│                      ProjectOS                        │
├───────────────────────────────────────────────────────┤
│  Identity Layer      身份 / 租户 / 权限决策点          │
├───────────────────────────────────────────────────────┤
│  Ontology Layer      本体注册 / 类型 / 关系 / 推理     │
├───────────────────────────────────────────────────────┤
│  Domain Layer        限界上下文 / 聚合 / 领域事件      │
├───────────────────────────────────────────────────────┤
│  Workflow Engine     状态机 / 自动化 / SLA / 审批      │
├───────────────────────────────────────────────────────┤
│  Agent Runtime       Agent 调度 / 记忆 / 工具 / 观测   │
├───────────────────────────────────────────────────────┤
│  Integration Layer   Connector / 事件总线 / Webhook    │
├───────────────────────────────────────────────────────┤
│  Storage Layer       关系库 / 图 / 向量 / 对象 / 事件  │
└───────────────────────────────────────────────────────┘
```

分层是**依赖方向**约束：上层可依赖下层，下层不得反向依赖上层。
Identity 是横切关注点，以**策略决策点（PDP）**形式被各层调用，而非被各层实现。

---

## 2. 各层职责

### 2.1 Identity Layer

| 职责 | 说明 |
| --- | --- |
| 身份 | User / Agent / Group / Department / Organization / Workspace / Tenant |
| 认证 | OIDC / SAML / PAT / Agent Credential |
| 授权 | PDP：给定 (Subject, Action, Resource, Context) 返回 Allow/Deny/Ask |
| 审计 | 所有决策与调用留痕 |

详见 [07-identity-permission.md](07-identity-permission.md)。

### 2.2 Ontology Layer

| 职责 | 说明 |
| --- | --- |
| 类型注册 | EntityType / RelationType / AttributeType |
| 版本化 | 本体 Schema 版本与兼容策略 |
| 校验 | 实体写入前的结构与关系约束校验 |
| 推理 | 传递闭包、逆关系、路径查询 |

详见 [04-ontology.md](04-ontology.md)。

### 2.3 Domain Layer

按限界上下文拆分的领域服务，持有聚合根与业务不变量，发布领域事件。
详见 [03-domain-model.md](03-domain-model.md)。

### 2.4 Workflow Engine

管理所有领域对象的生命周期状态机、自动化规则、审批与 SLA。
详见 [08-workflow-engine.md](08-workflow-engine.md)。

### 2.5 Agent Runtime

统一的 Agent 执行环境：任务调度、上下文装配、记忆读写、工具调用、可观测与成本核算。
详见 [05-agent-runtime.md](05-agent-runtime.md)。

### 2.6 Integration Layer

Connector 抽象与实现、外部事件订阅、Webhook 出入站、幂等与重试。
详见 [06-connector.md](06-connector.md)。

### 2.7 Storage Layer

| 存储 | 用途 |
| --- | --- |
| 关系型（PostgreSQL） | Resource 主数据、事务一致性 |
| 图存储 | 关系与路径查询（可先用 PG 递归 CTE，规模化后独立） |
| 向量库 | Knowledge / Memory 的语义检索 |
| 对象存储 | 附件、Artifact、大文本 |
| 事件存储 | Domain Event / Audit Log（append-only） |

---

## 3. 运行时视图（一次典型请求）

```
Client / Agent
   │  ① 携带身份与 Capability
   ▼
API Gateway ──② 认证──► Identity (PDP) ──③ Allow/Deny/Ask
   │
   ▼ ④ 通过
Domain Service
   │  ⑤ 本体校验
   ├──────────────► Ontology Layer
   │  ⑥ 状态迁移合法性
   ├──────────────► Workflow Engine
   │  ⑦ 持久化 + 事件
   ▼
Storage ──⑧ Domain Event──► Event Bus
                              ├──► Workflow 自动化
                              ├──► Agent Runtime（触发 Agent）
                              ├──► Ontology 关系维护
                              └──► Dashboard 指标物化
```

**关键点**：所有写入路径都必须经过 ①→⑧ 全链路；Agent 不享有旁路。

---

## 4. Agent 调用链（受控路径）

```
Agent
  │  声明目标 + 请求 Capability
  ▼
Agent Runtime ──► Identity：申请临时授权（带 scope + TTL）
  │
  │  ✔ 授权通过
  ▼
Tool / Connector 调用
  │
  ├─► ProjectOS 内部：走统一 Resource API（与人类同一条路径）
  └─► 外部系统：走 Connector（GitHub / DB / Browser / MCP …）
  │
  ▼
Observation → Reasoning → Artifact → 写回 Domain Object
  │
  ▼
Audit Log（全量、不可篡改）
```

**Agent 不直接访问数据库**——这是硬约束，见 [06-connector.md](06-connector.md)。

---

## 5. 架构需求条目

| ID | 需求 | 优先级 | 验收标准 |
| --- | --- | --- | --- |
| FR-ARCH-001 | 系统按七层分层实现，层间依赖单向 | M | 架构测试（如 ArchUnit 类工具）在 CI 中校验依赖方向，违规即失败 |
| FR-ARCH-002 | 所有写操作经过统一 PDP 授权 | M | 存在自动化测试证明绕过 PDP 的写路径为 0 |
| FR-ARCH-003 | 所有领域变更发布 Domain Event | M | 抽样 100% 核心聚合，写入后可在事件存储中查到对应事件 |
| FR-ARCH-004 | Agent 与人类共用同一套 Resource API | M | Agent 无专用写入端点；接口层无 `is_agent` 分支绕过权限 |
| FR-ARCH-005 | 支持多租户隔离（Tenant / Workspace） | M | 跨租户读取测试全部返回 404/403，无数据泄漏 |
| FR-ARCH-006 | 模型无关：LLM 供应商可插拔 | S | 至少接入 2 家供应商，切换仅需配置变更 |
| FR-ARCH-007 | 事件消费幂等 | M | 重复投递同一事件，最终状态一致 |
| FR-ARCH-008 | 存储可分层演进（图/向量可后置） | S | v1 允许以关系库模拟图查询，接口不变 |

---

## 6. 技术选型基线（建议，非强制）

| 层 | 建议 | 备注 |
| --- | --- | --- |
| API | REST + GraphQL（读侧） | 统一 Resource API 见 [09](09-data-model.md) |
| 服务端 | TypeScript / Node 或 Go | 以团队熟悉度为准，需在 ADR 中定稿 |
| 关系库 | PostgreSQL 15+ | JSONB 承载本体动态属性 |
| 事件总线 | Kafka / NATS | v1 可用 PG outbox + poller 起步 |
| 向量 | pgvector（起步） → 独立向量库 | 与 Knowledge 规模挂钩 |
| 工作流 | 自研状态机 + 规则 DSL | 见 [08](08-workflow-engine.md) |
| Agent | 自研 Runtime + MCP 工具协议 | 见 [05](05-agent-runtime.md) |

> 选型定稿必须落 ADR：`docs/adr/`。
