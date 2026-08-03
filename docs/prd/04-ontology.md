# 04 · 本体层（Ontology）

| 项 | 值 |
| --- | --- |
| 版本 | v1.0 |
| 状态 | Draft |
| 更新时间 | 2026-08-03 |

---

## 1. 为什么需要本体

DDD 解决**边界**问题：谁拥有什么、谁能改什么。
本体解决**语义**问题：这个东西是什么、它和别的东西是什么关系。

没有本体，AI 只能做字符串匹配；有了本体，AI 可以**沿关系推理**。

---

## 2. 本体三要素

```
EntityType     实体类型      Project / Requirement / Task / Agent …
AttributeType  属性类型      title / status / priority / confidence …
RelationType   关系类型      contains / implementedBy / produces / explains …
```

### 2.1 EntityType 定义

```yaml
entityType: Requirement
version: 1.2.0
context: Requirement            # 归属限界上下文
extends: Resource               # 继承统一资源基类
attributes:
  - name: level
    type: enum[Epic, Feature, Story]
    required: true
  - name: statement
    type: richtext
    required: true
  - name: priority
    type: ref(Priority)
  - name: source
    type: enum[customer, internal, incident, ai-proposed]
relations:
  - type: implementedBy
    target: Story
    cardinality: 0..n
  - type: explainedBy
    target: Decision
    cardinality: 0..n
lifecycle: requirement-default   # 引用 Workflow 状态机
```

### 2.2 RelationType 定义

```yaml
relationType: implementedBy
inverse: implements
transitive: false
domain: [Requirement, Story]
range: [Story, Task]
attributes:
  - name: coverage        # 覆盖比例
    type: percent
  - name: inferredBy      # human | system | agent:<id>
    type: string
  - name: confidence
    type: float           # agent 推断时必填
```

---

## 3. 核心本体图

```
Project
  │ contains
  ▼
Requirement
  │ implementedBy
  ▼
Task
  │ produces
  ▼
PR
  │ releasedAs
  ▼
Version (Release)
  │ distills
  ▼
Knowledge
```

补充关系：

```
Decision    --explains-->      Requirement
Decision    --supersedes-->    Decision
Agent       --owns-->          Task
Agent       --uses-->          Tool
Architecture--constrains-->    Requirement
Api         --exposedBy-->     MicroService
Task        --blockedBy-->     Task
Knowledge   --derivedFrom-->   Meeting | PR | Research
Meeting     --produces-->      ActionItem(Task)
Story       --verifiedBy-->    Acceptance
Issue       --regresses-->     Requirement
```

---

## 4. 关系语义规则

| 规则 | 说明 |
| --- | --- |
| 双向性 | 每个 RelationType 必须定义 `inverse`，查询任一方向等价 |
| 传递性 | 标记 `transitive: true` 的关系支持闭包查询（如 `contains`） |
| 来源可溯 | 每条关系记录 `createdBy`（human/system/agent）与 `createdAt` |
| 置信度 | Agent 推断的关系必须带 `confidence ∈ [0,1]`，低于阈值仅作为"建议关系" |
| 可否决 | 建议关系可被人工 confirm / reject；reject 记录为负样本 |

---

## 5. 本体驱动的能力

### 5.1 全链路追溯

> "这个线上故障对应的原始需求是什么？谁批准的？当时的决策依据？"

```
Issue --regresses--> Requirement --explainedBy--> Decision
                          ▲
                  approvedBy(User, at)
```

一次图查询即可返回完整证据链。

### 5.2 影响面分析

> "改这个 API 会影响哪些需求和迭代？"

```
Api --exposedBy--> MicroService --implements--> Story --partOf--> Requirement
```

### 5.3 知识可推理问答

RAG 不再是"向量相似度"，而是**图检索 + 向量检索混合**：
先用本体锁定候选子图，再在子图内做语义检索，答案自带出处。

### 5.4 自动关系建立

| 触发 | 自动建立的关系 |
| --- | --- |
| PR 描述含 `TASK-123` | `PR --produces--> Task` 的逆关系 |
| Commit message 含 issue key | `Commit --references--> Issue` |
| Release 包含某 PR | `PR --releasedAs--> Version` |
| 会议纪要产生行动项 | `Meeting --produces--> Task` |
| ADR 引用需求 | `Decision --explains--> Requirement` |

---

## 6. 本体版本与演进

| 变更类型 | 兼容性 | 处理 |
| --- | --- | --- |
| 新增可选属性 | 向后兼容 | minor 版本递增，无需迁移 |
| 新增关系类型 | 向后兼容 | minor |
| 属性由可选变必填 | 破坏性 | major，需迁移脚本 + 数据回填 |
| 删除属性 / 关系 | 破坏性 | major，先 deprecate 一个版本周期 |
| 修改枚举值语义 | 破坏性 | major，禁止原地改语义，须新增值 |

规则：

- 本体版本采用 SemVer；实体实例记录写入时的 `ontologyVersion`。
- 读取旧版本实例时按兼容视图投影，不阻塞读。
- 破坏性变更必须有 ADR。

---

## 7. 本体扩展（租户自定义）

企业可在系统本体之上扩展：

- 新增 EntityType（如 `ComplianceCheck`）
- 为已有 EntityType 新增属性（命名空间隔离：`x_<tenant>_<field>`）
- 新增 RelationType

约束：

- 不允许修改系统本体的既有语义
- 租户扩展仅在本租户可见
- 扩展同样需要通过校验与版本化

---

## 8. 需求条目

| ID | 需求 | 优先级 | 验收标准 |
| --- | --- | --- | --- |
| FR-ONT-001 | 提供 Ontology Registry，支持 EntityType/RelationType/AttributeType 的注册与查询 | M | 可通过 API 注册并读取类型定义 |
| FR-ONT-002 | 实体写入前进行本体校验 | M | 违反必填/类型/枚举约束的写入被拒绝并返回字段级错误 |
| FR-ONT-003 | 关系必须定义逆关系，双向查询等价 | M | 任取 20 条关系，正反向查询结果一致 |
| FR-ONT-004 | 支持传递闭包查询（如 Project 下所有后代对象） | M | 深度 ≥ 5 的图查询 P95 < 500ms（10 万节点规模） |
| FR-ONT-005 | 支持任意两实体间的路径查询 | M | 返回最短路径及路径上的关系类型 |
| FR-ONT-006 | Agent 推断关系带 confidence 与来源，可人工确认/否决 | M | 建议关系在 UI 中可见并可操作，操作留痕 |
| FR-ONT-007 | 本体版本化与兼容策略 | M | 升级 minor 版本后旧数据可正常读取 |
| FR-ONT-008 | 自动关系建立规则可配置 | S | 规则可增删改，变更即时生效 |
| FR-ONT-009 | 租户级本体扩展 | S | 扩展字段仅本租户可见，命名空间隔离 |
| FR-ONT-010 | 本体一致性巡检（孤儿对象、断链、循环） | S | 每日报告，问题对象可在 UI 中筛选 |
| FR-ONT-011 | 图检索 + 向量检索混合问答，答案带出处 | S | 抽样问答中 ≥ 90% 返回可点击的来源实体 |
| FR-ONT-012 | 本体可视化浏览器 | C | 可从任一实体出发展开 N 跳关系图 |
