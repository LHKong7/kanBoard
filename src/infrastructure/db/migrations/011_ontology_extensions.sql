-- 租户级本体扩展（FR-ONT-009）。
--
-- 验收标准：**扩展字段仅本租户可见，命名空间隔离。**
--
-- 「仅本租户可见」由 RLS 保证（和其它表同一条策略），
-- 「命名空间隔离」由 `validateExtension` 在写入前保证（`x_<tenant>_` 前缀）。
-- 两道是不同的东西：前者管**谁读得到这份定义**，
-- 后者管**两个租户各自扩出来的字段会不会重名**——
-- 只有前者的话，两个租户同时加一个 `owner` 字段，
-- 平台哪天想加一个同名的平台字段就再也加不了了。
--
-- 一个租户对一个类型只有一行：一份扩展的合法性是**整体**判定的
-- （所有字段必须同时命名空间正确、同时可选、同时不是 derived），
-- 拆成多行之后中间态必然出现非法组合。
CREATE TABLE ontology_extensions (
  tenant      TEXT        NOT NULL,
  entity_type TEXT        NOT NULL,
  attributes  JSONB       NOT NULL,
  updated_by  TEXT        NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL,

  PRIMARY KEY (tenant, entity_type),
  CONSTRAINT ontology_extensions_tenant_not_empty CHECK (tenant <> '')
);

ALTER TABLE ontology_extensions ENABLE ROW LEVEL SECURITY;
ALTER TABLE ontology_extensions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ontology_extensions
  USING (tenant = current_tenant())
  WITH CHECK (tenant = current_tenant());

GRANT SELECT, INSERT, UPDATE, DELETE ON ontology_extensions TO projectos_app;
