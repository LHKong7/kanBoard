# ADR-0013 · 模型接入采用 pi，Agent 语义留在自己手里

| 项 | 值 |
| --- | --- |
| 状态 | Accepted |
| 日期 | 2026-08-05 |
| 决策者 | 项目负责人 |
| 关联需求 | FR-AGT-002, FR-AGT-013, FR-AI-014 |
| 取代 | — |
| 被取代 | — |

## 背景

`ModelClient` 从第一天就是一个端口，但它只有一个确定性实现
（`ScriptedModelClient`）。`docs/agent-status.md` 里 FR-AGT-013 一直挂在
"未交付"那栏，缺的东西写得很清楚：**端口与 tier 都在，缺真实供应商适配器**。

自己写这个适配器要面对的是一堆与本项目无关的东西：

- 十几家供应商各自的鉴权（API key / OAuth / 云厂商 ambient 凭据）
- 同一个"工具调用"在 Anthropic Messages、OpenAI Responses、
  Google GenerativeAI 三套协议里的三种编码
- 模型目录、上下文窗口、计价表，且它们每月都在变
- 流式事件、重试、限流、超时

这部分做出来不会比现成的好，只会更晚、更少人用过。

[pi](https://github.com/earendil-works/pi) 正好分了三层，边界与我们要的一致：

| pi 的包 | 做什么 |
| --- | --- |
| `@earendil-works/pi-ai` | 多供应商统一推理 API、模型目录、工具调用协议、用量与计价 |
| `@earendil-works/pi-agent-core` | 推理循环、工具执行、会话状态 |
| `@earendil-works/pi-coding-agent` | 交互式编码 CLI |

## 决策

**用 `pi-ai` 作为模型接入的底座；`pi-agent-core` 与 `pi-coding-agent` 不引入。**

也就是说，pi 接在 `ModelClient` 这个端口**下面**，而不是替换掉
`AgentRuntime`。实现是 `src/infrastructure/model/pi.ts`。

界线画在这里的理由：**Agent 循环那一圈正是这个系统本身**。

| 属于 ProjectOS 的（留在 `AgentRuntime`） | 属于模型接入的（交给 pi） |
| --- | --- |
| 身份归属，Agent 以 `agent://` 执行（FR-AGT-003） | 供应商鉴权 |
| 上下文从本体图装配，每段带出处（FR-AGT-004） | 请求/响应编解码 |
| 预算与熔断（FR-AGT-012） | 用量与计价 |
| 影响面上限（FR-IAM-012） | 重试与超时 |
| 四种协作模式（FR-AGT-009） | 模型目录 |
| 出境控制与注入中和（FR-AI-012/013/014） | 流式事件 |
| 逐步可回放的轨迹（FR-AGT-007） | 工具调用协议 |

左边这一列全部有用例锁着。换用 pi 的循环，它们要么丢掉，要么在别人的
循环里重写一遍——而重写一遍的版本没有人会去测第二次。

### 动作空间映射成工具

`ModelResponse['action']` 是一个封闭联合（`finish` / `propose` / `call`），
一比一映射成 pi 的三个 tool。这不只是编码方式的选择：

`egress.ts` 里写着，提示注入的**主要防线是结构性的**——模型能做什么由
动作空间限死，而不是由系统提示里的一句约定限死。用工具调用，形状由
供应商侧保证；用"让它输出 JSON 然后解析"，形状靠模型自觉。
一段能改写提示的注入内容，改不动工具清单。

三个工具**始终全部提供**。`mayPropose`（这个 Agent 能提议什么类型）
与"这次 Run 有没有配连接器"都在运行时判，判完把拒绝原因作为观察交回模型。
放进适配器筛，等于把闸门挪到了一个换实现就会丢的位置。

### 分级路由

`ModelPolicy` 把 `tier-low/mid/high` 翻译成 `provider/model`，可由
`PROJECTOS_MODEL_TIER_*` 覆盖。于是 FR-AGT-013 的验收标准
"切换模型仅需改 modelPolicy"是字面成立的：领域层不知道 pi 存在。

缺省三档都在 Anthropic 一家。跨供应商混用意味着同一个 Agent 换个档位
就换了一家的数据处理条款，而出境审计记的正是"发给过谁"——
要混用可以，但那该是一个有人签过字的配置，不是缺省值。

## 备选方案

| 方案 | 优点 | 缺点 | 未选原因 |
| --- | --- | --- | --- |
| 直接用各家官方 SDK | 无中间层 | 每家一套协议；模型目录与计价要自己维护 | 正是 FR-AGT-013 拖到现在的原因 |
| 用 `pi-agent-core` 的循环 | 工具执行、会话状态现成 | 上表左列要在别人的循环里重写 | 那一圈是本系统的价值所在，不是可外包的部分 |
| 用 pi CLI 起子进程 | 接入最快 | 拿不到用量、拿不到轨迹、身份归属无从谈起 | 审计与预算会整体失效 |
| 自己写多供应商抽象 | 完全可控 | 与产品无关的重复劳动，且每月要跟目录变更 | 做出来不会更好，只会更晚 |

## 后果

### 正面

- FR-AGT-013 从"未交付"变成已交付，且 tier 路由是真的在用。
- 多了十几家供应商可选，切换是改一个环境变量。
- 用量与成本从 pi 的 `usage` 直接落到 Run 上（FR-AGT-014 的输入具备了）。
- 测试仍然不花钱：pi 自带 faux 供应商，`tests/integration/pi-runtime.test.ts`
  跑的是真数据库、真 RLS、真 PDP、真 AgentRunner，只有模型那一格是写死的。

### 负面 / 代价

- 多了一个上游依赖。pi 的版本**锁死**（不写 `^`），升级是一次有意的动作。
- pi 自己声明**不含权限系统**，不限制文件、进程、网络访问。这对我们不成立
  的前提是：只用 `pi-ai`（一个 HTTP 客户端），不用它的工具执行层。
  `pnpm lint:layers` 与 `pnpm lint:network` 一起保证 Agent 运行时碰不到网络。
- 出境审计目前记**一个**供应商（ADR-0006 的字段表），而档位是每个 Agent
  各自声明的。三档指向三家时，写进审计的那一个必然是错的——所以
  `main.ts` 直接不让它起来，并说明原因。

### 需要后续处理

- [ ] `RuntimeDeps.provider` 改成按档位取值（`PiModelClient.providerFor(tier)`
      已经备好），届时拆掉"所有档位必须同一家"的限制。
- [ ] FR-AGT-014：把 Run 上的 `costUsd` 按 Project / Requirement 汇总。
- [ ] 供应商准入仍需人工确认零训练留存条款（ADR-0006 的前置条件），
      白名单里加一家不等于这一条已经满足。

## 验证方式

| 怎么防止被悄悄违反 | 在哪 |
| --- | --- |
| Agent 运行时不得直连网络 | `pnpm lint:network` + `pnpm lint:layers`，CI 强制 |
| 领域层不认识 pi | `depcruise` 的 `domain-does-not-know-about-adapters` |
| 路由指向未批准的供应商 → 进程起不来 | `PiModelClient` 构造时校验，`tests/pi-model.test.ts` |
| 模型名写错 → 进程起不来 | 同上（构造时查 pi 的目录） |
| 缺凭据 → 不降级，直接不启动 | `createPiModelClient`，同上 |
| 换底座之后那一圈还在 | `tests/integration/pi-runtime.test.ts`：身份归属、出处、出境留痕、能力闸门、轨迹、结算各一条 |
