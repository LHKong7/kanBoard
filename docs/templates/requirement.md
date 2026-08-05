# Requirement 模板

> 本模板是 `Requirement` 领域对象的**人类可读视图**。
> 最终形态是结构化 Domain Object，不是 Markdown 文件。

---

## 元信息

| 字段 | 值 |
| --- | --- |
| ID | `req_...`（系统生成） |
| Level | Epic / Feature / Story |
| Owner | |
| Status | Draft / Review / Approved / Planning / InProgress / Finished |
| Priority | Must / Should / Could / Won't（或 WSJF / RICE 值） |
| Source | customer / internal / incident / ai-proposed |
| Parent | 上级 Requirement（Epic ← Feature ← Story） |
| Project | |

## 背景（Why）

为什么需要它？解决谁的什么问题？

**证据来源**：（客户反馈 / 数据 / 故障单 …，必须可追溯到具体实体）

## 目标（What）

一句话陈述期望达成的结果。可量化。

## 非目标（Non-Goals）

明确不做什么，避免范围蔓延。

## 范围与约束

- 涉及的服务 / API / 数据：
- 架构约束（关联 `Architecture` 对象）：
- 依赖（`blocks` / `relatesTo`）：

## 验收标准（Acceptance）

结构化，Story 级至少 1 条。

| # | Given | When | Then | Verified By |
| --- | --- | --- | --- | --- |
| 1 | | | | |
| 2 | | | | |

## 影响面

| 类型 | 对象 |
| --- | --- |
| 受影响的 Story / Task | |
| 受影响的 API / Service | |
| 相关 Decision / ADR | |

## 风险

| 风险 | 概率 | 影响 | 缓解 | Owner |
| --- | --- | --- | --- | --- |

## 关系（自动维护）

```
implementedBy  → Story / Task
explainedBy    → Decision
constrainedBy  → Architecture
verifiedBy     → Acceptance
```

## AI 辅助说明

若本需求由 Requirement Agent 生成：

- Run ID：
- 事实性陈述必须带出处；无出处的内容标注 `[待确认]`
- 状态为 `Draft`，需人工审阅后方可进入 `Review`
