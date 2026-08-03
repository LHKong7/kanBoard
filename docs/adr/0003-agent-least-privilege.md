# ADR-0003 · Agent 最低权限与临时授权

| 项 | 值 |
| --- | --- |
| 状态 | Accepted |
| 日期 | 2026-08-03 |
| 决策者 | 架构组 + 安全 |
| 关联需求 | FR-IAM-004 ~ FR-IAM-013, FR-AGT-003, FR-AGT-010, FR-AGT-012, FR-CON-002 |

## 背景

ProjectOS 允许 Agent 承担真实交付工作：改代码、提 PR、创建需求、调用外部系统。
Agent 的行为由模型推理驱动，存在三类固有风险：

1. **推理错误**：Agent 误判目标，执行了范围外的操作
2. **提示注入**：外部内容（PR 描述、网页、邮件）诱导 Agent 执行非预期动作
3. **权限扩散**：为了"让 Agent 好用"而逐步放宽权限，最终形成超级账号

一旦 Agent 持有长期高权限凭据，上述任一风险都可能造成不可逆损失。

## 决策

**Agent 是一等身份主体，默认零权限，所有外部访问经 Connector，所有授权临时且绑定 Run。**

具体：

1. **独立身份**：Agent principal 为 `agent://<name>@<version>`，不复用人的身份。
2. **默认零权限**：新建 Agent 未显式授权前，所有操作被 PDP 拒绝。
3. **受限委派**：Agent 代表用户执行时，有效权限 = `user权限 ∩ agent权限`，且不超过 Agent 上限。
4. **临时授权（JIT Grant）**：
   - 带 `scope` + `ttl` + `maxCalls` + `bindTo: AgentRun`
   - 三个失效条件任一触发即回收（TTL 到期 / 调用次数耗尽 / Run 结束）
   - 无长期有效的 Agent 凭据
5. **硬性护栏**（任何策略不可覆盖）：
   `Project.Delete` / `Permission.Grant` / `Tenant.*` 对所有 Agent 永久禁止。
6. **强制人工确认**（Ask 策略）：
   `PR.Merge` / `Release.Promote:prod` / `Data.Delete` / `Browser.Action:payment`
7. **blastRadius**：单次 Run 影响对象数上限（默认 100），超限熔断并告警。
8. **必经 Connector**：Agent 不得直连数据库或外部 API；网络策略层面阻断。
9. **全量审计**：所有权限决策与 Connector 调用 100% 留痕，保留 ≥ 1 年，精确到 Agent 版本与 Run。

## 备选方案

| 方案 | 优点 | 缺点 | 未选原因 |
| --- | --- | --- | --- |
| A. Agent 复用调用者身份（纯代理） | 实现简单，权限天然受限于用户 | 无法区分"人做的"与"Agent 做的"；用户是管理员时 Agent 即管理员 | 审计与爆炸半径均不可控 |
| B. Agent 使用长期服务账号 | 运维简单 | 凭据泄漏即长期高权限失守；无法按 Run 收敛 | 风险不可接受 |
| C. 仅靠 Prompt 约束（"请不要删除项目"） | 零成本 | 提示注入可绕过；无强制力 | 不构成安全控制 |
| D. Agent 只读，所有写操作人工执行 | 最安全 | Automation Rate 无法提升，产品价值不成立 | 与产品目标冲突 |

## 后果

### 正面

- 单个 Agent 被攻破的影响被限制在其 scope、TTL 与 blastRadius 内
- "谁做的"永远可回答，精确到 Agent 版本与具体 Run
- 提示注入即使成功诱导推理，也无法突破 PDP 与硬性护栏
- 权限扩散有明确的不可逾越上界

### 负面 / 代价

- 授权链路复杂：每次 Connector 调用增加一次 PDP 往返（性能预算见 NFR-PERF-004）
- Ask 策略会打断自动化流程，初期 Ask Rate 可能偏高，影响体感
- 配置成本：每个 Agent 需要逐条设计 Capability，不能"一键全开"
- 委派交集语义可能让用户困惑（"我有权限，为什么 Agent 做不了"）——需要清晰的错误提示

### 需要后续处理

- [ ] PDP 决策缓存策略，控制授权链路时延（不缓存 Deny 与 Ask）
- [ ] Ask Rate 监控；过高时说明护栏配置需调整（FR-DASH-003）
- [ ] 权限模拟器，帮助配置者预演有效权限（FR-IAM-014）
- [ ] 委派拒绝时返回可读原因（缺哪条 Capability、来自哪一侧）

## 验证方式

- 自动化测试：新建 Agent 未授权时所有操作被拒
- 自动化测试：TTL / maxCalls / Run 结束三种失效路径各自可验证
- 自动化测试：尝试为 Agent 授予 `Permission.Grant` 必须失败
- 混沌测试：构造 blastRadius 超限场景，验证熔断与告警
- 网络策略审计：Agent 运行环境无法直连数据库与外部 API
- 提示注入测试集：通过率 ≥ 95%（NFR-SEC-007）
