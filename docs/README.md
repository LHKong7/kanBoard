# ProjectOS 文档中心

本目录是 ProjectOS 的**单一事实来源（Single Source of Truth）**。

## 目录结构

```
docs/
├── README.md                 本文件：文档索引
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
│   ├── 0004-go-server-stack.md
│   ├── 0005-tenancy-model.md
│   └── 0006-model-data-egress.md
└── templates/                领域对象模板
    ├── requirement.md
    ├── story.md
    └── agent-spec.md
```

## 建议阅读顺序

**产品 / 业务视角**
`00-overview` → `01-principles` → `10-ai-capabilities` → `11-dashboard` → `13-roadmap`

**架构 / 研发视角**
`01-principles` → `02-architecture` → `03-domain-model` → `04-ontology` → `09-data-model`
→ `05-agent-runtime` → `06-connector` → `07-identity-permission` → `08-workflow-engine`

**安全 / 合规视角**
`07-identity-permission` → `06-connector` → `12-non-functional`

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
