-- 流程实例（FR-WF-010 / FR-WF-011）。
--
-- 一个流程实例会**跨天**：人工节点等 24 小时、灰度观察好几轮。
-- 进程重启、部署、崩溃都会发生在中间。状态只活在内存里的话，
-- 一次重启会让一个已经冻结了 Release、已经调过部署接口的流程
-- 从记录上彻底消失——而外面的世界已经变了。
--
-- state 整条存 JSONB：它是 `advance()` 的输入，而 advance 是纯函数，
-- 所以"跑到哪儿了"完全由这一坨数据决定，不需要额外的进度字段。
-- 拆成 steps 表的话，重入时要先把它拼回来，而拼错了没人会发现。
CREATE TABLE process_runs (
  tenant      TEXT        NOT NULL,
  id          TEXT        NOT NULL,
  process_id  TEXT        NOT NULL,
  -- 符号名 → 真实对象 id。流程定义里写的是 `release`，实例才知道是哪一个
  refs        JSONB       NOT NULL,
  state       JSONB       NOT NULL,
  status      TEXT        NOT NULL,
  -- 在等谁点头，以及等到什么时候。null = 没在等人。
  -- 单独两列而不是塞进 state：值班的人要能查"有哪些流程在等我"，
  -- 而那是一次按状态和时间的扫描，不该拆 JSONB
  awaiting_step TEXT,
  awaiting_deadline TIMESTAMPTZ,
  started_at  TIMESTAMPTZ NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL,

  PRIMARY KEY (tenant, id),
  CONSTRAINT process_runs_tenant_not_empty CHECK (tenant <> '')
);

-- 等人的实例按截止时间扫：超时了要么放行要么失败，不能一直挂着
CREATE INDEX process_runs_awaiting ON process_runs (tenant, awaiting_deadline)
  WHERE status = 'awaiting-human';

ALTER TABLE process_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE process_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON process_runs
  USING (tenant = current_tenant())
  WITH CHECK (tenant = current_tenant());

GRANT SELECT, INSERT, UPDATE, DELETE ON process_runs TO projectos_app;
