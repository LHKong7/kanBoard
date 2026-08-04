# 自用日志

[ADR-0011](adr/0011-dogfooding-first.md) 定了一条检验标准，原文是：

> 记录团队「绕开系统用别的工具」的次数。**绕开的地方就是产品缺陷**。

这份文档就是那份记录。每一条都写清楚：**当时想做什么、系统怎么挡的、绕过去用了什么**。
没有绕开的部分同样写下来——只记缺点会让这份记录变成情绪表达而不是证据。

规则：**一条记录必须能被复现**。写不出复现步骤的抱怨不进这份文档。

---

## 第 1 次迭代 · 2026-08-04

**做了什么**：把 `docs/` 整个迁进系统，然后用系统本身管理一条真实的 M1 工作项。

| 项 | 数量 |
| --- | --- |
| Project | 1（PROJECTOS） |
| Requirement | 142（PRD 里的 FR-\*/NFR-\* 表格行） |
| Decision | 11（ADR-0001…0011，含 1 条 Superseded） |
| Knowledge | 16（PRD 各章原文） |
| 关系 | 177（`contains` / `explains`） |
| 导入被拒 | 0 |

导入脚本是 `tools/import-docs.ts`，走的是和人完全一样的 HTTP 接口，没有直接写库。

### 系统扛住的部分

先写这些，因为它们决定了上面那些缺陷值不值得修。

- **可追溯链路是真的**。`ADR-0007 --explains--> FR-ONT-001` 这类边建起来之后，
  从决策查到它解释的需求、从需求查回决策，都是一次 `GET /relations` 的事。
  PRD 里承诺的「决策与需求可互查」第一次不是 PPT 上的话。
- **守卫拦住了真实的疏漏**。给任务设 `Doing` 时被 409 挡回：
  `Task cannot enter "Doing": attribute "assignee" must be set`。
  我确实忘了填 assignee。错误信息直接说清了缺什么，不用去翻代码。
- **自动化链路的归属完整**。Story 的历史里，
  `Ready → InProgress` 和 `InProgress → Done` 两步都记着
  `changedBy: system://internal` 和 `reason: automation: <规则 id>`，
  和人做的 `Draft → Ready` 排在同一条时间线上。事后想问「这一步是谁推的」有确定答案。
- **ADR 的 Superseded 状态如实反映了**。ADR-0004（Go）在系统里就是 Superseded，
  不是被删掉、也不是留在 Accepted 装作没发生过。

### 绕开系统的地方

#### 1 · 接口静默吞掉写错的字段 —— 已修

想做的事：把 142 条需求翻页取出来，找到 `FR-WF-001`。

我按直觉写了 `{"type":"Requirement","limit":200,"cursor":"…"}`。
接口回 **200**，一切看起来正常。翻 20 页拿到 1000 条结果——
而库里只有 142 条。**每一页都是同一页**。

原因：正确的形状是 `{"type":…,"page":{"size":…,"cursor":…}}`。
Zod 默认剥掉未知字段，于是 `limit` 和 `cursor` 双双被丢弃，
`size` 落回默认值 50，游标永远是 `undefined`。

这是本项目反复出现的那类失败：**没报错，只是答案是错的**。
调用方拿到 200 和一堆数据，没有任何信号可以据此发现自己写错了。
宽松解析在这里买不到兼容性，只买到「看起来成功的错误答案」。

- 绕过方式：读 `src/api/schemas.ts` 的源码才知道正确形状。
- 修复：所有信封 schema 加 `.strict()`，多余字段一律 400。
  `attributes` 是有意开放的 `z.record`，不受影响——那部分归本体管。
- 附带发现：Zod 的 `unrecognized_keys` 问题里 `path` 是空的（它指向容器不指向字段），
  照直渲染出来是 `{"path":"","message":"Unrecognized key(s)…"}`——
  知道错了，不知道错在哪。现在每个多余字段拆成一条 detail：
  ```json
  {"path":"limit","message":"unrecognized field"}
  {"path":"cursor","message":"unrecognized field"}
  ```
