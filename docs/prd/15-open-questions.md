# 15 · 待决问题（Open Questions）

| 项 | 值 |
| --- | --- |
| 版本 | v1.0 |
| 状态 | Draft |
| 更新时间 | 2026-08-03 |

> 每个问题解决后，结论落到 `docs/adr/`，本表标记为 Resolved 并链接 ADR。

---

## 产品

| # | 问题 | 影响 | 建议倾向 | 需在何时定 |
| --- | --- | --- | --- | --- |
| Q-P1 | 首个落地场景选哪个：内部研发团队自用，还是直接对外商业化？ | 决定 M1 的功能取舍与迁移优先级 | 先内部自用（dogfooding），M3 后再对外 | M0 结束前 |
| Q-P2 | 是否必须支持 Jira 完整迁移，还是只做单向导入？ | 影响 Connector 工作量（双向同步成本高） | 提供双向同步，但仅覆盖核心字段 | M2 启动前 |
| Q-P3 | 需求评审是否强制走系统内审批流？ | 影响用户接受度 | 可配置，默认开启但可按项目关闭 | M1 |
| Q-P4 | Agent 产出默认是否进入"人工审阅队列"？ | 影响 Automation Rate 的定义与体感 | 默认进入队列；成熟能力逐项放开 | M3 启动前 |
| Q-P5 | 定价模型：按席位 / 按 Agent Run / 按 Token？ | 影响成本归因与配额设计 | 席位 + Agent 用量混合 | M4 |

## 架构

| # | 问题 | 影响 | 建议倾向 | 需在何时定 |
| --- | --- | --- | --- | --- |
| ~~Q-A1~~ | ~~服务端语言与框架~~ | — | ✅ **已决：TypeScript / Node 22 LTS** → [ADR-0007](../adr/0007-typescript-server-stack.md)（取代 [ADR-0004](../adr/0004-go-server-stack.md) 的 Go 方案） | Resolved 2026-08-03 |
| Q-A2 | v1 是否引入独立图数据库？ | 复杂度 vs 查询性能 | 不引入，用 PG 递归 CTE + 物化路径，留适配层 | M0 |
| Q-A3 | 本体是否采用 RDF/OWL 标准，还是自定义元模型？ | 生态互通 vs 实现复杂度 | 自定义元模型，但保留导出为 RDF 的能力 | M0 |
| Q-A4 | 单体优先还是微服务优先？ | 早期迭代速度 | 模块化单体（按 BC 分模块），后期按需拆分 | M0 |
| Q-A5 | 事件总线选型（PG outbox / Kafka / NATS） | 运维成本 | v1 用 PG outbox + poller，M4 前评估 Kafka | M1 |
| ~~Q-A6~~ | ~~多租户隔离策略~~ | — | ✅ **已决：共享库 + tenant 列 + RLS，v1 单租户运行** → [ADR-0005](../adr/0005-tenancy-model.md) | Resolved 2026-08-03 |

## AI / Agent

