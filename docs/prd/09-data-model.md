# 09 · 统一数据模型与 API

| 项 | 值 |
| --- | --- |
| 版本 | v1.0 |
| 状态 | Draft |
| 更新时间 | 2026-08-03 |

> 任何对象都继承 `Resource`，因此任何对象都共享同一套 API。

---

## 1. Resource 基类

```
Resource
├── id            全局唯一 ID
├── type          实体类型（对应 Ontology EntityType）
├── owner         责任主体（user:// 或 agent://）
├── workspace     所属工作空间
├── status        生命周期状态（由 Workflow Engine 管理）
├── version       乐观锁版本号
├── permission    权限归属与策略引用
├── relation      本体关系集合
└── history       变更历史
```

### 完整字段定义

```jsonc
{
  "id": "req_01J8XQ4M9Z",              // 前缀 + ULID，全局唯一、可排序
  "type": "Requirement",
  "ontologyVersion": "1.2.0",
  "tenant": "t_acme",
  "workspace": "ws_platform",
  "project": "prj_projectos",
  "owner": "user://alice",
  "createdBy": "agent://requirement-agent@1.3.0",
  "createdAt": "2026-08-03T02:11:04Z",
  "updatedAt": "2026-08-03T09:40:22Z",
  "status": "Approved",
  "lifecycle": "requirement-default",
  "version": 7,                         // 乐观锁
  "labels": ["billing", "q3"],
  "attributes": { /* 由本体定义的类型化属性 */ },
  "relations": [
    { "type": "implementedBy", "target": "story_01J8XR...", "createdBy": "system", "confidence": 1.0 }
  ],
  "permission": { "policyRefs": ["pol_default_req"], "visibility": "workspace" },
  "deletedAt": null                     // 软删除
}
```

### 硬性规则

| # | 规则 |
| --- | --- |
| D1 | 所有实体表共享 Resource 头部字段，命名与语义一致 |
| D2 | `id` 全局唯一且带类型前缀，跨类型不冲突 |
| D3 | 业务属性放在 `attributes`，结构由本体定义并强校验 |
| D4 | 写入使用乐观锁（`If-Match: version`），冲突返回 409 |
| D5 | 删除为软删除；`history` 永不物理删除（GDPR 擦除除外，走专用流程） |
| D6 | 每次变更写入 `history` 条目与 Domain Event，二者一致（outbox 模式） |

---

## 2. History（变更历史）

```jsonc
{
  "resourceId": "req_01J8XQ4M9Z",
  "version": 7,
  "changedBy": "agent://pm-agent@2.0.1",
  "onBehalfOf": "user://alice",
  "changedAt": "2026-08-03T09:40:22Z",
  "runRef": "run_01J8XS...",            // 若由 Agent 产生
  "changes": [
    { "path": "attributes.priority", "from": "Should", "to": "Must" }
  ],
  "reason": "客户升级为合同必交项",
  "traceId": "tr_..."
}
```

历史是 append-only，可用于：审计、回滚、变更影响分析、Agent 行为复盘。

---

## 3. 统一 API

### 3.1 CRUD

```http
POST   /v1/resources                     # 创建（type 在 body 中）
GET    /v1/resources/{id}
PATCH  /v1/resources/{id}                # If-Match: <version>
DELETE /v1/resources/{id}                # 软删除
GET    /v1/resources/{id}/history
```

### 3.2 查询

```http
POST /v1/resources:query
{
  "type": "Requirement",
  "filter": {
    "project": "prj_projectos",
    "status": { "in": ["Approved", "Planning"] },
    "attributes.level": "Feature"
  },
  "sort": [{ "field": "updatedAt", "order": "desc" }],
  "page": { "size": 50, "cursor": "..." }
}
```

### 3.3 关系与图查询

```http
GET  /v1/resources/{id}/relations?type=implementedBy&direction=out
POST /v1/resources/{id}/relations         # 建立关系
DELETE /v1/relations/{relationId}

POST /v1/graph:traverse
{
  "start": "req_01J8XQ4M9Z",
  "follow": ["implementedBy", "produces", "releasedAs"],
  "maxDepth": 5,
  "direction": "out"
}

POST /v1/graph:path
{ "from": "issue_01...", "to": "req_01...", "maxDepth": 6 }
```

### 3.4 生命周期

