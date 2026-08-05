import type { Db } from './db/client.ts'
import type { RelationRule } from '../ontology/relation-rules.ts'

/**
 * 自动关系建立规则的存储（FR-ONT-008）。
 *
 * 验收标准：**规则可增删改，变更即时生效。**
 *
 * "即时生效"这里是字面意义上的——**每次用之前现读**，没有缓存。
 * 和状态机（`PgLifecycleStore` 的 TTL 缓存）不一样，理由是量级：
 * 一次写入只会拉回"对这种对象生效"的那几条规则，而状态机每个请求都要全量。
 * 为几行数据引入一层可能不一致的缓存，换来的是"我改了规则但没生效"
 * 这种查起来极难的问题。
 */
export type RelationRuleRecord = {
  rule: RelationRule
  updatedBy: string
  updatedAt: Date
}

export class PgRelationRuleStore {
  readonly #db: Db
  readonly #tenant: string

  constructor(db: Db, tenant: string) {
    this.#db = db
    this.#tenant = tenant
  }

  async list(): Promise<RelationRuleRecord[]> {
    const rows = await this.#db
      .selectFrom('relation_rules')
      .selectAll()
      .where('tenant', '=', this.#tenant)
      .orderBy('id')
      .execute()
    return rows.map((r) => ({
      rule: { ...(r.definition as unknown as RelationRule), enabled: r.enabled },
      updatedBy: r.updated_by,
      updatedAt: r.updated_at,
    }))
  }

  /**
   * 对某一种对象生效的、**启用着的**规则。
   *
   * 写路径走这条：拉回全部规则再在内存里过滤，等于每次写入都读一遍
   * 全租户的规则表，而其中绝大多数和这个对象无关。
   */
  async enabledFor(subjectType: string): Promise<RelationRule[]> {
    const rows = await this.#db
      .selectFrom('relation_rules')
      .selectAll()
      .where('tenant', '=', this.#tenant)
      .where('subject_type', '=', subjectType)
      .where('enabled', '=', true)
      .orderBy('id')
      .execute()
    return rows.map((r) => ({ ...(r.definition as unknown as RelationRule), enabled: true }))
  }

  /**
   * 写一条规则（新增或覆盖）。
   *
   * 校验由调用方在写入**之前**做（`validateRule`）。写在这里的话，
   * 存储就成了本体规则的第二处实现，两处迟早会分叉。
   */
  async put(rule: RelationRule, updatedBy: string, now: Date): Promise<void> {
    await this.#db
      .insertInto('relation_rules')
      .values({
        tenant: this.#tenant,
        id: rule.id,
        subject_type: rule.subjectType,
        definition: JSON.stringify(rule),
        enabled: rule.enabled !== false,
        updated_by: updatedBy,
        updated_at: now,
      })
      .onConflict((oc) =>
        oc.columns(['tenant', 'id']).doUpdateSet({
          subject_type: rule.subjectType,
          definition: JSON.stringify(rule),
          enabled: rule.enabled !== false,
          updated_by: updatedBy,
          updated_at: now,
        }),
      )
      .execute()
  }

  /** 删一条。返回它是否真的存在过——404 和 204 对调用方不是一回事 */
  async remove(id: string): Promise<boolean> {
    const result = await this.#db
      .deleteFrom('relation_rules')
      .where('tenant', '=', this.#tenant)
      .where('id', '=', id)
      .executeTakeFirst()
    return (result.numDeletedRows ?? 0n) > 0n
  }
}
