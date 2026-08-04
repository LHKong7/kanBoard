-- `project` 字段与 contains 边的一致性（docs/dogfooding-log.md #6）。
--
-- 「这个对象属于哪个项目」被存了两份：`resources.project` 标量字段，
-- 以及 `Project --contains--> 对象` 这条边。此前没有任何东西让两份保持一致，
-- 于是自用一轮之后：
--
--   type        | 有 project 字段 | 缺 contains 边
--   Knowledge   |        16       |      16
--   Task        |         6       |       6
--   Story       |         4       |       4
--   Requirement |       142       |       0   ← 只因为导入脚本手工补了边
--
-- 26 个对象声称属于某个项目，在图里却完全不可达，而系统一声没吭。
-- 服务层现在会在 create 时自动建这条边（service.ts 的 #linkToProject），
-- 这里补的是此前已经存进来的数据。

-- ── 1. 补齐缺失的 contains 边 ─────────────────────────────
--
-- 只补 project 确实指向一个存在的资源的那些。指向不存在 id 的（下面第 2 步说的
-- 那种）没有边可建，留给运维处理——静默塞一条指向虚空的边只会把问题藏得更深。
INSERT INTO relations (id, tenant, type, from_id, to_id, created_by, created_at, confidence, confirmed)
SELECT
  -- 与 platform/id.ts 同形的 id：小写前缀 + 26 位 Crockford base32
  -- （`^[a-z][a-z0-9]*_[0-9A-HJKMNP-TV-Z]{26}$`）。
  -- md5 的十六进制字符大写后是 0-9A-F，正好全部落在该字母表内，不必再做映射。
  -- 用 md5(from||to) 而不是随机数：迁移重跑会得到同样的 id，
  -- 配合下面的 NOT EXISTS 与 ON CONFLICT 才是真幂等。
  'rel_' || upper(substr(md5(r.project || '>' || r.id), 1, 26)),
  r.tenant,
  'contains',
  r.project,
  r.id,
  'system',
  r.created_at,
  NULL,
  TRUE
FROM resources r
JOIN resources p ON p.id = r.project AND p.tenant = r.tenant
WHERE r.project IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM relations rel
    WHERE rel.type = 'contains' AND rel.from_id = r.project AND rel.to_id = r.id
  )
ON CONFLICT DO NOTHING;

-- ── 2. 让"指向不存在的项目"从此写不进来 ────────────────────
--
-- 此前 `project` 是一个没有任何约束的 TEXT：
--   POST /v1/resources {"project":"prj_00000000000000000000000000"}  → 201 Created
-- 服务层现在会拒绝，外键是数据库层的兜底——和 relations.from_id / to_id 一样的做法。
--
-- NOT VALID：只约束今后的写入，不去校验已有行。历史上的悬空引用不该
-- 卡住一次部署；清理干净之后再 `VALIDATE CONSTRAINT` 即可。
--
-- 不用 ON DELETE CASCADE。relations 那两列用 CASCADE 是对的——边依附于两端；
-- 但一个对象不该因为项目行被删掉而跟着消失。何况删除一律是软删除，
-- 默认的 NO ACTION 在正常路径上永远不会触发。
ALTER TABLE resources
  ADD CONSTRAINT resources_project_fk
  FOREIGN KEY (project) REFERENCES resources (id)
  NOT VALID;

-- ── 3. 把已有的悬空引用报出来 ──────────────────────────────
--
-- 迁移不替使用者决定这些数据怎么处理（清空？改指？），但绝不能不吭声。
DO $$
DECLARE
  dangling bigint;
  linked   bigint;
BEGIN
  SELECT count(*) INTO dangling
  FROM resources r
  WHERE r.project IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM resources p WHERE p.id = r.project);

  SELECT count(*) INTO linked
  FROM relations WHERE type = 'contains' AND created_by = 'system';

  RAISE NOTICE 'project containment: % contains edge(s) present, % dangling project reference(s)',
    linked, dangling;

  IF dangling > 0 THEN
    RAISE WARNING 'resources_project_fk was added NOT VALID because % row(s) reference a project that does not exist; fix them then run: ALTER TABLE resources VALIDATE CONSTRAINT resources_project_fk', dangling;
  END IF;
END
$$;
