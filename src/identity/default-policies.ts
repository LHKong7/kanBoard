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
      id: 'pol-system-no-delete',
      effect: 'Deny',
      subject: 'system://internal',
      action: '*.Delete',
      scope: { kind: 'tenant', tenant },
      description: '自动化永远不删东西。需要删除时应当由人决定',
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
