# Agent 层交付状态

对照 [05-agent-runtime](prd/05-agent-runtime.md) 的需求条目。
只记**已经能跑并有用例锁住**的部分——写了但没验证过的不算交付。

## 已交付

| ID | 需求 | 落在哪 |
| --- | --- | --- |
| FR-AGT-001 | Agent 声明式定义 | `Agent` 实体的 `system` / `tier` / `mode` / `capabilities` / `mayPropose` / `contextRelations` 属性 |
| FR-AGT-002 | 统一 Runtime，无专用分支 | `src/domain/agent/runtime.ts`。运行时读声明，不认识具体是哪个 Agent |
| FR-AGT-003 | 独立 Identity，可授权可审计 | Runner 以 `agent://…` 身份执行；审计里主体是 Agent 而非发起人 |
| FR-AGT-004 | Context 从图装配，每段带出处 | `src/domain/agent/context.ts`；出处清单进 Run 轨迹 |
| FR-AGT-007 | 完整 Run 轨迹 | `agent_run_steps` 表，按 `seq` 可回放 |
| FR-AGT-009 | 四种协作模式可配置 | Agent 声明默认值，单次 Run 可覆盖 |
| FR-AGT-010 | 不可逆操作强制人工 | `pol-agent-no-self-approve` / `pol-agent-no-delete`（Deny，配不掉） |
| FR-AGT-011 | 通过领域对象协作 | Agent 之间没有任何直连通道；产出即领域对象 |
| FR-AGT-012 | 预算与熔断 | Run 级 `maxTokens` / `maxSteps`；超限终止并写明原因 |

### 两道闸门

Agent 要动一次手，必须同时过：

| 闸门 | 回答什么 | 配在哪 |
| --- | --- | --- |
| 能力 | **这个** Agent 被配置成能做什么 | Agent 声明的 `capabilities` |
| 策略 | 在**这个租户**里 Agent 这类主体被允许做什么 | `default-policies.ts` |
| Deny | 无论怎么配都不许做什么 | 同上，且**配不掉** |

`ROLE_CAPABILITIES.AIAgent` 是空集，所以不写声明的 Agent 什么都做不了——
这是 ADR-0003 想要的默认值，不是遗漏。

## 未交付

| ID | 需求 | 缺什么 |
| --- | --- | --- |
| FR-AGT-005 | 四级 Memory | 只有 Working（单次 Run 内）。Episodic / Semantic / Procedural 未做 |
| FR-AGT-006 | Semantic Memory 落 Knowledge BC | 依赖 005 |
| FR-AGT-008 | 从任意步骤 replay | 轨迹已经存了，replay 入口未做 |
| FR-AGT-013 | 模型分级路由，供应商可插拔 | 端口与 `tier` 都在，缺真实供应商适配器 |
| FR-AGT-014 | 成本归因到业务对象 | Run 上有 `costUsd`，未按 Project/Requirement 汇总 |
| FR-AGT-015 | 采纳率统计 | 依赖 Dashboard |
| FR-AGT-016 | 租户自建 Agent | Agent 已经是普通资源，缺模板与配额 |

## 关于模型客户端

`ModelClient` 是端口，目前只有确定性实现（`ScriptedModelClient`）。
这不是"假装有 AI"，而是两件事的分离：

- **包在模型外面的那一圈**——身份归属、上下文出处、预算熔断、协作模式、
  护栏——与模型说什么无关，因此用确定性实现测，快、免费、不 flaky。
- **模型本身**的效果由 FR-AI-015 的评估指标衡量，那是另一套东西。

没有凭据时 runner **默认不启动**（`PROJECTOS_MODEL=none`）。
退回到一个"看起来能跑"的假实现，会让系统安静地产出一堆无意义的草稿，
而草稿是会被人当真的。
