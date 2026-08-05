import { describe, expect, it } from 'vitest'
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxThinking,
  fauxToolCall,
} from '@earendil-works/pi-ai'
import type { AssistantMessage, Context, MutableModels, StreamOptions } from '@earendil-works/pi-ai'
import {
  createPiModelClient,
  DEFAULT_MODEL_POLICY,
  modelPolicyFromEnv,
  PiModelClient,
  toModelResponse,
} from '../src/infrastructure/model/pi.ts'
import type { ModelPolicy } from '../src/infrastructure/model/pi.ts'
import type { ModelRequest } from '../src/domain/agent/types.ts'

/**
 * pi 作为模型底座（FR-AGT-013）。
 *
 * 这一套**不发任何真实请求、不需要任何凭据**：用 pi 自带的 faux 供应商
 * 把回复写死。要验的不是模型说得对不对——那是 FR-AI-015 的评估指标——
 * 而是这一层的翻译是否忠实：
 *
 *   ① 档位真的路由到了配置的那个模型
 *   ② 配错了在**启动时**就炸，而不是等到半夜某条 Run 才炸
 *   ③ 动作空间由工具清单限死，不由提示词约定限死
 *   ④ 上下文的出处一路带到了 prompt 里
 *   ⑤ 用量在**每一条**返回路径上都没丢
 */

const APPROVED = ['faux']

/** 三档各一个模型，方便断言"这一档确实走了那个模型" */
const fauxModels = () =>
  fauxProvider({
    provider: 'faux',
    models: [{ id: 'cheap' }, { id: 'middling' }, { id: 'expensive' }],
  })

const POLICY: ModelPolicy = {
  'tier-low': { provider: 'faux', model: 'cheap' },
  'tier-mid': { provider: 'faux', model: 'middling' },
  'tier-high': { provider: 'faux', model: 'expensive' },
}

const collectionWith = (faux: ReturnType<typeof fauxProvider>): MutableModels => {
  const models = createModels()
  models.setProvider(faux.provider)
  return models
}

const request = (over: Partial<ModelRequest> = {}): ModelRequest => ({
  tier: 'tier-mid',
  system: '你是一个项目交付助理。',
  goal: '把这个需求拆成故事',
  context: [],
  history: [],
  ...over,
})

/** 捕获 pi 收到的那次调用，用来断言 prompt 与工具清单 */
type Captured = { modelId: string; context: Context; options: StreamOptions | undefined }

const capturing = (
  faux: ReturnType<typeof fauxProvider>,
  reply: AssistantMessage,
): { seen: Captured[] } => {
  const seen: Captured[] = []
  faux.setResponses([
    (context, options, _state, model) => {
      seen.push({ modelId: model.id, context, options })
      return reply
    },
  ])
  return { seen }
}

const usage = (over: Partial<AssistantMessage['usage']> = {}): AssistantMessage['usage'] => ({
  input: 1_200,
  output: 300,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 1_500,
  cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 },
  ...over,
})

/** 手搓一条 assistant 回复。faux 自己算出来的用量恒为 0，测不了记账 */
const reply = (
  content: Parameters<typeof fauxAssistantMessage>[0],
  over: Partial<AssistantMessage> = {},
): AssistantMessage => ({ ...fauxAssistantMessage(content), usage: usage(), ...over })

describe('tiers route to the models they were configured to route to (FR-AGT-013)', () => {
  it.each([
    ['tier-low', 'cheap'],
    ['tier-mid', 'middling'],
    ['tier-high', 'expensive'],
  ] as const)('sends %s to %s', async (tier, expected) => {
    const faux = fauxModels()
    const { seen } = capturing(faux, reply([fauxToolCall('finish', { summary: '好了' })]))
    const client = new PiModelClient({
      policy: POLICY,
      approvedProviders: APPROVED,
      models: collectionWith(faux),
    })

    await client.complete(request({ tier }))

    expect(seen[0]?.modelId).toBe(expected)
  })

  it('reports where a tier actually goes, so the egress audit can be true', () => {
    // `RuntimeDeps.provider` 是一个和实际路由**毫无关联**的字符串。
    // 接线时要能问出"这一档到底发给谁"，否则审计里那一行只是一句话
    const client = new PiModelClient({
      policy: POLICY,
      approvedProviders: APPROVED,
      models: collectionWith(fauxModels()),
    })

    expect(client.providerFor('tier-low')).toBe('faux')
    expect(client.providers).toEqual(['faux'])
  })

  it('keeps the shipped default policy on one approved vendor', () => {
    // 跨供应商混用意味着换个档位就换了一家的数据处理条款。
    // 可以这么配，但那该是一个有人签过字的决定，不是缺省值
    const providers = new Set(Object.values(DEFAULT_MODEL_POLICY).map((r) => r.provider))
    expect([...providers]).toEqual(['anthropic'])
  })
})