- 回归测试：`tests/integration/resource-api.test.ts` 的
  `malformed request bodies are rejected, not silently trimmed`，
  含一条「游标必须真的前进」——翻完 5 条就是 5 条，不是同一页翻十遍。

#### 2 · 自动化算出了停滞原因，然后把它扔了 —— 已修

想做的事：验证 Story 忘标 Ready 时会怎样。

建一个 Story（停在 `Draft`），挂一个 Task，把 Task 一路推到 `Done`。
预期 Story 被自动化推进；实际它停在 `Draft`。

停在 Draft 本身**是对的**——两条规则都带 `onlyIfCurrentIn`，
条件不满足就不动，这是设计意图。问题在于**没有任何地方说得出为什么**：

| 查哪儿 | 结果 |
| --- | --- |
| 服务端日志 | 一个字都没有 |
| Story 的 `/history` | 只有 `(created)` 一条 |
| `audit_log` | 只有人的操作和几条 Read |

而规则其实**算出了准确的原因**：

```
story-starts-when-first-task-starts  skipped  story_… is "Draft", not in ["Ready"]
story-done-when-all-tasks-done       skipped  story_… is "Draft", not in ["InProgress","Review"]
```

这段文字唯一的出口是 `PollerDeps.onOutcome` —— 一个**可选**钩子，
而 `src/main.ts` 从来没接过它。可选的可观测性等于没有可观测性。
从使用者角度看，这和「自动化根本没配」完全无法区分。

- 绕过方式：写一个临时测试把 `pollOnce()` 的返回值打出来。普通使用者没有这条路。
- 修复：poller 现在**总是**记录「找到了目标却没推动它」，分两类：
  - `rejected`（守卫挡回 / 调用出错）→ stderr **和** `audit_log`
  - `declined`（规则条件不满足）→ 只写 `audit_log`；这是正常业务分支，
    刷进日志只会把真正的异常淹掉
  - 压根没有这条关系（任务不属于任何 Story）→ **什么都不记**。
    那是常态，记下来会把有用的信号淹掉。
- 现在同样的场景，按 resource_id 一查就有答案：
  ```
  automation:story-starts-when-first-task-starts | story_… is "Draft", not in ["Ready"]
  automation:story-done-when-all-tasks-done      | story_… is "Draft", not in ["InProgress","Review"]
  ```
- 审计里用独立的 `Rejected`，不复用 `Deny`。`Deny` 意味着权限不足，
  是要去查权限配置的信号；两者混在一起会让「有多少次越权尝试」这个数字失真。
- 顺带修掉的：一个目标被守卫拒绝时，整个动作会抛出去，
  **同一动作里排在后面的目标就白白不执行了**。现在每个目标单独兜住。
- 回归测试：`tests/integration/automation.test.ts` 的
  `automation leaves a trace when it does not move things`。
  把 `#reportDeclines` 注释掉验证过——两条用例确实会红，不是摆设。

#### 3 · 找不到东西 —— 已修

142 条需求，我要找 `FR-WF-001`。**系统里没有任何搜索能力。**

最后的做法是：写一段 Node 脚本，把全部需求翻页拉到内存，
再用正则匹配标题。也就是说，**我没能用这个产品在这个产品里找东西**。

这是这次迭代里最大的一次绕开，而且它会污染其他所有场景——
UI 上的关系目标选择器只列最近 50 条，也是同一个缺失的表现：
不是「选择器需要优化」，是**没有搜索**。

`docs/m1-status.md` 里原本把它记成 M2 的优化项。这次自用证明它不是优化项，
是日常使用的阻塞项——一个记不住 id 的人无法使用这个系统。**于是当场做掉了。**

