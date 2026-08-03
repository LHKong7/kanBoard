# 06 · Connector 集成层

| 项 | 值 |
| --- | --- |
| 版本 | v1.0 |
| 状态 | Draft |
| 更新时间 | 2026-08-03 |

---

## 1. 核心约束

> **Agent 不直接访问数据库。Agent 通过 Connector 访问一切外部系统。**

```
Agent
  ↓
Connector（统一契约 + 权限校验 + 审计 + 限流）
  ↓
Jira · GitHub · GitLab · MySQL · Redis · Confluence · Notion
ERP · CRM · OSS · Browser · REST · GraphQL · MCP · Kafka
```

这条约束的价值：

| 价值 | 说明 |
| --- | --- |
| 可授权 | 每次外部访问都能落到具体 scope 与 TTL |
| 可审计 | 所有外部读写留痕，可回溯"Agent 到底动了什么" |
| 可替换 | 换 Jira 为其他系统，Agent 定义不变 |
| 可限流 | 统一处理配额、重试、退避、熔断 |
| 可脱敏 | 统一的数据分级与字段脱敏策略 |

---

## 2. Connector 统一能力

每个 Connector 实现同一组动词：

| 动词 | 语义 | 示例 |
| --- | --- | --- |
| `Read` | 读取资源 | 读 PR 内容、查数据库行 |
| `Write` | 写入 / 变更 | 创建 PR、更新 Issue |
| `Observe` | 拉取当前状态快照 | CI 当前状态、表结构 |
| `Subscribe` | 订阅变更事件 | GitHub Webhook、Kafka topic |
| `Action` | 执行副作用动作 | 触发流水线、发送通知 |

### 契约示例

```yaml
connector: github
version: 1.0.0
auth:
  type: oauth-app | github-app | pat
  scopeModel: repository
operations:
  - name: pr.create
    verb: Write
    requiredCapabilities: [PR.Create]
    scope: repository
    idempotencyKey: [repo, headSha, title]
    inputSchema:  { $ref: schemas/pr-create.json }
    outputSchema: { $ref: schemas/pr.json }
  - name: pr.merge
    verb: Action
    requiredCapabilities: [PR.Merge]
    humanApproval: required
rateLimit:
  perMinute: 300
  burst: 50
retry:
  strategy: exponential
  maxAttempts: 4
  baseDelayMs: 2000
dataClassification:
  default: internal
  fields:
    "*.email": pii
```

---

## 3. Connector 分类与优先级

| 类别 | Connector | v1.0 | 说明 |
| --- | --- | --- | --- |
| 代码 | GitHub | ✅ M | PR / Commit / Review / Actions |
| 代码 | GitLab | ✅ S | MR / Pipeline |
| 研发管理 | Jira | ✅ M | 双向同步，支持迁移期并行 |
| 文档 | Confluence | ✅ S | 导入为 Knowledge 对象 |
| 文档 | Notion | ⬜ C | |
| 数据 | PostgreSQL / MySQL | ✅ S | 只读优先，写需显式授权 |
| 缓存 | Redis | ⬜ C | |
| 消息 | Kafka | ✅ S | Subscribe 为主 |
| 存储 | OSS / S3 | ✅ S | Artifact 存取 |
| 通用 | REST | ✅ M | 由 OpenAPI 生成 |
| 通用 | GraphQL | ✅ S | 由 SDL 生成 |
| 通用 | **MCP** | ✅ M | 接入 MCP Server 生态 |
| 浏览器 | **Browser** | ✅ M | 无 API 系统的兜底通道 |
| 企业 | ERP / CRM | ⬜ C | 按客户定制 |

---

## 4. Browser Connector（特别说明）

用于**没有 API 的系统**与**需要真实浏览器语境**的任务（调研、取证、截图）。

### 权限模型（与整体权限模型一致）

```
Browser Capability
├── Domain Allowlist        只允许访问白名单域名
├── Action Scope            navigate / read / click / type / download
├── Credential Scope        使用哪个凭据仓中的凭据（Agent 永不见明文）
├── Data Egress Policy      哪些数据可带回系统
└── TTL                     会话与授权的过期时间
```

### 硬约束

