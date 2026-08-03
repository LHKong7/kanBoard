# 11 · Project Intelligence（Dashboard）

| 项 | 值 |
| --- | --- |
| 版本 | v1.0 |
| 状态 | Draft |
| 更新时间 | 2026-08-03 |

> Dashboard 不是统计报表，而是 **Project Intelligence**：
> 它不只告诉你"发生了什么"，还要回答"为什么"和"接下来该做什么"。

---

## 1. 四个视角

### 1.1 Project

| 指标 | 定义 | 数据来源 |
| --- | --- | --- |
| Burn Down | 剩余工作量随时间变化 | Task/Story 事件流 |
| Velocity | 每迭代完成点数（近 6 迭代趋势） | Sprint 完成事件 |
| Milestone | 里程碑达成率与预测偏差 | Milestone + 进度预测 |
| Risk | 风险数量、等级分布、逾期未缓解数 | Risk 对象 |
| Budget | 预算 vs 实际（人力 / Token / 云成本） | Budget + 成本归因 |
| Scope Change | 需求变更次数与影响范围 | RequirementChanged 事件 |
| Cycle Time | Story 从 Approved 到 Done 的时长分布 | 状态迁移事件 |
| Lead Time | 从提出到发布的端到端时长 | 全链路事件 |

### 1.2 Team

| 指标 | 定义 |
| --- | --- |
| Capacity | 可用工时/点数 |
| Workload | 实际负载与分布均衡度（含单点风险） |
| Review Time | PR/设计评审的等待与处理时长 |
| WIP | 在制品数量与是否超限 |
| Blocked Time | 任务处于 Blocked 的累计时长 |
| Human vs Agent | 人与 Agent 的工作量占比 |

### 1.3 Agent

| 指标 | 定义 |
| --- | --- |
| Cost | 按 Agent / Project / Requirement 归因的成本 |
| Token | Token 消耗趋势与分布 |
| Success Rate | Run 成功率（成功 / 总 Run） |
| **Automation Rate** | 由 Agent 独立完成且被接受的工作项占比（**北极星指标**） |
| Acceptance Rate | Agent 产出的人工采纳率 |
| Rework Rate | 采纳后 7 天内被推翻的比例 |
| Latency | Run 时延 P50 / P95 |
| Ask Rate | 触发人工确认的比例（过高说明权限或护栏设置需调整） |

### 1.4 Knowledge

| 指标 | 定义 |
| --- | --- |
| New Knowledge | 新增知识对象数量 |
| Reuse Rate | 被引用/复用的知识占比 |
| Decision Coverage | 重大变更中有 ADR 记录的比例 |
| Staleness | 过期未复核的知识占比 |
| Orphan Rate | 无关系连接的孤儿对象占比（本体健康度） |
| Traceability | Requirement → Release 全链路可追溯覆盖率 |

---

## 2. 从"统计"到"智能"

Dashboard 的每个异常指标都必须可**下钻到证据实体**，并给出可执行建议。

```
Velocity 下降 22%
   │  ▼ 下钻
   ├─ 归因：Blocked Time 增长 3.1×
   │    └─ 主要阻塞源：Task:441（等待 API 契约确认）
   │         └─ 关联：Architecture 变更 ARCH-88 无 ADR
   └─ 建议：
        · 为 ARCH-88 补充 Decision（一键调用 Architecture Agent 起草）
        · 将 Task:441 升级为阻塞项并指派 owner
```

规则：

| # | 规则 |
| --- | --- |
| I1 | 每个指标可下钻至构成它的实体清单 |
| I2 | 异常检测基于历史基线，而非固定阈值 |
| I3 | 归因结论必须沿本体关系给出路径，不做无依据推测 |
| I4 | 建议必须可一键执行（创建 Task / 调用 Agent / 发起审批） |
| I5 | 指标由事件流物化，**不存在人工填报** |

---

## 3. 实现要求

| 项 | 要求 |
| --- | --- |
| 计算方式 | 事件驱动增量物化视图；重算可回放事件重建 |
| 新鲜度 | 核心指标延迟 ≤ 1 分钟；成本类 ≤ 5 分钟 |
| 权限 | 指标遵守资源级权限：用户看不到无权访问对象贡献的明细（聚合值可按策略脱敏或隐藏） |
| 时区 | 按 Workspace 配置，跨时区团队一致 |
| 导出 | 支持 CSV / API 导出；支持订阅定期推送 |
| 自定义 | 支持自定义看板与指标组合（v1.1） |

---

## 4. 需求条目

| ID | 需求 | 优先级 | 验收标准 |
| --- | --- | --- | --- |
| FR-DASH-001 | Project 视角 8 项指标 | M | 全部可展示且可下钻 |
| FR-DASH-002 | Team 视角 6 项指标 | M | 全部可展示且可下钻 |
| FR-DASH-003 | Agent 视角 8 项指标 | M | 全部可展示；Automation Rate 为首屏北极星 |
| FR-DASH-004 | Knowledge 视角 6 项指标 | S | 全部可展示 |
| FR-DASH-005 | 指标由事件流自动物化，无人工填报 | M | 系统中不存在指标填报入口 |
| FR-DASH-006 | 指标可下钻至实体清单 | M | 任一指标点击后展示构成明细 |
| FR-DASH-007 | 基于历史基线的异常检测 | S | 异常项高亮并给出偏离度 |
| FR-DASH-008 | 归因沿本体关系给出路径 | S | 归因结果展示关系路径 |
| FR-DASH-009 | 建议可一键执行 | S | 建议触发创建对象或调用 Agent |
| FR-DASH-010 | 指标遵守资源级权限 | M | 无权限用户看不到相关明细 |
| FR-DASH-011 | 核心指标新鲜度 ≤ 1 分钟 | M | 压测下满足 |
| FR-DASH-012 | 指标可回放事件重建 | S | 重建结果与在线值一致 |
| FR-DASH-013 | 导出与定期订阅推送 | C | 支持 CSV/API 与邮件订阅 |
| FR-DASH-014 | 自定义看板 | C | v1.1 交付 |
