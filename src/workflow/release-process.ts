import type { Process } from './orchestration.ts'

/**
 * 发布流程（FR-WF-010 的验收标准：**Release 流程端到端跑通**）。
 *
 * 选它当样例不是因为它简单，是因为**这五种结构它一个不落地都要用到**，
 * 而且每一种都是被现实逼出来的：
 *
 *   并行    冻结之后，构建产物和发布说明互不依赖——串行做只是白等
 *   人工    上生产永远要人点头（PRD §4：不可逆操作永远需要人工确认）
 *   循环    灰度是**观察 → 判断 → 扩大**，不是一次性动作
 *   分支    灰度的结论决定是全量还是回滚
 *   超时    等人和观察都必须有上界，否则实例永远挂着
 *
 * 每一个有副作用的步骤都带 `compensate`（FR-WF-011）。
 * **没有补偿的步骤不该出现在自动化流程里**——它一旦成功，
 * 后面任何一步失败都会把系统留在一个没人描述过的状态。
 */
export const RELEASE_PROCESS: Process = {
  id: 'release-default',
  steps: [
    {
      id: 'freeze',
      kind: 'action',
      action: { kind: 'transition', resourceRef: 'release', to: 'Frozen' },
      // 撤销冻结 = 回到 Planned，范围重新可改
      compensate: { kind: 'transition', resourceRef: 'release', to: 'Planned' },
    },
    {
      id: 'prepare',
      kind: 'parallel',
      branches: [
        {
          id: 'build',
          kind: 'action',
          action: { kind: 'call', connectorId: 'ci', operation: 'build', target: 'release' },
          compensate: { kind: 'call', connectorId: 'ci', operation: 'discardArtifact', target: 'release' },
          timeoutMs: 30 * 60 * 1000,
        },
        {
          id: 'notes',
          kind: 'action',
          action: { kind: 'call', connectorId: 'docs', operation: 'draftReleaseNotes', target: 'release' },
          compensate: { kind: 'call', connectorId: 'docs', operation: 'deleteDraft', target: 'release' },
        },
      ],
    },
    {
      id: 'approve',
      kind: 'human',
      prompt: '构建与发布说明已就绪，确认开始灰度？',
      // 等一天没人点就当没批。**不设上界的话，这个实例会永远挂着**，
      // 而挂着的实例攥着一个已冻结的 Release
      timeoutMs: 24 * 60 * 60 * 1000,
      onTimeout: 'fail',
    },
    {
      id: 'canary',
      kind: 'loop',
      // 观察 → 判断 → 扩大。灰度观察有**三种**结论：
      //   healthy    稳了，出循环走全量
      //   unhealthy  明确坏了，出循环走中止
      //   degraded   还看不出来，再来一轮
      // 只认 healthy 一个出口的话，"明确坏了"和"还在看"就没法区分，
      // 流程只能一直重试到上界——而上界走的是补偿，不是中止分支，
      // 于是下面那条 abort 永远执行不到
      on: 'observe',
      untilAnyOf: ['healthy', 'unhealthy'],
      // 上界：五轮还没稳定就不是"再等等"的问题了
      maxIterations: 5,
      body: [
        {
          id: 'widen',
          kind: 'action',
          action: { kind: 'call', connectorId: 'deploy', operation: 'widenCanary', target: 'release' },
          compensate: { kind: 'call', connectorId: 'deploy', operation: 'rollback', target: 'release' },
        },
        {
          id: 'observe',
          kind: 'action',
          action: { kind: 'call', connectorId: 'metrics', operation: 'canaryHealth', target: 'release' },
          timeoutMs: 10 * 60 * 1000,
        },
      ],
    },
    {
      id: 'decide',
      kind: 'branch',
      on: 'observe',
      cases: {
        healthy: [
          {
            id: 'promote',
            kind: 'action',
            action: { kind: 'call', connectorId: 'deploy', operation: 'promote', target: 'release' },
            compensate: { kind: 'call', connectorId: 'deploy', operation: 'rollback', target: 'release' },
          },
          {
            id: 'mark-released',
            kind: 'action',
            action: { kind: 'transition', resourceRef: 'release', to: 'Released' },
          },
        ],
      },
      // 没走到 healthy 就中止。**这一条不是兜底，是主路径之一**——
      // 灰度不健康是常态，不是异常
      otherwise: [
        {
          id: 'abort',
          kind: 'action',
          action: { kind: 'transition', resourceRef: 'release', to: 'Abandoned' },
        },
      ],
    },
  ],
}
