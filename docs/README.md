# ProjectOS 文档中心

本目录是 ProjectOS 的**单一事实来源（Single Source of Truth）**。

## 目录结构

```
docs/
├── README.md                 本文件：文档索引
├── development.md            开发指南（环境、命令、分层约定、两个前端）
├── m0-status.md              M0 进度、出口标准核对、已知欠账
├── m1-status.md              M1 进度：工作流引擎、自动化、五种看法、企业级对象
├── agent-status.md           Agent 层逐条交付状态（对照 PRD 05）
├── prd-coverage.md           PRD 覆盖情况：每模块 Must 条数与已交付数
├── dogfooding-log.md         自用日志：真实踩到的坑与修法
├── perf-baseline.md          性能基线：100 万节点实测与结论
├── research/                 对标调研（对着源码写，不抄官网）
│   ├── plane-features.md              Plane 开源版功能盘点
│   ├── plane-enterprise-features.md   Plane 付费档 14 组 87 条对照表
│   └── plane-vs-projectos.md          与 ProjectOS 的差距，含逐轮进展
├── prd/                      产品需求文档（PRD v1.0）
│   ├── 00-overview.md        愿景 / 定位 / 理念 / 用户
│   ├── 01-principles.md      设计原则
│   ├── 02-architecture.md    总体架构
│   ├── 03-domain-model.md    DDD 领域模型
│   ├── 04-ontology.md        本体层
│   ├── 05-agent-runtime.md   Agent Layer
│   ├── 06-connector.md       Connector 集成层
│   ├── 07-identity-permission.md  身份与权限
│   ├── 08-workflow-engine.md 工作流引擎
│   ├── 09-data-model.md      统一数据模型
│   ├── 10-ai-capabilities.md AI 能力
│   ├── 11-dashboard.md       Project Intelligence
│   ├── 12-non-functional.md  非功能需求
│   ├── 13-roadmap.md         路线图
│   ├── 14-glossary.md        术语表
│   └── 15-open-questions.md  待决问题
├── adr/                      架构决策记录
│   ├── README.md
│   ├── template.md
│   ├── 0001-ontology-first.md
│   ├── 0002-unified-resource-model.md
│   ├── 0003-agent-least-privilege.md
│   ├── 0004-go-server-stack.md          (Superseded → 0007)
│   ├── 0005-tenancy-model.md
│   ├── 0006-model-data-egress.md
│   ├── 0007-typescript-server-stack.md
│   ├── 0008-modular-monolith.md
│   ├── 0009-custom-ontology-metamodel.md
│   ├── 0010-graph-on-postgres.md
│   ├── 0011-dogfooding-first.md
│   ├── 0012-reopen-is-an-explicit-edge.md
│   └── 0013-pi-as-model-substrate.md
└── templates/                领域对象模板
    ├── requirement.md
    ├── story.md
    └── agent-spec.md
```

源码侧与文档对应的两处：`src/` 是后端与领域模型，
`web/` 是 React 前端（企业版），`public/` 是原生 JS 的看板。

## 建议阅读顺序

**产品 / 业务视角**
`00-overview` → `01-principles` → `10-ai-capabilities` → `11-dashboard` → `13-roadmap`

**架构 / 研发视角**
`01-principles` → `02-architecture` → `03-domain-model` → `04-ontology` → `09-data-model`
→ `05-agent-runtime` → `06-connector` → `07-identity-permission` → `08-workflow-engine`

**安全 / 合规视角**
`07-identity-permission` → `06-connector` → `12-non-functional`
→ [ADR-0006](adr/0006-model-data-egress.md)（模型数据出境）

**"我们和竞品差在哪"视角**
`research/plane-features` → `research/plane-enterprise-features`
→ `research/plane-vs-projectos`

**当前进度视角**
`prd-coverage`（每模块 Must 覆盖）→ `m1-status`（这一期交付了什么）
→ `agent-status`（Agent 层逐条）→ `dogfooding-log`（自用踩到的坑）

## 需求编号约定

所有功能需求使用稳定 ID，格式：`FR-<MODULE>-<NNN>`；非功能需求为 `NFR-<CATEGORY>-<NNN>`。

| 前缀 | 模块 |
| --- | --- |
| `FR-ONT` | Ontology Layer |
| `FR-DOM` | Domain Layer |
| `FR-RES` | Resource / 统一数据模型 |
| `FR-WF` | Workflow Engine |
| `FR-AGT` | Agent Runtime |
| `FR-CON` | Connector |
| `FR-IAM` | Identity & Permission |
| `FR-AI` | AI 能力 |
| `FR-DASH` | Dashboard |
| `NFR-*` | 非功能需求 |

ID 一旦分配**不可复用、不可重新编号**；废弃的需求标记为 `Deprecated` 而非删除。

## 文档约定

- 每篇 PRD 文档以 **元信息表** 开头（版本、状态、责任人、更新时间）。
- 需求条目必须包含：**描述 + 验收标准（AC）+ 优先级**。
- 优先级采用 MoSCoW：`M`(Must) / `S`(Should) / `C`(Could) / `W`(Won't-now)。
- 重大架构选择必须落到 `docs/adr/`，PRD 内以链接引用，不重复论证。
