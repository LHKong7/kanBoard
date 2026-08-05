# ADR-0002 · 统一 Resource 数据模型与统一 API

| 项 | 值 |
| --- | --- |
| 状态 | Accepted |
| 日期 | 2026-08-03 |
| 决策者 | 架构组 |
| 关联需求 | FR-RES-001 ~ FR-RES-015, FR-ARCH-004 |
| 依赖 | [ADR-0001](0001-ontology-first.md) |

## 背景

ProjectOS 需要管理数十种领域对象（Requirement / Task / Agent / Knowledge / Meeting / Prompt …），
且租户还可扩展自定义类型。

若每种类型各写一套 CRUD、各定义一套权限、各实现一套历史记录：

- 新增类型的边际成本恒定不下降
- 权限与审计必然出现遗漏（"这个新端点忘了加权限检查"）
- Agent 需要为每种类型学习不同接口

## 决策

**所有领域对象继承统一 `Resource` 基类，共享同一套 API。**

`Resource` 公共字段：
`id / type / ontologyVersion / tenant / workspace / project / owner / createdBy / createdAt / updatedAt / status / lifecycle / version / labels / attributes / relations / permission / deletedAt`

统一 API：

```
POST   /v1/resources
GET    /v1/resources/{id}
PATCH  /v1/resources/{id}          # If-Match: version（乐观锁）
DELETE /v1/resources/{id}          # 软删除
POST   /v1/resources:query
POST   /v1/resources/{id}:transition
GET    /v1/resources/{id}/relations
POST   /v1/graph:traverse
```

配套硬性约束：

1. 业务属性放在 `attributes`，结构由本体强校验。
2. 写入使用乐观锁，冲突返回 409。
3. 删除为软删除；history 为 append-only。
4. 业务写入与 Domain Event 同事务（outbox 模式）。
5. **Agent 与人类使用同一套 API**，不存在 Agent 专用端点，不存在 `is_agent` 权限旁路。

## 备选方案

| 方案 | 优点 | 缺点 | 未选原因 |
| --- | --- | --- | --- |
| A. 每类型独立 API | 接口贴合业务，易读 | 新增类型成本恒定；权限/审计易遗漏；Agent 需学 N 套接口 | 与"万物皆实体"原则冲突 |
| B. 纯 GraphQL 单入口 | 查询灵活 | 写侧权限与不变量控制困难；N+1 与成本控制复杂 | 读侧可用 GraphQL，写侧仍走 REST |
| C. 统一 API + 类型专用扩展端点 | 兼顾通用与特例 | 特例会不断增长，最终退化为方案 A | 仅在确有必要时以 ADR 单独豁免 |

## 后果

### 正面

- 新增 EntityType 的边际成本趋近于零（本体注册即可用）
- 权限、审计、历史、乐观锁只实现一次，无遗漏面
- Agent 只需学一套接口，工具定义大幅简化
- 租户自定义类型天然获得完整能力

### 负面 / 代价

- API 通用性高但业务表达力弱，前端需要更多本体元数据来渲染
- `attributes` 为 JSONB，复杂查询需要精心设计索引
- 类型特有的业务动作（如"合并 PR"）需通过 `:transition` 或专用 action 表达，抽象成本存在

### 需要后续处理

- [ ] 定义 action 扩展机制（类型特有动作如何在统一 API 下表达）
- [ ] JSONB 索引策略与查询性能基线（NFR-PERF-002）
- [ ] 前端本体驱动渲染框架

## 验证方式

- 端点清单审查：不存在类型专用 CRUD 端点，不存在 Agent 专用写入端点
- 自动化测试：≥10 种 EntityType 通过同一 API 完成全生命周期
- 故障注入：业务写入与事件发布的一致性（无事件丢失或幽灵事件）
