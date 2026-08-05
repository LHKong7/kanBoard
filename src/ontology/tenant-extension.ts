import { ValidationError } from '../platform/errors.ts'
import { OntologyRegistry } from './registry.ts'
import type { AttributeType, EntityTypeDef } from './types.ts'

/**
 * 租户级本体扩展（FR-ONT-009）。
 *
 * 验收标准：**扩展字段仅本租户可见，命名空间隔离。**
 *
 * 需要它的理由很实际：每个团队都有几个自己才用的字段（内部工单号、
 * 成本中心、某个合规要求的标记）。不给扩展口，这些东西会挤进
 * `description` 里变成一段没人能查询的自由文本——**而那正是
 * 本体想解决的问题**。
 *
 * 两条硬约束：
 *
 * 1. **必须带命名空间前缀**（`x_` + 租户名）。没有前缀的话，一个租户
 *    加了个 `owner` 字段，将来平台自己也想加 `owner`，两者就撞上了——
 *    而撞车的表现是升级平台之后某个租户的数据校验不过。
 * 2. **扩展只能加可选属性。** 加必填的会让**这个租户的存量数据**
 *    在下一次写入时全部被拒；改类型、删字段同理。
 *    这和 FR-ONT-007 的 minor 兼容规则是同一条道理，
 *    只是这里连"升 major"这个出口都不给——平台的类型不归租户改。
 */

/** 扩展字段的前缀。`x_` 取自 HTTP 扩展头的老习惯，一眼看得出不是平台字段 */
export const EXTENSION_PREFIX = 'x_'

export function namespaceOf(tenant: string): string {
  return `${EXTENSION_PREFIX}${tenant}_`
}

/** 一个租户对某个类型的扩展 */
export type TenantExtension = {
  tenant: string
  entityType: string
  attributes: readonly AttributeType[]
}

/**
 * 校验一份扩展。纯函数，**先判定再落库**——
 * 一份写错的扩展如果先生效再报错，这个租户的写入会在它自己
 * 察觉之前就开始失败。
 */
export function validateExtension(ext: TenantExtension, base: EntityTypeDef): void {
  const ns = namespaceOf(ext.tenant)
  const baseNames = new Set(base.attributes.map((a) => a.name))
  const problems: { path: string; message: string }[] = []

  for (const attr of ext.attributes) {
    if (!attr.name.startsWith(ns)) {
      problems.push({
        path: attr.name,
        message: `tenant extensions must be namespaced with "${ns}"`,
      })
      continue
    }
    if (baseNames.has(attr.name)) {
      // 到不了这里（平台字段不带 x_ 前缀），但平台将来若加了带前缀的字段
      // 就会走到——那时应当报冲突，而不是让租户悄悄覆盖平台定义
      problems.push({ path: attr.name, message: 'collides with a platform attribute' })
      continue
    }
    if (attr.required === true) {
      // 加必填 = 这个租户的存量数据下一次写入时全部被拒
      problems.push({
        path: attr.name,
        message: 'tenant extensions must be optional; a required one would reject existing records',
      })
    }
    if (attr.derived === true) {
      // derived 意味着"由系统写入"，而扩展字段没有系统代码去写它，
      // 于是它会永远是空的——又一个"看起来配置好了、实际什么也不做"的字段
      problems.push({ path: attr.name, message: 'nothing would ever write a derived extension' })
    }
  }

  const seen = new Set<string>()
  for (const attr of ext.attributes) {
    if (seen.has(attr.name)) problems.push({ path: attr.name, message: 'duplicated in this extension' })
    seen.add(attr.name)
  }

  if (problems.length > 0) {
    // 理由写进**消息**，不只写进 details。日志里通常只有消息那一行，
    // 而"invalid tenant extension of Task"这句话不含任何可操作的信息——
    // 读到它的人还得去翻结构化字段，而多数时候他翻不到
    const why = problems.map((p) => `${p.path}: ${p.message}`).join('; ')
    throw new ValidationError(
      `invalid tenant extension of "${ext.entityType}" for tenant "${ext.tenant}" — ${why}`,
      { entityType: ext.entityType, tenant: ext.tenant, fields: problems },
    )
  }
}

/**
 * 按租户装配出一份注册表。
 *
 * 返回的是**一份新的注册表**，不是在共享那份上打补丁。
 * 就地修改的话，两个租户的扩展会互相看得见——而"仅本租户可见"
 * 这句话一旦破了，破的方式是安静的：另一个租户只是多出来几个字段，
 * 没有任何报错。
 *
 * 代价是每个租户一份注册表。它很小（几十个类型定义），
 * 而且可以缓存；用共享注册表加 if 判断省下的那点内存，
 * 换来的是一个只在多租户下才出现、且极难复现的泄漏。
 */
export function registryFor(
  base: OntologyRegistry,
  tenant: string,
  extensions: readonly TenantExtension[],
): OntologyRegistry {
  const mine = extensions.filter((e) => e.tenant === tenant)
  if (mine.length === 0) return base

  const extended = new OntologyRegistry()
  for (const relation of base.relationTypes()) extended.registerRelation(relation)

  const byType = new Map<string, AttributeType[]>()
  for (const ext of mine) {
    const target = base.entityType(ext.entityType)
    validateExtension(ext, target)
    byType.set(ext.entityType, [...(byType.get(ext.entityType) ?? []), ...ext.attributes])
  }

  for (const def of base.entityTypes()) {
    const extra = byType.get(def.name)
    extended.registerEntity(
      extra === undefined ? def : { ...def, attributes: [...def.attributes, ...extra] },
    )
  }
  return extended
}
