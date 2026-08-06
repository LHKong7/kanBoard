-- 归档（project-management-guide §2.6 与反模式表里的「Backlog 无限增长」）。
--
-- 归档不是删除，也不是一个状态。三者的区别值得写清楚，
-- 因为把它做成其中任何一个都会坏掉一批别的东西：
--
--   删除（deleted_at）  东西没了。历史、关系、指标里都不该再出现它。
--   状态（status）      东西在流程的哪一步。归档不是流程的一步——
--                       一个 Done 的任务被归档之后**仍然是 Done**，
--                       做成状态就得给每台状态机都加一个 Archived，
--                       而那会让"完成率"的分母凭空变化。
--   归档（archived_at） 东西还在、还算数，只是不该出现在日常视图里。
--
-- 所以它是一个**独立的维度**，和状态正交。指标照常统计归档的对象
-- （上个季度完成了多少件事，不该因为归档而变少），列表默认不显示它们。
ALTER TABLE resources ADD COLUMN archived_at TIMESTAMPTZ;

-- 谁归的档、为什么。自动归档的写 `system://internal`。
--
-- 需要它是因为归档**是可逆的**：有人要把一条捞回来时，
-- 第一个问题一定是"这是谁归的、是自动的还是有人特意归的"。
-- 只存一个时间戳的话，这个问题答不了。
ALTER TABLE resources ADD COLUMN archived_by TEXT;

-- 列表的默认形状是"没删、没归档"，所以部分索引直接按这个条件建。
-- 建成全量索引的话，归档掉的行仍然占着索引，而它们恰恰是
-- 日常查询永远不会碰的那些
CREATE INDEX resources_active_idx
  ON resources (tenant, type, id DESC)
  WHERE deleted_at IS NULL AND archived_at IS NULL;

-- 自动归档巡检的查询形状：某租户、某项目、某状态、更新时间早于某时刻
CREATE INDEX resources_archive_sweep_idx
  ON resources (tenant, project, updated_at)
  WHERE deleted_at IS NULL AND archived_at IS NULL;
