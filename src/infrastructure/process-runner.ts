import type { ActionRunner } from '../domain/orchestration/executor.ts'
import type { StepAction } from '../workflow/orchestration.ts'
import type { Caller, ResourceService } from '../domain/resource/service.ts'
import type { ConnectorInvoker } from '../domain/agent/runtime.ts'
import { DomainError } from '../platform/errors.ts'

/**
 * 把流程里的动作真的做掉（FR-WF-010）。
 *
 * 两种动作，两条**已经存在的**路径：
 *
 *   transition  走 `ResourceService.transition` —— 同一套守卫、权限、审计。
 *   call        走连接器网关 —— 同一套白名单、幂等键、脱敏、限流。
 *
 * 都不另开近路。另写一条"流程引擎直接改状态"会省几十行，
 * 代价是流程绕过了状态机守卫——而守卫正是"Release 只能装 Done 的 Task"
 * 这类规则的所在地。一个能绕过它们的执行器，会让那些规则变成建议。
 */
export type ProcessRunnerDeps = {
  service: ResourceService
  caller: Caller
  /** 没有连接器就只能跑纯状态迁移的流程——而这必须是显式的 */
  connectors?: ConnectorInvoker | undefined
  /** 流程实例 id，用作幂等键前缀：重试不该创建第二个 PR */
  runId: string
}

export function processRunner(deps: ProcessRunnerDeps): ActionRunner {
  return {
    async perform(action: StepAction, refs: Readonly<Record<string, string>>) {
      try {
        if (action.kind === 'noop') return { status: 'ok' as const }

        if (action.kind === 'transition') {
          const id = refs[action.resourceRef]
          if (id === undefined) {
            // 符号名没绑到对象上是**流程定义或启动参数的错**，
            // 不是运行期的意外。说清楚是哪个名字，否则排查要从头读一遍定义
            return {
              status: 'failed' as const,
              error: `no resource bound to "${action.resourceRef}"`,
            }
          }
          const updated = await deps.service.transition(deps.caller, id, action.to, {
            reason: `process ${deps.runId}`,
          })
          return { status: 'ok' as const, value: updated.status }
        }

        if (deps.connectors === undefined) {
          return {
            status: 'failed' as const,
            error: `no connector gateway configured; cannot run "${action.connectorId}.${action.operation}"`,
          }
        }
        const result = await deps.connectors.invoke(deps.caller, {
          connectorId: action.connectorId,
          operation: action.operation,
          target: refs[action.target] ?? action.target,
          params: {},
          // 幂等键带上实例和步骤：**一次超时重试不该创建第二个 PR**
          idempotencyKey: `${deps.runId}:${action.connectorId}:${action.operation}:${action.target}`,
        })
        // 连接器的返回值决定分支与循环怎么走（灰度观察的 healthy / degraded）。
        // 拿不出一个字符串就当没有结论——让 `advance` 去决定那意味着什么，
        // 而不是在这里编一个默认值
        return {
          status: result.ok ? ('ok' as const) : ('failed' as const),
          ...(typeof result.data === 'string' ? { value: result.data } : {}),
        }
      } catch (error) {
        // 领域错误（守卫挡回、权限不足、状态机不允许）是**流程的失败**，
        // 不是进程的失败：它要变成一个 failed 的步骤结果，让补偿跑起来。
        // 其它异常往上抛——把数据库故障也当成"这一步失败了"，
        // 会让流程一路补偿到底，而原因是一次可以重试的抖动
        if (!(error instanceof DomainError)) throw error
        return { status: 'failed' as const, error: error.message }
      }
    },
  }
}
