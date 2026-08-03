# 10 · AI 能力

| 项 | 值 |
| --- | --- |
| 版本 | v1.0 |
| 状态 | Draft |
| 更新时间 | 2026-08-03 |

> 不仅是 AI Chat，而是 **AI PM / AI Architect / AI QA**——AI 承担角色，而非提供聊天框。

---

## 1. 能力总览

| # | 能力 | 负责 Agent | 默认模式 | 优先级 |
| --- | --- | --- | --- | --- |
| 1 | 自动生成 WBS | PM Agent | Draft | M |
| 2 | 自动拆分 Story | PM Agent | Draft | M |
| 3 | 自动生成 Sprint 计划 | PM Agent | Suggest | M |
| 4 | 自动估 Story Point | PM Agent | Suggest | M |
| 5 | 自动生成 Roadmap | PM Agent | Suggest | S |
| 6 | 自动发现风险 | PM Agent | Suggest | M |
| 7 | 自动写 PRD | Requirement Agent | Draft | M |
| 8 | 自动 Review 架构 | Architecture Agent | Suggest | S |
| 9 | 自动关联 Knowledge | Knowledge Agent | Autonomous | M |
| 10 | 自动总结会议 | Meeting Agent | Autonomous | M |
| 11 | 自动更新 Dashboard | 系统 + Knowledge Agent | Autonomous | M |
| 12 | 承接编码任务并提 PR | Coding Agent | Execute-with-review | S |
| 13 | 生成测试用例并验证 | QA Agent | Execute-with-review | S |
| 14 | 技术调研（含 Browser） | Research Agent | Draft | S |
| 15 | 发布编排与变更清单 | Release Agent | Execute-with-review | S |

