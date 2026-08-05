import type { Caller, ResourceService } from '../resource/service.ts'
import type { SprintPlan } from './capabilities.ts'

/**
 * 一键应用与撤销一份 Sprint 方案（FR-AI-004 验收标准的后半句）。
 *
 * "一键撤销"是这条需求里真正有分量的部分。没有它，一份候选方案就不是
 * "可以试试的方案"，而是一次**要开会决定**的变更——而要开会决定的东西，
 * 没有人会为了比较两个候选而各试一遍。**撤销的成本决定了尝试的意愿。**
 *
 * 撤销靠一张**明确的清单**（`SprintApplication`），不是靠时间戳或者
 * "把最近 N 条关系删掉"。按时间回滚会连带撤掉别人在这中间做的改动，
 * 而那种错误发生时没有任何提示——你以为你撤销了自己那一步。
 */

export type SprintApplication = {
  sprintId: string
  /** 建出来的关系 id。撤销时逐条删，不猜 */
  relationIds: readonly string[]
  /** 应用时这个 Sprint 是不是刚建出来的。撤销要不要连它一起删，取决于这个 */
  sprintCreated: boolean
  planId: string
}

export type ApplyOptions = {
  /** 排进哪个 Sprint。不给就新建一个 */
  sprintId?: string
  /** 新建时用的属性。`sprintId` 给了就用不上 */
  sprint?: { name: string; startAt: string; endAt: string; goal?: string; capacity?: number }
  workspace: string
  project?: string
}

/**
 * 把方案落成关系。
 *
 * 走普通的 `create` / `relate`：本体校验、权限、审计、事件一个不少。
 * "AI 排的期"和"人排的期"在库里没有区别，只是多了一条 `agent-planned` 标签
 * 说明它是怎么来的。
 */
export async function applyPlan(
  service: ResourceService,
  caller: Caller,
  plan: SprintPlan,
  options: ApplyOptions,
): Promise<SprintApplication> {
  let sprintId = options.sprintId
  let sprintCreated = false

  if (sprintId === undefined) {
    if (options.sprint === undefined) {
      throw new Error('applyPlan needs either an existing sprintId or attributes to create one')
    }
    const created = await service.create(caller, {
      type: 'Sprint',
      workspace: options.workspace,
      ...(options.project === undefined ? {} : { project: options.project }),
      attributes: {
        name: options.sprint.name,
        startAt: options.sprint.startAt,
        endAt: options.sprint.endAt,
        ...(options.sprint.goal === undefined ? {} : { goal: options.sprint.goal }),
        // 容量记在 Sprint 上而不是只留在方案里：**方案是一次性的，
        // Sprint 会活很久**，而"当时按多少容量排的"是事后复盘要问的第一个问题
        capacity: options.sprint.capacity ?? plan.capacity,
      },
      labels: ['agent-planned'],
    })
    sprintId = created.id
    sprintCreated = true
  }

  const relationIds: string[] = []
  try {
    for (const taskId of plan.taskIds) {
      // 不覆写 `origin`：服务层按 caller 自己填，人点的就是 human、
      // Agent 调的就是 `agent:<名字>`。硬写成 'agent' 反而丢掉了是**哪个**
      // Agent 这条信息，而且一份由人点下"应用"的方案，出处本来就是那个人——
      // **方案是排程器给的，决定是人做的。** 方案来自排程器这件事记在
      // Sprint 的 `agent-planned` 标签上
      const relation = await service.relate(caller, {
        type: 'plannedIn',
        fromId: taskId,
        toId: sprintId,
      })
      relationIds.push(relation.id)
    }
  } catch (error) {
    // 半应用是这里最坏的结果：一半任务排进去了，调用方拿到一个异常，
    // 而它手里没有那半截的清单，**撤不掉**。所以先把已经建成的撤干净再抛
    await undoPlan(service, caller, { sprintId, relationIds, sprintCreated, planId: plan.id })
    throw error
  }

  return { sprintId, relationIds, sprintCreated, planId: plan.id }
}

/**
 * 撤销一次应用。
 *
 * **幂等**：重复撤销不报错。撤销按钮被点两下是常事，
 * 而第二下报一个错会让人以为第一下没成功。
 */
export async function undoPlan(
  service: ResourceService,
  caller: Caller,
  applied: SprintApplication,
): Promise<{ removed: number; sprintDeleted: boolean }> {
  let removed = 0
  for (const id of applied.relationIds) {
    try {
      await service.unrelate(caller, id)
      removed++
    } catch {
      // 已经不在了就算撤过了。这里吞掉异常是有意的，
      // 但只吞这一种：下面删 Sprint 的失败不吞
    }
  }

  let sprintDeleted = false
  if (applied.sprintCreated) {
    // 只删**这次应用建出来的** Sprint。排进一个已有 Sprint 的方案，
    // 撤销只该把任务撤出来——把别人的迭代删掉不是撤销，是破坏。
    //
    // 软删除而不是物理删除：这个 Sprint 上已经挂过审计和事件，
    // 而"它曾经存在过"是那些记录能被读懂的前提。
    //
    // 已经删过就当撤过了。**这里必须容错**：`get` 会返回软删除的对象
    // （那是有意的，删掉的东西仍然读得到），但 `softDelete` 走 `requireLive`
    // 会抛。不处理的话第二次点撤销就报错，而报错会让人以为第一次没成功
    //
    // **只吞"已经不在了"这一种失败。** 早先这里是一个大 catch，
    // 什么错都吞——包括权限不足。那意味着撤销失败时调用方拿到的仍然是
    // "撤销成功"，而 Sprint 还在。变异测试逮到了它：把
    // `deletedAt === null` 这个判断改坏，用例照样绿，
    // 因为那个 catch 把重复删除的异常也一起吃了
    const sprint = await tryGet(service, caller, applied.sprintId)
    if (sprint !== null && sprint.deletedAt === null) {
      await service.softDelete(caller, applied.sprintId, sprint.version)
      sprintDeleted = true
    }
  }

  return { removed, sprintDeleted }
}

/** 读不到就是 null。**只用于"它还在不在"这个问题**，不用来掩盖别的失败 */
async function tryGet(
  service: ResourceService,
  caller: Caller,
  id: string,
): Promise<{ version: number; deletedAt: Date | null } | null> {
  try {
    return await service.get(caller, id)
  } catch {
    return null
  }
}
