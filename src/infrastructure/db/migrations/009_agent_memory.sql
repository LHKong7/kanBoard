-- Agent 的四级 Memory（FR-AGT-005 / FR-AGT-006，口径见 docs/prd/05-agent-runtime.md §3.3）。
--
-- 四级里**只有 Episodic 需要一张表**：
--
--   Working     单次 Run，Run 结束即释放      → 内存里的局部变量
--   Episodic    Agent × Project，默认 30 天    → 这张表
--   Semantic    Project / Workspace，长期      → Knowledge BC，不在这里
--   Procedural  Agent，长期                    → Agent / Skill 实体，不在这里
--
-- FR-AGT-006 是一条**否定式**要求：「不存在 Agent 私有的项目级长期知识存储」。
-- 这种要求光写在文档里守不住——它没有一个会失败的时刻，
-- 只会在某天有人图省事往这张表里塞长期知识时悄悄破掉。
-- 所以把它做成**数据库层面办不到**的事：见下面两条约束。

CREATE TABLE agent_memories (
  id          TEXT        PRIMARY KEY,
  tenant      TEXT        NOT NULL,
  -- 记忆属于**某个 Agent 在某个项目里**的经历，两者都是键的一部分。
  -- 少了 project，一个 Agent 会把 A 项目的经验带到 B 项目里去用，
  -- 而它自己意识不到——这类串味比没有记忆更糟
  agent       TEXT        NOT NULL,
  project     TEXT,
  kind        TEXT        NOT NULL,
  key         TEXT        NOT NULL,
  value       JSONB       NOT NULL,
  run_ref     TEXT,
  created_at  TIMESTAMPTZ NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,

  -- ① 这张表**只能装 episodic**。
  --
  -- 一个可以写 'semantic' 的枚举，迟早会被写成 'semantic'。
  -- 写死成单值之后，"把语义记忆藏进 Agent 私有存储"这件事
  -- 不是"不该做"，而是**做不到**——INSERT 会直接失败。
  CONSTRAINT agent_memories_episodic_only CHECK (kind = 'episodic'),

  -- ② 必须有到期时间，而且不能是长期。
  --
  -- 没有上限的话，写一条 100 年后过期的记录就等于长期存储，
  -- 上面那条约束就被绕过去了。90 天是"可配置 TTL"的上界，
  -- 不是默认值（默认 30 天，见 PRD §3.3）
  CONSTRAINT agent_memories_bounded_ttl CHECK (expires_at <= created_at + INTERVAL '90 days'),
  CONSTRAINT agent_memories_forward_ttl CHECK (expires_at > created_at),
  CONSTRAINT agent_memories_tenant_not_blank CHECK (tenant <> ''),

  -- 同一个 Agent 在同一个项目里，同一个 key 只有一条：记忆是被更新的，不是被累积的。
  --
  -- **NULLS NOT DISTINCT 是必须的**：Postgres 默认认为两个 NULL 互不相等，
  -- 于是"不属于任何项目"的记忆（project IS NULL）永远撞不上唯一约束，
  -- 同一段经历会一次次攒下去。症状是召回的内容全是重复的，
  -- 而约束看起来明明写在那里——这条是被用例抓出来的
  CONSTRAINT agent_memories_unique_key UNIQUE NULLS NOT DISTINCT (tenant, agent, project, key)
);

-- 召回的查询形状：某 Agent、某项目、还没过期的
CREATE INDEX agent_memories_recall_idx
  ON agent_memories (tenant, agent, project, expires_at DESC);

ALTER TABLE agent_memories ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_memories FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON agent_memories
  USING (tenant = current_tenant())
  WITH CHECK (tenant = current_tenant());

GRANT SELECT, INSERT, UPDATE, DELETE ON agent_memories TO projectos_app;
