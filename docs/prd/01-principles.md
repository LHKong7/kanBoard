# 01 · 设计原则

| 项 | 值 |
| --- | --- |
| 版本 | v1.0 |
| 状态 | Draft |
| 更新时间 | 2026-08-03 |

四条原则是**约束**，不是建议。任何违反原则的设计需要一条 ADR 来豁免。

---

## 原则 1 · Ontology First（本体先行）

所有业务对象**先定义本体**，再产生实现。

```
Ontology  →  Storage Schema  →  API  →  UI
```

首批本体对象：

```
Project      Requirement   Story        Task
API          Database      Service      Agent
Knowledge    Decision
```

### 规则

| # | 规则 |
| --- | --- |
| P1.1 | 新增任何领域对象，必须先在 Ontology Registry 中注册类型定义 |
| P1.2 | 数据库表结构由本体派生（生成或校验），不允许绕过本体私建业务表 |
| P1.3 | API 的资源形态由本体决定，不允许 API 暴露本体中不存在的字段语义 |
| P1.4 | UI 是本体的渲染视图，不允许 UI 层定义业务语义 |
| P1.5 | 本体变更必须版本化，并提供迁移策略（见 [04-ontology.md](04-ontology.md)） |

### 反例

> ❌ 为了赶排期，先加了 `task_ext` 表存一个新字段，等以后再补本体。
> ✅ 先在本体上给 `Task` 增加 attribute（带版本），再生成存储与 API。

---

## 原则 2 · DDD First（领域驱动先行）

所有对象必须归属于**唯一一个限界上下文（Bounded Context, BC）**。

```
Project BC        Requirement BC      Execution BC
Knowledge BC      Identity BC         AI BC
Architecture BC
```

### 规则

| # | 规则 |
| --- | --- |
| P2.1 | **禁止一个对象跨多个上下文维护状态**（单一写入方） |
| P2.2 | 跨上下文只允许通过 **Domain Event** 或 **只读引用（ID + 快照）** 交互 |
| P2.3 | 每个 BC 拥有自己的聚合根（Aggregate Root）与事务边界 |
| P2.4 | 跨 BC 的一致性是**最终一致**，不使用分布式事务 |
| P2.5 | 上下文映射关系（Context Map）必须显式记录并维护 |

### 反例

> ❌ Execution BC 直接改写 Requirement 的 `status`。
> ✅ Execution BC 发出 `TaskCompleted` 事件；Requirement BC 订阅后**自行**决定是否推进状态。

---

## 原则 3 · Everything is Entity（万物皆实体）

所有东西都是 Entity：

```
Requirement  Task     Issue    PR
Meeting      Document Prompt   Agent   Memory
```

每个实体**必须**具备：

| 字段 | 含义 |
| --- | --- |
| `id` | 全局唯一标识 |
| `owner` | 责任主体（User 或 Agent） |
| `status` | 生命周期状态（由 Workflow Engine 管理） |
| `permission` | 权限归属与策略 |
| `relation` | 与其他实体的本体关系 |
| `history` | 不可变的变更历史 |

### 规则

| # | 规则 |
| --- | --- |
| P3.1 | 不存在"只是一段文本"的一等信息；文本必须挂载在某个实体上 |
| P3.2 | 所有实体继承统一 `Resource` 基类（见 [09-data-model.md](09-data-model.md)） |
| P3.3 | 实体的删除是**软删除 + 归档**，历史永不物理丢失（合规删除除外） |
| P3.4 | Agent、Prompt、Memory 同样是实体，同样受权限与审计约束 |

---

## 原则 4 · Everything Connected（万物互联）

所有对象**天然关联**，不依赖人工挂链接。

```
Requirement
   ↓ implementedBy
Story
   ↓ decomposedInto
Task
   ↓ produces
Commit
   ↓ partOf
PR
   ↓ releasedAs
Release
   ↓ distills
Knowledge
```

### 规则

| # | 规则 |
| --- | --- |
| P4.1 | 关系是**一等公民**，有类型、方向、属性与来源（人工 / 系统 / Agent 推断） |
| P4.2 | 系统在事件发生时自动建立关系（如 PR 提到 `TASK-123` 即建立 `produces`） |
| P4.3 | Agent 推断的关系必须标注 `confidence` 与 `inferredBy`，可被人工确认或否决 |
| P4.4 | 任意两个实体之间必须可以进行**图路径查询** |
| P4.5 | 断链（孤儿对象）需在质量看板中暴露，而不是静默存在 |

---

## 原则优先级冲突处理

当原则之间冲突时，按以下顺序裁决：

```
安全与权限 (07)  >  DDD 边界 (P2)  >  本体一致性 (P1)
                 >  关联完整性 (P4) >  交付速度
```

任何为交付速度做出的妥协，必须记录为**技术债条目**并关联到具体 ADR。
