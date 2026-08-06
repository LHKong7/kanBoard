import { OntologyRegistry } from './registry.ts'
import type { EntityTypeDef, RelationTypeDef } from './types.ts'

/**
 * 默认本体包。
 *
 * 存在的理由是风险 R1（本体建模成本高，团队难以上手）：
 * 开箱即用的一套类型，让团队可以先用起来，再按需扩展。
 *
 * 注意：这里没有 `status` 属性——生命周期状态在 Resource 头部字段中，
 * 由 Workflow Engine 管理（M1）。在 attributes 里再放一个 status 会造成双写。
 */

/**
 * 可以被评论的类型。
 *
 * 列出来而不是"除了几个之外都行"：白名单会随着新类型加入被**重新审视一次**，
 * 黑名单只会让新类型默认可评论，而没有人做过那个决定。
 */
const COMMENTABLE: readonly string[] = [
  'Project',
  'Requirement',
  'Story',
  'Task',
  'Decision',
  'Knowledge',
  'Risk',
  'Release',
  'Milestone',
  'Sprint',
  // 模块和意见收集都是要讨论的地方：一条待分诊的意见最需要的
  // 恰恰是"这个要不要做"的那段对话
  'Module',
  'Intake',
]

/**
 * 工作项优先级。Story 与 Task 共用一份定义。
 *
 * 五档带一个显式的 `None`，而不是"不填即无优先级"。区别在于
 * **"还没定"和"定了，不紧急"是两回事**：前者是待办事项（有人得去判断），
 * 后者是已完成的判断。合成一个空值之后，"有多少条还没定优先级"
 * 这个问题就再也问不出来了。
 *
 * 与 `Requirement.priority`（MoSCoW：Must/Should/Could/Wont）刻意不同。
 * 那一档回答的是"这个需求要不要做"，这一档回答的是"这件事什么时候做"——
 * 同一个词、两个问题，强行统一只会让两边都变得说不清。
 */
const WORK_ITEM_PRIORITY = {
  name: 'priority',
  kind: 'enum',
  values: ['Urgent', 'High', 'Medium', 'Low', 'None'],
  description: '优先级。Urgent + High 占比超过 40% 时这个字段就已经失效了',
} as const

/**
 * 估点类别到点数的固定映射（project-management-guide §2.5）。
 *
 * 类别制式下人选的是 `S`，落库的是 `2`。映射写死在这里而不是让每个项目
 * 自己配：可配的话，两个项目的 `M` 就不是同一个 `M`，跨项目的速率对比
 * 立刻失去意义——而那正是工作区级分析最想回答的问题。
 *
 * 数值取斐波那契前几项，于是**换制式不用换数据**：
 * 从类别切到点数的那天，历史速率曲线原样接得上。
 */
export const ESTIMATE_CATEGORY_POINTS: Readonly<Record<string, number>> = {
  XS: 1,
  S: 2,
  M: 3,
  L: 5,
  XL: 8,
}

/** 点数制式的可选值（斐波那契）。表单上用它渲染下拉，避免有人填 4 或 7 */
export const ESTIMATE_POINT_SCALE: readonly number[] = [1, 2, 3, 5, 8, 13]

