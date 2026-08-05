import type { SecretProvider } from '../../domain/connector/types.ts'

/**
 * 从环境变量取凭据（FR-CON-011）。
 *
 * 这是最简单的一种 Secret Manager，够本地开发和小规模部署用；
 * 换 Vault / AWS Secrets Manager 只是换一个实现同一端口的类。
 *
 * 两条不变量，无论换成哪种实现都必须守住：
 *
 * 1. **取到的值不出现在返回给调用方的任何东西里。** 网关把它交给
 *    Connector 适配器，用完即弃——不进审计详情、不进 Run 轨迹、
 *    更不进 Agent 上下文。
 * 2. **取不到就返回 null，不抛也不猜。** 让调用失败在"外部系统拒绝"上，
 *    而不是在"我们用了一个空字符串当凭据"上——后者的报错会指向错误的方向。
 */
export class EnvSecretProvider implements SecretProvider {
  readonly #prefix: string

  constructor(prefix = 'PROJECTOS_SECRET_') {
    this.#prefix = prefix
  }

  async get(ref: string): Promise<string | null> {
    // ref 只允许大写字母、数字和下划线：拼进环境变量名之前必须收紧，
    // 否则一个精心构造的 ref 可以去读别的环境变量
    if (!/^[A-Z0-9_]+$/.test(ref)) return null
    return process.env[`${this.#prefix}${ref}`] ?? null
  }
}
