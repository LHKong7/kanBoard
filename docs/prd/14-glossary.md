# 14 · 术语表（Glossary）

| 项 | 值 |
| --- | --- |
| 版本 | v1.0 |
| 状态 | Draft |
| 更新时间 | 2026-08-03 |

> 术语表本身也是 ProjectOS 的一部分：将来它应当由 Ontology Registry 生成，而不是手写。

---

## A–C

| 术语 | 定义 |
| --- | --- |
| **ADR**（Architecture Decision Record） | 架构决策记录。记录一个决策的背景、选项、结论与后果。在 ProjectOS 中是 `Decision` 的一种。 |
| **Agent** | 具备独立身份、技能、记忆、工具与权限的执行主体。**不等于 LLM**。 |
| **Agent Graph** | 多个 Agent 通过领域对象协作形成的执行网络，由 Workflow Engine 编排。 |
| **AgentRun** | Agent 的一次执行实例，携带完整推理与调用轨迹。 |
| **Aggregate（聚合）** | DDD 概念，一组保持业务不变量的对象集合，有唯一聚合根与事务边界。 |
| **Artifact** | Agent 的产出物（PR、文档、补丁、报告）。 |
| **Automation Rate** | 由 Agent 独立完成且被人类接受的工作项占比。北极星指标。 |
| **blastRadius** | 单次 Agent Run 允许影响的对象数量上限，失控熔断闸。 |
| **Bounded Context（限界上下文）** | DDD 概念，语义边界。同一术语在不同上下文可有不同含义。 |
| **Capability** | 细粒度动作权限，如 `Requirement.Write`。 |
| **Connector** | Agent 与外部系统之间的唯一受控通道，实现统一契约。 |
| **Context Map** | 限界上下文之间的关系图与协作模式。 |

## D–I

| 术语 | 定义 |
| --- | --- |
| **DDD**（Domain-Driven Design） | 领域驱动设计。ProjectOS 的边界划分方法论。 |
| **Decision** | 决策领域对象，解释"为什么这样做"。 |
| **Domain Event（领域事件）** | 领域内发生的、对外可见的事实，如 `TaskCompleted`。 |
| **Domain Object（领域对象）** | 具备 ID/Owner/Status/Permission/Relation/History 的一等业务对象。 |
| **Grant** | 一次临时授权，带 scope、TTL、调用次数与绑定的 Run。 |
| **Guard** | 状态迁移的前置条件表达式。 |
| **Human-in-the-loop** | 人在回路。Agent 产出需人工确认或审阅的协作方式。 |
| **Idempotency Key** | 幂等键，保证重复投递不产生重复副作用。 |
| **Identity** | 身份主体，包括 User 与 Agent。 |

## K–P

| 术语 | 定义 |
| --- | --- |
| **Knowledge** | 有来源、有时效、可复用的知识对象。 |
| **MCP**（Model Context Protocol） | 模型上下文协议，ProjectOS 通过 MCP Connector 接入其工具生态。 |
| **Memory** | Agent 记忆，分 Working / Episodic / Semantic / Procedural 四类。 |
| **Ontology（本体）** | 定义"世界上有哪些类型的东西、它们之间有什么关系"的语义模型。 |
| **PDP**（Policy Decision Point） | 策略决策点，统一回答"这个主体能否对这个资源做这个动作"。 |
| **Policy** | 权限策略：Allow / Deny / Ask / OwnerOnly 等。 |
| **Project Runtime** | ProjectOS 的本质定位：项目的运行时环境，而非工具集合。 |
| **Prompt** | 可版本化、可评估的提示词资产，属于 Knowledge Context。 |
| **Provenance（出处）** | 一条信息的来源实体链，AI 产出必须携带。 |

## R–W

| 术语 | 定义 |
| --- | --- |
| **RelationType** | 本体中的关系类型，含逆关系、传递性、定义域与值域。 |
| **Resource** | 统一资源基类，所有领域对象继承它。 |
| **Skill** | 可复用的做事方法，Agent 的能力单元。 |
| **Story** | 可独立交付的最小需求单元，必须含结构化 Acceptance。 |
| **Tenant** | 租户，最外层数据隔离边界。 |
| **Traceability（可追溯性）** | 从需求到发布的完整链路可查询能力。 |
| **Workflow Engine** | 管理所有领域对象生命周期与自动化的引擎。 |
| **Workspace** | 工作空间，权限的主要作用边界。 |

---

## 易混淆概念辨析

| A | B | 区别 |
| --- | --- | --- |
| Ontology | Database Schema | 本体是语义层（有关系、有推理），Schema 是存储层。本体在前，Schema 由其派生。 |
| Bounded Context | 微服务 | BC 是逻辑边界，微服务是部署单元。一个 BC 可以是一个或多个服务。 |
| Agent | LLM | LLM 是推理器；Agent 有身份、权限、记忆、工具与审计。 |
| Capability | Role | Capability 是权限本身；Role 只是 Capability 的命名集合。 |
| Knowledge | Document | Document 是载体；Knowledge 是有来源、有时效、可复用的对象。 |
| Task | Story | Story 是需求单元（交付什么），Task 是执行单元（怎么做）。 |
| Automation Rate | Success Rate | 前者衡量"AI 真正替人完成了多少"，后者只衡量 Run 是否报错。 |
