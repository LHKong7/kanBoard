import {
  acceptanceCoverage,
  actionableItems,
  markUnverified,
  verifyMarking,
} from './capabilities.ts'
import type { AcceptanceRef, ActionItem, Claim, Verdict } from './capabilities.ts'
import { DomainError } from '../../platform/errors.ts'
import type { Caller, ResourceService } from '../resource/service.ts'

/**
 * 三条"AI 产出要落成对象"的路径（FR-AI-002 / 007 / 010）。
 *
 * 它们的验收标准都是**机制**，不是模型输出的质量：
 *
 *   FR-AI-002  拆出来的 Story 要覆盖父需求的验收标准 ≥ 95%，未覆盖项列出
 *   FR-AI-007  写出来的文档里，没有出处的陈述必须被标注为"待确认"
 *   FR-AI-010  会议纪要里的行动项要能一键变成 Task，并关联负责人
 *
 * 所以它们和 FR-AI-001 是同一类，验证方式也一样：模型用
 * `ScriptedModelClient` 顶替，**被验的是机制**——生成的内容好不好
 * 是另一个问题，而且是一个这一层管不了的问题。
 *
 * 这一层做的是同一件事：**在落库之前把闸设好，并且把不合格的部分
 * 逐条说出来。** 三条路径都走普通的 `service.create`，
 * 于是本体校验、权限、审计、事件一个不少——
 * AI 产出的对象和人建的对象没有区别。
 */

// ── FR-AI-002：拆 Story ──────────────────────────────────────

export type SplitCandidate = {
  title: string
  /** 作为<角色>、我希望<能力>、以便<价值> */
  role?: string
  capability?: string
  value?: string
}

export type SplitOutcome = {
  /** 真的建出来的 Story id。**不达标时是空的** */
  storyIds: readonly string[]
  coverage: Verdict & { rate: number }
  /** 没被覆盖的验收标准。验收标准原文要求"显式列出" */
  uncovered: readonly string[]
}

/**
 * 把一个需求拆成 Story，**先验覆盖率再落库**。
 *
 * 顺序是刻意的：先建后验的话，覆盖率不达标时库里已经有了一批半成品，
 * 而清理它们要么靠人、要么靠一段"回滚"代码——而回滚代码的失败
 * 恰恰发生在最不该失败的时候。
 *
 * 不达标就**一条都不建**，并把漏掉的验收标准列出来。
 * 建一半再说"覆盖率只有 60%"，等于把这堆残留物留给了使用者。
 */
export async function splitIntoStories(
  service: ResourceService,
  caller: Caller,
  input: {
    requirementId: string
    acceptances: readonly AcceptanceRef[]
    candidates: readonly SplitCandidate[]
    workspace: string
    project?: string
  },
): Promise<SplitOutcome> {
  const texts = input.candidates.map(
    (c) => `${c.title} ${c.role ?? ''} ${c.capability ?? ''} ${c.value ?? ''}`,
  )
  const coverage = acceptanceCoverage(input.acceptances, texts)

  if (!coverage.ok) {
    return { storyIds: [], coverage, uncovered: coverage.offenders }
  }

  const storyIds: string[] = []
  for (const candidate of input.candidates) {
    const story = await service.create(caller, {
      type: 'Story',
      workspace: input.workspace,
      ...(input.project === undefined ? {} : { project: input.project }),
      attributes: {
        title: candidate.title,
        ...(candidate.role === undefined ? {} : { role: candidate.role }),
        ...(candidate.capability === undefined ? {} : { capability: candidate.capability }),
        ...(candidate.value === undefined ? {} : { value: candidate.value }),
      },
      labels: ['agent-generated'],
    })
    // 挂回父需求。不挂的话，拆出来的 Story 和它们的来源就断了，
    // 而"这个需求拆成了什么"是评审时问的第一个问题。
    //
    // 用 `implements`（Story → Requirement）而不是 `partOf`——
    // 后者是 Task → Story。**两条边不是一回事**：一个 Story
    // 实现某个需求，一个 Task 是某个 Story 的一部分
    await service.relate(caller, {
      type: 'implements',
      fromId: story.id,
      toId: input.requirementId,
    })
    storyIds.push(story.id)
  }

  return { storyIds, coverage, uncovered: [] }
}

