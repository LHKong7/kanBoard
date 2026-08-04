/**
 * CI 状态回写 Task（FR-CON-006 验收标准的第三段）。
 *
 * 判断和执行分开：这里只回答「**该把 Task 怎么样**」，
 * 真正的迁移走普通的 `service.transition`，于是生命周期守卫、权限、
 * 审计、事件一个不少——**CI 触发的迁移和人点出来的迁移没有区别**。
 *
 * 另开一条"CI 专用的写路径"会省掉几行胶水，代价是那条路径上的守卫
 * 要重新实现一遍，而重新实现的那份迟早会漏。已经在自动化引擎那边
 * 走过一次这个决定了（invokeAgent 就是创建一个普通的 AgentRun）。
 *
 * `CiStatus` 定义在这一层而不是 GitHub 适配器里：**方向要对**。
 * 领域说"我需要一个 CI 结论长这样"，适配器负责把 GitHub 的形状翻译过来；
 * 反过来的话，领域就绑在了 GitHub 的字段名上，接第二个 CI 时才发现。
 */

/**
 * CI 的结论，收敛成三种。
 *
 * GitHub 的 `conclusion` 有九种取值（success / failure / cancelled / timed_out /
 * action_required / neutral / skipped / stale / startup_failure）。原样透出去的话，
 * 每一个消费方都要自己决定 `timed_out` 算不算失败——而它们迟早会决定得不一样。
 *
 * `pending` 是独立的一档，不是"还不算失败"：**在跑**和**跑完了没通过**
 * 是两种完全不同的状态，合并之后回写 Task 就只能等到最后一刻。
 */
export type CiVerdict = 'passing' | 'failing' | 'pending'

export type CiStatus = {
  sha: string
  verdict: CiVerdict
  /** 具体是哪几个 run 失败了。只给一个 'failing' 的话，人还得自己去翻 */
  failing: readonly { name: string; url: string }[]
  total: number
}

/** Task 上记录 CI 结论的属性名。写成常量，读的人和写的人用同一个 */
export const CI_STATUS_ATTR = 'ciStatus'

/**
 * CI 写下的阻塞原因前缀。
 *
 * 它是一个**标记**，不只是给人读的文案：解除阻塞时要靠它判断
 * "这个 Blocked 是不是我造成的"。
 */
export const CI_BLOCK_PREFIX = 'CI 失败：'

/**
 * 一次回写要做的事。
 *
 * ⚠️ `attributes` 是**要改的那几个**，不是完整的属性集。
 * 应用它的代码必须读-改-写：`service.update` 的 attributes 是整体替换
 * 而非合并（那边有说明：合并语义下没法表达"删除一个属性"）。
 * 直接把这里的 attributes 传过去，非必填的属性会被静默抹掉——
 * 必填的会被本体校验拦住，`assignee`、`blockReason` 这些不会。
 *
 * 有 `transition` 时顺序是**先写属性再迁移**：`Blocked` 的守卫要求
 * blockReason 已经在那儿。反过来的话，中间会短暂存在一个
 * "没有原因的阻塞任务"，而守卫的存在就是为了让那个状态不可能出现。
 */
export type CiWriteBack =
  /** 迁移到某状态，并带上这些属性改动 */
  | { kind: 'transition'; to: string; attributes: Record<string, string> }
  /** 状态不动，只更新属性 */
  | { kind: 'annotate'; attributes: Record<string, string> }

/**
 * 哪些状态下 CI 失败应该把任务挡回去。
 *
 * `Todo` 不在里面：还没开工的任务被 CI 弄成 Blocked，看起来像是
 * 有人在上面干了活。`Done` 也不在里面——**CI 不该自己重开一个已完成的任务**。
 * 重开是一次有代价的决定（ADR-0012 把它记成一条显式的边就是这个原因），
 * 而一次 CI 抖动不足以做这个决定。它只被标注，由人来看。
 */
const BLOCKABLE = ['Doing', 'Review', 'Testing']

export type TaskSnapshot = {
  status: string
  /** 当前的阻塞原因。判断"这个 Blocked 是不是 CI 造成的"要用 */
  blockReason?: string | null
}

export function decideWriteBack(status: CiStatus, task: TaskSnapshot): CiWriteBack {
  const attributes: Record<string, string> = { [CI_STATUS_ATTR]: status.verdict }

  if (status.verdict === 'pending') {
    // 在跑就是在跑。把它记下来但不动状态：**"还没结果"不是一种结果**，
    // 而据此改状态会让任务在每次 push 后抖一下
    return { kind: 'annotate', attributes }
  }

  if (status.verdict === 'failing') {
    if (!BLOCKABLE.includes(task.status)) return { kind: 'annotate', attributes }
    // Blocked 状态要求 blockReason（生命周期守卫强制）。
    // CI 恰好知道原因，所以这里把它填进去——**让守卫成立，而不是绕开守卫**。
    // 填不出来时正确的做法是不迁移，不是把守卫放松
    const why = status.failing.map((f) => f.name).join('、')
    return {
      kind: 'transition',
      to: 'Blocked',
      attributes: {
        ...attributes,
        blockReason: `${CI_BLOCK_PREFIX}${why === '' ? status.sha.slice(0, 8) : why}`,
      },
    }
  }

  // 绿了。**不自动推进状态**——CI 通过只说明代码能编译能跑测试，
  // 不说明这个任务做完了。自动推进会让"完成"这个信号变得不可信，
  // 而那是整个看板上最重要的一个信号。
  //
  // 唯一的例外是解除自己造成的阻塞。而"自己造成的"必须**真的查一下**：
  // 一个因为"等第三方接口"而被人挂起的任务，不该因为 CI 变绿就被放回去。
  // 只看状态是 Blocked 就解除，等于让 CI 去推翻一个它读都没读过的决定。
  const blockedByCi =
    task.status === 'Blocked' && (task.blockReason ?? '').startsWith(CI_BLOCK_PREFIX)
  if (blockedByCi) {
    // blockReason 的清空由 Doing 的入口动作负责
    return { kind: 'transition', to: 'Doing', attributes }
  }
  return { kind: 'annotate', attributes }
}