export const DEFAULT_ENTITY_TYPES: readonly EntityTypeDef[] = [
  {
    name: 'Project',
    // 1.2 → 1.3：新增三个可选属性（估点制式 + 两条自动化配置）
    version: '1.3.0',
    context: 'Project',
    lifecycle: 'project-default',
    description: '项目：目标、里程碑、预算与风险的聚合根',
    attributes: [
      { name: 'key', kind: 'string', required: true, description: '同 Workspace 下唯一' },
      { name: 'name', kind: 'string', required: true },
      { name: 'vision', kind: 'text' },
      { name: 'ownerTeam', kind: 'string' },
      /**
       * 估点制式：类别（XS/S/M/L/XL）还是点数（斐波那契）。
       *
       * **只影响怎么录入和怎么显示，不影响存的是什么**——两种制式都落到
       * 同一个数值字段（Story.storyPoint / Task.estimate）。
       *
       * 这是个有意的取舍。给两种制式各开一个字段，切换制式那天
       * 历史数据就断在那里：速率曲线会从切换点起归零，而团队恰恰是
       * 「跑三四个周期建立基线之后」才切的——那正是最不该丢历史的时刻。
       * 类别到数值的映射是固定的（见 ESTIMATE_CATEGORY_POINTS），
       * 所以换制式只是换一副刻度，底下的数一个都没动。
       */
      {
        name: 'estimateSystem',
        kind: 'enum',
        values: ['categories', 'points'],
        description: '估点制式。不填按 points 处理',
      },
      /**
       * 自动归档 / 自动关闭（Plane 的 Automations）。
       *
       * 单位是月，取值 1–12，不填就是不开。做成项目级属性而不是全局配置：
       * 一个支持型团队和一个平台团队对"多久算僵尸需求"的判断差得很远。
       *
       * 不开启的后果不是"没有自动化"，是 Backlog 半年后变成垃圾场
       * （见 project-management-guide 的反模式表）。所以两个字段都带
       * 建议值写进 description，让人在表单上就看得到。
       */
      {
        name: 'archiveInMonths',
        kind: 'int',
        description: '已完成的工作项多少个月无更新后自动归档。建议 1–2，不填不开启',
      },
      {
        name: 'closeInMonths',
        kind: 'int',
        description: '未完成的工作项多少个月无活动后自动关闭。建议 3，不填不开启',
      },
      // 以下由状态机的 entry action 写入（04-ontology：新增可选属性 = minor 版本）
      { name: 'startedAt', kind: 'datetime', derived: true },
      { name: 'completedAt', kind: 'datetime', derived: true },
    ],
  },
  {
    name: 'Requirement',
    version: '1.2.0',
    context: 'Requirement',
    lifecycle: 'requirement-default',
    description: '需求：Epic / Feature / Story 三级',
    attributes: [
      { name: 'title', kind: 'string', required: true },
      { name: 'level', kind: 'enum', values: ['Epic', 'Feature', 'Story'], required: true },
      { name: 'statement', kind: 'richtext', required: true },
      {
        name: 'source',
        kind: 'enum',
        values: ['customer', 'internal', 'incident', 'ai-proposed'],
      },
      { name: 'priority', kind: 'enum', values: ['Must', 'Should', 'Could', 'Wont'] },
      { name: 'approvedAt', kind: 'datetime', derived: true, description: '由状态机进入 Approved 时写入' },
    ],
  },
  {
    name: 'Story',
    // 1.3 → 1.4：新增一个可选属性（priority）。按 FR-ONT-007 的口径是 minor
    version: '1.4.0',
    context: 'Requirement',
    lifecycle: 'story-default',
    description: '可独立交付的最小需求单元',
    attributes: [
      { name: 'title', kind: 'string', required: true },
      { name: 'role', kind: 'string', description: '作为 <角色>' },
      { name: 'capability', kind: 'text', description: '我希望 <能力>' },
      { name: 'value', kind: 'text', description: '以便 <价值>' },
      { ...WORK_ITEM_PRIORITY },
      { name: 'storyPoint', kind: 'int' },
      /**
       * 计划的起止日期（不是状态机写的那两个实际时刻）。
       *
       * 和 `startedAt` / `completedAt` 分得很开，因为它们回答的不是同一件事：
       * 计划日期是**人许下的承诺**，实际时刻是**系统观察到的事实**。
       * 混成一对的话，"这条延期了吗"就永远问不出来——延期正是两者之差。
       *
       * 两个都可选：只填 dueDate 就是一个截止日（日历上看得到），
       * 两个都填才排得进甘特。逼着必填只会让人随手填一个日期，
       * 而随手填的日期比没有日期更糟——它看起来像个承诺。
       */
      { name: 'startDate', kind: 'datetime', description: '计划开始日' },
      { name: 'dueDate', kind: 'datetime', description: '计划完成日（承诺，不是实际）' },
      { name: 'estimateRationale', kind: 'text', description: '估点依据，AI 估点时必填' },
      { name: 'startedAt', kind: 'datetime', derived: true },
      { name: 'completedAt', kind: 'datetime', derived: true },
    ],
  },
  {
    name: 'Task',
    // 同上：新增可选属性 = minor
    version: '1.4.0',
    context: 'Execution',
    lifecycle: 'task-default',
    description: '执行单元。assignee 可以是 User 也可以是 Agent',
    attributes: [
      { name: 'title', kind: 'string', required: true },
      { name: 'description', kind: 'text' },
      { name: 'assignee', kind: 'string', description: 'user://… 或 agent://…' },
      { ...WORK_ITEM_PRIORITY },
      { name: 'estimate', kind: 'float' },
      { name: 'blockReason', kind: 'text', description: '进入 Blocked 状态时必填' },
      /**
       * 计划的起止日期（不是状态机写的那两个实际时刻）。
       *
       * 和 `startedAt` / `completedAt` 分得很开，因为它们回答的不是同一件事：
       * 计划日期是**人许下的承诺**，实际时刻是**系统观察到的事实**。
       * 混成一对的话，"这条延期了吗"就永远问不出来——延期正是两者之差。
       *
       * 两个都可选：只填 dueDate 就是一个截止日（日历上看得到），
       * 两个都填才排得进甘特。逼着必填只会让人随手填一个日期，
       * 而随手填的日期比没有日期更糟——它看起来像个承诺。
       */
      { name: 'startDate', kind: 'datetime', description: '计划开始日' },
      { name: 'dueDate', kind: 'datetime', description: '计划完成日（承诺，不是实际）' },
      {
        name: 'ciStatus',
        kind: 'enum',
        // 三档，和 CiVerdict 一一对应（src/domain/execution/ci.ts）。
        // 用 enum 而不是 string：GitHub 的九种结论收敛成三种是一次**决定**，
        // 让它在本体里也是三种，别处就没法悄悄多写一个值进来
        values: ['passing', 'failing', 'pending'],
        // 由 CI 回写，不该出现在人填的表单里。
        // 让人手填的话，这个字段说的就不再是 CI 说过什么了——
        // 而它唯一的用处就是转述 CI 说过什么
        derived: true,
        description: 'CI 结论（FR-CON-006 回写）',
      },
      { name: 'startedAt', kind: 'datetime', derived: true },
      { name: 'completedAt', kind: 'datetime', derived: true },
    ],
  },
  {
    name: 'Decision',
    version: '1.2.0',
    context: 'Knowledge',
    lifecycle: 'decision-default',
    description: '决策 / ADR：解释"为什么这样做"',
    attributes: [
      { name: 'question', kind: 'string', required: true },
      { name: 'chosen', kind: 'text', required: true },
      { name: 'rationale', kind: 'text', required: true },
      { name: 'consequences', kind: 'text' },
      { name: 'acceptedAt', kind: 'datetime', derived: true },
    ],
  },
  {
    name: 'Knowledge',
    version: '1.2.0',
    context: 'Knowledge',
    lifecycle: 'knowledge-default',
    description: '知识：必须有来源（derivedFrom），否则不可信',
    attributes: [
      { name: 'title', kind: 'string', required: true },
      { name: 'body', kind: 'richtext', required: true },
      { name: 'confidence', kind: 'percent' },
      { name: 'validUntil', kind: 'datetime', description: '到期后进入待复核，避免知识腐化' },
      { name: 'publishedAt', kind: 'datetime', derived: true },
    ],
  },
  {
    name: 'AgentRun',
    version: '1.0.0',
    context: 'AI',
    lifecycle: 'agentrun-default',
    description:
      '一次 Agent 执行（FR-AGT-007）。它是**领域对象**而不是后台任务记录：' +
      '既然要能被授权、被审计、被回放，就该和别的对象走同一条 API 与同一套权限。',
    attributes: [
      { name: 'goal', kind: 'text', required: true, description: '这次要达成什么' },
      {
        name: 'agent',
        kind: 'ref',
        target: 'Agent',
        required: true,
        description: '哪个 Agent 执行；它的 principal 决定这次 Run 的身份',
      },
      {
        name: 'subject',
        kind: 'ref',
        description: '这次 Run 围绕哪个对象展开，Context 从它开始沿图装配（FR-AGT-004）',
      },
      {
        name: 'mode',
        kind: 'enum',
        values: ['Suggest', 'Draft', 'ExecuteWithReview', 'Autonomous'],
        required: true,
        description: '人机协作模式（FR-AGT-009）。不可逆操作无论哪种模式都要人工确认',
      },
      { name: 'trigger', kind: 'enum', values: ['human', 'event', 'schedule', 'agent'], required: true },
      // 预算是**输入**不是统计：写在 Run 上，执行时按它熔断（FR-AGT-012）
      { name: 'maxTokens', kind: 'int', description: '本次 Run 的 token 上限；缺省用 Agent 定义里的值' },
      { name: 'maxSteps', kind: 'int', description: '本次 Run 的步数上限，防止推理循环' },
      { name: 'tokensUsed', kind: 'int', derived: true },
      { name: 'costUsd', kind: 'float', derived: true },
      { name: 'stepCount', kind: 'int', derived: true },
      { name: 'outcome', kind: 'text', derived: true, description: '终止原因：完成、超预算、被拒、出错' },
      { name: 'startedAt', kind: 'datetime', derived: true },
      { name: 'finishedAt', kind: 'datetime', derived: true },
      // 时长在结算时算好存下来（FR-DASH-003 的 Latency）。
      // 让指标层去减两个时间戳的话，那一层就得会解析日期、
      // 处理缺失值、定义"还没结束算多久"——而它只该会做查询
      { name: 'durationMs', kind: 'int', derived: true, description: '本次 Run 的耗时' },
    ],
  },
  {
    name: 'Agent',
    version: '1.2.0',
    context: 'AI',
    lifecycle: 'agent-default',
    description:
      'Agent 是一等身份主体，同样是领域对象（ADR-0003）。' +
      '它的行为由**声明**决定而不是由代码分支决定（FR-AGT-001/002）：' +
      '运行时读下面这些属性，并不知道自己在跑哪个 Agent。',
    attributes: [
      { name: 'name', kind: 'string', required: true },
      { name: 'principal', kind: 'string', required: true, description: 'agent://<name>@<version>' },
      { name: 'ownerTeam', kind: 'string' },
      { name: 'capabilities', kind: 'json', description: '显式授予的 Capability 列表；默认为空' },
      { name: 'system', kind: 'text', description: '角色设定与规则，送给模型的 system 段' },
      {
        name: 'tier',
        kind: 'enum',
        values: ['tier-low', 'tier-mid', 'tier-high'],
        description: '模型档位（FR-AGT-013）。换供应商只改这里，领域层不认识具体厂商',
      },
      {
        name: 'mode',
        kind: 'enum',
        values: ['Suggest', 'Draft', 'ExecuteWithReview', 'Autonomous'],
        description: '默认协作模式；单次 Run 可以覆盖它（FR-AGT-009）',
      },
      {
        name: 'contextRelations',
        kind: 'json',
        description: 'Context 从 subject 出发沿哪些关系装配（FR-AGT-004）',
      },
      {
        name: 'mayPropose',
        kind: 'json',
        description:
          '允许提议写回的类型清单。**空表示只能给建议**——' +
          '能写什么由声明决定，不由模型的输出决定',
      },
      { name: 'maxTokensPerRun', kind: 'int', description: '单次 Run 的 token 上限（FR-AGT-012）' },
    ],
  },
  {
    name: 'Notification',
    version: '1.0.0',
    // 归到 Execution：通知在这个系统里全部由工作发生的事情引发
    // （自动化、SLA 超时）。它不完美——通知本质上是跨上下文的平台关注点——
    // 但 PRD 的 7 个 BC 是固定的，硬加第 8 个比放错一个更糟
    context: 'Execution',
    lifecycle: 'notification-default',
    description:
      '一条站内通知（FR-WF-005 的 notify 动作）。' +
      '做成领域对象而不是一张旁路表：这样它天然受租户隔离与资源级权限约束，' +
      '能被查询、被下钻、被审计——而不是变成一条发出去就无人知晓的消息。' +
      'IM 与邮件属于 Connector 层，这里只负责站内这一路。',
    attributes: [
      { name: 'title', kind: 'string', required: true },
      { name: 'body', kind: 'text' },
      { name: 'recipient', kind: 'string', required: true, description: 'user:// 或 agent:// 主体' },
      { name: 'about', kind: 'ref', description: '这条通知在说哪个对象' },
      {
        name: 'severity',
        kind: 'enum',
        values: ['info', 'warning', 'critical'],
        description: '决定它在收件箱里排在哪儿；不影响送达',
      },
      { name: 'readAt', kind: 'datetime', derived: true },
    ],
  },
  {
    name: 'Comment',
    // 1.0 → 1.1：新增一个可选属性（audience）
    version: '1.1.0',
    context: 'Execution',
    /**
     * **刻意没有 lifecycle。**
     *
     * 一条评论没有状态可言——它被说出来了，就这样。硬安一个
     * `Open → Resolved` 的状态机，会让"回复了没有"变成一件要有人去点的事，
     * 而实际上没人会去点，于是这个字段永远停在初值，看起来像所有评论都没解决。
     *
     * 副作用正好是想要的：看板标签页只列有生命周期的类型
     * （`public/app.js` 的 `boardable`），所以评论不会自己长出一个看板。
     */
    description:
      '一条评论（协作的最小闭环）。做成领域对象而不是挂在资源上的一个数组：' +
      '于是它天然受租户隔离与资源级权限约束，能被查询、被审计、被 Agent 当作上下文读到。' +
      '被 @ 到的人由正文解析得出（src/domain/collaboration/mentions.ts），' +
      '不另存一份清单——两份会漂移，而正文是唯一改得动的那份。',
    attributes: [
      { name: 'body', kind: 'richtext', required: true },
      /**
       * 这条评论说给谁听（project-management-guide §6）。
       *
       * 名字是 `audience` 而不是 `visibility`：Resource 头部已经有一个
       * `visibility`（private / project / workspace / tenant），说的是
       * **谁能读到这条记录**。这个字段说的是**这段话是对内还是对外**——
       * 两件事都叫 visibility 的话，"把评论设成 external"到底放宽了
       * 数据库层的可见性还是只是打了个标记，没人说得清。
       *
       * 默认按 internal 处理（不填即内部）：把没标过的历史评论当成对外，
       * 是这个字段唯一不可挽回的错法。
       */
      {
        name: 'audience',
        kind: 'enum',
        values: ['internal', 'external'],
        description: '对内讨论还是对外回复。不填按 internal 处理',
      },
    ],
  },
  /**
   * ── 项目管理骨架 ─────────────────────────────────────
   *
   * 对照 docs/0806planeFeatures/project-management-guide.md 的第一节：
   * **Cycle（时间）与 Module（范围）是两个正交的维度**。
   * 系统里此前只有 Sprint（时间维度），于是"这个功能做完了吗"
   * 这个问题无处可问——那正是那份指南列为反模式的第三条。
   */
  {
    name: 'Module',
    version: '1.0.0',
    context: 'Project',
    lifecycle: 'module-default',
    description:
      '模块：交付物 / 里程碑式的**范围**维度，与周期（时间维度）正交。' +
      '一个工作项同时属于「本周期」和「登录模块」才是正确用法——' +
      '只用一个维度，看板就退化成了普通待办列表。' +
      '与 Milestone 的区别是它装得下工作项并自带进度，Milestone 只是一个日期上的点。',
    attributes: [
      { name: 'name', kind: 'string', required: true },
      { name: 'description', kind: 'text' },
      { name: 'lead', kind: 'string', description: '模块负责人 user://…' },
      { name: 'startDate', kind: 'datetime', description: '计划开始日' },
      { name: 'targetDate', kind: 'datetime', description: '目标交付日' },
      { name: 'startedAt', kind: 'datetime', derived: true },
      { name: 'completedAt', kind: 'datetime', derived: true },
    ],
  },
  {
    name: 'Label',
    version: '1.0.0',
    context: 'Project',
    /**
     * **刻意没有 lifecycle**：一个标签没有状态可言。
     *
     * 也刻意**不是**工作项与标签之间的一条边。资源头部已经有
     * `labels: string[]`，筛选、导出、分组全都走它。再引一套关系来表达
     * "打了哪个标签"，同一件事就有了两个真相，而它们一定会漂移。
     *
     * 所以这个类型是**目录**：它给标签名配上颜色和说明，让
     * "这个标签是什么意思"有一个可查的地方。名字本身仍是那个唯一的键。
     */
    description:
      '标签目录：给标签名配颜色与说明。**不承载"谁打了这个标签"**——' +
      '那是资源头部的 labels 字段。分组用前缀命名法（type/ area/ flag/），' +
      '前缀从名字里读出来，不另存一份（见 labelGroupOf）。',
    attributes: [
      {
        name: 'name',
        kind: 'string',
        required: true,
        description: '标签名。建议 `前缀/名字`，如 type/bug、area/frontend',
      },
      { name: 'color', kind: 'string', description: '十六进制色值，如 #E76E50' },
      { name: 'description', kind: 'text', description: '什么时候该用这个标签' },
    ],
  },
  {
    name: 'Intake',
    version: '1.0.0',
    context: 'Project',
    lifecycle: 'intake-default',
    description:
      '意见收集队列里的一条（Plane 的 Intake / 原 Inbox）。' +
      '外部或内部提上来的东西先进这里等分诊，**不直接变成工作项**——' +
      '让任何人都能直接建工作项，Backlog 会在两周内失去可信度。' +
      '接受时必须真的产生一个工作项（见 intake-default 上的守卫），' +
      '否则"已接受"就只是一句安慰话。',
    attributes: [
      { name: 'title', kind: 'string', required: true },
      { name: 'body', kind: 'richtext', description: '提交内容' },
      {
        name: 'submittedBy',
        kind: 'string',
        // 分级为 pii：外部提交人的联系方式不该随上下文进模型（ADR-0006）
        classification: 'pii',
        description: '谁提的。外部提交时可能是邮箱',
      },
      {
        name: 'source',
        kind: 'enum',
        values: ['web', 'email', 'api', 'internal'],
        description: '从哪个渠道进来的',
      },
      {
        name: 'snoozedUntil',
        kind: 'datetime',
        description: '延后到哪天。进入 Snoozed 必填——无限期延后等于没有回复',
      },
    ],
  },
  {
    name: 'Sticky',
    version: '1.0.0',
    context: 'Knowledge',
    /**
     * **刻意没有 lifecycle、没有 assignee、没有 dueDate。**
     *
     * 便签就该是一张便签。给它加上状态和负责人之后，它会变成一个
     * 绕过工作项、绕过守卫、绕过审计的第二套任务系统——
     * 而那套系统里的东西不进任何统计，团队却以为它们被跟踪着。
     */
    description:
      '工作区级的便签：待办速记、临时链接、本周关注点。' +
      '**不要拿它当任务系统**——它没有状态、指派人和截止日期，这是有意的。',
    attributes: [
      { name: 'body', kind: 'richtext', required: true },
      { name: 'color', kind: 'string', description: '背景色，十六进制' },
      { name: 'sortOrder', kind: 'int', description: '手动排序用' },
    ],
  },
  /**
   * ── 企业级对象 ───────────────────────────────────────
   *
   * 对照 Plane 的付费档（docs/research/plane-enterprise-features.md）。
   * 值得记一笔的是**它们在这里有多便宜**：统一 Resource 模型（ADR-0002）
   * 意味着写进本体就自带 CRUD、查询、权限、审计、历史与图关系——
   * 不需要新端点、不需要迁移、不需要另一套权限。
   *
   * 换句话说，Plane 拿去分档卖的这些东西，在这套地基上主要是**声明**，
   * 不是代码。这正是当初把本体做成元模型想换的东西。
   */
  {
    name: 'Teamspace',
    version: '1.0.0',
    context: 'Project',
    // 没有 lifecycle：团队空间不是一个会流转的东西。
    // 要停用一个团队，停用的是它的成员关系，不是给它安一个 Archived 状态
    description:
      '团队空间：跨项目的人的集合（Plane business 档）。' +
      '它回答"这些项目归谁管"，而项目本身回答"要做什么"。',
    attributes: [
      { name: 'name', kind: 'string', required: true },
      { name: 'mission', kind: 'text', description: '这个团队负责什么' },
      { name: 'lead', kind: 'string', description: 'user://… 团队负责人' },
    ],
  },
  {
    name: 'Initiative',
    version: '1.0.0',
    context: 'Project',
    lifecycle: 'initiative-default',
    description:
      '举措：**跨项目**的目标（Plane pro 档）。' +
      '比 Project 高一层——一件事要动三个项目才做得成时，它是那个"一件事"。',
    attributes: [
      { name: 'name', kind: 'string', required: true },
      { name: 'objective', kind: 'text', required: true, description: '要达成什么' },
      { name: 'startDate', kind: 'datetime' },
      { name: 'dueDate', kind: 'datetime' },
      {
        name: 'health',
        kind: 'enum',
        values: ['OnTrack', 'AtRisk', 'OffTrack'],
        description: '人判断的健康度。刻意不自动算——自动算出来的绿灯没人信',
      },
    ],
  },
  {
    name: 'Template',
    version: '1.0.0',
    context: 'Project',
    // 模板没有状态：它要么在那儿要么不在
    description:
      '模板：预填好的一份属性，套用时生成目标对象（Plane pro / business 档）。' +
      '存的是 draft 而不是"生成器"——一个能执行的模板等于在配置里嵌了代码。',
    attributes: [
      { name: 'name', kind: 'string', required: true },
      { name: 'targetType', kind: 'string', required: true, description: '套用后生成哪一类对象' },
      {
        name: 'draft',
        kind: 'json',
        required: true,
        description: '预填属性。套用时与调用方给的属性合并，调用方的优先',
      },
    ],
  },
  {
    name: 'Worklog',
    version: '1.0.0',
    context: 'Execution',
    lifecycle: 'worklog-default',
    description:
      '一条工时记录（Plane one 档起，business 档带审批）。' +
      '做成领域对象而不是工作项上的一个数字：于是它能被审批、被审计、被按人按周汇总，' +
      '而一个累加字段只能回答"总共多少"，回答不了"谁在哪天报的"。',
    attributes: [
      { name: 'hours', kind: 'float', required: true, description: '工时数' },
      { name: 'spentOn', kind: 'datetime', required: true, description: '哪一天的工' },
      { name: 'note', kind: 'text', description: '做了什么' },
      { name: 'approvedAt', kind: 'datetime', derived: true },
    ],
  },
  {
    name: 'SavedView',
    version: '1.0.0',
    context: 'Project',
    description:
      '存下来的一组筛选条件（Plane pro 档的 Shared Views）。' +
      '筛选条件本来就能序列化成 URL，所以这里存的就是那串东西——' +
      '存成结构化查询会让"看到的"和"存下来的"变成两套实现。',
    attributes: [
      { name: 'name', kind: 'string', required: true },
      { name: 'targetType', kind: 'string', required: true, description: '看哪一类对象' },
      { name: 'query', kind: 'json', required: true, description: '筛选条件（与列表接口同构）' },
      {
        name: 'shared',
        kind: 'bool',
        description: '是否对同租户其他人可见。默认只有自己看得到',
      },
    ],
  },
  {
    name: 'Baseline',
    version: '1.0.0',
    context: 'Project',
    // 快照是不可变的，没有状态可言
    description:
      '基线：某一刻的计划快照（Plane business 档的 Baselines And Deviations）。' +
      '有了它，"这个计划比原计划晚了多少"才问得出来——' +
      '没有基线的话，改完计划之后原计划就消失了，偏差永远是零。',
    attributes: [
      { name: 'name', kind: 'string', required: true },
      { name: 'capturedAt', kind: 'datetime', required: true, description: '这份快照是哪一刻的' },
      {
        name: 'snapshot',
        kind: 'json',
        required: true,
        description: '当时每个对象的计划日期，形如 { id: { startDate, dueDate } }',
      },
    ],
  },
  {
    name: 'Release',
    version: '1.0.0',
    context: 'Execution',
    lifecycle: 'release-default',
    description:
      '一次发布（FR-DOM-007）。它装的是 Task——"这次发了什么"必须是可枚举的对象，' +
      '不是一段发布说明里的文字。',
    attributes: [
      { name: 'name', kind: 'string', required: true },
      { name: 'version', kind: 'string', required: true },
      { name: 'notes', kind: 'richtext' },
      { name: 'releasedAt', kind: 'datetime', derived: true },
    ],
  },
  {
    name: 'Recommendation',
    version: '1.0.0',
    context: 'Knowledge',
    lifecycle: 'recommendation-default',
    description:
      '一次主动推荐（FR-AI-009）。做成**领域对象**而不是一条埋点日志，' +
      '是为了让"点击率可统计"这件事不需要新的写路径：' +
      '推荐被点了没有，就是这个对象现在处于哪个状态，' +
      '而点击率就是一次普通的分组计数（和别的指标同一条路径）。',
    attributes: [
      { name: 'reason', kind: 'text', required: true, description: '为什么推这条给你。说不出理由的推荐不该出现' },
      { name: 'score', kind: 'float', description: '排序分。留着是为了事后能复算排序' },
      // **没有 shownAt**：资源本来就有 `createdAt`，而一条推荐被创建的时刻
      // 就是它被展示的时刻。加一个同义的字段，代价是它永远填不上——
      // entry action 只在**迁移进入**某状态时运行，而初始状态是创建时直接落的，
      // 不走迁移。那就又是一个"看起来配置好了、实际什么也不做"的字段
      { name: 'respondedAt', kind: 'datetime', derived: true },
    ],
  },
  {
    name: 'Sprint',
    // 1.0 → 1.1：新增一个 derived 属性（progressSnapshot）
    version: '1.1.0',
    context: 'Execution',
    lifecycle: 'sprint-default',
    description:
      '一次迭代 / 周期（PRD 03 §5）。Velocity 的分母就是它。' +
      '**时间维度**，与模块的范围维度正交；一个工作项只能属于一个周期。',
    attributes: [
      { name: 'name', kind: 'string', required: true },
      { name: 'goal', kind: 'text' },
      { name: 'startAt', kind: 'datetime', required: true },
      { name: 'endAt', kind: 'datetime', required: true },
      { name: 'capacity', kind: 'float', description: '可用点数 / 工时' },
      { name: 'completedPoints', kind: 'float', derived: true, description: '本迭代完成的点数' },
      /**
       * 周期关闭时冻结的进度快照。
       *
       * 存下来而不是每次现算，因为**回顾要看的是当时的样子**：
       * 周期关掉之后工作项还会继续被改——被挪走、被重开、被取消——
       * 现算出来的"上个迭代完成率"会随着这些改动一直变，
       * 于是回顾会上拿出来的数字和一周后再看时对不上。
       *
       * 由 `sprint-default` 进入 `Closed` 时写入（snapshotProgress）。
       */
      {
        name: 'progressSnapshot',
        kind: 'json',
        derived: true,
        description: '关闭那一刻的进度快照，用于回顾。之后再改工作项不会动它',
      },
    ],
  },
  {
    name: 'Milestone',
    version: '1.0.0',
    context: 'Project',
    lifecycle: 'milestone-default',
    description: '里程碑（PRD 03 §2）',
    attributes: [
      { name: 'name', kind: 'string', required: true },
      { name: 'dueDate', kind: 'datetime', required: true },
      { name: 'forecastDate', kind: 'datetime', description: '按当前进度预测的达成日' },
    ],
  },
  {
    name: 'Risk',
    version: '1.0.0',
    context: 'Project',
    lifecycle: 'risk-default',
    description:
      '风险登记册的一条（PRD 03 §2）。不变量：**高风险必须有 owner 与 mitigation**——' +
      '一条没人负责、没有对策的高风险，登记下来只是让人安心，不改变任何事。',
    attributes: [
      { name: 'description', kind: 'text', required: true },
      {
        name: 'probability',
        kind: 'enum',
        values: ['low', 'medium', 'high'],
        required: true,
      },
      { name: 'impact', kind: 'enum', values: ['low', 'medium', 'high'], required: true },
      { name: 'mitigation', kind: 'text', description: '缓解措施。高风险进入 Mitigating 时必填' },
      { name: 'dueDate', kind: 'datetime', description: '缓解期限；过期未处理会被指标点名' },
    ],
  },
  {
    name: 'Budget',
    version: '1.0.0',
    context: 'Project',
    lifecycle: 'budget-default',
    description: '预算（PRD 03 §2）。人力 / Token / 云成本各记一条',
    attributes: [
      {
        name: 'type',
        kind: 'enum',
        values: ['headcount', 'token', 'cloud'],
        required: true,
      },
      { name: 'planned', kind: 'float', required: true },
      { name: 'consumed', kind: 'float', description: '已消耗。超过 hardLimit 触发策略' },
      { name: 'hardLimit', kind: 'float' },
    ],
  },
  {
    name: 'Proposal',
    version: '1.0.0',
    context: 'AI',
    lifecycle: 'proposal-default',
    description:
      'Agent 提议创建的一个对象（FR-AI-001）。**一个节点一条**，' +
      '因此可以逐节点接受或拒绝——而不是对着一整棵生成出来的树只能全要或全不要。' +
      '接受时才真正创建那个对象；在此之前它只是一条提议，不占用类型体系里的位置。',
    attributes: [
      { name: 'resourceType', kind: 'string', required: true, description: '接受后要创建什么类型' },
      { name: 'draft', kind: 'json', required: true, description: '接受后写进去的属性' },
      { name: 'rationale', kind: 'text', description: 'Agent 给出的依据' },
      { name: 'runRef', kind: 'ref', description: '哪次 Run 提的' },
      {
        name: 'materialisedId',
        kind: 'string',
        derived: true,
        description: '接受之后真正创建出来的对象 id。**没接受就是空**',
      },
      { name: 'decidedAt', kind: 'datetime', derived: true },
    ],
  },
  {
    name: 'Approval',
    version: '1.0.0',
    context: 'Identity',
    lifecycle: 'approval-default',
    description:
      '一次人工确认（FR-IAM-009）。策略判定为 Ask 时挂起在这里，' +
      '等人批准或拒绝，**超时自动拒绝**。' +
      '做成领域对象而不是内存里的一张挂起表：进程重启不该让待批的操作凭空消失，' +
      '而"谁批准了什么"本来就该是可查、可审计的。',
    attributes: [
      { name: 'action', kind: 'string', required: true, description: '被挂起的 Capability' },
      { name: 'requestedBy', kind: 'string', required: true },
      { name: 'targetId', kind: 'string', description: '作用于哪个对象' },
      { name: 'matchedPolicy', kind: 'string', description: '哪条 Ask 策略把它挡下来的' },
      {
        name: 'expiresAt',
        kind: 'datetime',
        required: true,
        description: '过了这个时刻自动拒绝。**没有它，一次挂起就是永久待批**',
      },
      { name: 'decidedBy', kind: 'string', derived: true },
      { name: 'decidedAt', kind: 'datetime', derived: true },
    ],
  },
  {
    name: 'Acceptance',
    version: '1.0.0',
    context: 'Requirement',
    lifecycle: 'acceptance-default',
    description:
      '验收标准（FR-DOM-004）。**是一个对象，不是 Story 上的一段文本**——' +
      '因为它要能被单独确认、被测试用例引用、被查询"哪些验收还没过"。' +
      '塞进 Story 的一个 richtext 字段里，这三件事一件也做不到。',
    attributes: [
      // given / when / then 分成三个字段而不是一段自由文本：
      // 一条读起来像验收标准、其实没有可判定条件的描述，
      // 是需求评审里最常见也最贵的一种含糊
      { name: 'given', kind: 'text', required: true, description: '前置条件' },
      { name: 'when', kind: 'text', required: true, description: '触发动作' },
      { name: 'then', kind: 'text', required: true, description: '可观察的结果' },
      { name: 'verifiedBy', kind: 'string', description: '由哪个测试用例 / 谁验证' },
      { name: 'verifiedAt', kind: 'datetime', derived: true },
    ],
  },
]