// ── FR-AI-007：写文档，事实带出处 ────────────────────────────

export type DraftOutcome = {
  knowledgeId: string
  /** 成文。没有出处的句子都带着标记 */
  body: string
  unverified: number
  verdict: Verdict
}

/**
 * 把一组陈述写成一份文档，**没有出处的标注为"待确认"**。
 *
 * 落库前复查一遍（`verifyMarking`），而不是只信渲染那一步：
 * 渲染和校验是两段代码，而"标注"这件事只有在成文里真的带着标记
 * 才算数。只在生成时打标记、不复查的话，将来改渲染的人
 * 会在毫不知情的情况下把这条需求废掉。
 */
export async function draftWithProvenance(
  service: ResourceService,
  caller: Caller,
  input: { title: string; claims: readonly Claim[]; workspace: string; project?: string },
): Promise<DraftOutcome> {
  const { text, unverified } = markUnverified(input.claims)
  const verdict = verifyMarking(input.claims, text)
  if (!verdict.ok) {
    // **老实说：现在没有任何用例能让这一条抛出来**（变异测试确认过——
    // 改成 `if (false)` 全部用例照样绿）。markUnverified 刚刚才打完标记，
    // verifyMarking 当然找得到。
    //
    // 留着是因为这两段代码会各自演化：改渲染的人不会想到自己在动
    // FR-AI-007。它们一旦对不上，表现是"文档里有几句没有标记"——
    // 一种没人会注意到的失败，而这正是这条需求要防的那件事
    throw new DomainError('validation_failed', 'unsourced claims were not marked', 422, {
      offenders: verdict.offenders,
    })
  }

  const knowledge = await service.create(caller, {
    type: 'Knowledge',
    workspace: input.workspace,
    ...(input.project === undefined ? {} : { project: input.project }),
    attributes: { title: input.title, body: text },
    labels: ['agent-generated'],
  })

  // 有出处的陈述，出处要建成关系——**Knowledge 想进 Published
  // 本来就要求 derivedFrom**（FR-DOM-008）。在这里建好，
  // 是让这份文档从一开始就满足系统自己的不变量
  const sources = new Set(input.claims.flatMap((c) => [...c.sourceIds]))
  for (const sourceId of sources) {
    await service.relate(caller, { type: 'derivedFrom', fromId: knowledge.id, toId: sourceId })
  }

  return { knowledgeId: knowledge.id, body: text, unverified, verdict }
}

// ── FR-AI-010：会议纪要里的行动项 ────────────────────────────

export type MeetingOutcome = {
  /** 建出来的 Task id */
  taskIds: readonly string[]
  /** 没有负责人、因此没有建的那些。**要还给使用者，不是丢掉** */
  skipped: readonly string[]
  verdict: Verdict
}

/**
 * 把会议纪要里的行动项一键变成 Task。
 *
 * 没有负责人的不建——**"我们应该做 X" 不是行动项，是一句感想**。
 * 但它们要被**还回去**而不是丢掉：那句话在会上是有人说过的，
 * 使用者可能只是想补一个负责人。悄悄扔掉的话，
 * 他会以为系统没听见。
 */
export async function createActionItems(
  service: ResourceService,
  caller: Caller,
  input: { items: readonly ActionItem[]; workspace: string; project?: string; meetingRef?: string },
): Promise<MeetingOutcome> {
  const { actionable, verdict } = actionableItems(input.items)

  const taskIds: string[] = []
  for (const item of actionable) {
    const task = await service.create(caller, {
      type: 'Task',
      workspace: input.workspace,
      ...(input.project === undefined ? {} : { project: input.project }),
      attributes: {
        title: item.text,
        // 负责人是一键创建的**条件**，不是可选项。
        // 这里能直接写，是因为上面那道闸已经保证它非空
        assignee: item.assignee ?? '',
        ...(input.meetingRef === undefined ? {} : { description: `来自会议 ${input.meetingRef}` }),
      },
      labels: ['agent-generated', 'from-meeting'],
    })
    taskIds.push(task.id)
  }

  return { taskIds, skipped: verdict.offenders, verdict }
}