| # | 约束 |
| --- | --- |
| B1 | 默认**拒绝所有域名**，必须显式加入白名单 |
| B2 | 凭据由凭据服务注入，Agent 上下文中**不出现明文凭据** |
| B3 | 涉及支付、权限变更、数据删除的页面动作**必须人工确认** |
| B4 | 每一步操作留存动作日志与截图（可配置） |
| B5 | 下载文件进入隔离区，扫描后方可成为 Artifact |
| B6 | 会话默认 15 分钟过期，不可续期超过 2 次 |

---

## 5. 同步与一致性

### 5.1 双向同步（以 Jira 为例）

```
ProjectOS Task  ◄──────────►  Jira Issue
```

| 问题 | 策略 |
| --- | --- |
| 冲突 | 字段级 last-writer-wins + 冲突记录；关键字段（状态）可配置单向权威源 |
| 循环 | 同步写入携带 `originId`，回环事件被丢弃 |
| 幂等 | 每次写入携带 `idempotencyKey`，重复投递不产生重复对象 |
| 断连 | 本地事件队列缓冲，恢复后按序补发 |
| 漂移 | 定期全量对账，输出差异报告 |

### 5.2 迁移期并行运行

允许 Jira 与 ProjectOS 并行 3–6 个月：

1. **只读镜像期**：Jira 为权威源，ProjectOS 只读同步并构建本体
2. **双写期**：两侧均可写，冲突按字段权威源裁决
3. **切换期**：ProjectOS 为权威源，Jira 降级为只读镜像
4. **退役**

---

## 6. 安全要求

| # | 要求 |
| --- | --- |
| C1 | 凭据集中存储于 Secret Manager，Connector 运行时按需取用，永不落盘于业务库 |
| C2 | 外部调用出站流量走统一网关，域名白名单 + 审计 |
| C3 | 数据分级（public/internal/confidential/pii），高等级字段默认脱敏后才进入 Agent 上下文 |
| C4 | 每次 Connector 调用先经 PDP 授权，授权结果与调用一并入审计日志 |
| C5 | 支持按租户隔离 Connector 实例与凭据 |
| C6 | 写操作默认需要显式 Capability，读写权限不共用同一 scope |

---

## 7. 需求条目

| ID | 需求 | 优先级 | 验收标准 |
| --- | --- | --- | --- |
| FR-CON-001 | 定义并实现 Connector 统一契约（Read/Write/Observe/Subscribe/Action） | M | 至少 3 个 Connector 实现同一接口且可互换测试 |
| FR-CON-002 | Agent 无法绕过 Connector 直连外部系统 | M | 网络策略 + 代码审查证明无直连路径 |
| FR-CON-003 | 每次 Connector 调用先经 PDP 授权并审计 | M | 审计日志包含 subject/action/resource/decision/latency |
| FR-CON-004 | 写操作幂等 | M | 重复投递同一 idempotencyKey 不产生重复对象 |
| FR-CON-005 | 统一限流、重试（指数退避）与熔断 | M | 模拟 429/5xx，行为符合配置 |
| FR-CON-006 | GitHub Connector：PR/Commit/Review/CI | M | 可创建 PR、读取 CI 状态并回写 Task |
| FR-CON-007 | Jira Connector：双向同步与并行运行 | M | 完成 3 阶段迁移演练，无数据丢失 |
| FR-CON-008 | MCP Connector：接入任意 MCP Server 作为 Tool | M | 注册 MCP Server 后其工具自动出现在 Tool 目录 |
| FR-CON-009 | Browser Connector：域名白名单 + 动作范围 + TTL | M | 越白名单访问被拒绝并告警 |
| FR-CON-010 | Browser 敏感动作强制人工确认 | M | 支付/删除类动作未确认时阻断 |
| FR-CON-011 | 凭据由 Secret Manager 注入，Agent 上下文无明文 | M | 上下文快照扫描无凭据泄漏 |
| FR-CON-012 | 数据分级与字段脱敏 | M | PII 字段进入 Agent 上下文前被脱敏 |
| FR-CON-013 | 定期对账与漂移报告 | S | 每日输出与外部系统的差异清单 |
| FR-CON-014 | REST/GraphQL Connector 由规范文件自动生成 | S | 上传 OpenAPI 即可获得可调用工具 |
| FR-CON-015 | Connector 契约测试纳入 CI | S | 外部 API 变更导致契约不符时 CI 失败 |
