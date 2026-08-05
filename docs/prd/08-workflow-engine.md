# 08 · 工作流引擎（Workflow Engine）

| 项 | 值 |
| --- | --- |
| 版本 | v1.0 |
| 状态 | Draft |
| 更新时间 | 2026-08-03 |

> 所有领域对象都有生命周期，全部可配置。

---

## 1. 默认生命周期

### Task

```
Todo → Doing → Review → Testing → Done
                 │        │
                 └────────┴──► Blocked ──► Doing
```

### Requirement

```
Draft → Review → Approved → Planning → InProgress → Finished
   │       │                                            │
   └───────┴──► Rejected                          Superseded
```

### Release

```
Pending → Gray → Production
   │        │
   └────────┴──► RolledBack
```

### Issue

```
Open → Triaged → Fixing → Verifying → Closed
                              └──► Reopened
```

### Agent Run

```
Queued → Running → WaitingApproval → Running → Succeeded
                          │                        │
                          └──► Rejected      Failed / Cancelled / Timeout
```

---

## 2. 状态机定义

```yaml
lifecycle: task-default
entityType: Task
initial: Todo
states:
  - name: Todo
  - name: Doing
    entryActions: [ set(startedAt, now) ]
    sla: { maxDuration: 5d, onBreach: notify-owner }
  - name: Review
    requires: [ artifact.pr.exists ]
  - name: Testing
  - name: Blocked
    requires: [ field.blockReason ]
  - name: Done
    entryActions: [ set(completedAt, now), emit(TaskCompleted) ]
transitions:
  - from: Todo
    to: Doing
    guard: assignee != null
    capability: Task.Execute
  - from: Doing
    to: Review
    guard: hasLinkedPr()
    capability: Task.Update
  - from: Review
    to: Testing
    guard: review.verdict == 'approve'
  - from: Testing
    to: Done
    guard: acceptance.allPassed()
    capability: Task.Complete
  - from: [Doing, Review, Testing]
    to: Blocked
  - from: Blocked
    to: Doing
```

### 要素说明

| 要素 | 作用 |
| --- | --- |
| `guard` | 前置条件，不满足则拒绝迁移并返回原因 |
| `capability` | 迁移所需权限，交由 PDP 判定 |
| `entryActions` / `exitActions` | 迁移副作用（赋值、发事件、调 Agent） |
| `sla` | 状态停留时限与超时动作 |
| `requires` | 进入该状态必须具备的字段或关系 |

---

## 3. 自动化规则（Automation）

事件驱动的 `when → if → then`：

```yaml
automation: pr-merged-complete-task
when:
  event: connector.github.pr.merged
if:
  - pr.linkedTask != null
  - pr.checksPassed == true
then:
  - transition(task, Testing)
  - relate(pr, task, 'produces')
  - notify(task.owner)
```

```yaml
automation: requirement-approved-decompose
when:
  event: RequirementApproved
if:
  - requirement.level == 'Feature'
then:
  - invokeAgent('pm-agent', goal: 'decompose-to-stories', mode: 'draft')
```

```yaml
automation: p0-issue-escalate
when:
  event: IssueOpened
if:
  - issue.severity == 'P0'
then:
  - assign(issue, oncall())
  - notify(channel: 'incident')
  - createTask(title: 'RCA for ' + issue.key)
```

### 触发源

| 源 | 示例 |
| --- | --- |
| 领域事件 | `TaskCompleted` `RequirementApproved` |
| 外部事件 | GitHub webhook、CI 结果、Kafka 消息 |
| 定时 | 每日站会汇总、每周风险巡检 |
| 人工 | 按钮触发 |
| Agent | Agent 产出触发下一步 |

### 动作类型

| 动作 | 说明 |
| --- | --- |
| `transition` | 状态迁移 |
| `assign` | 分配给 User 或 Agent |
| `relate` | 建立本体关系 |
| `createEntity` | 创建领域对象 |
| `invokeAgent` | 触发 Agent（指定协作模式） |
| `notify` | 通知（站内 / IM / 邮件） |
| `callConnector` | 调用外部系统 |
| `requireApproval` | 插入人工审批节点 |

---

## 4. 编排（Orchestration）

支持多步骤流程编排，用于 Release 流程、需求评审流程、多 Agent 协作：

```yaml
workflow: release-pipeline
steps:
  - id: freeze
    action: transition(release, Pending)
  - id: changelog
    action: invokeAgent('release-agent', goal: 'generate-changelog')
  - id: review
    action: requireApproval(role: Leader)
    timeout: 24h
    onTimeout: escalate
  - id: gray
    action: transition(release, Gray)
  - id: soak
    action: wait(duration: 2h)
  - id: verify
    action: invokeAgent('qa-agent', goal: 'verify-gray-metrics')
  - id: promote
    action: requireApproval(capability: Release.Promote:prod)
  - id: prod
    action: transition(release, Production)
compensation:                       # 失败补偿
  - onFailure: [gray, soak, verify]
    do: transition(release, RolledBack)
```

支持：串行、并行（`parallel`）、条件分支（`branch`）、循环（`forEach`）、人工节点、超时、补偿。

---

## 5. 治理约束

| # | 约束 |
| --- | --- |
| W1 | 状态迁移必须经过 PDP 授权，Agent 与人同一路径 |
| W2 | 自动化不得绕过 `guard` 与不变量 |
| W3 | 自动化触发链深度上限（默认 10），防止无限级联 |
| W4 | 单条自动化的触发频率受限，超限熔断并告警 |
| W5 | 每次自动化执行留痕：触发源、条件求值结果、执行动作、耗时 |
| W6 | 流程定义版本化；运行中的实例沿用启动时的版本 |
| W7 | 不可逆动作（发布、删除）必须有显式审批节点或人工确认 |

---

## 6. 需求条目

| ID | 需求 | 优先级 | 验收标准 |
| --- | --- | --- | --- |
| FR-WF-001 | 每个 EntityType 可绑定可配置状态机 | M | 修改状态机定义后新实例即时生效 |
| FR-WF-002 | 迁移支持 guard / capability / actions / SLA | M | 各要素均有测试覆盖 |
| FR-WF-003 | 非法迁移被拒绝并返回可读原因 | M | 返回具体失败的 guard 名称与期望值 |
| FR-WF-004 | 状态迁移经 PDP 授权 | M | 无权限用户迁移失败并留审计 |
| FR-WF-005 | 自动化规则 when/if/then 引擎 | M | 8 类动作全部可用 |
| FR-WF-006 | 支持外部事件触发（GitHub / CI / Kafka） | M | PR 合并自动推进 Task |
| FR-WF-007 | 支持 invokeAgent 动作及协作模式参数 | M | 需求批准后自动触发 PM Agent 出草稿 |
| FR-WF-008 | 触发链深度与频率限制 | M | 构造循环触发被熔断并告警 |
| FR-WF-009 | 自动化执行全量留痕 | M | 可查看条件求值明细 |
| FR-WF-010 | 多步骤编排：并行 / 分支 / 循环 / 人工节点 / 超时 | S | Release 流程端到端跑通 |
| FR-WF-011 | 失败补偿（compensation） | S | 灰度失败自动回滚状态 |
| FR-WF-012 | 流程定义版本化，运行实例锁定版本 | S | 升级定义不影响在途实例 |
| FR-WF-013 | SLA 超时告警与升级 | S | 超时触发 notify/escalate |
| FR-WF-014 | 可视化流程编辑器 | C | 拖拽编辑状态机并保存 |
