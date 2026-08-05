# Story 模板

> Story 是**可独立交付的最小需求单元**。
> 没有结构化 Acceptance 的 Story 不能进入执行（FR-DOM-004）。

---

## 元信息

| 字段 | 值 |
| --- | --- |
| ID | `story_...` |
| Parent Feature | `req_...` |
| Owner | |
| Assignee | User 或 Agent |
| Status | Draft / Ready / InProgress / Review / Testing / Done |
| Story Point | （含估算依据与置信度） |
| Sprint | |

## 用户故事

> 作为 **<角色>**，我希望 **<能力>**，以便 **<价值>**。

## INVEST 自检

| 项 | 满足 | 说明 |
| --- | --- | --- |
| Independent 独立 | ☐ | |
| Negotiable 可协商 | ☐ | |
| Valuable 有价值 | ☐ | |
| Estimable 可估算 | ☐ | |
| Small 足够小 | ☐ | 建议 ≤ 1 个迭代的 1/3 |
| Testable 可测试 | ☐ | |

## 验收标准（必填）

| # | Given | When | Then |
| --- | --- | --- | --- |
| 1 | | | |

## 拆分为 Task

| Task | 负责人（User/Agent） | 估算 |
| --- | --- | --- |
| | | |

## 估点依据

| 项 | 内容 |
| --- | --- |
| 类比对象 | `story_...`（历史相似 Story） |
| 历史实际 | |
| 本次估算 | |
| 置信区间 | |
| 估算来源 | human / pm-agent@x.y.z |

## 关系（自动维护）

```
implements   → Requirement (Feature)
decomposedInto → Task
verifiedBy   → Acceptance
produces     → PR / Commit
```
