import pg from 'pg'
import { migrate } from '../src/infrastructure/db/migrate.ts'

/**
 * 基准数据集。
 *
 * 全部在 SQL 侧用 generate_series 生成：1M 行如果走客户端逐条插入，
 * 光往返就要几分钟，而我们要测的是查询不是插入。
 *
 * 图的形状刻意贴近真实项目：
 *
 *   Project ─contains→ Requirement ─implementedBy→ Story ─decomposedInto→ Task
 *                                                                          │
 *                                                                    blockedBy（成环）
 *
 * blockedBy 故意做成稠密且有环——真实需求图就是这样，
 * 而防环逻辑的开销必须体现在基准里，不能拿一棵干净的树来测。
 */

const TENANT = 'default'

/**
 * 与 001_foundation.sql 一致的索引定义。
 *
 * 这里必须和迁移保持同步——不同步的话基准测的就不是生产的那套索引。
 * seed 结束时会断言它们确实存在。
 */
const BENCH_INDEXES: readonly string[] = [
  'CREATE INDEX resources_tenant_type_idx     ON resources (tenant, type, id DESC)',
  'CREATE INDEX resources_tenant_project_idx  ON resources (tenant, project, updated_at DESC)',
  'CREATE INDEX resources_tenant_status_idx   ON resources (tenant, type, status)',
  'CREATE INDEX resources_attributes_gin_idx  ON resources USING gin (attributes jsonb_path_ops)',
  'CREATE INDEX resources_labels_gin_idx      ON resources USING gin (labels)',
  'CREATE INDEX resources_live_idx            ON resources (tenant, type) WHERE deleted_at IS NULL',
  'CREATE UNIQUE INDEX relations_unique_edge_idx ON relations (tenant, from_id, type, to_id)',
  'CREATE INDEX relations_out_idx ON relations (tenant, from_id, type)',
  'CREATE INDEX relations_in_idx  ON relations (tenant, to_id, type)',
]

export type SeedScale = {
  projects: number
  requirementsPerProject: number
  storiesPerRequirement: number
  tasksPerStory: number
  /** 每个 Task 平均被多少条 blockedBy 边连接 */
  blockedByPerTask: number
}

/** M0 出口标准要求的 100 万节点样本 */
export const SCALE_1M: SeedScale = {
  projects: 100,
  requirementsPerProject: 100,
  storiesPerRequirement: 10,
  tasksPerStory: 9,
  blockedByPerTask: 2,
}

