# M0 · Foundation 进度

| 项 | 值 |
| --- | --- |
| 更新时间 | 2026-08-03 |
| 状态 | 进行中 |

---

## 已交付

| 交付项 | 关联需求 | 实现位置 |
| --- | --- | --- |
| Ontology Registry：类型注册、校验、版本化、逆关系一致性 | FR-ONT-001/002/003/007 | `src/ontology/` |
| 本体 → Zod 校验器生成管道 | FR-ONT-002, FR-ARCH-010 | `src/ontology/validation.ts` |
| 默认本体包（7 类实体 + 14 类关系） | R1 缓解措施 | `src/ontology/defaults.ts` |
| 统一 Resource 模型与 CRUD/Query API | FR-RES-001/002 | `src/domain/resource/`, `src/api/` |
| 乐观锁 | FR-RES-003 | `PgResourceRepository.update` |
| 软删除 + 历史保留 | FR-RES-004 | `ResourceService.softDelete` |
| 字段级变更历史（含委派人与原因） | FR-RES-005 | `diffResource`, `resource_history` |
| Domain Event 同事务落 outbox | FR-RES-006 | `PgOutbox` |
| 关系 CRUD 与图遍历（递归 CTE） | FR-ONT-004/005, FR-RES-007 | `PgRelationRepository` |
| Agent 推断关系的置信度与待确认状态 | FR-ONT-006 | `ResourceService.relate` |
| 游标分页 | FR-RES-012 | `PgResourceRepository.query` |
| 五层权限 PDP，默认拒绝 | FR-IAM-001/002/003 | `src/identity/pdp.ts` |
| Agent 一等身份，默认零权限 | FR-IAM-004/005 | 同上 |
| 临时授权三重失效（TTL / 次数 / Run） | FR-IAM-006 | 同上 |
| 受限委派取交集 | FR-IAM-007 | 同上 |
| 硬性护栏不可覆盖 | FR-IAM-008 | `src/identity/guardrails.ts` |
| Agent 敏感操作返回 Ask | FR-IAM-009 | 同上 |
| 资源层级与收紧 | FR-IAM-010 | `scopeMatches` |
| 条件策略（ownerOnly / MFA / 数据分级） | FR-IAM-011 | `conditionHolds` |
| 全量审计（含被拒绝的尝试） | FR-IAM-013 | `BufferedAuditSink` + `flushAudit` |
| 多租户隔离：tenant 列 + 强制 RLS | FR-ARCH-005, FR-IAM-015 | `001_foundation.sql` |
| 分层架构 + CI 依赖方向校验 | FR-ARCH-001 | `.dependency-cruiser.cjs` |
| 所有写操作经 PDP，无 Agent 专用端点 | FR-ARCH-002/004 | `ResourceService`, `src/api/server.ts` |
| 外部输入边界运行期校验 | FR-ARCH-010 | `src/api/schemas.ts` |

**测试**：84 项通过（单元 37 + 集成 47）。集成测试以非超级用户连接，RLS 真实生效。

---

## 出口标准核对

| 标准 | 状态 | 证据 |
| --- | --- | --- |
| ≥5 种 EntityType 通过同一套 API 完成全生命周期 | ✅ | `resource-api.test.ts` 覆盖 5 类 |
| 绕过 PDP 的写路径为 0 | ✅ | 服务层所有写方法首行即 `#authorize`；无旁路端点 |
| 移除应用层 tenant 过滤后 RLS 仍拦得住 | ✅ | `tenant-isolation.test.ts` 全部使用裸查询 |
| `tsc --strict` 零错误 | ✅ | CI |
| 所有外部输入边界具备 Zod 校验 | ✅ | HTTP 边界已覆盖；边界清单见下方待办 |
| 深度 5 图遍历 P95 < 500ms（100 万节点） | ⬜ | **未压测**，见下 |
| NFR-PERF 基线在 Node 下重新标定 | ⬜ | **未做**，见下 |