- 修复：`filter.text`（FR-RES-016），落在 `POST /v1/resources:query` 上，
  不新增端点——统一 Resource 模型（ADR-0002）的收益就体现在这里。
  同一个查询接口现在同时承载列表、过滤和检索。
- 索引：Postgres `pg_trgm` 的 GIN 索引，建在一个生成列上（`002_search.sql`）。
  **不用 `to_tsvector`**：语料是中英混排，默认分词器不切中文，
  整段中文会变成一个 token，搜「状态机」一无所获。
- 可检索文本只取属性的**值**不取键名。用 `attributes::text` 建索引的话，
  搜 "title" 会命中全表——一个永远返回一切的搜索框比没有搜索框更糟。
  有一条用例专门锁这个。
- 做的过程中又挖出一个坑，而且第一版注释把它写错了：trigram 三字符一组，
  查询串短于 3 字时**不是"索引用不上"那么温和**——规划器照样可能选它，
  然后把整表当候选返回再逐行 recheck。100 万行实测 `状态`：

  | | 带 `type` 过滤 | 不带 |
  | --- | --- | --- |
  | `ILIKE`（可命中 trigram） | 14.0ms | 1259ms |
  | `strpos`（挡开 trigram） | **0.4ms** | 734ms |

  中文两字词（需求 / 状态 / 权限）太常见，不能因此拒绝查询，
  所以短查询改写成 `strpos()` 换一条路，不带 type 收窄的那条仍然慢，打 warn 日志。
- 100 万行上的检索基线（详见[性能基线](perf-baseline.md)）：
  窄查询 P95 56ms、宽查询 58ms、两字短词 27ms，目标是 400ms。
- UI 加了搜索框。有一条浏览器用例**直接检查请求体里带没带 `filter.text`**——
  改成前端过滤的话功能断言照样全绿，但用户搜到的永远只是"最近 200 条里的"。
  种了这个缺陷验证过，用例确实会红。
- 顺带：看板一次最多取 200 条，以前不说，用户看到的就是"全部"。
  现在超出会显式提示。同一类毛病，同一个改法。

回到最初那个动作——在 142 条需求里找 `FR-WF-001`：

```
搜 "FR-WF-001"： 命中 1   FR-WF-001 每个 EntityType 可绑定可配置状态机
搜 "状态机"：    命中 2
搜 "租户隔离"：  命中 9（跨 Requirement 与 Knowledge）
搜 "title"：     命中 0
```

#### 4 · 以非特权角色启动直接起不来 —— 已修

`src/main.ts` 用 `DATABASE_URL` 同时做迁移和跑业务。
建表要 DDL 权限，跑业务不要。用同一个连接串意味着
**API 进程常驻着一个能 `DROP TABLE` 的身份**——
RLS 的 `FORCE` 挡得住 owner 绕过读写，挡不住一次 DDL。

以 `projectos_dev_app`（无 SUPERUSER、无 BYPASSRLS）启动时直接崩：

```
error: permission denied to create extension "pgcrypto"
hint: Must have CREATE privilege on current database to create this extension.
```

讽刺的是 `tests/helpers/db.ts` 一直做对了：管理员迁移、非特权角色连接。
只有生产入口没分。

- 绕过方式：手工以 `postgres` 跑迁移，再单独起服务。
- 修复：加 `MIGRATE_DATABASE_URL`（不设则退回 `DATABASE_URL`，本地开发一条命令照旧）
  和 `PROJECTOS_SKIP_MIGRATE`，让 API 能以只有 DML 权限的角色运行。

#### 5 · 读数据得用 POST —— 已修

第一反应写的是 `GET /v1/resources?type=Requirement&limit=1`，得到 404。
列表只有 `POST /v1/resources:query`。

这是 AIP 自定义方法的既定代价（[ADR-0002](adr/0002-unified-resource-model.md)），
不是 bug。但代价是真实的：**看板的任何一个视图都没有 URL**，
分享不了、收藏不了、浏览器前进后退不工作、HTTP 缓存完全用不上。
有了搜索之后这条更痛——「搜索结果发给同事」是最基本的协作动作。