export async function seed(connectionString: string, scale: SeedScale): Promise<void> {
  await migrate(connectionString)

  const client = new pg.Client({ connectionString })
  await client.connect()

  const t = (label: string, started: number): void =>
    console.log(`  ${label.padEnd(28)} ${((Date.now() - started) / 1000).toFixed(1)}s`)

  try {
    // 生成形如 ULID 的 id：26 位 Crockford base32，且随 n 单调递增，
    // 这样游标分页（按 id 排序）在基准里也是真实行为
    await client.query(`
      CREATE OR REPLACE FUNCTION bench_id(prefix text, n bigint) RETURNS text AS $$
      DECLARE
        alphabet CONSTANT text := '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
        out text := '';
        v bigint := n;
      BEGIN
        WHILE length(out) < 26 LOOP
          out := substr(alphabet, (v % 32)::int + 1, 1) || out;
          v := v / 32;
        END LOOP;
        RETURN prefix || '_' || out;
      END;
      $$ LANGUAGE plpgsql IMMUTABLE;
    `)

    await client.query('TRUNCATE relations, resource_history, outbox_events, audit_log, resources CASCADE')

    // 索引在批量写入期间是纯负担：先删后建比边写边维护快数倍。
    //
    // 索引定义写死在这里而不是从 pg_indexes 读回来再重建：
    // 前一版就是那么做的，结果重建阶段静默地什么都没干，
    // 基准跑在一张只有主键的表上——而且因为百分位算的是成功请求，
    // 全部超时反而被报告成"达标"。定义显式列出，重建后还要断言，
    // 这一类"看起来跑过了"的失败才不会再发生。
    console.log('dropping indexes for bulk load…')
    const { rows: existing } = await client.query<{ indexname: string }>(`
      SELECT indexname FROM pg_indexes
      WHERE tablename IN ('resources', 'relations') AND indexname NOT LIKE '%_pkey'
    `)
    for (const index of existing) await client.query(`DROP INDEX ${index.indexname}`)
    console.log(`  dropped ${existing.length}`)

    const nProjects = scale.projects
    const nRequirements = nProjects * scale.requirementsPerProject
    const nStories = nRequirements * scale.storiesPerRequirement
    const nTasks = nStories * scale.tasksPerStory

    console.log(
      `seeding ${(nProjects + nRequirements + nStories + nTasks).toLocaleString()} resources…`,
    )

    let started = Date.now()
    await client.query(
      `
      INSERT INTO resources
        (id, tenant, type, ontology_version, workspace, project, owner, created_by,
         created_at, updated_at, status, lifecycle, version, labels, attributes, visibility)
      SELECT
        bench_id('prj', n), $1, 'Project', '1.1.0', 'ws_bench', NULL,
        'user://alice', 'user://alice', now(), now(), 'Active', 'project-default', 1,
        ARRAY[]::text[],
        jsonb_build_object('key', 'P' || n, 'name', 'Project ' || n),
        'workspace'
      FROM generate_series(1, $2::bigint) AS n
    `,
      [TENANT, nProjects],
    )
    t('projects', started)

    started = Date.now()
    await client.query(
      `
      INSERT INTO resources
        (id, tenant, type, ontology_version, workspace, project, owner, created_by,
         created_at, updated_at, status, lifecycle, version, labels, attributes, visibility)
      SELECT
        bench_id('req', n), $1, 'Requirement', '1.1.0', 'ws_bench',
        bench_id('prj', ((n - 1) / $3::bigint) + 1),
        'user://alice', 'user://alice', now(), now(), 'Approved', 'requirement-default', 1,
        CASE WHEN n % 7 = 0 THEN ARRAY['q3'] ELSE ARRAY[]::text[] END,
        jsonb_build_object(
          'title', 'Requirement ' || n,
          'level', (ARRAY['Epic','Feature','Story'])[1 + n % 3],
          'statement', 'generated for benchmarking',
          'priority', (ARRAY['Must','Should','Could'])[1 + n % 3]
        ),
        'workspace'
      FROM generate_series(1, $2::bigint) AS n
    `,
      [TENANT, nRequirements, scale.requirementsPerProject],
    )
    t('requirements', started)

    started = Date.now()
    await client.query(
      `
      INSERT INTO resources
        (id, tenant, type, ontology_version, workspace, project, owner, created_by,
         created_at, updated_at, status, lifecycle, version, labels, attributes, visibility)
      SELECT
        bench_id('story', n), $1, 'Story', '1.1.0', 'ws_bench',
        bench_id('prj', ((n - 1) / ($3::bigint * $4::bigint)) + 1),
        'user://alice', 'user://alice', now(), now(), 'Ready', 'story-default', 1,
        ARRAY[]::text[],
        jsonb_build_object('title', 'Story ' || n, 'storyPoint', 1 + n % 8),
        'workspace'
      FROM generate_series(1, $2::bigint) AS n
    `,
      [TENANT, nStories, scale.storiesPerRequirement, scale.requirementsPerProject],
    )
    t('stories', started)

    started = Date.now()
    // assignee 全部填上：状态迁移基准要走通 Todo → Doing 的守卫，
    // 测一条必然被拒的路径没有意义
    await client.query(
      `
      INSERT INTO resources
        (id, tenant, type, ontology_version, workspace, project, owner, created_by,
         created_at, updated_at, status, lifecycle, version, labels, attributes, visibility)
      SELECT
        bench_id('task', n), $1, 'Task', '1.1.0', 'ws_bench',
        bench_id('prj', ((n - 1) / ($3::bigint * $4::bigint * $5::bigint)) + 1),
        'user://alice', 'user://alice', now(), now(), 'Todo', 'task-default', 1,
        CASE WHEN n % 11 = 0 THEN ARRAY['hot'] ELSE ARRAY[]::text[] END,
        jsonb_build_object(
          'title', 'Task ' || n,
          'assignee', 'user://dev' || (n % 50),
          'estimate', (n % 13)::float
        ),
        'workspace'
      FROM generate_series(1, $2::bigint) AS n
    `,
      [TENANT, nTasks, scale.tasksPerStory, scale.storiesPerRequirement, scale.requirementsPerProject],
    )
    t('tasks', started)

    console.log('seeding relations…')

    started = Date.now()
    await client.query(
      `
      INSERT INTO relations (id, tenant, type, from_id, to_id, created_by, created_at, confirmed)
      SELECT bench_id('relation', n), $1, 'contains',
             bench_id('prj', ((n - 1) / $3::bigint) + 1), bench_id('req', n),
             'system', now(), true
      FROM generate_series(1, $2::bigint) AS n
    `,
      [TENANT, nRequirements, scale.requirementsPerProject],
    )
    t('contains', started)

    started = Date.now()
    await client.query(
      `
      INSERT INTO relations (id, tenant, type, from_id, to_id, created_by, created_at, confirmed)
      SELECT bench_id('relation', $2::bigint + n), $1, 'implementedBy',
             bench_id('req', ((n - 1) / $3::bigint) + 1), bench_id('story', n),
             'system', now(), true
      FROM generate_series(1, $4::bigint) AS n
    `,
      [TENANT, nRequirements, scale.storiesPerRequirement, nStories],
    )
    t('implementedBy', started)

    started = Date.now()
    await client.query(
      `
      INSERT INTO relations (id, tenant, type, from_id, to_id, created_by, created_at, confirmed)
      SELECT bench_id('relation', $2::bigint + n), $1, 'decomposedInto',
             bench_id('story', ((n - 1) / $3::bigint) + 1), bench_id('task', n),
             'system', now(), true
      FROM generate_series(1, $4::bigint) AS n
    `,
      [TENANT, nRequirements + nStories, scale.tasksPerStory, nTasks],
    )
    t('decomposedInto', started)

    started = Date.now()
    // blockedBy 用互质步长连接，产生稠密且成环的子图。
    // 一棵干净的树测不出防环逻辑的成本。
    const nBlocked = nTasks * scale.blockedByPerTask
    await client.query(
      `
      INSERT INTO relations (id, tenant, type, from_id, to_id, created_by, created_at, confirmed)
      SELECT bench_id('relation', $2::bigint + n), $1, 'blockedBy',
             bench_id('task', src), bench_id('task', dst),
             'system', now(), true
      FROM (
        SELECT
          1 + (n - 1) % $3::bigint AS src,
          -- 第 k 遍要用不同的偏移量。两遍都用同一个步长的话，
          -- (n) 与 (n + nTasks) 会算出完全相同的 (src, dst)——
          -- 边被生成两次，而唯一索引在批量写入期间是被删掉的，
          -- ON CONFLICT DO NOTHING 因此拦不住任何东西。
          1 + ((n - 1) * 7919 + 13 + ((n - 1) / $3::bigint) * 104729) % $3::bigint AS dst,
          n
        FROM generate_series(1, $4::bigint) AS n
      ) e
      WHERE src <> dst
    `,
      [TENANT, nRequirements + nStories + nTasks, nTasks, nBlocked],
    )
    t('blockedBy', started)

    console.log('rebuilding indexes…')
    started = Date.now()
    for (const ddl of BENCH_INDEXES) await client.query(ddl)
    t('indexes', started)

    // 后置断言：索引没建起来的话，后面测的是一张裸表，
    // 而那个数字看起来只会比真实情况更"好"
    const { rows: rebuilt } = await client.query<{ indexname: string }>(`
      SELECT indexname FROM pg_indexes
      WHERE tablename IN ('resources', 'relations') AND indexname NOT LIKE '%_pkey'
    `)
    if (rebuilt.length !== BENCH_INDEXES.length) {
      throw new Error(
        `index rebuild incomplete: expected ${BENCH_INDEXES.length}, found ${rebuilt.length} ` +
          `(${rebuilt.map((r) => r.indexname).join(', ')})`,
      )
    }
    console.log(`  verified ${rebuilt.length} indexes`)

    started = Date.now()
    await client.query('VACUUM ANALYZE resources, relations')
    t('vacuum analyze', started)

    const { rows } = await client.query<{ resources: string; relations: string; size: string }>(`
      SELECT
        (SELECT count(*) FROM resources)::text AS resources,
        (SELECT count(*) FROM relations)::text AS relations,
        pg_size_pretty(pg_database_size(current_database())) AS size
    `)
    const summary = rows[0]
    console.log(
      `\nseeded: ${Number(summary?.resources).toLocaleString()} resources, ` +
        `${Number(summary?.relations).toLocaleString()} relations, db ${summary?.size}`,
    )
  } finally {
    await client.end()
  }
}

const entry = process.argv[1]
if (entry !== undefined && import.meta.url.endsWith(entry.split('/').slice(-2).join('/'))) {
  const url = process.env['BENCH_DATABASE_URL']
  if (url === undefined) {
    console.error('BENCH_DATABASE_URL is not set')
    process.exit(1)
  }
  await seed(url, SCALE_1M)
}