```http
POST /v1/resources/{id}:transition
{ "to": "Review", "reason": "PR 已就绪" }

GET  /v1/resources/{id}/transitions       # 当前可用迁移（已按权限过滤）
```

### 3.5 语义检索（混合）

```http
POST /v1/search
{
  "query": "为什么我们放弃了方案 X",
  "mode": "hybrid",                       // graph + vector + keyword
  "scope": { "project": "prj_projectos", "types": ["Decision", "Knowledge", "Meeting"] },
  "withProvenance": true
}
```

### 3.6 事件订阅

```http
POST /v1/subscriptions
{ "events": ["TaskCompleted", "RequirementApproved"], "sink": "https://…/webhook" }
```

### 3.7 Agent 接口

```http
POST /v1/agents/{name}:invoke
{ "goal": "decompose Feature into Stories", "context": { "resourceId": "req_..." }, "mode": "draft" }

GET  /v1/agent-runs/{runId}               # 状态与轨迹
POST /v1/agent-runs/{runId}:approve       # 处理 Ask
POST /v1/agent-runs/{runId}:cancel
```

> **Agent 与人类使用同一套 `/v1/resources` API**。
> 不存在 Agent 专用写入端点，也不存在 `is_agent` 的权限旁路分支。

---

## 4. 存储映射

| 数据 | 存储 | 说明 |
| --- | --- | --- |
| Resource 主数据 | PostgreSQL | 公共头部为列，`attributes` 为 JSONB + GIN 索引 |
| Relation | PostgreSQL（边表） | `(from, type, to)` 唯一；v1 用递归 CTE 做图查询 |
| History / Audit | append-only 表 / 对象存储 | 按月分区，冷数据归档 |
| Domain Event | outbox 表 → 事件总线 | 保证与业务写入同事务 |
| 向量索引 | pgvector | Knowledge / Memory / 长文本 |
| 附件 / Artifact | 对象存储 | 数据库仅存引用与元信息 |

演进：关系规模超过阈值（如 5000 万条边或图查询 P95 > 1s）后，引入专用图存储，**API 契约不变**。

---

## 5. 需求条目

| ID | 需求 | 优先级 | 验收标准 |
| --- | --- | --- | --- |
| FR-RES-001 | 所有实体继承统一 Resource 基类 | M | 新增实体类型无需新增专用 CRUD 端点 |
| FR-RES-002 | 统一 CRUD + Query API | M | 至少 10 种实体类型通过同一 API 完成增删改查 |
| FR-RES-003 | 乐观锁并发控制 | M | 并发写冲突返回 409 且不产生丢失更新 |
| FR-RES-004 | 软删除 + 历史保留 | M | 删除后可查询历史，可恢复 |
| FR-RES-005 | 变更历史含变更人、委派人、原因、字段级 diff | M | 抽样验证 diff 精确到字段路径 |
| FR-RES-006 | 业务写入与 Domain Event 同事务（outbox） | M | 故障注入测试无事件丢失或幽灵事件 |
| FR-RES-007 | 关系 CRUD 与图遍历 API | M | 深度 5 遍历返回路径与关系类型 |
| FR-RES-008 | 生命周期迁移 API，返回当前可用迁移（按权限过滤） | M | 无权限的迁移不出现在可用列表中 |
| FR-RES-009 | 混合语义检索并返回出处 | S | 结果含来源实体 ID，可点击跳转 |
| FR-RES-010 | 事件订阅 / Webhook 出站，含签名与重试 | S | 消费方可校验签名，失败按退避重试 |
| FR-RES-011 | Agent 与人共用同一 API，无旁路端点 | M | 端点清单审查通过 |
| FR-RES-012 | 分页采用游标，稳定排序 | M | 数据变更中翻页不重复不遗漏 |
| FR-RES-013 | API 版本化与弃用策略 | S | 破坏性变更提供 ≥ 2 个版本周期的过渡 |
| FR-RES-014 | 批量操作（批量创建/更新/建关系） | S | 单请求 ≤ 500 条，部分失败返回逐条结果 |
| FR-RES-015 | 存储可演进至独立图库而不改契约 | S | 存在适配层，切换有测试证明 |
| FR-RES-016 | 全文检索：按标题、属性值、标签查找对象，中英文皆可 | M | 中文子串（如「状态机」）可检索；属性**名**不参与匹配；与其余过滤条件为 AND；粘贴 id 可直接定位 |
