-- 可配置状态机（FR-WF-001）。
--
-- 此前状态机是代码里的常量：改一次流程要发一次版。
-- 需求原文是「修改状态机定义后新实例即时生效」——"即时"排除了重启。
--
-- 定义整条存 JSONB 而不是拆成 states / transitions 两张表：
-- 一台状态机是**一个整体**，它的合法性（初始状态存在、迁移两端都有定义、
-- 没有到不了的状态）只能整体校验。拆表之后中间态必然出现非法组合，
-- 而那时的校验只能推迟到读取时——也就是推迟到出问题的时候。
CREATE TABLE lifecycles (
  tenant      TEXT        NOT NULL,
  id          TEXT        NOT NULL,
  entity_type TEXT        NOT NULL,
  definition  JSONB       NOT NULL,
  -- 每次写入 +1。多进程部署时，其余进程靠它判断缓存是否过期
  revision    INTEGER     NOT NULL DEFAULT 1,
  updated_by  TEXT        NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL,

  PRIMARY KEY (tenant, id),
  CONSTRAINT lifecycles_tenant_not_empty CHECK (tenant <> ''),
  -- 一个 EntityType 只能绑一台状态机：绑两台的话，
  -- "这个对象该走哪条流程"就没有确定答案了
  CONSTRAINT lifecycles_one_per_type UNIQUE (tenant, entity_type)
);

ALTER TABLE lifecycles ENABLE ROW LEVEL SECURITY;
ALTER TABLE lifecycles FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON lifecycles
  USING (tenant = current_tenant())
  WITH CHECK (tenant = current_tenant());

GRANT SELECT, INSERT, UPDATE, DELETE ON lifecycles TO projectos_app;