export const DEFAULT_RELATION_TYPES: readonly RelationTypeDef[] = [
  {
    // Proposal ──refines──▶ Proposal：生成出来的是一棵树（FR-AI-001 的"对象树"）
    name: 'refines',
    inverse: 'refinedBy',
    acyclic: true,
    domain: ['Proposal'],
    range: ['Proposal'],
  },
  {
    name: 'refinedBy',
    inverse: 'refines',
    acyclic: true,
    domain: ['Proposal'],
    range: ['Proposal'],
  },
  {
    // Release ──ships──▶ Task
    name: 'ships',
    inverse: 'shippedIn',
    acyclic: true,
    domain: ['Release'],
    range: ['Task'],
  },
  /**
   * 推荐指向被推的那条知识（FR-AI-009）。
   *
   * 出处不需要单独记：Knowledge 本身就必须有 `derivedFrom`（FR-DOM-008），
   * 顺着这条边再走一步就到了。**同一件事只表达一次**，
   * 否则两处迟早不一致，而不一致的那份会被当成真的。
   */
  {
    name: 'recommends',
    inverse: 'recommendedBy',
    domain: ['Recommendation'],
    range: ['Knowledge'],
  },
  {
    name: 'recommendedBy',
    inverse: 'recommends',
    domain: ['Knowledge'],
    range: ['Recommendation'],
  },
  /** 推荐是在看哪个对象的时候给出的。没有它就没法回答"这条推荐当时合不合适" */
  {
    name: 'recommendedFor',
    inverse: 'gotRecommendations',
    domain: ['Recommendation'],
    range: ['Task', 'Story', 'Requirement', 'Decision'],
  },
  {
    name: 'gotRecommendations',
    inverse: 'recommendedFor',
    domain: ['Task', 'Story', 'Requirement', 'Decision'],
    range: ['Recommendation'],
  },
  /**
   * 任务排进了哪个 Sprint（FR-AI-004 的"一键应用"就是建这条边）。
   *
   * 和 `shippedIn` 分开：**"计划在这个迭代做"和"实际在这个版本发了"
   * 是两件事**，而且经常对不上——那个差值正是 Velocity 想说的东西。
   * 复用一条边的话，一个被挪到下个迭代的任务会看起来像是发布过了。
   */
  {
    name: 'plannedIn',
    inverse: 'plans',
    acyclic: true,
    // Story 也排周期。只让 Task 排的话，一个不拆任务的小需求
    // 就永远进不了任何迭代，而它照样占着这两周的人力
    domain: ['Task', 'Story'],
    range: ['Sprint'],
    /**
     * 基数 `0..1`：**一个工作项只能在一个周期里**。
     *
     * 这是周期与模块之间那处不对称的落点（见指南第一节）：
     * 一件事只能在一个时间盒里做，但它可以同时服务于多个交付目标。
     * 加入新周期时旧的那条边会被自动移除，见 ResourceService#enforceExclusiveCycle。
     */
    cardinality: '0..1',
  },
  {
    name: 'plans',
    inverse: 'plannedIn',
    domain: ['Sprint'],
    range: ['Task', 'Story'],
  },
  /**
   * 工作项归属模块——**范围**维度。
   *
   * 与 `plannedIn` 唯一的结构差别就是基数：这里是 `0..n`。
   * 一个工作项既可以属于「支付重构」（业务模块），又可以属于
   * 「Q3 技术债清理」（治理模块），两个模块的进度各自正确统计。
   */
  {
    name: 'inModule',
    inverse: 'moduleIncludes',
    acyclic: true,
    domain: ['Task', 'Story'],
    range: ['Module'],
    cardinality: '0..n',
  },
  {
    name: 'moduleIncludes',
    inverse: 'inModule',
    domain: ['Module'],
    range: ['Task', 'Story'],
  },
  /**
   * 重复与相关（Plane 的 duplicate / relates_to）。
   *
   * `duplicates` 有方向：A 是 B 的重复，说明该留下的是 B。
   * 做成有向的才答得出"该关掉哪一个"——无向的话两条都还在，
   * 而没有人知道该以哪一条为准。
   */
  {
    name: 'duplicates',
    inverse: 'duplicatedBy',
    acyclic: true,
    domain: ['Task', 'Story', 'Requirement', 'Intake'],
    range: ['Task', 'Story', 'Requirement', 'Intake'],
  },
  {
    name: 'duplicatedBy',
    inverse: 'duplicates',
    domain: ['Task', 'Story', 'Requirement', 'Intake'],
    range: ['Task', 'Story', 'Requirement', 'Intake'],
  },
  /**
   * 泛泛的"有关系"。
   *
   * 名字成对而不是自反，是因为注册表禁止自反关系（一条边的两端
   * 必须分得出来，否则逆关系解析没有确定结果）。语义上两个方向等价，
   * UI 上都渲染成"相关"。
   *
   * 刻意**没有** acyclic：相关本来就可以互相指。
   */
  {
    name: 'relatesTo',
    inverse: 'relatedFrom',
    domain: ['Task', 'Story', 'Requirement', 'Decision', 'Knowledge', 'Module'],
    range: ['Task', 'Story', 'Requirement', 'Decision', 'Knowledge', 'Module'],
  },
  {
    name: 'relatedFrom',
    inverse: 'relatesTo',
    domain: ['Task', 'Story', 'Requirement', 'Decision', 'Knowledge', 'Module'],
    range: ['Task', 'Story', 'Requirement', 'Decision', 'Knowledge', 'Module'],
  },
  /**
   * 一条 Intake 被接受之后变成了哪个工作项。
   *
   * `intake-default` 的 Accepted 守卫查的就是这条边：**接受必须落地**。
   * 没有它，分诊会退化成把队列清空的动作——队列确实空了，
   * 而提需求的人等来的仍然是没有下文。
   */
  {
    name: 'acceptedInto',
    inverse: 'acceptedFromIntake',
    acyclic: true,
    domain: ['Intake'],
    range: ['Task', 'Story', 'Requirement'],
  },
  {
    name: 'acceptedFromIntake',
    inverse: 'acceptedInto',
    domain: ['Task', 'Story', 'Requirement'],
    range: ['Intake'],
  },
  {
    name: 'shippedIn',
    inverse: 'ships',
    acyclic: true,
    domain: ['Task'],
    range: ['Release'],
  },
  {
    // Story ──acceptedBy──▶ Acceptance
    name: 'acceptedBy',
    inverse: 'acceptanceFor',
    domain: ['Requirement', 'Story'],
    range: ['Acceptance'],
  },
  {
    name: 'acceptanceFor',
    inverse: 'acceptedBy',
    domain: ['Acceptance'],
    range: ['Requirement', 'Story'],
  },
  {
    name: 'contains',
    inverse: 'containedIn',
    transitive: true,
    // 一个项目装着自己，会让传递闭包查询直接转不出来
    acyclic: true,
    domain: ['Project'],
    range: [
      'Requirement', 'Story', 'Task', 'Decision', 'Knowledge', 'Acceptance',
      // Project BC 与 Execution BC 的其余对象也归项目所有——
      // 漏掉的话，一条风险 / 一个里程碑没法归到任何项目下，
      // 而项目视角的指标全部按 project 收窄
      'Risk', 'Milestone', 'Budget', 'Sprint', 'Release',
      // 模块、意见收集、标签目录同样是项目级的东西。
      // 漏掉的话它们没法归到任何项目下，而所有按 project 收窄的
      // 查询与指标会当它们不存在
      'Module', 'Intake', 'Label',
    ],
  },
  {
    name: 'containedIn',
    inverse: 'contains',
    transitive: true,
    acyclic: true,
    domain: [
      'Requirement', 'Story', 'Task', 'Decision', 'Knowledge', 'Acceptance',
      // Project BC 与 Execution BC 的其余对象也归项目所有——
      // 漏掉的话，一条风险 / 一个里程碑没法归到任何项目下，
      // 而项目视角的指标全部按 project 收窄
      'Risk', 'Milestone', 'Budget', 'Sprint', 'Release',
      'Module', 'Intake', 'Label',
    ],
    range: ['Project'],
  },
  {
    name: 'implementedBy',
    inverse: 'implements',
    domain: ['Requirement'],
    range: ['Story'],
  },
  {
    name: 'implements',
    inverse: 'implementedBy',
    domain: ['Story'],
    range: ['Requirement'],
  },
  {
    name: 'decomposedInto',
    acyclic: true,
    inverse: 'partOf',
    domain: ['Story'],
    range: ['Task'],
  },
  {
    name: 'partOf',
    acyclic: true,
    inverse: 'decomposedInto',
    domain: ['Task'],
    range: ['Story'],
  },
  {
    // 依赖成环意味着这几件事互相等对方先做完，谁也开不了工。
    // 这是能在写入时判掉的错，而在排期会上才发现的话，代价大得多
    name: 'blockedBy',
    acyclic: true,
    inverse: 'blocks',
    // 甘特图的依赖线认的就是这个标记，不是关系的名字
    blocking: true,
    domain: ['Task'],
    range: ['Task'],
  },
  {
    name: 'blocks',
    acyclic: true,
    inverse: 'blockedBy',
    domain: ['Task'],
    range: ['Task'],
  },
  {
    name: 'explains',
    inverse: 'explainedBy',
    domain: ['Decision'],
    range: ['Requirement'],
  },
  {
    name: 'explainedBy',
    inverse: 'explains',
    domain: ['Requirement'],
    range: ['Decision'],
  },
  {
    name: 'owns',
    inverse: 'ownedBy',
    domain: ['Agent'],
    range: ['Task'],
  },
  {
    name: 'ownedBy',
    inverse: 'owns',
    domain: ['Task'],
    range: ['Agent'],
  },
  {
    name: 'derivedFrom',
    inverse: 'distills',
    domain: ['Knowledge'],
    range: ['Task', 'Decision'],
  },
  {
    name: 'distills',
    inverse: 'derivedFrom',
    domain: ['Task', 'Decision'],
    range: ['Knowledge'],
  },
  /**
   * 风险指向触发它的实体（FR-AI-006：每条风险可点击到触发它的实体）。
   *
   * 单开一对关系而不是复用 `derivedFrom`：语义不是一回事。
   * Knowledge「从一次执行中提炼出来」，Risk「是被这些东西暴露出来的」。
   * 复用的话得把 `derivedFrom` 的值域一起放宽，
   * 而那会**顺手改掉 Knowledge 的不变量**——一次为了少写十行而做的
   * 语义变更，事后没人会记得是这么来的。
   */
  {
    name: 'evidencedBy',
    inverse: 'evidenceFor',
    domain: ['Risk'],
    // 能让人判断"这个风险是真的"的东西。范围给得窄：
    // 允许指向任意对象的话，"有证据"这件事就不再意味着什么
    range: ['Task', 'Decision', 'Requirement', 'Sprint', 'Release'],
  },
  {
    name: 'evidenceFor',
    inverse: 'evidencedBy',
    domain: ['Task', 'Decision', 'Requirement', 'Sprint', 'Release'],
    range: ['Risk'],
  },
  /**
   * 评论挂在它所讨论的对象上。
   *
   * 用**关系**而不是一个 `about` 属性——`src/domain/agent/runtime.ts` 末尾
   * 那段注释把理由写清楚了：在这个系统里"可点击到实体"的意思是关系，
   * 不是属性。一个字符串 id 点不动，也走不进图遍历。
   *
   * 走关系换来三件属性给不了的事：评论出现在关系图里；
   * Agent 装配上下文时可以沿 `hasComments` 把讨论一起读进来；
   * 删除目标对象时的引用完整性由关系层统一管，不用每处自己记得清理。
   */
  {
    name: 'commentsOn',
    inverse: 'hasComments',
    domain: ['Comment'],
    // 值域列举而不是放开：允许评论任何东西的话，评论会长到
    // Notification、Approval 这类系统自己产生的对象上，而那些没人该去讨论
    range: COMMENTABLE,
  },
  {
    name: 'hasComments',
    inverse: 'commentsOn',
    domain: COMMENTABLE,
    range: ['Comment'],
  },
  /**
   * ── 企业级对象之间的边 ─────────────────────────────
   *
   * 全部用关系而不是 id 属性，理由和评论那对一样：属性点不动、
   * 也走不进图遍历，而这几类对象的价值恰恰在"能沿着它往下看"。
   */
  {
    // 团队空间管着哪些项目
    name: 'teamOwns',
    inverse: 'ownedByTeam',
    domain: ['Teamspace'],
    range: ['Project'],
  },
  { name: 'ownedByTeam', inverse: 'teamOwns', domain: ['Project'], range: ['Teamspace'] },
  {
    // 一个举措要动哪些项目 / 需求。跨项目正是它存在的理由
    name: 'initiativeIncludes',
    inverse: 'includedInInitiative',
    domain: ['Initiative'],
    range: ['Project', 'Requirement', 'Milestone'],
  },
  {
    name: 'includedInInitiative',
    inverse: 'initiativeIncludes',
    domain: ['Project', 'Requirement', 'Milestone'],
    range: ['Initiative'],
  },
  {
    // 这条工时报在哪个工作项上
    name: 'loggedOn',
    inverse: 'hasWorklogs',
    domain: ['Worklog'],
    range: ['Task', 'Story'],
  },
  { name: 'hasWorklogs', inverse: 'loggedOn', domain: ['Task', 'Story'], range: ['Worklog'] },
  {
    // 这份基线是给谁拍的
    name: 'baselineOf',
    inverse: 'hasBaselines',
    domain: ['Baseline'],
    range: ['Project', 'Sprint', 'Initiative'],
  },
  {
    name: 'hasBaselines',
    inverse: 'baselineOf',
    domain: ['Project', 'Sprint', 'Initiative'],
    range: ['Baseline'],
  },
]

export function buildDefaultRegistry(): OntologyRegistry {
  const registry = new OntologyRegistry()
  for (const def of DEFAULT_ENTITY_TYPES) registry.registerEntity(def)
  for (const def of DEFAULT_RELATION_TYPES) registry.registerRelation(def)
  registry.seal()
  return registry
}
