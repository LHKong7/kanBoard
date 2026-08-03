# ProjectOS — AI Native Project Operating System

> 代号：kanBoard → **ProjectOS**
> 当前阶段：需求定义（PRD v1.0）

ProjectOS 是面向 AI 时代的软件研发**项目操作系统**。

它不是 "Jira + AI"，也不是 "Jira + Confluence + Notion" 的拼装。
它把研发生命周期中的**所有对象**——目标、需求、架构、任务、代码、文档、决策、知识、Agent——
统一建模为**领域对象（Domain Object）**，在统一的本体（Ontology）、权限模型和工作流引擎之上，
让**人与 AI Agent 共同参与项目交付**。

```
Idea → Objective → Requirement → Architecture → Implementation
     → Verification → Release → Knowledge
```

整个生命周期**持续可追踪、可推理、可沉淀**。

---

## 文档导航

| 文档 | 内容 |
| --- | --- |
| [docs/README.md](docs/README.md) | 文档索引与阅读顺序 |
| [docs/development.md](docs/development.md) | **开发指南**：环境、命令、分层约定 |
| [docs/m0-status.md](docs/m0-status.md) | **M0 进度**：地基层，已交付与欠账 |
| [docs/m1-status.md](docs/m1-status.md) | **M1 进度**：工作流引擎、自动化、poller |
| [docs/prd/00-overview.md](docs/prd/00-overview.md) | 产品愿景、定位、核心理念、目标用户 |
| [docs/prd/01-principles.md](docs/prd/01-principles.md) | 四大设计原则 |
| [docs/prd/02-architecture.md](docs/prd/02-architecture.md) | 总体架构与七层分层 |
| [docs/prd/03-domain-model.md](docs/prd/03-domain-model.md) | DDD 领域模型与限界上下文 |
| [docs/prd/04-ontology.md](docs/prd/04-ontology.md) | 本体层：实体、关系、推理 |
| [docs/prd/05-agent-runtime.md](docs/prd/05-agent-runtime.md) | Agent 抽象与 Agent Runtime |
| [docs/prd/06-connector.md](docs/prd/06-connector.md) | Connector 集成层 |
| [docs/prd/07-identity-permission.md](docs/prd/07-identity-permission.md) | 五层权限模型 |
| [docs/prd/08-workflow-engine.md](docs/prd/08-workflow-engine.md) | 工作流引擎与生命周期状态机 |
| [docs/prd/09-data-model.md](docs/prd/09-data-model.md) | 统一 Resource 数据模型与统一 API |
| [docs/prd/10-ai-capabilities.md](docs/prd/10-ai-capabilities.md) | AI 能力：从 AI Chat 到 AI PM |
| [docs/prd/11-dashboard.md](docs/prd/11-dashboard.md) | Project Intelligence 仪表盘 |
| [docs/prd/12-non-functional.md](docs/prd/12-non-functional.md) | 非功能需求 |
| [docs/prd/13-roadmap.md](docs/prd/13-roadmap.md) | 分期交付路线图与验收标准 |
| [docs/prd/14-glossary.md](docs/prd/14-glossary.md) | 术语表 |
| [docs/prd/15-open-questions.md](docs/prd/15-open-questions.md) | 待决问题 |
| [docs/adr/](docs/adr/) | 架构决策记录（ADR） |

---

## 一句话价值主张

> ProjectOS 提供一套统一的 **Project Runtime**：
> 让项目、知识、数据和智能体在同一个领域模型中持续演化。

---

## 状态

| 项 | 值 |
| --- | --- |
| PRD 版本 | v1.0 |
| 阶段 | M1 · Domain & Workflow 实现中 |
| 技术栈 | TypeScript / Node 22 · Fastify · Zod · PostgreSQL 16（[ADR-0007](docs/adr/0007-typescript-server-stack.md)） |
| 测试 | 127 项 vitest + 14 项真实浏览器 UI 测试 |
| 进度 | 见 [M1 状态](docs/m1-status.md) |