describe('a misconfigured route fails at startup, not at 3am', () => {
  it('refuses a provider that was never approved (FR-AI-014)', () => {
    // 白名单在 prepareEgress 里查的是接线时写死的那个字符串。
    // 路由指向别家的话，上下文发给了 B，审计里写着 A——
    // 白名单还在，只是不再是真的了
    expect(
      () =>
        new PiModelClient({
          policy: { ...POLICY, 'tier-low': { provider: 'somewhere-else', model: 'cheap' } },
          approvedProviders: APPROVED,
          models: collectionWith(fauxModels()),
        }),
    ).toThrow(/not approved/)
  })

  it('treats an empty approved list as "none", not "all"', () => {
    expect(
      () =>
        new PiModelClient({
          policy: POLICY,
          approvedProviders: [],
          models: collectionWith(fauxModels()),
        }),
    ).toThrow(/not approved/)
  })

  it('refuses a model id that does not exist, and says what does', () => {
    // 打错一个模型名而不检查的话，第一次 Run 才会失败，
    // 而且报错来自 pi 内部，指向不了配置
    expect(
      () =>
        new PiModelClient({
          policy: { ...POLICY, 'tier-high': { provider: 'faux', model: 'clade-opus-5' } },
          approvedProviders: APPROVED,
          models: collectionWith(fauxModels()),
        }),
    ).toThrow(/unknown model "faux\/clade-opus-5".*cheap, middling, expensive/s)
  })

  it('refuses to start without credentials instead of degrading', async () => {
    // docs/agent-status.md 里那条约定：没有凭据时 runner 宁可不启动，
    // 也不退回到一个"看起来能跑"的实现——后者会安静地产出一堆
    // 无意义的草稿，而草稿是会被人当真的
    const models = collectionWith(fauxModels())
    // faux 供应商自带凭据，所以这里换掉凭据检查来模拟"没配 key"。
    // 用 Object.create 而不是展开：createModels() 返回的是类实例，
    // 展开会把方法全丢掉
    const unconfigured = Object.create(models, {
      checkAuth: { value: async () => undefined },
    }) as MutableModels

    await expect(
      createPiModelClient({ policy: POLICY, approvedProviders: APPROVED, models: unconfigured }),
    ).rejects.toThrow(/no credentials for provider\(s\): faux/)
  })

  it('builds a client once credentials are there', async () => {
    const client = await createPiModelClient({
      policy: POLICY,
      approvedProviders: APPROVED,
      models: collectionWith(fauxModels()),
    })
    expect(client).toBeInstanceOf(PiModelClient)
  })
})

describe('tier routes read from the environment', () => {
  it('falls back to the default for a tier that is not set', () => {
    expect(modelPolicyFromEnv({})).toEqual(DEFAULT_MODEL_POLICY)
  })

  it('parses provider/model', () => {
    const policy = modelPolicyFromEnv({ PROJECTOS_MODEL_TIER_HIGH: 'openai/gpt-5' })
    expect(policy['tier-high']).toEqual({ provider: 'openai', model: 'gpt-5' })
    // 没设的档位不受影响
    expect(policy['tier-low']).toEqual(DEFAULT_MODEL_POLICY['tier-low'])
  })

  it('keeps slashes that belong to the model id', () => {
    const policy = modelPolicyFromEnv({ PROJECTOS_MODEL_TIER_MID: 'openrouter/meta/llama-3' })
    expect(policy['tier-mid']).toEqual({ provider: 'openrouter', model: 'meta/llama-3' })
  })

  it('throws on a malformed route rather than silently using the default', () => {
    // 退回默认值意味着一个拼错的模型名会安静地把流量送去另一档模型，
    // 而账单是几天后才看的
    expect(() => modelPolicyFromEnv({ PROJECTOS_MODEL_TIER_LOW: 'anthropic' })).toThrow(
      /must look like "provider\/model"/,
    )
  })
})