| # | 问题 | 影响 | 建议倾向 | 需在何时定 |
| --- | --- | --- | --- | --- |
| Q-I1 | Agent 编排用自研 Workflow 还是引入现成框架？ | 可控性 vs 速度 | 自研（与领域对象和权限深度耦合） | M3 启动前 |
| Q-I2 | Agent 间是否允许直接消息传递？ | 可审计性 | **不允许**，只通过领域对象协作（本 PRD 已定，待 ADR 固化） | M3 |
| Q-I3 | Semantic Memory 与 Knowledge BC 的边界如何划？ | 数据重复风险 | Memory 只做索引与偏好，事实一律落 Knowledge | M3 |
| Q-I4 | 是否支持客户自带模型（BYOM / 私有化部署模型）？ | 合规客户的准入 | 支持，通过 modelPolicy 配置端点 | M4 |
| Q-I5 | Agent 失败重试策略：自动重试还是转人工？ | 成本与体验 | 幂等步骤自动重试 ≤ 2 次，其余转人工 | M3 |
| ~~Q-I6~~ | ~~Automation Rate 的精确口径~~ | — | ✅ **已决：L0–L3 四级分级，L3（零编辑 + 7 天未推翻）计入** → [11-dashboard §2](11-dashboard.md#2-automation-rate-口径北极星指标定义) | Resolved 2026-08-03 |

## 安全与合规

| # | 问题 | 影响 | 建议倾向 | 需在何时定 |
| --- | --- | --- | --- | --- |
| ~~Q-S1~~ | ~~confidential 数据能否发送给外部托管模型~~ | — | ✅ **已决：允许，受白名单 + PII 脱敏 + 租户开关 + 审计约束** → [ADR-0006](../adr/0006-model-data-egress.md) | Resolved 2026-08-03 |
| Q-S2 | Browser Connector 的凭据注入方案 | 泄漏风险 | 凭据服务代理注入，Agent 全程不见明文 | M3 |
| Q-S3 | GDPR 擦除与 append-only 审计的冲突如何处理？ | 合规 | 擦除内容主体，保留哈希化审计摘要 | M4 |
| Q-S4 | 代码执行沙箱选型（容器 / microVM / WASM） | 隔离强度 vs 启动时延 | microVM（如 Firecracker）优先，容器兜底 | M4（Coding Agent 前） |
| Q-S5 | 审计日志保留是否需支持 7 年（金融客户）？ | 存储成本 | 支持配置，冷数据归档到对象存储 | M4 |

## 数据与迁移

| # | 问题 | 影响 | 建议倾向 | 需在何时定 |
| --- | --- | --- | --- | --- |
| Q-D1 | 存量 Confluence 文档如何转为 Knowledge 对象？ | 迁移工作量 | 分批导入 + Knowledge Agent 抽取结构，人工抽检 | M2 |
| Q-D2 | 历史 Jira 数据导入多久的？ | 数据量与价值 | 近 24 个月全量，更早只导入摘要 | M2 |
| Q-D3 | 本体破坏性变更的数据回填方案 | 升级风险 | 双写 + 影子读校验 + 灰度切换 | M1 |

---

## 决策记录

| 问题 | 状态 | ADR |
| --- | --- | --- |
| 本体先行 | ✅ Resolved | [ADR-0001](../adr/0001-ontology-first.md) |
| 统一 Resource 模型 | ✅ Resolved | [ADR-0002](../adr/0002-unified-resource-model.md) |
| Agent 最低权限与临时授权 | ✅ Resolved | [ADR-0003](../adr/0003-agent-least-privilege.md) |
| Q-A1 服务端语言 | ✅ Resolved | [ADR-0007](../adr/0007-typescript-server-stack.md)（0004 已 Superseded） |
| Q-A6 多租户隔离策略 | ✅ Resolved | [ADR-0005](../adr/0005-tenancy-model.md) |
| Q-S1 模型数据出境 | ✅ Resolved | [ADR-0006](../adr/0006-model-data-egress.md) |
| Q-I6 Automation Rate 口径 | ✅ Resolved | [11-dashboard §2](11-dashboard.md) |
| 其余 | ⬜ Open | — |

---

## 阻塞项汇总

**M0 已无阻塞项，可以开工。**

四个原阻塞项已于 2026-08-03 全部决策完毕：

| # | 问题 | 结论 |
| --- | --- | --- |
| ✅ Q-A1 | 服务端语言与框架 | TypeScript / Node 22 LTS |
| ✅ Q-A6 | 多租户隔离策略 | 共享库 + tenant 列 + RLS；v1 单租户运行 |
| ✅ Q-I6 | Automation Rate 口径 | L0–L3 分级；L3 = 零编辑 + 7 天未推翻 |
| ✅ Q-S1 | confidential 数据出境 | 允许，受控 |

### 下一批需要决策的问题

| # | 问题 | 何时需要 |
| --- | --- | --- |
| Q-A4 | 模块化单体 vs 微服务 | M0 启动前（倾向：模块化单体） |
| Q-A3 | 自定义元模型 vs RDF/OWL | M0（倾向：自定义 + 可导出 RDF） |
| Q-P1 | 先内部自用还是直接商业化 | M0 结束前（影响 M2 迁移优先级） |
| Q-D3 | 本体破坏性变更的回填方案 | M1 |
