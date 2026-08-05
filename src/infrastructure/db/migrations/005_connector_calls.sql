-- Connector 调用的幂等记录（FR-CON-004）。
--
-- 没有它，一次超时重试就会创建第二个 PR——而外部系统不会帮我们去重。
-- 唯一约束落在 (tenant, connector_id, operation, idempotency_key) 上：
-- 幂等键的作用域是"某个 Connector 的某个操作"，不是全局，
-- 否则两个 Connector 恰好用了同一个键就会互相吞掉对方的调用。

CREATE TABLE connector_calls (
  seq_id          BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant          TEXT        NOT NULL,
  connector_id    TEXT        NOT NULL,
  operation       TEXT        NOT NULL,
  idempotency_key TEXT        NOT NULL,
  subject         TEXT        NOT NULL,
  -- 第一次调用的结果。重放时原样返回，**不再碰外部系统**
  result          JSONB       NOT NULL DEFAULT 'null'::jsonb,
  occurred_at     TIMESTAMPTZ NOT NULL,

  CONSTRAINT connector_calls_tenant_not_empty CHECK (tenant <> ''),
  CONSTRAINT connector_calls_key_unique UNIQUE (tenant, connector_id, operation, idempotency_key)
);

CREATE INDEX connector_calls_recent_idx ON connector_calls (tenant, connector_id, occurred_at DESC);

ALTER TABLE connector_calls ENABLE ROW LEVEL SECURITY;
ALTER TABLE connector_calls FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON connector_calls
  USING (tenant = current_tenant())
  WITH CHECK (tenant = current_tenant());

GRANT SELECT, INSERT, UPDATE, DELETE ON connector_calls TO projectos_app;