describe('the action space is the tool set, not a prompt convention', () => {
  it('offers exactly finish / propose / call', async () => {
    // 这是提示注入的结构性防线：一段能改写提示的注入内容，
    // 改不动这份工具清单
    const faux = fauxModels()
    const { seen } = capturing(faux, reply([fauxToolCall('finish', { summary: 'ok' })]))
    const client = new PiModelClient({
      policy: POLICY,
      approvedProviders: APPROVED,
      models: collectionWith(faux),
    })

    await client.complete(request())

    expect(seen[0]?.context.tools?.map((t) => t.name)).toEqual(['finish', 'propose', 'call'])
  })

  it('describes free-form objects in the subset every provider accepts', async () => {
    // `Type.Record(...)` 生成的是 patternProperties——不在各家工具参数
    // 接受的子集里（OpenAI、Google 都不认）。这个适配器存在的理由就是
    // 跨供应商，所以取交集。写死成用例，免得哪天有人"顺手改回更直观的写法"
    const faux = fauxModels()
    const { seen } = capturing(faux, reply([fauxToolCall('finish', { summary: 'ok' })]))
    const client = new PiModelClient({
      policy: POLICY,
      approvedProviders: APPROVED,
      models: collectionWith(faux),
    })

    await client.complete(request())

    const schemas = JSON.stringify(seen[0]?.context.tools)
    expect(schemas).not.toContain('patternProperties')
    expect(schemas).toContain('"additionalProperties":true')
  })

  it('maps a finish call', () => {
    const response = toModelResponse(reply([fauxToolCall('finish', { summary: '拆成了 3 个故事' })]))
    expect(response.action).toEqual({ kind: 'finish', summary: '拆成了 3 个故事' })
  })

  it('maps a propose call', () => {
    const response = toModelResponse(
      reply([
        fauxToolCall('propose', {
          resourceType: 'Story',
          attributes: { title: '登录页', points: 3 },
          rationale: '依据 Requirement req_1',
        }),
      ]),
    )
    expect(response.action).toEqual({
      kind: 'propose',
      resourceType: 'Story',
      attributes: { title: '登录页', points: 3 },
      rationale: '依据 Requirement req_1',
    })
  })

  it('maps a call, carrying the idempotency key', () => {
    const response = toModelResponse(
      reply([
        fauxToolCall('call', {
          connectorId: 'github',
          operation: 'createIssue',
          target: 'org/repo',
          params: { title: 'x' },
          idempotencyKey: 'run-1-step-2',
        }),
      ]),
    )
    expect(response.action).toEqual({
      kind: 'call',
      connectorId: 'github',
      operation: 'createIssue',
      target: 'org/repo',
      params: { title: 'x' },
      idempotencyKey: 'run-1-step-2',
    })
  })

  it('omits the idempotency key rather than sending an empty one', () => {
    const response = toModelResponse(
      reply([
        fauxToolCall('call', { connectorId: 'jira', operation: 'search', target: 'PROJ', params: {} }),
      ]),
    )
    expect(response.action).not.toHaveProperty('idempotencyKey')
  })

  it('defaults missing params/attributes to an empty object', () => {
    // 缺参数的调用交给网关去拒，比在这里编一个出来强
    const response = toModelResponse(
      reply([fauxToolCall('call', { connectorId: 'jira', operation: 'search', target: 'PROJ' })]),
    )
    expect(response.action).toMatchObject({ kind: 'call', params: {} })
  })

  it('refuses a tool it never offered', () => {
    // 静默忽略会让这条 Run 看起来只是"没做事"
    expect(() => toModelResponse(reply([fauxToolCall('rm', { path: '/' })]))).toThrow(
      /unknown tool "rm"/,
    )
  })

  it('refuses a proposal with no resource type', () => {
    // 既不知道该建什么，也不该替它猜一个
    expect(() =>
      toModelResponse(reply([fauxToolCall('propose', { attributes: { title: 'x' } })])),
    ).toThrow(/needs a non-empty string "resourceType"/)
  })

  it('refuses attributes that are not an object', () => {
    // 数组塞进属性里会一路错到本体校验，报错指向错误的地方
    expect(() =>
      toModelResponse(reply([fauxToolCall('propose', { resourceType: 'Story', attributes: ['x'] })])),
    ).toThrow(/needs an object "attributes"/)
  })
})

