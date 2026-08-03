# 架构决策记录（ADR）

ADR 记录**为什么这样决定**，而不是**系统是什么样**。
系统现状写在 PRD 与设计文档里；ADR 是不可变的历史。

## 规则

1. 每个重大架构选择必须有一条 ADR。
2. ADR 一经 `Accepted` **不再修改内容**；改变主意就写一条新 ADR 并标记 `supersedes`。
3. PRD 中引用 ADR，不重复论证过程。
4. 违反 [设计原则](../prd/01-principles.md) 的设计，必须有一条 ADR 说明豁免理由与代价。

## 状态

| 状态 | 含义 |
| --- | --- |
| `Proposed` | 提议中，尚未生效 |
| `Accepted` | 已采纳，当前有效 |
| `Superseded` | 被后续 ADR 取代（注明取代者编号） |
| `Deprecated` | 不再适用，且无替代 |

## 索引

| 编号 | 标题 | 状态 |
| --- | --- | --- |
| [0001](0001-ontology-first.md) | 本体先行（Ontology First） | Accepted |
| [0002](0002-unified-resource-model.md) | 统一 Resource 数据模型 | Accepted |
| [0003](0003-agent-least-privilege.md) | Agent 最低权限与临时授权 | Accepted |
| [0004](0004-go-server-stack.md) | 服务端采用 Go | Accepted |
| [0005](0005-tenancy-model.md) | 多租户隔离：共享库 + tenant 列 + RLS | Accepted |
| [0006](0006-model-data-egress.md) | 允许项目数据发送至外部托管模型 | Accepted |

## 新增

复制 [template.md](template.md)，编号取当前最大值 +1（四位，不复用）。
