-- 全文检索（FR-RES-016）。
--
-- 第一次真实自用后加的（docs/dogfooding-log.md #3）：142 条需求里找一条，
-- 只能把全部翻页拉到内存用正则匹配——没能用这个产品在这个产品里找东西。
--
-- 为什么用 trigram 而不是 Postgres 自带的全文检索：
-- 语料是中英混排（`FR-WF-001 每个 EntityType 可绑定可配置状态机`）。
-- `to_tsvector` 的默认分词器不切中文，整段中文会变成一个 token，
-- 搜「状态机」什么都搜不到。装 zhparser / pg_jieba 能解决，但那是一个
-- 需要在每台机器上装扩展的运维负担，而本环境也没有。
-- trigram 对中英一视同仁（按字符切三元组），代价写在下面。

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- 可检索文本 = 标签 + 属性的**值**。
--
-- 只取值不取键：`attributes::text` 会把 `title`、`level` 这些键名也带进去，
-- 于是搜 "title" 命中全表——一个永远返回一切的搜索框比没有搜索框更糟。
--
-- 不含 id：ULID 是随机字符，进 trigram 索引只会制造噪声和体积。
-- 「粘贴一个 id 去找对象」在仓储层单独走主键精确匹配。
CREATE OR REPLACE FUNCTION resource_search_text(labels text[], attrs jsonb)
  RETURNS text
  LANGUAGE sql
  IMMUTABLE
  PARALLEL SAFE
  STRICT
AS $$
  SELECT coalesce(array_to_string(labels, ' '), '') || ' ' ||
         coalesce((SELECT string_agg(v, ' ') FROM jsonb_each_text(attrs) AS e(k, v)), '')
$$;

-- STORED 生成列而不是表达式索引：查询里写普通列名即可，
-- 不必让 Kysely 拼出与索引**逐字相同**的表达式才能走上索引——
-- 那种耦合一旦漂移就会静默退化成全表扫描，而且没有任何报错。
ALTER TABLE resources
  ADD COLUMN search_text text
  GENERATED ALWAYS AS (resource_search_text(labels, attributes)) STORED;

CREATE INDEX resources_search_trgm_idx ON resources USING gin (search_text gin_trgm_ops);

-- 已知代价，写在这里免得后人当成 bug 去查：
--
-- trigram 顾名思义按三字符切分。查询串短于 3 个字符时抽不出三元组，
-- 而后果**不是"索引用不上"那么温和**——规划器照样可能选这个索引，
-- 而索引扫描会把整表当候选返回，再由 recheck 逐行过滤：
--
--   Bitmap Index Scan on resources_search_trgm_idx  →  rows=1,010,420
--
-- 100 万行实测 `状态`（Execution Time）：
--
--                          带 type 过滤    不带
--   ILIKE（可命中 trigram）    14.0 ms    1259 ms
--   strpos（挡开 trigram）      0.4 ms     734 ms
--
-- 所以仓储层对短查询**刻意不写 ILIKE**，改用 `strpos()` 把这个索引挡在外面。
-- 带 type 时收益来自规划器改选 (tenant, type, id DESC)：它本就按 id 排好序，
-- 凑够一页就停；不带 type 时两条路都很糟，strpos 只是没那么糟。
--
-- 中文两字词（需求 / 状态 / 权限）非常常见，所以**不能**简单地拒绝短查询，
-- 那会让搜索框对中文用户基本不可用。换路径，不是拒绝。
--
-- 仍然慢的那条路（短查询 + 无 type/project 收窄）会打一条 warn 日志。
-- 这是运维要知道的负载风险，不是使用者要看的东西，所以不进 HTTP 响应。
-- 要的只是别让它悄悄变慢到某天有人来问"搜索怎么卡了"而没有任何线索——
-- 这个项目栽在静默退化上的次数已经够多了。