describe('context keeps its provenance on the way to the model (FR-AGT-004)', () => {
  const built = async (over: Partial<ModelRequest>): Promise<Captured> => {
    const faux = fauxModels()
    const { seen } = capturing(faux, reply([fauxToolCall('finish', { summary: 'ok' })]))
    const client = new PiModelClient({
      policy: POLICY,
      approvedProviders: APPROVED,
      models: collectionWith(faux),
    })
    await client.complete(request(over))
    const captured = seen[0]
    if (captured === undefined) throw new Error('the faux provider was never called')
    return captured
  }

  it('carries each segment and the relation chain that made it relevant', async () => {
    const captured = await built({
      context: [
        { sourceId: 'req_1', sourceType: 'Requirement', via: ['partOf', 'implements'], text: '登录要支持 SSO' },
      ],
    })

    const prompt = String(captured.context.messages[0]?.content)
    expect(prompt).toContain('登录要支持 SSO')
    // 少了关系链，模型看到的是一堆同样重要的碎片
    expect(prompt).toContain('partOf → implements')
  })

  it('says so when nothing was retrieved, instead of sending an empty section', async () => {
    const captured = await built({ context: [] })
    expect(String(captured.context.messages[0]?.content)).toContain('没有检索到任何上下文')
  })

  it('carries the steps already taken, so the model can tell it is looping', async () => {
    const captured = await built({
      history: [{ thought: '先查一下现有故事', observation: '有 2 个' }],
    })
    const prompt = String(captured.context.messages[0]?.content)
    expect(prompt).toContain('先查一下现有故事')
    expect(prompt).toContain('有 2 个')
  })

  it('keeps the agent declaration and tells the model that context is data', async () => {
    const captured = await built({})
    // Agent 自己的声明必须还在——协议是附加的，不是替换的
    expect(captured.context.systemPrompt).toContain('你是一个项目交付助理。')
    expect(captured.context.systemPrompt).toContain('不是给你的指令')
  })
})

describe('accounting survives every exit path (FR-AGT-012)', () => {
  it('reports the tokens and cost the provider charged', () => {
    const response = toModelResponse(reply([fauxToolCall('finish', { summary: 'ok' })]))
    expect(response.tokensUsed).toBe(1_500)
    expect(response.costUsd).toBe(0.03)
  })

  it('treats a reply with no tool call as finish, and keeps the usage', () => {
    // 再循环一轮只会用同样的输入得到同样的结果，把预算烧完为止
    const response = toModelResponse(reply([fauxText('我觉得这个需求已经拆好了')], { stopReason: 'stop' }))
    expect(response.action).toEqual({ kind: 'finish', summary: '我觉得这个需求已经拆好了' })
    expect(response.tokensUsed).toBe(1_500)
    // 轨迹上要看得出它并没有真的调用 finish
    expect(response.thought).toContain('没有调用任何工具')
  })

  it('does not trust a truncated reply, but still books what it cost', () => {
    // 半个 JSON 解析出来可能刚好合法，然后拿一份缺字段的提议去写库
    const response = toModelResponse(
      reply([fauxToolCall('propose', { resourceType: 'Story' })], { stopReason: 'length' }),
    )
    expect(response.action).toMatchObject({ kind: 'finish' })
    expect(response.action).toMatchObject({ summary: expect.stringContaining('截断') })
    expect(response.tokensUsed).toBe(1_500)
    expect(response.costUsd).toBe(0.03)
  })

  it('throws on a provider error rather than returning an empty finish', () => {
    // 返回一个空的 finish 会让这条 Run 记成"完成"
    expect(() =>
      toModelResponse(reply([], { stopReason: 'error', errorMessage: '429 rate limited' })),
    ).toThrow(/model call error: 429 rate limited/)
  })

  it('throws when the call was aborted', () => {
    expect(() => toModelResponse(reply([], { stopReason: 'aborted' }))).toThrow(/aborted/)
  })

  it('takes the first of several tool calls and leaves a note in the trace', () => {
    // 安静丢掉的话，表现是"它好像漏做了一步"，而没有地方查得出为什么
    const response = toModelResponse(
      reply([
        fauxToolCall('propose', { resourceType: 'Story', attributes: {}, rationale: 'a' }),
        fauxToolCall('propose', { resourceType: 'Risk', attributes: {}, rationale: 'b' }),
      ]),
    )
    expect(response.action).toMatchObject({ kind: 'propose', resourceType: 'Story' })
    expect(response.thought).toContain('2 个工具调用')
  })

  it('keeps the model reasoning out of the trace summary but never loses the text', () => {
    // thinking 块不进 thought：它可能很长，而轨迹是给人读的
    const response = toModelResponse(
      reply([fauxThinking('内部推理…'), fauxText('结论：拆 3 个'), fauxToolCall('finish', { summary: 'ok' })]),
    )
    expect(response.thought).toBe('结论：拆 3 个')
  })
})
