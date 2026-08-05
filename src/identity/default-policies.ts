import type { Policy } from './types.ts'

/**
 * 默认策略集。
 *
 * 刻意保持很小：默认拒绝是全局默认（FR-IAM-002），
 * 每加一条 Allow 都应该是有意识的决定，而不是"先开着方便调试"。
 */
export function defaultPolicies(tenant: string): Policy[] {
  return [
    {
      id: 'pol-admin-full',
      effect: 'Allow',
      subject: 'role:Admin',
      action: '*',
      scope: { kind: 'tenant', tenant },
      description: '租户管理员在本租户内全权',
    },
    {
      id: 'pol-member-read',
      effect: 'Allow',
      subject: '*',
      action: '*.Read',
      scope: { kind: 'tenant', tenant },
      description: '租户内成员默认可读；细粒度收紧靠资源级 Deny 策略',
    },
    /**
     * 谁都可以参与讨论——**在能力允许的前提下**。
     *
     * 写成 `subject: '*'` 而不是给四个角色各来一条，理由和 `pol-member-read`
     * 一样：这一道回答的是"在这个租户里，讨论这件事被允许吗"，
     * 而"**这个人**能不能讨论"由能力那一道回答。
     * 两道都要过，所以这条并没有把门打开：
     *
     *   Guest 的能力集是 `*.Read`      → 看得到讨论，插不上话
     *   AIAgent 的能力集是空的         → 不在自己的声明里写就发不了言
     *
     * 反过来给四个角色各写一条的话，第五个角色加进来时会**默认不能评论**，
     * 而那不会有任何报错，只会表现为"这个角色的人好像不爱说话"。
     */
    {
      id: 'pol-member-comment',
      effect: 'Allow',
      subject: '*',
      action: 'Comment.*',
      scope: { kind: 'tenant', tenant },
      description: '租户内成员可以评论；能不能真的发言由各自的能力集决定',
    },
    {
      id: 'pol-pm-requirement',
      effect: 'Allow',
      subject: 'role:PM',
      action: 'Requirement.*',
      scope: { kind: 'tenant', tenant },
    },
    {
      id: 'pol-pm-story',
      effect: 'Allow',
      subject: 'role:PM',
      action: 'Story.*',
      scope: { kind: 'tenant', tenant },
    },
    {
      id: 'pol-rd-task',
      effect: 'Allow',
      subject: 'role:RD',
      action: 'Task.*',
      scope: { kind: 'tenant', tenant },
    },
    {
      id: 'pol-rd-knowledge',
      effect: 'Allow',
      subject: 'role:RD',
      action: 'Knowledge.*',
      scope: { kind: 'tenant', tenant },
    },
    // 自动化以 system://internal 身份执行。
    //
    // 权限刻意开得很窄：只能推进状态和读取，不能创建、不能删除、不能授权。
    // 自动化引擎是个高权限执行路径——它不面对人类的判断力，
    // 一条写错的规则会以机器的速度把错误铺开。
    {
      id: 'pol-system-automation-transition',
      effect: 'Allow',
      subject: 'system://internal',
      action: '*.Transition',
      scope: { kind: 'tenant', tenant },
      description: '自动化推进状态；守卫与生命周期约束照常生效',
    },
    {
      id: 'pol-system-automation-read',
      effect: 'Allow',
      subject: 'system://internal',
      action: '*.Read',
      scope: { kind: 'tenant', tenant },
    },
    {
      id: 'pol-system-automation-execute',
      effect: 'Allow',
      subject: 'system://internal',
      action: 'Task.Execute',
      scope: { kind: 'tenant', tenant },
      description: 'Todo → Doing 需要它',
    },
    {
      // Runner 的结算：把 token 用量、成本、终止原因写回 Run。
      //
      // 刻意只给 `AgentRun.Update` 而不是 `*.Update`：这是运行时的记账，
      // 不是"自动化可以改任何东西"的通行证。写得越窄，
      // 将来看到审计里出现别的 Update 时才知道那不正常。
      id: 'pol-system-settle-run',
      effect: 'Allow',
      subject: 'system://internal',
      action: 'AgentRun.Update',
      scope: { kind: 'tenant', tenant },
      description: 'Agent Runner 回写用量与终止原因（FR-AGT-012/014）',
    },
    // ── 自动化动作需要的创建权限（FR-WF-005） ──
    //
    // 上面那句"不能创建"到这里为止只对没列出来的类型成立。
    // 逐个列而不是 `*.Create`：每加一行都是一次明确的决定。
    {
      id: 'pol-system-automation-notify',
      effect: 'Allow',
      subject: 'system://internal',
      action: 'Notification.Create',
      scope: { kind: 'tenant', tenant },
      description: 'notify 动作。站内通知，写坏了的代价是噪音而不是损坏',
    },
    {
      id: 'pol-system-automation-create-task',
      effect: 'Allow',
      subject: 'system://internal',
      action: 'Task.Create',
      scope: { kind: 'tenant', tenant },
      description: 'createEntity 动作，例如 P0 缺陷自动开 RCA 任务',
    },
    {
      // 这一条比别的都重。自动化从此**可以花钱**：
      // 一次 Run 会消耗 token。兜底在别处——Run 自带预算并在超限时熔断
      // （FR-AGT-012），协作模式决定产出要不要人工复核（FR-AGT-009）。
      // 但那些是"花多少"的上限，不是"花不花"的开关，
      // 而这条策略就是那个开关。删掉它，自动化就再也发起不了 Agent。
      id: 'pol-system-automation-invoke-agent',
      effect: 'Allow',
      subject: 'system://internal',
      action: 'AgentRun.Create',
      scope: { kind: 'tenant', tenant },
      description: 'invokeAgent 动作（FR-WF-007）。自动化由此可以消耗预算',
    },
    {
      id: 'pol-system-automation-assign',
      effect: 'Allow',
      subject: 'system://internal',
      action: 'Task.Update',
      scope: { kind: 'tenant', tenant },
      description: 'assign 动作。只给工作项——需求归谁是人的判断',
    },
    {
      id: 'pol-system-automation-assign-story',
      effect: 'Allow',
      subject: 'system://internal',
      action: 'Story.Update',
      scope: { kind: 'tenant', tenant },
    },

    // ── Agent（ADR-0003：最低权限 + 事后可审计） ────────────
    //
    // Agent 要动一次手，必须**两道闸门同时放行**：
    //
    //   ① 能力：`ROLE_CAPABILITIES.AIAgent` 是空集，所以能力只能来自
    //      该 Agent 自己声明里的 `capabilities`（PRD 07 §3）。
    //      这一道回答"**这个** Agent 被配置成能做什么"。
    //   ② 策略：下面这几条。回答"在**这个租户**里，Agent 这类主体
    //      被允许做什么"。
    //
    // 缺哪一道都不行，而且顺序上 ① 先判——所以只写策略不写声明的话，
    // Agent 会在第 ④ 步就被拒，策略根本走不到。两道闸门的分工是：
    // 声明按 Agent 收紧，策略按租户封顶，Deny 则是两者都配不掉的地板。
    {
      id: 'pol-agent-read',
      effect: 'Allow',
      subject: 'role:AIAgent',
      action: '*.Read',
      scope: { kind: 'tenant', tenant },
      description: '租户允许 Agent 读；具体读得到什么由它自己的能力声明决定',
    },
    {
      id: 'pol-agent-run-transition',
      effect: 'Allow',
      subject: 'role:AIAgent',
      action: 'AgentRun.Transition',
      scope: { kind: 'tenant', tenant },
      description: 'Agent 推进自己那次 Run 的状态；采纳产出另有 Deny 挡着',
    },
    {
      id: 'pol-agent-draft',
      effect: 'Allow',
      subject: 'role:AIAgent',
      action: '*.Create',
      scope: { kind: 'tenant', tenant },
      description:
        '租户层面允许 Agent 产出草稿。能产出**哪些类型**由 Agent 声明里的 ' +
        'capabilities 与 mayPropose 共同收窄，这里不做类型级的白名单——' +
        '否则每加一种可产出类型都要改一次全局策略',
    },
    {
      // Agent 不批准自己的产出。
      //
      // 少了这条，人机协作模式就只是个摆设：给 Agent 声明上
      // `AgentRun.*` 就能让它自己走 AwaitingReview → Succeeded，
      // "人工审阅"这一步凭空消失。写成 Deny 才配不掉。
      id: 'pol-agent-no-self-approve',
      effect: 'Deny',
      subject: 'role:AIAgent',
      action: 'AgentRun.Approve',
      scope: { kind: 'tenant', tenant },
      description: 'FR-AGT-009：产出的采纳权归人',
    },
    {
      // 不可逆操作永远要人（docs/prd/05-agent-runtime.md §4）
      id: 'pol-agent-no-delete',
      effect: 'Deny',
      subject: 'role:AIAgent',
      action: '*.Delete',
      scope: { kind: 'tenant', tenant },
    },

    {
      id: 'pol-system-no-delete',
      effect: 'Deny',
      subject: 'system://internal',
      action: '*.Delete',
      scope: { kind: 'tenant', tenant },
      description: '自动化永远不删东西。需要删除时应当由人决定',
    },

    // 迁移作业以 system://migration 身份执行（FR-CON-007）。
    //
    // 和自动化那组是**两个身份**，权限也不同：自动化能推状态不能创建，
    // 迁移能创建能改**不能推状态**。
    //
    // 迁移不给 `*.Transition` 是这一组里最重要的一条：状态由映射表决定，
    // 让迁移作业能推状态机，等于给它一把绕开所有守卫的钥匙——
    // 而迁移正是最想绕开守卫的那个场景（"这批老数据不满足新规则"）。
    // 满足不了就该出现在迁移报告里，由人决定怎么办。
    {
      id: 'pol-system-migration-create',
      effect: 'Allow',
      subject: 'system://migration',
      action: '*.Create',
      scope: { kind: 'tenant', tenant },
      description: '迁移作业创建对象；本体校验与不变量照常生效',
    },
    {
      id: 'pol-system-migration-update',
      effect: 'Allow',
      subject: 'system://migration',
      action: '*.Update',
      scope: { kind: 'tenant', tenant },
      description: '迁移作业更新对象',
    },
    {
      id: 'pol-system-migration-read',
      effect: 'Allow',
      subject: 'system://migration',
      action: '*.Read',
      scope: { kind: 'tenant', tenant },
      description: '迁移作业读取对象以做对账',
    },
    {
      id: 'pol-system-migration-no-delete',
      effect: 'Deny',
      subject: 'system://migration',
      action: '*.Delete',
      scope: { kind: 'tenant', tenant },
      description: '迁移永远不删东西。「同步掉了」不该是一次删除的理由',
    },
    {
      id: 'pol-system-migration-no-transition',
      effect: 'Deny',
      subject: 'system://migration',
      action: '*.Transition',
      scope: { kind: 'tenant', tenant },
      description: '迁移不推状态机——那等于绕开守卫',
    },

    // 删除限于资源 owner。
    //
    // 必须写成 Deny：上面的 `Task.*` / `Requirement.*` 已经把 Delete 包含在内，
    // 再加一条带条件的 Allow 是没有约束力的——任一 Allow 命中即放行，
    // 宽策略会直接把它冲掉。收紧只能靠 Deny。
    //
    // 逐个角色列出而不是用 `*`：Deny 优先于一切 Allow，
    // 用 `*` 会连 Admin 一起挡住，而 Admin 正是需要保留的兜底路径。
    ...(['PM', 'RD', 'QA'] as const).map((role) => ({
      id: `pol-delete-owner-only-${role.toLowerCase()}`,
      effect: 'Deny' as const,
      subject: `role:${role}`,
      action: '*.Delete',
      scope: { kind: 'tenant' as const, tenant },
      condition: { ownerOnly: true },
      description: `${role} 只能删除自己拥有的资源`,
    })),
  ]
}
