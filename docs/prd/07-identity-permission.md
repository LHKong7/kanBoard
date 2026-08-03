# 07 · 身份与权限模型（Identity & Permission）

| 项 | 值 |
| --- | --- |
| 版本 | v1.0 |
| 状态 | Draft |
| 更新时间 | 2026-08-03 |

> 权限不能止步于 RBAC。
> ProjectOS 采用 **Identity + Role + Capability + Resource + Policy** 五层模型，
> 统一约束**人和 Agent**的行为。

---

## 1. 五层模型

```
① Identity    谁                User / Group / Department / Org / Workspace / Tenant / Agent
② Role        什么身份           PM / RD / QA / Admin / Leader / Guest / AI Agent
③ Capability  能做什么           Requirement.Read / Task.Execute / Project.Delete
④ Resource    对什么             Requirement:123 / Task:222 / Agent:PM / Project:A
⑤ Policy      在什么条件下        Allow / Deny / Ask / OwnerOnly / DepartmentOnly / …
```

授权决策：

```
decide(Subject, Action, Resource, Context) → Allow | Deny | Ask
```

---

## 2. 第一层 · Identity

```
Tenant
 └── Organization
      └── Department
           └── Group
                └── User
Workspace（跨部门的工作空间）
Agent（一等身份主体）
```

| 类型 | 说明 |
| --- | --- |
| `User` | 自然人 |
| `Group` | 逻辑团队（可跨部门） |
| `Department` | 组织架构单元 |
| `Organization` | 法律/业务实体 |
| `Workspace` | 协作空间，权限的主要边界 |
| `Tenant` | 最外层隔离边界 |
| `Agent` | AI 主体，**与 User 同级的一等身份** |

**规则**
- Agent 拥有独立 principal（`agent://<name>@<version>`），不复用人的身份。
- Agent 代表人执行时使用**受限委派**：`user + agent` 双主体，取权限**交集**，且不超过 Agent 自身上限。

---

## 3. 第二层 · Role

角色是 Capability 的**命名集合**，便于管理，不是权限本身。

| Role | 典型 Capability |
| --- | --- |
| `PM` | Requirement.*, Story.*, Sprint.Plan, Dashboard.Read |
| `RD` | Task.Execute, Code.Read, Code.Write, PR.Create |
| `QA` | TestCase.*, Issue.Create, Acceptance.Verify |
| `Leader` | 上述只读 + Approve.* + Budget.Read |
| `Admin` | 租户内全部（含 Permission.Grant） |
| `Guest` | 指定 Resource 的 Read |
| `AI Agent` | **无默认权限**，必须逐条显式授予 |

**规则**：`AI Agent` 角色不是"给 Agent 全部权限"的快捷方式；它是一个**空集合**起点。

---

## 4. 第三层 · Capability

细粒度动作权限，命名规范：`<Domain>.<Action>[:<Qualifier>]`

```
Requirement.Read        Requirement.Write      Requirement.Approve
Task.Read               Task.Execute           Task.Update:own
Code.Read               Code.Write             PR.Create        PR.Merge
Knowledge.Read          Knowledge.Share
Project.Read            Project.Delete
Agent.Invoke            Agent.Define
Permission.Grant        Connector.Use:<name>
Release.Promote:gray    Release.Promote:prod
```

Qualifier 用于收窄范围：`:own`（仅自己拥有的）、`:team`、`:gray`。

---

## 5. 第四层 · Resource

权限作用于**具体资源**，而非仅资源类型。

```
Requirement:123
Task:222
Document:444
Agent:PM
Project:A
Repo:org/service-x
Connector:github
```

支持层级继承：

```
Tenant:T1 → Workspace:W1 → Project:A → Requirement:123
```

上层授权向下继承，下层可**收紧**但不可放宽（除非显式 Allow 且无更高优先级的 Deny）。

---

## 6. 第五层 · Policy

| Policy | 语义 |
| --- | --- |
| `Allow` | 允许 |
| `Deny` | 拒绝（**始终优先于 Allow**） |
| `Ask` | 需人工确认后放行（用于 Agent 敏感操作） |
| `OwnerOnly` | 仅资源 owner |
| `DepartmentOnly` | 仅同部门 |
| `WorkspaceOnly` | 仅同 Workspace |
| `TenantOnly` | 仅同租户 |

### 条件（Context）

Policy 可附加条件表达式：

```yaml
policy:
  effect: Allow
  subject: role:RD
  action: Code.Write
  resource: Repo:org/service-x
  condition:
    ip: { in: corp-cidr }
    time: { between: "09:00-21:00", tz: Asia/Shanghai }
    mfa: true
    dataClassification: { notIn: [confidential] }
```

### 决策顺序

```
1. 显式 Deny            → Deny（终止）
2. 硬性护栏（forbidden） → Deny（终止）
3. 显式 Allow + 条件满足 → 继续
4. 存在 Ask 策略        → Ask（挂起等待人工）
5. 未匹配任何 Allow      → Deny（默认拒绝）
```

**默认拒绝（deny-by-default）是全局默认。**

---

## 7. Agent 权限（最重要的一节）

### 7.1 最低权限原则

Agent **永远**是最低权限。

