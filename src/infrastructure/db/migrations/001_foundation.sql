-- M0 · Foundation
--
-- 统一 Resource 模型（ADR-0002）+ 租户隔离（ADR-0005）。
--
-- 关于 RLS：应用层当然也会带 tenant 条件，但那是会被遗忘的防线。
-- RLS 是不会被遗忘的防线——ADR-0005 的核心验收项就是"删掉应用层过滤后仍然拦得住"。

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- 应用连接使用的角色。它没有 BYPASSRLS，这是本方案成立的前提。
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'projectos_app') THEN
    CREATE ROLE projectos_app NOLOGIN;
  END IF;
END
$$;

-- ─────────────────────────────────────────────────────────────
-- Resource：所有领域对象的统一形态
-- ─────────────────────────────────────────────────────────────
CREATE TABLE resources (
  id                TEXT PRIMARY KEY,
  tenant            TEXT        NOT NULL,
  type              TEXT        NOT NULL,
  ontology_version  TEXT        NOT NULL,
  workspace         TEXT        NOT NULL,
  project           TEXT,
  owner             TEXT        NOT NULL,
  created_by        TEXT        NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL,
  updated_at        TIMESTAMPTZ NOT NULL,
  status            TEXT        NOT NULL,
  lifecycle         TEXT,
  version           INTEGER     NOT NULL DEFAULT 1,
  labels            TEXT[]      NOT NULL DEFAULT '{}',
  attributes        JSONB       NOT NULL DEFAULT '{}'::jsonb,
  visibility        TEXT        NOT NULL DEFAULT 'workspace',
  deleted_at        TIMESTAMPTZ,

  CONSTRAINT resources_version_positive CHECK (version > 0),
  -- 空租户不是合法租户：配合 current_tenant() 的 nullif，
  -- "无上下文"永远无法匹配到任何一行
  CONSTRAINT resources_tenant_not_blank CHECK (tenant <> '')
);

-- tenant 作为索引前缀：RLS 的过滤条件因此总能命中索引
CREATE INDEX resources_tenant_type_idx     ON resources (tenant, type, id DESC);
CREATE INDEX resources_tenant_project_idx  ON resources (tenant, project, updated_at DESC);
CREATE INDEX resources_tenant_status_idx   ON resources (tenant, type, status);
CREATE INDEX resources_attributes_gin_idx  ON resources USING gin (attributes jsonb_path_ops);
CREATE INDEX resources_labels_gin_idx      ON resources USING gin (labels);
-- 软删除是常态过滤条件，单独建部分索引
CREATE INDEX resources_live_idx            ON resources (tenant, type) WHERE deleted_at IS NULL;

-- ─────────────────────────────────────────────────────────────
-- Relation：关系是一等公民（原则 P4.1）
-- ─────────────────────────────────────────────────────────────
CREATE TABLE relations (
  id          TEXT PRIMARY KEY,
  tenant      TEXT        NOT NULL,
  type        TEXT        NOT NULL,
  from_id     TEXT        NOT NULL REFERENCES resources (id) ON DELETE CASCADE,
  to_id       TEXT        NOT NULL REFERENCES resources (id) ON DELETE CASCADE,
  created_by  TEXT        NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL,
  -- Agent 推断的关系必填（FR-ONT-006）；人工/系统建立的为 NULL
  confidence  REAL,
  -- NULL = 待确认，true = 人工确认，false = 人工否决
  confirmed   BOOLEAN,

  CONSTRAINT relations_no_self_loop CHECK (from_id <> to_id),
  CONSTRAINT relations_confidence_range CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1))
);

-- 同一租户下 (from, type, to) 唯一：重复建立同一条关系是幂等的
CREATE UNIQUE INDEX relations_unique_edge_idx ON relations (tenant, from_id, type, to_id);
CREATE INDEX relations_out_idx ON relations (tenant, from_id, type);
CREATE INDEX relations_in_idx  ON relations (tenant, to_id, type);

-- ─────────────────────────────────────────────────────────────
-- History：append-only，永不物理删除
-- ─────────────────────────────────────────────────────────────
CREATE TABLE resource_history (
  seq          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  resource_id  TEXT        NOT NULL,
  tenant       TEXT        NOT NULL,
  version      INTEGER     NOT NULL,
  changed_by   TEXT        NOT NULL,
  on_behalf_of TEXT,
  changed_at   TIMESTAMPTZ NOT NULL,
  run_ref      TEXT,
  changes      JSONB       NOT NULL,
  reason       TEXT,
  trace_id     TEXT
);