模式定义见 [05-agent-runtime.md](05-agent-runtime.md#4-人机协作模式human-in-the-loop)。

---

## 2. 能力细则

### 2.1 自动生成 WBS

**输入**：Project / Epic + 约束（时间、人力、技术栈）
**输出**：多层 WBS，叶子节点可直接转为 Story
**上下文**：历史相似项目的 WBS、团队技能矩阵、Architecture 约束
**验收**：
- 生成结果为 Draft 状态的对象树，人工可逐节点接受/修改/拒绝
- 每个节点标注估算依据与置信度
- 与历史项目的相似节点建立 `derivedFrom` 关系

### 2.2 自动拆分 Story

**输入**：Feature 级 Requirement
**输出**：Story 列表 + 每个 Story 的 Given/When/Then 验收标准
**规则**：
- 每个 Story 必须独立可交付（INVEST）
- 拆分结果必须覆盖父需求的全部 Acceptance，覆盖率在 UI 中展示
- 自动建立 `Requirement --implementedBy--> Story` 关系
**验收**：拆分覆盖率 ≥ 95%；未覆盖项显式列出

### 2.3 自动估 Story Point

**输入**：Story + 团队历史速度
**输出**：点数 + 置信区间 + 类比依据（"类似于 STORY-233，当时 5 点，实际 6 点"）
**验收**：与人工估算的中位偏差 ≤ 1 个斐波那契档位（在 3 个迭代样本上）

### 2.4 自动生成 Sprint

**输入**：待办 Story 池、团队 capacity、依赖关系、优先级
**输出**：Sprint 候选方案（≥ 2 个），标注取舍
**约束**：不得违反依赖顺序；不得超 capacity 的 110%
**验收**：方案可一键应用，应用后可撤销

### 2.5 自动生成 Roadmap

**输入**：Goal / Milestone / Requirement 优先级
**输出**：按季度/月的 Roadmap 视图 + 关键风险节点
**验收**：Roadmap 变更可与实际进度对比，偏差可视化

### 2.6 自动发现风险

**信号源**：

| 信号 | 风险类型 |
| --- | --- |
| 需求批准后频繁变更 | 范围蔓延 |
| 依赖链过长 / 存在单点 | 交付阻塞 |
| Task 在 Doing 停留超 SLA | 进度风险 |
| 关键人员负载 > 阈值 | 容量风险 |
| 缺陷回归率上升 | 质量风险 |
| Agent 成本增速 > 预算增速 | 成本风险 |
| Architecture 破坏性变更无 ADR | 技术风险 |

**输出**：`Risk` 对象（含概率、影响、建议缓解、owner 建议）
**验收**：风险附带触发它的证据实体链接

### 2.7 自动写 PRD

**输入**：一段业务描述 / 会议纪要 / 客户反馈
**输出**：结构化 Requirement（背景、目标、范围、非目标、验收标准、风险）
**约束**：所有引用的事实必须能追溯到来源实体；**不得凭空编造数据**
**验收**：产出为 Draft；每个事实性陈述带出处或标注"待确认"

### 2.8 自动 Review 架构

**输入**：Architecture 变更 / API 契约 diff
**输出**：评审意见（一致性、兼容性、影响面、备选方案）+ ADR 草案
**验收**：破坏性变更 100% 被识别并提示需要 ADR

### 2.9 自动关联 Knowledge

**行为**：在需求撰写、任务执行、故障处理时，主动推送相关历史知识
**约束**：推送必须带出处与时效标记（过期知识降权）
**验收**：知识推荐的人工点击率 ≥ 20%

### 2.10 自动总结会议

**输入**：录音 / 转写 / 聊天记录
**输出**：`Meeting` 对象 + 决策（`Decision`）+ 行动项（`Task`）
**验收**：行动项自动关联到负责人与截止时间，可一键创建

### 2.11 自动更新 Dashboard

指标由事件流实时物化，无需人工填报。见 [11-dashboard.md](11-dashboard.md)。

---

## 3. AI 质量与安全约束

| # | 约束 |
| --- | --- |
| Q1 | **不编造**：所有事实性陈述必须有出处实体；无出处则标注为假设 |
| Q2 | **可追溯**：每个 AI 产出关联 `AgentRun`，可回放推理过程 |
| Q3 | **可拒绝**：任何 AI 产出都可被人工拒绝，拒绝原因作为反馈样本 |
| Q4 | **不越权**：AI 读不到的对象不进入上下文；越权请求被 PDP 拒绝 |
| Q5 | **不外泄**：数据分级策略决定哪些内容可发送给外部模型；confidential 默认不出境 |
| Q6 | **可关闭**：任何 AI 能力可按租户/项目级开关关闭 |
| Q7 | **成本可控**：见 [05](05-agent-runtime.md#6-成本与模型策略) |
| Q8 | **提示注入防护**：外部来源内容（PR 描述、网页、邮件）在进入上下文前标记为不可信，不得作为指令执行 |

---

## 4. 效果评估

每个 AI 能力必须有可度量的评估：

| 指标 | 定义 |
| --- | --- |
| 采纳率 | 人工接受的产出 / 总产出 |
| 修改幅度 | 采纳前的人工编辑量（字符级 diff 比例） |
| 返工率 | 采纳后 7 天内被推翻的比例 |
| 时延 | 从触发到产出的 P50 / P95 |
| 单位成本 | 每个被采纳产出的平均 token 成本 |

评估数据进入 Dashboard，作为 Agent 版本迭代与 Prompt 优化的依据。

---

## 5. 需求条目

| ID | 需求 | 优先级 | 验收标准 |
| --- | --- | --- | --- |
| FR-AI-001 | 自动生成 WBS（Draft 模式，逐节点可操作） | M | 生成对象树并可逐节点接受/拒绝 |
| FR-AI-002 | 自动拆分 Story 且覆盖父需求 Acceptance | M | 覆盖率 ≥ 95%，未覆盖项显式列出 |
| FR-AI-003 | 自动估点并给出类比依据 | M | 中位偏差 ≤ 1 档（3 迭代样本） |
| FR-AI-004 | 自动生成 ≥2 个 Sprint 候选方案 | M | 不违反依赖与 capacity 约束，可一键应用与撤销 |
| FR-AI-005 | 自动生成 Roadmap 并可对比实际进度 | S | 偏差可视化 |
| FR-AI-006 | 自动发现风险并附证据链 | M | 每条风险可点击到触发它的实体 |
| FR-AI-007 | 自动写 PRD，事实带出处 | M | 无出处内容被标注为"待确认" |
| FR-AI-008 | 架构评审识别破坏性变更 | S | 破坏性变更识别率 100%（测试集） |
| FR-AI-009 | 知识主动推荐 | M | 推荐带出处与时效，点击率可统计 |
| FR-AI-010 | 会议总结产出 Meeting/Decision/Task | M | 行动项可一键创建并关联负责人 |
| FR-AI-011 | Dashboard 指标由事件流自动物化 | M | 无人工填报路径 |
| FR-AI-012 | AI 能力可按租户/项目开关 | M | 关闭后相关入口与自动化均不触发 |
| FR-AI-013 | 提示注入防护 | M | 注入测试集通过率 ≥ 95%，不可信内容不被当作指令 |
| FR-AI-014 | 数据分级出境控制 | M | confidential 数据不发送至未授权的外部模型 |
| FR-AI-015 | AI 效果评估指标采集与展示 | S | 5 项指标可在 Dashboard 查看并按 Agent 版本对比 |
| FR-AI-016 | 拒绝反馈进入优化闭环 | C | 拒绝样本可导出用于 Prompt/模型评估 |
