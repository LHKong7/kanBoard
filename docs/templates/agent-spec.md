# Agent 规格模板

> 每个 Agent 必须有一份规格。规格即契约：它定义了这个 Agent **能做什么、不能做什么、由谁负责**。

---

## 1. 身份

| 字段 | 值 |
| --- | --- |
| 名称 | |
| Principal | `agent://<name>` |
| 版本 | SemVer |
| Owner Team | |
| 描述 | 一句话说明它承担什么角色 |

## 2. 职责边界

**负责**：

-

**明确不负责**：

-

## 3. 触发方式

| 触发源 | 条件 |
| --- | --- |
| 领域事件 | |
| 定时 | |
| 人工 | |
| 其他 Agent | |

## 4. 输入 / 输出

| 项 | 内容 |
| --- | --- |
| 输入对象类型 | |
| 输出 Artifact 类型 | |
| 写回的 Domain Object | |

## 5. Skill 与 Tool

```yaml
skills:
  - skill://
tools:
  - connector://
  - tool://
```

## 6. Capability（最低权限）

```yaml
capabilities:
  -
```

**必须说明**：为什么每一条都是**必需**的。无法说明的，删掉。

## 7. 护栏（Guardrails）

```yaml
guardrails:
  forbidden:            # 硬性禁止（不可被策略覆盖）
    - Project.Delete
    - Permission.Grant
  requireHumanApproval: # 强制 Ask
    -
  rateLimit:
    writesPerMinute:
  blastRadius:
    maxObjectsPerRun:
```

## 8. Memory

| 类型 | 作用域 | TTL | 说明 |
| --- | --- | --- | --- |
| Episodic | | | |
| Semantic | | | 必须落 Knowledge BC |

## 9. 模型与预算

```yaml
modelPolicy:
  default:
  fallback:
  maxTokensPerRun:
budget:
  maxCostPerRun:
```

## 10. 人机协作模式

`Suggest` / `Draft` / `Execute-with-review` / `Autonomous`

默认模式：
可覆盖范围：

## 11. 质量指标与目标

| 指标 | 目标 |
| --- | --- |
| 采纳率 | |
| 修改幅度 | |
| 返工率（7 天） | |
| Run 成功率 | |
| P95 时延 | |
| 单位采纳成本 | |

## 12. 失败处理

| 场景 | 处理 |
| --- | --- |
| 工具调用失败 | 幂等步骤重试 ≤ 2 次 |
| 超预算 | 终止 + 告警 |
| 超 blastRadius | 熔断 + 告警 |
| 权限被拒 | 记录原因，转人工 |
| 模型不可用 | 切换 fallback |

## 13. 安全自检

- [ ] 不需要任何硬性禁止的 Capability
- [ ] 所有外部访问经 Connector
- [ ] 不可逆操作已列入 `requireHumanApproval`
- [ ] 上下文中不包含明文凭据
- [ ] 外部来源内容被标记为不可信数据，不作为指令
- [ ] confidential 数据的出境路径已评估
