-- Agent Run 轨迹（FR-AGT-007）。
--
-- Run 本身是一个 Resource（走 `resources` 表和统一 API），
-- 但它的**步骤**不是：一次 Run 会产生几十条步骤，把它们做成资源
-- 会让看板和查询被推理噪声淹没。步骤是 Run 的从属明细，
-- 和 `resource_history` 一样单独一张表。
--
-- 判断标准很简单：**会不会有人想给它建关系、设权限、走状态机？**
-- Run 会（要审批、要授权、要回放），步骤不会。

CREATE TABLE agent_run_steps (
  seq_id      BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant      TEXT        NOT NULL,
  run_id      TEXT        NOT NULL REFERENCES resources (id) ON DELETE CASCADE,
  -- Run 内的序号。回放要按顺序，而 seq_id 是全局的，跨 Run 不连续
  seq         INTEGER     NOT NULL,
  kind        TEXT        NOT NULL,
  summary     TEXT        NOT NULL,
  detail      JSONB       NOT NULL DEFAULT '{}'::jsonb,
  -- 成本记在每一步上而不是只记总数：Run 超预算时要能看出是哪一步烧掉的
  tokens_used INTEGER     NOT NULL DEFAULT 0,
  cost_usd    NUMERIC(12, 6) NOT NULL DEFAULT 0,
  occurred_at TIMESTAMPTZ NOT NULL,

  CONSTRAINT agent_run_steps_tenant_not_empty CHECK (tenant <> ''),
  CONSTRAINT agent_run_steps_seq_unique UNIQUE (run_id, seq)
);

CREATE INDEX agent_run_steps_replay_idx ON agent_run_steps (tenant, run_id, seq);

-- 和其余表一样：ENABLE 之外必须 FORCE，否则表 owner 绕得过去
ALTER TABLE agent_run_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_run_steps FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON agent_run_steps
  USING (tenant = current_tenant())
  WITH CHECK (tenant = current_tenant());

GRANT SELECT, INSERT, UPDATE, DELETE ON agent_run_steps TO projectos_app;