- 修复：加 `GET /v1/resources`，覆盖**放得进查询串的那部分**
  （类型 / 工作区 / 项目 / 负责人 / 状态 / 标签 / 检索词 / 分页）。
  `attributes` 的任意匹配留在 POST——把嵌套 JSON 塞进查询串是这类接口变丑的起点，
  而且它本来也不是分享场景。
- 两条路径调用**同一个** `service.query`，行为不可能分叉。
- 查询串同样 `.strict()`：`?stauts=Done` 直接 400 并指名参数，
  而不是静默忽略后返回全部结果——又是 #1 那个坑的同一张脸。
  `includeDeleted` 用 `'true'|'false'` 枚举而不是布尔强转，
  因为 `z.coerce.boolean()` 会把字符串 `"false"` 判为真。
- UI 改成走 GET，并把类型与搜索词写进地址栏：粘一条链接过来就是同一个视图。
  切换类型进历史，输入搜索用 `replaceState`——否则退出一个看板要按二十次后退。
- **自己不用那条可分享的路径，加它就没有意义**，所以前端读数据一律走 GET。

顺带治好了一个偶发性变红的用例，而且它是真的：
`renderTabs` 是同步的、`refresh()` 是异步的，于是标签页已经切到新类型时
列还是旧类型的，`waitForSelector('.column')` 立刻命中旧列。
视图现在由 URL 决定，测试直接用 URL 导航就没有这个中间态了。

#### 6 · 没有关系的对象无声地漂着 —— 已修

导入脚本给 Requirement 和 Decision 都建了 `contains` 边，
**唯独漏了 Knowledge**——16 条知识不属于任何项目，系统一声没吭。

深挖之后发现问题比"少了个必需关系校验"更基本：
**「这个对象属于哪个项目」被存了两份**——`resources.project` 标量字段，
以及 `Project --contains--> 对象` 这条边——而没有任何东西让两份保持一致。
把库里所有对象数一遍：

| type | 有 project 字段 | 缺 contains 边 |
| --- | --- | --- |
| Knowledge | 16 | 16 |
| Task | 6 | 6 |
| Story | 4 | 4 |
| Requirement | 142 | 0 ← 只因为导入脚本手工补了边 |

**26 个对象声称属于某个项目，在图里却完全不可达。**
这不是导入脚本的 bug——脚本按我写的做了。指望调用方每次记得补边行不通：
我自己写的脚本就漏了一整类。

- 修复：`create()` 现在维持这条不变式——写了 `project` 就一定有边。
  图变成"构造出来就完整"，而不是"靠纪律保持完整"。
  **不再单独授权一次**：调用方已经通过了 `<Type>.Create` 且被允许指定 project，
  而这条边就是"放进这个项目"这件事本身。
- 本体不允许 Project 装下的类型**直接拒绝**，而不是"存字段但不建边"——
  后者正是半连接对象的来源。要让 Project 装下新类型，改本体（ADR-0001）。
- 迁移 003 回填历史数据：26 条孤儿变成 1 条，剩下那条正是下面 #6b 里
  我故意造的悬空引用，它确实没有边可建。
- 导入脚本因此**变短了**——不用再手工建 `contains`。这是修对了的标志。
- 清库重跑一遍导入验证：143 Requirement + 11 Decision + 16 Knowledge，
  `missing_edge` 全部为 0，从项目一次遍历可达 170 个对象。

#### 6b · `project` 可以指向一个不存在的东西 —— 已修

顺着上一条查出来的：`project` 就是一个没有任何约束的 TEXT 字段。

```
POST /v1/resources {"type":"Task","project":"prj_00000000000000000000000000",…}
→ 201 Created
```

- 修复：服务层校验它指向一个活着的 `Project`（422，并指明是哪个字段），
  数据库层加外键兜底——和 `relations.from_id / to_id` 一直以来的做法一致。
