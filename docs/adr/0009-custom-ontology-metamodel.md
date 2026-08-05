# ADR-0009 · 自定义本体元模型，保留 RDF 导出能力

| 项 | 值 |
| --- | --- |
| 状态 | Accepted |
| 日期 | 2026-08-03 |
| 决策者 | 架构组 |
| 关联需求 | FR-ONT-001 ~ FR-ONT-009 |
| 解决问题 | Q-A3 |
| 依赖 | [ADR-0001](0001-ontology-first.md), [ADR-0007](0007-typescript-server-stack.md) |

## 背景

[ADR-0001](0001-ontology-first.md) 确定了本体先行，但没有定本体**用什么表达**。
两条路：采用 RDF/OWL 标准，或自定义元模型。

RDF/OWL 的吸引力是真实的：标准语义、成熟的推理机、与知识图谱生态互通。
ADR-0001 当时把它列为备选 B，注明"团队与场景不匹配"，但没有展开论证——这条 ADR 补上。

关键考量：我们需要的推理能力到底有多少？

盘点 PRD 里所有用到"推理"的场景：

| 场景 | 需要的能力 |
| --- | --- |
| 全链路追溯（Issue → Requirement → Decision） | 路径查询 |
| 影响面分析（改 API 影响哪些需求） | 有向可达性 |
| 项目下所有后代对象 | 传递闭包 |
| 双向查询等价 | 逆关系 |
| 知识推荐的候选子图 | N 跳邻域 |

**全部是图遍历，没有一个需要描述逻辑推理机**（类型推断、等价类、基数约束求解）。
为了用不上的能力引入 OWL，代价与收益不成比例。

## 决策

**自定义元模型（EntityType / RelationType / AttributeType），
在类型系统中保留到 RDF/OWL 的可导出性。**

### 元模型

M0 已实现（`src/ontology/types.ts`）：

```
EntityType    name, version(SemVer), context, attributes[], lifecycle
RelationType  name, inverse(必填), transitive, domain[], range[], cardinality
AttributeType name, kind, required, values[], target, classification
```

三条设计取舍：

| 取舍 | 理由 |
| --- | --- |
| `inverse` 是**必填**而非可选 | FR-ONT-003 要求双向查询等价。可选意味着一半的关系反向查不到，且不会报错 |
| 属性携带 `classification` | 数据分级是 ADR-0006 出境控制的基础，必须长在本体上而不是散在代码里 |
| 版本是 SemVer 而非单调整数 | 需要区分"加了个可选字段"和"破坏性变更"，整数表达不了 |

### RDF 映射（保留能力，非当前交付）

元模型的每个概念都有明确的 OWL 对应物，因此导出是一次机械转换：

| ProjectOS | OWL |
| --- | --- |
| `EntityType` | `owl:Class` |
| `RelationType` | `owl:ObjectProperty` |
| `RelationType.inverse` | `owl:inverseOf` |
| `RelationType.transitive` | `owl:TransitiveProperty` |
| `RelationType.domain / range` | `rdfs:domain` / `rdfs:range` |
| `AttributeType` | `owl:DatatypeProperty` |
| `cardinality` | `owl:minCardinality` / `owl:maxCardinality` |

**约束：新增元模型概念时，必须同时给出它的 OWL 对应物。**
给不出，说明这个概念要么可以拆成已有概念，要么是设计跑偏了——
这条规则的价值不在于将来真的导出，而在于它是一个持续的设计约束。

## 备选方案

| 方案 | 优点 | 缺点 | 未选原因 |
| --- | --- | --- | --- |
| A. RDF/OWL + 三元组库 + 推理机 | 标准语义、生态互通、推理能力强 | 与 PG/TS 阻抗大；推理机性能不可预测（本体一改，查询延迟可能跳变，无法给 NFR-PERF 承诺）；团队学习成本高；TS 生态的 RDF 工具链薄 | 需要的推理全是图遍历，为用不上的能力付全部代价 |
| **B. 自定义元模型 + 保留 RDF 导出** | 完全可控，性能可预测；与统一 Resource 模型（ADR-0002）天然契合；可直接生成 Zod 校验器 | 无现成推理机，闭包/路径要自己实现；与知识图谱生态互通需要额外导出工作 | **已选** |
| C. 无元模型，纯 JSON Schema | 上手最快 | 没有关系语义，"万物互联"（原则 P4）无从谈起 | 与 ADR-0001 直接冲突 |

## 后果

### 正面

- 性能可预测：图查询是我们自己写的递归 CTE，可压测、可优化、可给出 NFR 承诺
- 本体直接生成 Zod 校验器与 TS 类型（ADR-0007 的核心收益），OWL 走不通这条路
- 元模型只有三个概念，团队半小时能理解完
- 演进自由：需要 `classification`、`lifecycle` 这类领域特有概念时直接加，不必迁就标准

### 负面 / 代价

- **推理能力全部自己实现**。M0 已实现传递闭包与最短路径；将来若需要更复杂的推理
  （等价类、基数约束求解），要么自己写，要么届时付出迁移成本
- 与外部知识图谱生态不能开箱互通，需要先做导出
- 自定义标准意味着没有外部工具可用：可视化、校验、查询语言都得自建
- OWL 映射约束会在某些时候显得碍事——那正是它该发挥作用的时候

### 需要后续处理

- [ ] 实现 RDF/Turtle 导出（M2），并加一条测试：默认本体包可完整导出
- [ ] 本体可视化浏览器（FR-ONT-012），无外部工具可用
- [ ] 若出现真正需要描述逻辑推理的场景，重新评估并写新 ADR，不要在自定义元模型上
      逐步长出一个半吊子推理机

## 验证方式

- 元模型评审：新增概念的 PR 必须在描述中给出 OWL 对应物
- 测试：`tests/ontology.test.ts` 已覆盖逆关系对称性、定义域/值域、版本格式
- 待补：RDF 导出的往返测试（导出 → 解析 → 与原定义等价）
