/**
 * 双向同步与三阶段迁移（FR-CON-007）。
 *
 * 验收标准是「完成 **3 阶段迁移演练，无数据丢失**」。注意它考的不是
 * "能不能连上 Jira"，而是**搬家过程中东西有没有丢**——那是同步引擎的性质，
 * 和源系统是谁无关。所以这一层不认识 Jira，只认识 `SyncSource`。
 *
 * 三个阶段，各自**允许的写方向不同**。写成一张表而不是散在 if 里，
 * 是因为"这个阶段能往哪边写"是这次迁移里最容易搞错、
 * 而搞错了最贵的一件事：
 *
 *   mirror    只读镜像。旧系统是唯一事实来源，这边只看不改。
 *   parallel  并行运行。两边都能改，冲突要**被发现**，不能悄悄合并。
 *   cutover   切换完成。这边是事实来源，旧系统只读。
 *
 * **没有"自动解决冲突"这一档。** 两边都改了同一条记录，就是有人要做决定。
 * 系统能做的是把它准确地摆出来——按时间戳挑一个"赢家"看起来省事，
 * 代价是另一边那次修改**无声地消失**，而这正是"无数据丢失"要防的东西。
 */

export type MigrationPhase = 'mirror' | 'parallel' | 'cutover'

/** 每个阶段允许往哪边写 */
type Directions = { toLocal: boolean; toRemote: boolean }

const ALLOWED: Record<MigrationPhase, Directions> = {
  mirror: { toLocal: true, toRemote: false },
  parallel: { toLocal: true, toRemote: true },
  // 切换之后**不再往旧系统写**。继续双写看起来是"留个后路"，
  // 实际效果是两份数据继续分叉，而且没有人再盯着它们
  cutover: { toLocal: true, toRemote: false },
}

export function allows(phase: MigrationPhase, direction: 'toLocal' | 'toRemote'): boolean {
  return ALLOWED[phase][direction]
}

/**
 * 每个阶段都必须往本地写。
 *
 * `decide` 依赖这条：远端改了就下拉，不再判方向。加一个只读到不写本地的
 * 阶段，会让远端的改动**被静默跳过**——同步跑完不报错，东西却没过来，
 * 正是这个模块要防的那种失败。
 *
 * 写成模块加载期的断言而不是 `decide` 里的一个分支：那个分支永远不成立，
 * 于是它是一条测不到的保证（变异测试确认过——改坏它全部用例照样绿）。
 * 断言在这里的话，真加了那样一个阶段，进程**起不来**，
 * 而不是在某次同步里安静地漏掉几条记录。
 */
for (const [phase, dirs] of Object.entries(ALLOWED)) {
  if (!dirs.toLocal) {
    throw new Error(
      `migration phase "${phase}" does not write to local; decide() assumes every phase does. ` +
        'Handle it explicitly there before adding such a phase.',
    )
  }
}

/**
 * 一条外部记录。**只要求这三样**——
 * 字段名、类型、必填性都由适配器负责翻译成这个形状。
 */
export type ExternalRecord = {
  /** 在源系统里的 id，如 `PROJ-123`。同步的锚点 */
  externalId: string
  /** 翻译后的属性 */
  fields: Record<string, unknown>
  /** 源系统里的最后修改时间 */
  updatedAt: Date
}

/** 本地这一侧的对应物 */
export type LocalRecord = {
  localId: string
  externalId: string | null
  fields: Record<string, unknown>
  updatedAt: Date
}

/**
 * 同步链接：一条记录在两边的对应关系，以及**上次同步时双方长什么样**。
 *
 * 存两个摘要而不是一个时间戳，是因为冲突检测要回答的是
 * "**自上次同步以来，哪一边动过**"。只存时间戳的话，
 * 时钟偏差、批量导入刷新 updatedAt 这类事都会被误判成"改过"，
 * 而误报冲突多了之后，人就会开始无脑点"用远端的"。
 */
export type SyncLink = {
  externalId: string
  localId: string
  /** 上次同步时**远端**内容的摘要 */
  remoteDigest: string
  /** 上次同步时**本地**内容的摘要 */
  localDigest: string
  lastSyncedAt: Date
}

/**
 * 内容摘要。
 *
 * 用排序后的 JSON 而不是对象自身的顺序：`{a:1,b:2}` 和 `{b:2,a:1}`
 * 是同一份数据，但 `JSON.stringify` 给出不同的串，于是每次同步
 * 都会看起来"改过了"。适配器返回的字段顺序不受我们控制。
 */
export function digest(fields: Record<string, unknown>): string {
  return JSON.stringify(fields, Object.keys(fields).sort())
}

export type SyncDecision =
  /** 远端新记录，本地要建 */
  | { kind: 'create-local'; externalId: string; fields: Record<string, unknown> }
  /** 远端改了，本地没改 */
  | { kind: 'update-local'; localId: string; externalId: string; fields: Record<string, unknown> }
  /** 本地改了，远端没改 */
  | { kind: 'update-remote'; localId: string; externalId: string; fields: Record<string, unknown> }
  /** 两边都改了。**不猜**，交给人 */
  | {
      kind: 'conflict'
      localId: string
      externalId: string
      /** 具体哪几个字段对不上。只说"冲突"的话，人得自己逐字段比 */
      fields: readonly string[]
      local: Record<string, unknown>
      remote: Record<string, unknown>
    }
  /** 两边都没动 */
  | { kind: 'noop'; externalId: string }
  /**
   * 本地改了，但当前阶段不允许往远端写。
   *
   * 这一条**不是** noop，必须单独存在：mirror 阶段本地的改动确实
   * 传不回去，但那是一次"被压住的改动"，演练报告里必须看得见。
   * 归进 noop 的话，"镜像阶段有人在这边改了东西"这件事就没人知道了。
   */
  | { kind: 'held'; localId: string; externalId: string; reason: string }