- 外键用 `NOT VALID`：只约束今后的写入，不让历史悬空数据卡住一次部署。
  迁移会把发现的悬空条数 `RAISE WARNING` 出来，清理干净后再 `VALIDATE`。

#### 6c · 重复建边会返回一个不存在的 id —— 已修

也是查上面两条时撞见的。同一条边建两次：

```
第一次 → 201  relation_01ABC…
第二次 → 201  relation_01XYZ…   ← 这个 id 数据库里根本没有
```

唯一索引 + `ON CONFLICT DO NOTHING` 保证了自动化规则反复触发不会报错，
但服务层把**刚构造的对象**原样返回了。拿第二次的 id 去删会 404，
而且还发了一条 `RelationCreated` 事件——为一条并不存在的边。

- 修复：仓储层在冲突时把已存在的那行查回来返回，并报告 `created: false`；
  事件只在真的插入时才发。**幂等的意思是"再来一次结果相同"，
  不是"假装刚刚创建了一条"。**

#### 7 · 文本属性没有长度上限，只能靠猜 —— 未修

导入时我把 ADR 正文截断到 20 000 字符、标题截断到 1024。
**这两个数字是我编的**：`AttributeType` 只有
`kind` / `required` / `values` / `ref` / `derived`，没有任何长度约束。
客户端无从知道多长会被拒，唯一的实际边界是 4 MB 的请求体上限。

后果是每个客户端都会各自猜一个数，猜得不一样，数据就以不同的方式被截断。

### 顺带修掉的

- **UI 用例偶发性失败**：并发冲突那条用例在冲突提示弹出后立刻断言抽屉内容，
  但重新载入是异步的，读到的是「加载中…」。改成等 `.drawer-body .section` 出现。
  连跑 3 次稳定通过。随机红的用例和静默失败是同一种病——都让人不再相信信号。

### 结论

一次迭代，最初记下 **7 处绕开**；修的过程中顺着线索又挖出 2 处
（#6b、#6c），合计 9 处，**修掉 8 处**——只剩 #7。

值得注意的是这些里面**没有一处是「功能没做完」**——
状态机、权限、租户隔离、图查询都按设计工作了。
挡路的全部是**说不出话**：

| | 系统做了什么 | 应该说什么 |
| --- | --- | --- |
| #1 | 剥掉写错的字段，回 200 | 400，指名是哪个字段 |
| #2 | 算出了停滞原因然后扔掉 | 写进审计，按 id 可查 |
| #3 | —— | 给一个搜索入口 |
| #4 | 以特权身份跑业务 | 迁移与运行分开 |
| #6 | 接受一个不完整的图 | 自己把边补上 |
| #6b | 接受指向虚空的引用 | 422 |
| #6c | 返回一个不存在的 id | 返回真实存在的那条 |

这和之前几轮踩的坑是同一类：一条从不触发的 CI 规则、一个把全面超时报告成成功的压测、
一次从没重建的索引。**这个项目真正的技术债不是缺功能，是缺信号。**

还有一条模式值得记下来：**#6、#6b、#6c 是同一次深挖挖出来的**。
最初记的是"导入脚本漏了 Knowledge 的边"，看起来像脚本的疏忽；
往下追才发现是同一个事实被存了两份而没有不变式，
再往下又撞见外键根本不存在、以及重复建边会返回假 id。
一条摩擦记录背后往往不止一个缺陷——**照着记录去挖，比照着记录去修更值**。

下一次迭代前应当解决的，按阻塞程度排序：

1. ~~**搜索**（#3）~~ —— ✅ 已交付
2. ~~**孤儿与必需关系**（#6）~~ —— ✅ 已交付，并牵出 #6b / #6c
3. ~~**读路径的 GET 投影**（#5）~~ —— ✅ 已交付
4. **文本属性的长度上限**（#7）——每个客户端各猜一个数，截断方式必然不一致
