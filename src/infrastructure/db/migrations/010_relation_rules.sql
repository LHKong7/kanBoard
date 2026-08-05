-- 自动关系建立规则（FR-ONT-008）。
--
-- 需求原文是「规则可增删改，变更即时生效」——"即时"排除了重启，
-- 所以规则必须是数据而不是代码常量。和 lifecycles 是同一个理由、
-- 同一个形状：整条存 JSONB，因为一条规则的合法性（关系类型存在、
-- 定义域/值域对得上、属性名在本体里、置信度严格在 0 与 1 之间）
-- 只能整体校验，拆成列之后中间态必然出现非法组合。
--
-- 没有 revision 列。lifecycles 需要它是因为多进程要判缓存是否过期，
-- 而规则**每次用之前现读**：一次写入触发的规则应用最多命中几十行，
-- 为它省一次查询而引入一层可能不一致的缓存不划算。
CREATE TABLE relation_rules (
  tenant        TEXT        NOT NULL,
  id            TEXT        NOT NULL,
  -- 冗余出来只为了按主体类型收窄：一次写入只关心"对这种对象生效"的那些规则，
  -- 全表拉回来在内存里过滤会让每一次写都读一遍全部规则
  subject_type  TEXT        NOT NULL,
  definition    JSONB       NOT NULL,
  enabled       BOOLEAN     NOT NULL DEFAULT TRUE,
  updated_by    TEXT        NOT NULL,
  updated_at    TIMESTAMPTZ NOT NULL,

  PRIMARY KEY (tenant, id),
  CONSTRAINT relation_rules_tenant_not_empty CHECK (tenant <> '')
);

CREATE INDEX relation_rules_by_subject ON relation_rules (tenant, subject_type) WHERE enabled;

ALTER TABLE relation_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE relation_rules FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON relation_rules
  USING (tenant = current_tenant())
  WITH CHECK (tenant = current_tenant());

GRANT SELECT, INSERT, UPDATE, DELETE ON relation_rules TO projectos_app;
