-- SLA 超时（FR-WF-002 的 sla 要素）。
--
-- 在此之前 `sla` 只是状态机定义里的一个字段：Task 的 `Doing` 上写着
-- 「5 天，超时通知 owner」，而**没有任何代码读它**。
-- 一个看起来配置好了、实际什么也不做的字段，比没有这个字段更糟——
-- 有人会以为超时会有人管。
--
-- 要让它变成真的，需要回答两个问题，各对应下面一块。

-- ─────────────────────────────────────────────────────────────
-- 一、这个对象在当前状态里待了多久？
-- ─────────────────────────────────────────────────────────────
--
-- 不用 `updated_at`：改一次标题就会把它刷新，于是一个停滞了三周、
-- 昨天被人补了个描述的任务，看起来"刚动过"。那正好是最该报警的对象，
-- 而这种算法会**恰恰漏掉它**。
--
-- 也不去翻 resource_history：那是每个对象一次查询，
-- 一次全租户巡检会变成几万次往返。
--
-- 存一列。它同时是几个 PRD 指标（Cycle Time、Blocked Time、WIP 时长）
-- 想问的同一个问题，不是只为 SLA 加的。
ALTER TABLE resources ADD COLUMN status_since TIMESTAMPTZ;

-- 已有的行没有迁移记录可查，用 updated_at 作为最接近的近似。
-- 这会让存量对象的 SLA 计时**偏晚**（看起来比实际年轻），
-- 也就是偏向不报警——补数据时宁可漏报也不要造一批假的超时告警。
UPDATE resources SET status_since = updated_at WHERE status_since IS NULL;
ALTER TABLE resources ALTER COLUMN status_since SET NOT NULL;

-- 巡检的查询形状是"某类型、某状态、进入时间早于某时刻"
CREATE INDEX resources_sla_sweep_idx
  ON resources (tenant, type, status, status_since)
  WHERE deleted_at IS NULL;

-- ─────────────────────────────────────────────────────────────
-- 二、这次超时报过了吗？
-- ─────────────────────────────────────────────────────────────
--
-- 巡检是反复跑的。没有这张表的话，一个超时的任务会在每一轮
-- 都生成一条通知——几小时之后收件箱里全是同一件事，
-- 而**一个吵到没人看的告警等于没有告警**。
--
-- 主键带上 status_since：同一个对象重新进入这个状态算一次新的计时，
-- 因此也应当能重新报警。用 (resource_id, status) 做主键的话，
-- 一个反复超时的对象只会在第一次被提醒。
CREATE TABLE sla_breaches (
  tenant       TEXT        NOT NULL,
  resource_id  TEXT        NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  status       TEXT        NOT NULL,
  status_since TIMESTAMPTZ NOT NULL,
  -- notify-owner | escalate
  action       TEXT        NOT NULL,
  breached_at  TIMESTAMPTZ NOT NULL,
  detected_at  TIMESTAMPTZ NOT NULL,
  -- 生成的那条通知；巡检动作失败时为 NULL，于是"报警本身失败了"
  -- 也是可查的，而不是消失
  notification_id TEXT,

  PRIMARY KEY (tenant, resource_id, status, status_since),
  CONSTRAINT sla_breaches_tenant_not_blank CHECK (tenant <> '')
);

ALTER TABLE sla_breaches ENABLE ROW LEVEL SECURITY;
ALTER TABLE sla_breaches FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON sla_breaches
  USING (tenant = current_tenant())
  WITH CHECK (tenant = current_tenant());

GRANT SELECT, INSERT, UPDATE, DELETE ON sla_breaches TO projectos_app;
