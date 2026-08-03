# 12 · 非功能需求（NFR）

| 项 | 值 |
| --- | --- |
| 版本 | v1.0 |
| 状态 | Draft |
| 更新时间 | 2026-08-03 |

---

## 1. 规模假设（设计基线）

| 维度 | v1.0 目标 | 设计上限 |
| --- | --- | --- |
| 租户数 | 50 | 1,000 |
| 单租户用户数 | 2,000 | 20,000 |
| Resource 总量 | 1,000 万 | 1 亿 |
| Relation 总量 | 3,000 万 | 5 亿 |
| 并发 Agent Run | 200 | 2,000 |
| 事件吞吐 | 2,000 events/s | 20,000 events/s |

---

## 2. 性能

| ID | 需求 | 目标 |
| --- | --- | --- |
| NFR-PERF-001 | Resource 单体读取 | P95 < 150ms |
| NFR-PERF-002 | Resource 列表查询（分页 50） | P95 < 400ms |
| NFR-PERF-003 | 图遍历（深度 ≤ 5，1000 万节点） | P95 < 500ms |
| NFR-PERF-004 | 状态迁移（含 PDP + guard） | P95 < 300ms |
| NFR-PERF-005 | 混合语义检索 | P95 < 1.5s |
| NFR-PERF-006 | Dashboard 首屏 | P95 < 2s |
| NFR-PERF-007 | 事件端到端（写入 → 自动化触发） | P95 < 3s |
| NFR-PERF-008 | Agent Run 启动时延（排队至开始推理） | P95 < 5s |
| NFR-PERF-009 | 长时 Agent Run 并发运行时，API 进程时延不受影响 | 与基线偏差 < 10%（worker 隔离有效性，见 [ADR-0007](../adr/0007-typescript-server-stack.md)） |

> 上述目标在选型前设定，与语言无关。**M0 需在 Node 运行时下重新标定并验证**；
> 确实达不到的项须显式调整目标并记录原因，不得默认放宽。

---

## 3. 可用性与可靠性

| ID | 需求 | 目标 |
| --- | --- | --- |
| NFR-AVAIL-001 | 核心 API 可用性 | 99.9%（月） |
| NFR-AVAIL-002 | Agent Runtime 可用性 | 99.5%（降级不影响人类使用） |
| NFR-AVAIL-003 | RPO（数据恢复点） | ≤ 5 分钟 |
| NFR-AVAIL-004 | RTO（恢复时间） | ≤ 1 小时 |
| NFR-AVAIL-005 | 外部 Connector 故障不影响核心功能 | 降级为只读同步，队列缓冲 |
| NFR-AVAIL-006 | LLM 供应商故障自动切换 | 切换时延 < 30s，Run 不丢失 |
| NFR-AVAIL-007 | 事件至少一次投递 + 消费幂等 | 无重复副作用 |

---

## 4. 安全

| ID | 需求 |
| --- | --- |
| NFR-SEC-001 | 传输 TLS 1.3；静态数据加密（AES-256） |
| NFR-SEC-002 | 凭据集中于 Secret Manager，禁止落业务库或日志 |
| NFR-SEC-003 | 默认拒绝的授权模型（见 [07](07-identity-permission.md)） |
| NFR-SEC-004 | 全量审计日志，append-only，保留 ≥ 1 年 |
| NFR-SEC-005 | 出站流量走统一网关 + 域名白名单 |
| NFR-SEC-006 | 依赖漏洞扫描与 SBOM，CI 阻断高危；Node 生态依赖面广，需锁定版本并限制直接依赖数量 |
| NFR-SEC-007 | 提示注入防护：外部内容标记为不可信数据，不作为指令 |
| NFR-SEC-008 | Agent 沙箱：代码执行与浏览器在隔离环境，无宿主网络与文件系统访问 |
| NFR-SEC-009 | 每年至少一次渗透测试；高危问题 30 天内闭环 |
| NFR-SEC-010 | 密钥轮换周期 ≤ 90 天 |

---

## 5. 合规与数据治理

| ID | 需求 |
| --- | --- |
| NFR-COMP-001 | 数据分级：public / internal / confidential / pii |
| NFR-COMP-002 | 数据驻留：支持按租户配置地域，数据不跨域 |
| NFR-COMP-003 | GDPR / 个人信息保护：支持个人数据导出与擦除（擦除走专用流程，保留审计摘要） |
| NFR-COMP-004 | 模型出境：默认允许 `internal` / `confidential` 数据发送至**已批准的**外部托管模型供应商；`pii` 字段默认脱敏；供应商白名单 + 租户级开关 + 全量出境审计（[ADR-0006](../adr/0006-model-data-egress.md)） |
| NFR-COMP-007 | 与模型供应商签署零训练留存（zero-retention）条款，作为进入白名单的前置条件 |
| NFR-COMP-005 | 数据保留策略可配置（默认 3 年，审计 1 年起） |
| NFR-COMP-006 | 支持 SOC 2 Type II 所需的控制项与证据采集 |

---

## 6. 可维护性与可观测性

| ID | 需求 |
| --- | --- |
| NFR-OPS-001 | 全链路 traceId 贯通 API → Domain → Agent → Connector |
| NFR-OPS-002 | 结构化日志，敏感字段自动脱敏 |
| NFR-OPS-003 | 核心指标（RED：Rate/Error/Duration）+ 业务指标暴露为 Prometheus 指标 |
| NFR-OPS-004 | 蓝绿或滚动发布，支持快速回滚（< 10 分钟） |
| NFR-OPS-005 | 数据库迁移可前向兼容，支持在线迁移 |
| NFR-OPS-006 | 架构依赖方向由 CI 自动校验（见 FR-ARCH-001） |
| NFR-OPS-007 | 核心模块单测覆盖率 ≥ 80%，领域不变量覆盖 ≥ 85% |

---

## 7. 可扩展性

| ID | 需求 |
| --- | --- |
| NFR-EXT-001 | 本体可扩展（租户自定义类型与属性） |
| NFR-EXT-002 | Workflow 可配置，无需发版 |
| NFR-EXT-003 | Connector 可插拔（实现统一契约即可接入） |
| NFR-EXT-004 | Agent 与 Skill 可自定义 |
| NFR-EXT-005 | LLM 供应商可插拔 |
| NFR-EXT-006 | 存储可演进（关系库 → 图库 / 向量库）而不改 API 契约 |

---

## 8. 国际化与可访问性

| ID | 需求 |
| --- | --- |
| NFR-I18N-001 | UI 支持中英文，可扩展语言包 |
| NFR-I18N-002 | 时区、日期、数字按 Workspace 设置本地化 |
| NFR-A11Y-001 | 关键流程符合 WCAG 2.1 AA |

---

## 9. 成本

| ID | 需求 |
| --- | --- |
| NFR-COST-001 | Agent 成本三层预算（Agent / Project / Tenant），超限熔断 |
| NFR-COST-002 | 成本可归因至业务对象 |
| NFR-COST-003 | 上下文缓存命中率 ≥ 40%（稳定运行后） |
| NFR-COST-004 | 模型分级路由，低复杂度任务不使用高价模型 |
