# ADR-0007 · 服务端采用 TypeScript

| 项 | 值 |
| --- | --- |
| 状态 | Accepted |
| 日期 | 2026-08-03 |
| 决策者 | 项目负责人 |
| 关联需求 | FR-ARCH-001, FR-AGT-*, NFR-PERF-*, NFR-OPS-* |
| 解决问题 | Q-A1 |
| 取代 | [ADR-0004](0004-go-server-stack.md)（服务端采用 Go） |

## 背景

[ADR-0004](0004-go-server-stack.md) 曾选定 Go，理由是 Agent Run 的高并发与长时任务特征
更契合 Go 的并发模型。同日项目负责人改变决定，改用 TypeScript。

重新评估后，支持这次反向选择的因素有三个，其中前两个在 ADR-0004 中被低估了：

1. **LLM / Agent 生态**。MCP 官方 SDK、流式解析、token 计数、各家模型 SDK 在
   TypeScript 中都是一等支持；ADR-0004 已把「Go 侧需自行封装 MCP 客户端」列为待处理项，
   那是一笔在 M3 前必须还的债。
2. **本体元数据跨语言共享**。ADR-0001 要求 UI 是本体的渲染视图，
   ADR-0002 又把业务属性放进动态 `attributes`——前端需要本体元数据来渲染。
   ADR-0004 曾把「前后端不同语言」列为代价，需要靠 OpenAPI + JSON Schema 桥接。
   同语言后，本体 → 校验器 → 类型 → 渲染可以走一条链路。
3. **迭代速度**。M0 是纯地基交付，没有可见功能，缩短这段周期有实际价值。

代价也是真实的：ADR-0004 选 Go 的理由（长时任务的并发、取消、背压、内存可预测性）
并未消失，只是变成了需要显式工程手段解决的问题。本 ADR 的主要内容就是如何还这笔账。

## 决策

**服务端采用 TypeScript（Node.js 22 LTS，`strict` 模式）。**

### 技术配套

| 项 | 选择 | 说明 |
| --- | --- | --- |
| 运行时 | Node.js 22 LTS | |
| 类型 | TypeScript `strict: true`，禁用隐式 `any` | |
| **运行期校验** | **Zod** | TS 类型在运行期不存在，所有边界必须运行期校验 |
| HTTP | Fastify | 性能与生态平衡；不引入全栈框架 |
| API 规范 | OpenAPI 3.1 为写侧真源 | 与 ADR-0002 的统一 Resource API 对齐 |
| 数据库访问 | `pg` + **Kysely** | 编译期类型化 SQL；**不使用重 ORM**（沿用 ADR-0004 的判断） |
| 依赖方向校验 | **dependency-cruiser**（CI 强制） | 替代 Go 侧的静态分析，落实 FR-ARCH-001 |
| 项目结构 | `src/contexts/<bc>/`，domain 层零框架依赖 | 按限界上下文分模块 |
| 可观测 | OpenTelemetry Node SDK | trace/metric/log 统一 |
| 包管理 | pnpm + workspace | 前后端共享本体类型包 |

### 必须补上的工程手段（对应 Go 放弃掉的能力）

这部分不是可选项，是本决策成立的前提：

| 风险 | 手段 |
| --- | --- |
| **长时 Agent Run 阻塞事件循环** | Agent Run **不在 API 进程内执行**：入队后由独立 worker 进程消费；API 进程只做 I/O |
| **取消与超时** | `AbortSignal` 全链路贯穿（等价于 Go 的 `context.Context`）；每个 Run、每次 Connector 调用都必须接受 signal |
| **背压** | 队列显式限长 + 并发上限；超限拒绝而非堆积。与 FR-AGT-012 的预算熔断共用告警通道 |
| **内存不可预测** | worker 进程设 `--max-old-space-size`；单 Run 的 token 与对象数上限已由 `maxTokensPerRun` / `blastRadius` 约束；worker 崩溃自动重启且不影响 API |
| **运行期类型不安全** | Zod 校验所有外部输入：HTTP 请求体、Connector 响应、模型输出、事件载荷。**本体定义直接生成 Zod schema**——这与 ADR-0001 的「本体先行」天然契合 |
| **CPU 密集任务** | 编辑幅度计算（Levenshtein，FR-DASH-015）、图遍历后处理等放入 worker threads |

### 语言分工

| 用途 | 语言 |
| --- | --- |
| 服务端 + 前端 + 本体类型包 | TypeScript |
| 数据处理 / 模型评估脚本 | Python（离线，不进入服务端主链路） |

## 备选方案

见 [ADR-0004 的备选方案对比](0004-go-server-stack.md#备选方案)（Go / TypeScript / Java / Rust 四选一的分析仍然有效）。
本 ADR 只是在同一组备选中改选 TypeScript，不重复论证。

## 后果

### 正面

- MCP、模型 SDK、流式处理、token 计数全部有一等支持，M3 的 Agent 工作量显著下降
- 本体元数据在前后端共享同一份类型定义，ADR-0002 提到的「前端需要本体元数据渲染」不再需要跨语言桥接
- 本体 → Zod schema → TS 类型 → 前端渲染是一条链路，落实 ADR-0001 的「Ontology → Storage → API → UI」派生关系
- 统一 Resource 模型（ADR-0002）的通用 CRUD 在 TS 的类型系统下样板代码更少（ADR-0004 曾把这列为 Go 的代价）
- 前后端同技能栈，人员调配灵活

### 负面 / 代价

- **长时任务的运行特征需要显式工程保障**，不再由语言兜底。上表的 worker 隔离、AbortSignal、背压是硬性要求，漏掉任何一条都会在 M3 暴露为线上问题
- **运行期无类型保障**，完全依赖 Zod 校验的覆盖度。校验遗漏 = 运行期崩溃或脏数据入库
- 内存占用高于 Go，容器规格与成本上升；需要在 NFR-PERF 压测中重新标定基线
- 部署产物不是单二进制，镜像更大，冷启动更慢
- Node 生态依赖数量多，供应链攻击面大于 Go —— SBOM 与依赖扫描（NFR-SEC-006）的重要性上升

### 需要后续处理

- [ ] Agent Run worker 进程架构定稿（队列选型、崩溃恢复、Run 状态一致性）
- [ ] `AbortSignal` 贯穿规范：任何超过 1 秒的操作必须可取消，lint 规则兜底
- [ ] 本体 → Zod schema 的生成管道（FR-ONT-002 的实现路径）
- [ ] Zod 校验覆盖清单：列出所有外部输入边界，逐条确认已校验
- [ ] 重新标定 NFR-PERF 基线（Node 下的 P95 目标是否仍可达成）
- [ ] 依赖治理策略：锁定版本、定期审计、限制直接依赖数量

## 验证方式

- CI 中 dependency-cruiser 强制模块依赖方向；domain 层 import 框架或基础设施包即失败（FR-ARCH-001）
- CI 中 `tsc --strict` 零错误，禁止 `any` 逃逸
- 自动化测试：所有外部输入边界均有 Zod 校验（边界清单与测试一一对应）
- 自动化测试：取消一个进行中的 Agent Run，全链路（含 Connector 调用）在 5 秒内停止
- 压测：长时 Run 并发运行时，API 进程 P95 时延不受影响（验证 worker 隔离有效）
- 压测：NFR-PERF 各项指标在 Node 下达标，未达标项需显式调整目标并记录