---

## 未完成 / 已知欠账

按影响排序。前两项会影响 M0 能否宣布完成。

| # | 项 | 影响 | 计划 |
| --- | --- | --- | --- |
| 1 | **性能基线未标定**：图遍历、列表查询、状态迁移均未在 Node 下压测 | 出口标准两条未验证；[ADR-0007](adr/0007-typescript-server-stack.md) 要求换语言后重新标定，[ADR-0010](adr/0010-graph-on-postgres.md) 的"递归 CTE 够用"结论也依赖它 | M0 收尾前补压测脚本与 100 万节点数据集 |
| 2 | **审计写入是尽力而为**：flush 失败仅记日志 | 极端情况下审计可能丢失，与 FR-IAM-013 的"全量"有差距 | M1 落地本地持久缓冲；已在代码中标 TODO |
| ~~3~~ | ~~Outbox poller 未实现~~ | — | ✅ 已交付，见 [M1 状态](m1-status.md) |
| ~~4~~ | ~~Workflow Engine 未接入~~ | — | ✅ 已交付，见 [M1 状态](m1-status.md) |
| 5 | Grant 表已建但无签发/回收 API | Agent 临时授权只有 PDP 逻辑，无管理面 | M3 前 |
| 6 | 本体只有代码内置，无注册 API 与租户扩展 | FR-ONT-009 未交付 | M1 |
| 7 | 认证是请求头方案 | 生产不可用 | M1 接 OIDC |
| 8 | 无 OpenAPI 文档产出 | ADR-0007 定的"OpenAPI 为写侧真源"尚未落实 | M1 |
| 9 | 本体一致性巡检（孤儿/断链）未做 | FR-ONT-010 | M1 |
| 10 | 无可观测性：无 trace、无指标 | NFR-OPS-001/003 | M1 |
| 11 | 目录按技术分层，未按限界上下文重组 | [ADR-0008](adr/0008-modular-monolith.md) 要求 M1 重组，并补 BC 间依赖规则 | M1 |
| 12 | 跨 BC 事务的 CI 检查未实现 | 模块化单体的边界靠纪律，这条是把纪律变成机器强制的关键 | M1 |
| 13 | RDF/Turtle 导出未实现 | [ADR-0009](adr/0009-custom-ontology-metamodel.md) 保留的能力尚未验证 | M2 |

---

## 实现过程中发现并修正的问题

记录下来是因为它们都不是"写错了"，而是设计上的坑，值得后续注意。

| 问题 | 后果 | 处理 |
| --- | --- | --- |
| 宽 Allow 策略静默冲掉窄 Allow 的限制 | `Task.*` 让 owner-only 的删除限制完全失效 | 收紧只能表达为 Deny；`conditionHolds` 对 Allow/Deny 取镜像语义。已加回归测试 |
| 审计与业务写在同一事务 | 授权被拒 → 事务回滚 → **拒绝记录一起消失** | 审计改为内存缓冲 + 独立事务落盘 |
| 请求体校验早于认证 | 未认证者可探测请求体结构 | 认证移到 `onRequest` 钩子，401 先于 400 |
| Fastify 把 `:query` 解析为路径参数 | 两条 `/v1/graph:*` 路由冲突；且 `/v1/resources:任意串` 会落到查询处理器 | 注册单条参数路由后显式分发，未知自定义方法返回 404 |
| `SET LOCAL` 事务外是空操作 | 测试里静默返回空集，看起来像"功能没实现" | 测试辅助 `queryAsTenant` 强制开事务 |
| dependency-cruiser 的 npm 包路径匹配 | 分层规则**从不触发**，等于没有护栏 | 匹配解析后路径 `node_modules/<pkg>/`；已用植入违规的方式验证规则会响 |

最后一条尤其值得记住：一条从不触发的 CI 规则比没有规则更危险，因为它提供虚假的安全感。
新增架构约束时，都应当先植入一个违规确认它会失败。
