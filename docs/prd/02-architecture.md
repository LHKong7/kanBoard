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
| FR-ARCH-005 | 多租户隔离：数据模型自始携带 `tenant`，由 PG RLS 强制过滤 | M | 跨租户读取测试全部返回 404/403，无数据泄漏（见 [ADR-0005](../adr/0005-tenancy-model.md)） |
| FR-ARCH-006 | 模型无关：LLM 供应商可插拔 | S | 至少接入 2 家供应商，切换仅需配置变更 |
| FR-ARCH-007 | 事件消费幂等 | M | 重复投递同一事件，最终状态一致 |
| FR-ARCH-008 | 存储可分层演进（图/向量可后置） | S | v1 允许以关系库模拟图查询，接口不变 |
| FR-ARCH-009 | Agent Run 在独立 worker 进程执行，不阻塞 API 进程 | M | 长时 Run 并发下 API P95 时延不受影响；worker 崩溃不影响 API 可用性（见 §7） |
| FR-ARCH-010 | 所有外部输入边界具备运行期校验（Zod） | M | 边界清单与校验测试一一对应；本体定义可自动生成校验 schema |
| FR-ARCH-011 | 全链路可取消：任何超过 1 秒的操作接受 `AbortSignal` | M | 取消进行中的 Run，含 Connector 调用在 5 秒内全部停止 |

---

## 6. 技术选型基线

| 层 | 选型 | 状态 | 备注 |
| --- | --- | --- | --- |
| **服务端** | **TypeScript / Node.js 22 LTS**（`strict`） | ✅ 已定 | 见 [ADR-0007](../adr/0007-typescript-server-stack.md)（取代 ADR-0004 的 Go 方案） |
| 运行期校验 | **Zod**（本体自动生成 schema） | ✅ 已定 | TS 类型运行期不存在，所有边界必须校验 |
| HTTP | Fastify | ✅ 已定 | 不引入全栈框架 |
| API | REST（写侧） + GraphQL（读侧） | ✅ 已定 | 统一 Resource API 见 [09](09-data-model.md) |
| 数据库访问 | `pg` + Kysely（类型化 SQL） | ✅ 已定 | 不使用重 ORM |
| 关系库 | PostgreSQL 15+ | ✅ 已定 | JSONB 承载本体动态属性；RLS 承载租户隔离 |
| 租户隔离 | 共享库 + `tenant` 列 + RLS | ✅ 已定 | 见 [ADR-0005](../adr/0005-tenancy-model.md) |
| 事件总线 | PG outbox + poller（v1） | ✅ 已定 | 规模化后评估 Kafka/NATS（Q-A5） |
| 向量 | pgvector（起步） → 独立向量库 | ⬜ 待评估 | 与 Knowledge 规模挂钩 |
| 图查询 | PG 递归 CTE（v1） | ✅ 已定 | 留适配层，规模化后切独立图库 |
| 工作流 | 自研状态机 + 规则 DSL | ✅ 已定 | 见 [08](08-workflow-engine.md) |
| Agent | 自研 Runtime + MCP 工具协议 | ✅ 已定 | 见 [05](05-agent-runtime.md) |
| **Agent 执行位置** | **独立 worker 进程**（不在 API 进程内） | ✅ 已定 | Node 单线程事件循环的硬性要求，见下 §7 |
| 依赖方向校验 | dependency-cruiser（CI 强制） | ✅ 已定 | 落实 FR-ARCH-001 |
| 部署形态 | 模块化单体（按 BC 分模块） | ⬜ 待定（Q-A4） | 倾向单体优先，按需拆分 |

> 后续选型定稿同样必须落 ADR：`docs/adr/`。

---

## 7. Node 运行时的进程边界（TypeScript 选型的硬性约束）

Node 是单线程事件循环，长时任务会阻塞所有请求。因此**进程边界不是部署细节，是架构约束**：

```
┌─────────────────┐        ┌──────────────────┐
│  API 进程        │  队列   │  Agent Worker     │
│  只做 I/O        │ ──────►│  执行 Agent Run   │
│  请求 P95 有保障 │        │  可崩溃、可重启    │
└─────────────────┘        └──────────────────┘
        │                          │
        └──────────┬───────────────┘
                   ▼
              PostgreSQL
```

| 约束 | 要求 |
| --- | --- |
| Agent Run 不在 API 进程内执行 | 入队后由 worker 消费；worker 崩溃不影响 API 可用性 |
| `AbortSignal` 全链路贯穿 | 任何超过 1 秒的操作必须可取消（等价于 Go 的 `context.Context`） |
| 队列显式限长 + 并发上限 | 背压靠拒绝而非堆积；与 FR-AGT-012 预算熔断共用告警 |
| CPU 密集任务进 worker threads | 编辑幅度计算（FR-DASH-015）、图后处理等 |
| worker 设堆上限 | `--max-old-space-size`；配合 `blastRadius` 约束单 Run 影响面 |

**验收**：长时 Run 并发运行时，API 进程 P95 时延不受影响。
