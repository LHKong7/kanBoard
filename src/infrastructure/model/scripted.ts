import type { ModelClient, ModelRequest, ModelResponse } from '../../domain/agent/types.ts'

/**
 * 确定性的模型客户端。
 *
 * 用途有两个，都不是"假装有 AI"：
 *
 * 1. **测试。** 运行时里真正需要验证的是预算熔断、护栏、协作模式、
 *    出处记录、审计归属——这些都与模型说了什么无关。
 *    用真模型测它们，只会让测试变慢、变贵、且不稳定。
 * 2. **本地开发。** 没有 API key 也能把整条链路跑通，
 *    从而知道链路本身是不是通的。
 *
 * 真实供应商的适配器实现同一个 `ModelClient` 端口。
 * 领域层不知道换了哪家——FR-AGT-013 要求"切换模型仅需改 modelPolicy"，
 * 这条只有在领域层不认识供应商时才成立。
 */

export type ScriptedTurn = Omit<ModelResponse, 'tokensUsed' | 'costUsd'> &
  Partial<Pick<ModelResponse, 'tokensUsed' | 'costUsd'>>

export class ScriptedModelClient implements ModelClient {
  readonly #turns: ScriptedTurn[]
  #index = 0
  /** 收到过的请求，测试用来断言上下文确实带了出处 */
  readonly seen: ModelRequest[] = []

  constructor(turns: readonly ScriptedTurn[]) {
    this.#turns = [...turns]
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    this.seen.push(request)
    const turn = this.#turns[this.#index]
    this.#index++
    if (turn === undefined) {
      // 脚本用完还在被调用，说明运行时的终止条件没生效。
      // 静默返回 finish 会把这个缺陷藏起来，所以这里要吵
      throw new Error(
        `ScriptedModelClient ran out of turns after ${this.#index - 1}; ` +
          'the runtime kept looping when it should have stopped',
      )
    }
    return { tokensUsed: turn.tokensUsed ?? 100, costUsd: turn.costUsd ?? 0.001, ...turn }
  }
}

/**
 * 一个不收敛的模型：永远提议、从不 finish。
 * 专门用来验证步数熔断真的会触发——没有它，`maxSteps` 只是一个没人走过的分支。
 */
export class NeverFinishingModelClient implements ModelClient {
  readonly #turn: ScriptedTurn
  #calls = 0

  constructor(turn: ScriptedTurn) {
    this.#turn = turn
  }

  get calls(): number {
    return this.#calls
  }

  async complete(): Promise<ModelResponse> {
    this.#calls++
    return { tokensUsed: this.#turn.tokensUsed ?? 100, costUsd: this.#turn.costUsd ?? 0.001, ...this.#turn }
  }
}