CREATE INDEX resource_history_resource_idx ON resource_history (tenant, resource_id, version DESC);

-- ─────────────────────────────────────────────────────────────
-- Outbox：业务写入与领域事件同事务（FR-RES-006）
--
-- 用 outbox 而不是"写完再发"：后者在进程崩溃时会产生
-- 写入成功但事件丢失，或事件已发但事务回滚的幽灵事件。
-- ─────────────────────────────────────────────────────────────
CREATE TABLE outbox_events (
  seq           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant        TEXT        NOT NULL,
  event_type    TEXT        NOT NULL,
  resource_id   TEXT        NOT NULL,
  resource_type TEXT        NOT NULL,
  payload       JSONB       NOT NULL,
  occurred_at   TIMESTAMPTZ NOT NULL,
  trace_id      TEXT,
  published_at  TIMESTAMPTZ
);

CREATE INDEX outbox_unpublished_idx ON outbox_events (seq) WHERE published_at IS NULL;

-- ─────────────────────────────────────────────────────────────
-- Audit：所有授权决策与资源变更（FR-IAM-013）
-- ─────────────────────────────────────────────────────────────
CREATE TABLE audit_log (
  seq           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant        TEXT        NOT NULL,
  subject       TEXT        NOT NULL,
  on_behalf_of  TEXT,
  action        TEXT        NOT NULL,
  resource_id   TEXT,
  resource_type TEXT,
  decision      TEXT        NOT NULL,
  reason        TEXT        NOT NULL,
  matched_policy TEXT,
  run_ref       TEXT,
  occurred_at   TIMESTAMPTZ NOT NULL,
  trace_id      TEXT
);

CREATE INDEX audit_subject_idx  ON audit_log (tenant, subject, occurred_at DESC);
CREATE INDEX audit_resource_idx ON audit_log (tenant, resource_id, occurred_at DESC);
CREATE INDEX audit_decision_idx ON audit_log (tenant, decision, occurred_at DESC);

-- ─────────────────────────────────────────────────────────────
-- Grant：Agent 临时授权（ADR-0003 §7.2）
-- ─────────────────────────────────────────────────────────────
CREATE TABLE grants (
  id            TEXT PRIMARY KEY,
  tenant        TEXT        NOT NULL,
  subject       TEXT        NOT NULL,
  on_behalf_of  TEXT,
  capabilities  TEXT[]      NOT NULL,
  scope_kind    TEXT        NOT NULL,
  scope_value   TEXT,
  issued_at     TIMESTAMPTZ NOT NULL,
  expires_at    TIMESTAMPTZ NOT NULL,
  max_calls     INTEGER     NOT NULL,
  used_calls    INTEGER     NOT NULL DEFAULT 0,
  bound_to_run  TEXT,
  revoked_at    TIMESTAMPTZ,

  CONSTRAINT grants_ttl_bounded CHECK (expires_at > issued_at),
  CONSTRAINT grants_calls_bounded CHECK (used_calls >= 0 AND max_calls > 0)
);

CREATE INDEX grants_subject_idx ON grants (tenant, subject) WHERE revoked_at IS NULL;
CREATE INDEX grants_run_idx     ON grants (tenant, bound_to_run) WHERE revoked_at IS NULL;

-- ─────────────────────────────────────────────────────────────
-- RLS：租户隔离的兜底防线
--
-- FORCE ROW LEVEL SECURITY 很关键：默认情况下表 owner 不受 RLS 约束，
-- 加上 FORCE 之后连 owner 也必须遵守。少了这一句，用 owner 身份连接就绕过了整套隔离。
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION current_tenant() RETURNS TEXT AS $$
  -- current_setting 的第二个参数 true = "未设置时返回 NULL 而不是报错"。
  --
  -- 外面的 nullif 不是多余的：SET LOCAL 在事务结束后会把自定义 GUC 回退成**空串**
  -- 而不是 NULL。空串本身匹配不到任何行（tenant 有非空约束），
  -- 但让"无租户上下文"只有 NULL 一种表示，比依赖两种值都恰好安全要可靠。
  SELECT nullif(current_setting('projectos.tenant', true), '');
$$ LANGUAGE sql STABLE;

DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['resources', 'relations', 'resource_history', 'outbox_events', 'audit_log', 'grants']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant = current_tenant()) WITH CHECK (tenant = current_tenant())',
      t
    );
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO projectos_app', t);
  END LOOP;
END
$$;

GRANT USAGE ON SCHEMA public TO projectos_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO projectos_app;