```
Coding Agent
  ✅ Code.Read
  ✅ Code.Write
  ✅ PR.Create
  ✅ Task.Update:own
  ──────────────────
  ❌ PR.Merge            → Ask（需人工）
  ❌ Project.Delete      → 硬性禁止
  ❌ Permission.Grant    → 硬性禁止
  ❌ Release.Promote:prod→ 硬性禁止
```

### 7.2 临时授权（Just-in-Time Grant）

Agent 调用 Connector **必须**申请临时授权：

```
Agent 请求
   ↓
Grant {
  subject:  agent://coding-agent@2.1.0
  onBehalfOf: user://alice          # 委派来源（可选）
  connector: github
  scope:    Repository:org/service-x
  actions:  [PR.Create, Code.Read]
  ttl:      30m
  maxCalls: 200
  bindTo:   AgentRun:run-8891       # 绑定到具体 Run
}
   ↓
Capability 自动失效（TTL 到期 / Run 结束 / 调用次数耗尽，三者取先到者）
```

**规则**

| # | 规则 |
| --- | --- |
| A1 | 无长期有效的 Agent 凭据；所有授权带 TTL |
| A2 | 授权绑定到具体 `AgentRun`，Run 结束即回收 |
| A3 | 委派权限取 `user ∩ agent` 交集，且不超过 Agent 上限 |
| A4 | Agent 不可自我提权，`Permission.Grant` 对所有 Agent 硬性禁止 |
| A5 | Agent 不可创建/修改其他 Agent 的权限定义 |
| A6 | 所有 Agent 的权限决策 100% 审计，保留期 ≥ 1 年 |
| A7 | 敏感操作走 `Ask`：挂起 Run，人工确认后继续，超时自动 Deny |

### 7.3 Agent 行为护栏

```yaml
guardrails:
  forbidden:                       # 硬性禁止，任何策略不可覆盖
    - Project.Delete
    - Permission.Grant
    - Tenant.*
    - Connector.Use:erp            # 未评估的高风险连接器
  requireHumanApproval:            # 强制 Ask
    - PR.Merge
    - Release.Promote:prod
    - Data.Delete
    - Browser.Action:payment
  rateLimit:
    writesPerMinute: 20
  blastRadius:
    maxObjectsPerRun: 100          # 单次 Run 最多影响 100 个对象
```

`blastRadius` 是防止 Agent 失控的最后一道闸：超限即熔断并告警。

---

## 8. 审计

| 要求 | 说明 |
| --- | --- |
| 覆盖 | 所有授权决策 + 所有 Connector 调用 + 所有资源变更 |
| 内容 | who(subject) / what(action) / which(resource) / when / where(ip) / decision / reason / traceId |
| 不可篡改 | append-only，写入后不可修改；可选哈希链 |
| 保留 | 默认 1 年，合规场景可配置至 7 年 |
| 可查询 | 支持按主体、资源、时间、决策类型检索；支持导出 |
| 人 vs Agent | 可分别筛选，Agent 记录精确到版本与 Run |

---

## 9. 需求条目

| ID | 需求 | 优先级 | 验收标准 |
| --- | --- | --- | --- |
| FR-IAM-001 | 实现五层权限模型与统一 PDP | M | `decide()` 接口对全部写路径生效 |
| FR-IAM-002 | 默认拒绝（deny-by-default） | M | 未配置策略时任何操作返回 Deny |
| FR-IAM-003 | Deny 优先于 Allow | M | 冲突策略测试结果为 Deny |
| FR-IAM-004 | Agent 为一等身份主体 | M | Agent 可被独立授权、审计、禁用 |
| FR-IAM-005 | Agent 默认零权限 | M | 新建 Agent 未授权前所有操作被拒绝 |
| FR-IAM-006 | 临时授权：TTL + 调用次数 + 绑定 Run | M | 三个条件任一触发即失效，测试可验证 |
| FR-IAM-007 | 受限委派取权限交集 | M | user 无某权限时，Agent 代其执行同样被拒 |
| FR-IAM-008 | 硬性护栏不可被策略覆盖 | M | 尝试为 Agent 授予 `Permission.Grant` 失败 |
| FR-IAM-009 | Ask 策略：挂起 + 人工确认 + 超时拒绝 | M | 敏感操作触发确认流程，超时自动 Deny |
| FR-IAM-010 | Resource 层级继承与收紧 | M | 上层 Allow 下层 Deny，结果为 Deny |
| FR-IAM-011 | 条件策略（IP / 时间 / MFA / 数据分级） | S | 条件不满足时返回 Deny 并说明原因 |
| FR-IAM-012 | blastRadius 熔断 | M | 单 Run 超限即终止并告警 |
| FR-IAM-013 | 全量审计，append-only，≥1 年保留 | M | 审计记录不可修改，可按多维检索与导出 |
| FR-IAM-014 | 权限模拟器（"如果这样配，Alice 能做什么"） | S | 输入主体与资源，输出有效权限清单 |
| FR-IAM-015 | 多租户隔离 | M | 跨租户访问一律 Deny，无数据泄漏 |
| FR-IAM-016 | 权限变更本身受审计与审批 | S | 授权操作产生审计记录并可要求二次确认 |