/**
 * 决定一条记录该怎么同步。
 *
 * 纯函数：给定两边的当前状态和上次同步的摘要，结论是确定的。
 * 把它和"去哪儿读、往哪儿写"分开，是因为**冲突判断是这里唯一难的部分**，
 * 而混在 IO 里的判断没法逐种情况测。
 */
export function decide(
  phase: MigrationPhase,
  remote: ExternalRecord,
  local: LocalRecord | null,
  link: SyncLink | null,
): SyncDecision {
  if (local === null || link === null) {
    return { kind: 'create-local', externalId: remote.externalId, fields: remote.fields }
  }

  const remoteChanged = digest(remote.fields) !== link.remoteDigest
  const localChanged = digest(local.fields) !== link.localDigest

  if (!remoteChanged && !localChanged) return { kind: 'noop', externalId: remote.externalId }

  if (remoteChanged && localChanged) {
    const diverged = divergedFields(local.fields, remote.fields)
    if (diverged.length === 0) {
      // 两边都改了，但**改成了同一个样子**。这不是冲突，
      // 判成冲突会让一次批量的同义修改产出几百条要人处理的"冲突"
      return { kind: 'noop', externalId: remote.externalId }
    }
    return {
      kind: 'conflict',
      localId: local.localId,
      externalId: remote.externalId,
      fields: diverged,
      local: local.fields,
      remote: remote.fields,
    }
  }

  if (remoteChanged) {
    // 这里**没有** `allows(phase, 'toLocal')` 的分支，因为三个阶段全都往本地写
    // （见 ALLOWED，以及下面那条模块加载期的断言）。写一个永远不成立的
    // 分支等于给自己一个测不到的保证——变异测试当场抓到了这件事：
    // 把它改坏，全部用例照样绿。
    return {
      kind: 'update-local',
      localId: local.localId,
      externalId: remote.externalId,
      fields: remote.fields,
    }
  }

  // 只有本地改了
  if (!allows(phase, 'toRemote')) {
    return {
      kind: 'held',
      localId: local.localId,
      externalId: remote.externalId,
      reason: `phase "${phase}" does not write back to the source system`,
    }
  }
  return {
    kind: 'update-remote',
    localId: local.localId,
    externalId: remote.externalId,
    fields: local.fields,
  }
}

/** 哪些字段两边的值不一样 */
function divergedFields(
  local: Record<string, unknown>,
  remote: Record<string, unknown>,
): string[] {
  const keys = new Set([...Object.keys(local), ...Object.keys(remote)])
  const out: string[] = []
  for (const key of keys) {
    if (JSON.stringify(local[key]) !== JSON.stringify(remote[key])) out.push(key)
  }
  return out.sort()
}

// ── 对账：证明没丢东西 ────────────────────────────────────────

/**
 * 对账报告（FR-CON-007 的「无数据丢失」）。
 *
 * "无数据丢失"不能靠"同步跑完没报错"来证明——**同步过程本身有 bug 时，
 * 它同样不会报错**。所以对账是独立的一遍：不看同步日志，
 * 只看两边现在各有什么。
 */
export type Reconciliation = {
  /** 源系统有、这边没有。**这就是丢数据** */
  missing: readonly string[]
  /** 这边有、源系统没有。可能是本地新建的，也可能是源那边删了 */
  extra: readonly string[]
  /** 两边都有但内容对不上 */
  diverged: readonly { externalId: string; fields: readonly string[] }[]
  matched: number
  /** 只有三者都为空才算干净。**这个字段不是算出来给人看的，是判据** */
  clean: boolean
}

export function reconcile(
  remotes: readonly ExternalRecord[],
  locals: readonly LocalRecord[],
): Reconciliation {
  const byExternal = new Map<string, LocalRecord>()
  const localOnly: string[] = []
  for (const local of locals) {
    if (local.externalId === null) {
      localOnly.push(local.localId)
      continue
    }
    byExternal.set(local.externalId, local)
  }

  const missing: string[] = []
  const diverged: { externalId: string; fields: readonly string[] }[] = []
  let matched = 0

  const seen = new Set<string>()
  for (const remote of remotes) {
    seen.add(remote.externalId)
    const local = byExternal.get(remote.externalId)
    if (local === undefined) {
      missing.push(remote.externalId)
      continue
    }
    const fields = divergedFields(local.fields, remote.fields)
    if (fields.length > 0) diverged.push({ externalId: remote.externalId, fields })
    else matched++
  }

  // 本地有 externalId 但源系统里已经没有了。**不当作丢失**——
  // 那是源那边删的，而删除是一次决定，不是一次丢失。
  // 但也不能不报：一次误删在这里是唯一还能被发现的地方
  const extra = [...localOnly, ...[...byExternal.keys()].filter((id) => !seen.has(id))]

  return {
    missing,
    extra,
    diverged,
    matched,
    clean: missing.length === 0 && diverged.length === 0,
  }
}
