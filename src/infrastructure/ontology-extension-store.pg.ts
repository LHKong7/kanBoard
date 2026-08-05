import type { Db } from './db/client.ts'
import type { TenantExtension } from '../ontology/tenant-extension.ts'
import type { AttributeType } from '../ontology/types.ts'

/**
 * 租户级本体扩展的存储（FR-ONT-009）。
 *
 * **每次请求现读**，没有缓存。理由和关系规则一样：一个租户的扩展
 * 最多几行，而缓存换来的是"我加了字段但写不进去"——
 * 一个说不清的不一致，比一次多出来的小查询贵得多。
 *
 * 校验（命名空间前缀、只能加可选字段、不能是 derived）由
 * `validateExtension` 在**写入之前**做。放在存储里的话，
 * 本体规则就有了第二处实现，两处迟早分叉。
 */
export class PgOntologyExtensionStore {
  readonly #db: Db
  readonly #tenant: string

  constructor(db: Db, tenant: string) {
    this.#db = db
    this.#tenant = tenant
  }

  async list(): Promise<TenantExtension[]> {
    const rows = await this.#db
      .selectFrom('ontology_extensions')
      .selectAll()
      .where('tenant', '=', this.#tenant)
      .orderBy('entity_type')
      .execute()
    return rows.map((r) => ({
      tenant: r.tenant,
      entityType: r.entity_type,
      attributes: r.attributes as unknown as AttributeType[],
    }))
  }

  async put(ext: TenantExtension, updatedBy: string, now: Date): Promise<void> {
    await this.#db
      .insertInto('ontology_extensions')
      .values({
        tenant: this.#tenant,
        entity_type: ext.entityType,
        attributes: JSON.stringify(ext.attributes),
        updated_by: updatedBy,
        updated_at: now,
      })
      .onConflict((oc) =>
        oc.columns(['tenant', 'entity_type']).doUpdateSet({
          attributes: JSON.stringify(ext.attributes),
          updated_by: updatedBy,
          updated_at: now,
        }),
      )
      .execute()
  }

  /**
   * 撤掉一个类型上的全部扩展。
   *
   * 注意这**不会删掉已经写进对象里的那些值**——`attributes` 是整体替换的，
   * 旧值还在 JSONB 里躺着，只是不再被校验、不再出现在表单上。
   * 那是刻意的：撤一份扩展定义不该顺手改掉一批业务数据。
   */
  async remove(entityType: string): Promise<boolean> {
    const result = await this.#db
      .deleteFrom('ontology_extensions')
      .where('tenant', '=', this.#tenant)
      .where('entity_type', '=', entityType)
      .executeTakeFirst()
    return (result.numDeletedRows ?? 0n) > 0n
  }
}
