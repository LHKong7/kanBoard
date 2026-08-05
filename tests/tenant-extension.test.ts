import { describe, expect, it } from 'vitest'
import {
  EXTENSION_PREFIX,
  namespaceOf,
  registryFor,
  validateExtension,
} from '../src/ontology/tenant-extension.ts'
import { buildDefaultRegistry } from '../src/ontology/defaults.ts'
import type { TenantExtension } from '../src/ontology/tenant-extension.ts'

/**
 * 租户级本体扩展（FR-ONT-009）。
 *
 * 验收标准：**扩展字段仅本租户可见，命名空间隔离。**
 *
 * 这一组的主题是"隔离破了会怎样"——而答案是**安静地破**：
 * 另一个租户只是多出来几个字段，没有任何报错。
 */

const base = buildDefaultRegistry()

const ext = (tenant: string, name: string, over: Record<string, unknown> = {}): TenantExtension => ({
  tenant,
  entityType: 'Task',
  attributes: [{ name: `${namespaceOf(tenant)}${name}`, kind: 'string', ...over }],
})

describe('the namespace is the isolation (FR-ONT-009)', () => {
  it('prefixes with x_ and the tenant name', () => {
    expect(namespaceOf('acme')).toBe(`${EXTENSION_PREFIX}acme_`)
  })

  it('refuses an unprefixed field', () => {
    // 没有前缀的话，租户加的 `owner` 和平台将来要加的 `owner` 会撞上——
    // 而撞车的表现是升级平台之后某个租户的数据校验不过
    expect(() =>
      validateExtension(
        { tenant: 'acme', entityType: 'Task', attributes: [{ name: 'costCenter', kind: 'string' }] },
        base.entityType('Task'),
      ),
    ).toThrow(/namespaced/)
  })

  it("refuses another tenant's namespace", () => {
    expect(() =>
      validateExtension(
        {
          tenant: 'acme',
          entityType: 'Task',
          attributes: [{ name: 'x_globex_secret', kind: 'string' }],
        },
        base.entityType('Task'),
      ),
    ).toThrow(/namespaced/)
  })

  it('accepts a properly namespaced optional field', () => {
    expect(() => validateExtension(ext('acme', 'costCenter'), base.entityType('Task'))).not.toThrow()
  })
})

describe('what a tenant may not do to a platform type (FR-ONT-009)', () => {
  it('may not add a required field', () => {
    // 加必填 = 这个租户的存量数据下一次写入时全部被拒
    expect(() =>
      validateExtension(ext('acme', 'costCenter', { required: true }), base.entityType('Task')),
    ).toThrow(/optional/)
  })

  it('may not add a derived field', () => {
    // 没有系统代码去写它，于是它永远是空的——
    // 又一个"看起来配置好了、实际什么也不做"的字段
    expect(() =>
      validateExtension(ext('acme', 'stamp', { kind: 'datetime', derived: true }), base.entityType('Task')),
    ).toThrow(/nothing would ever write/)
  })

  it('rejects a duplicate inside one extension', () => {
    expect(() =>
      validateExtension(
        {
          tenant: 'acme',
          entityType: 'Task',
          attributes: [
            { name: 'x_acme_a', kind: 'string' },
            { name: 'x_acme_a', kind: 'int' },
          ],
        },
        base.entityType('Task'),
      ),
    ).toThrow(/duplicated/)
  })

  it('reports every problem at once, not just the first', () => {
    expect(() =>
      validateExtension(
        {
          tenant: 'acme',
          entityType: 'Task',
          attributes: [
            { name: 'noPrefix', kind: 'string' },
            { name: 'x_acme_b', kind: 'string', required: true },
          ],
        },
        base.entityType('Task'),
      ),
    ).toThrow(/invalid tenant extension/)
  })
})

describe('one tenant cannot see another tenant (FR-ONT-009)', () => {
  const extensions: TenantExtension[] = [ext('acme', 'costCenter'), ext('globex', 'ticketId')]

  it('shows a tenant its own extension', () => {
    const acme = registryFor(base, 'acme', extensions)
    const names = acme.entityType('Task').attributes.map((a) => a.name)
    expect(names).toContain('x_acme_costCenter')
  })

  it("does not show it the other tenant's", () => {
    // 隔离破了的表现是安静的：只是多出来几个字段，没有任何报错
    const acme = registryFor(base, 'acme', extensions)
    const names = acme.entityType('Task').attributes.map((a) => a.name)
    expect(names).not.toContain('x_globex_ticketId')
  })

  it('leaves the shared base registry untouched', () => {
    // 就地修改那份共享注册表的话，两个租户的扩展会互相看得见
    registryFor(base, 'acme', extensions)
    registryFor(base, 'globex', extensions)
    const names = base.entityType('Task').attributes.map((a) => a.name)
    expect(names.filter((n) => n.startsWith(EXTENSION_PREFIX))).toEqual([])
  })

  it('refuses to assemble a registry from an invalid extension', () => {
    // 只在 validateExtension 上测是不够的：装配那条路径**自己也得校验**，
    // 否则一份没走过校验的扩展照样能生效。变异测试逮到的
    expect(() =>
      registryFor(base, 'acme', [
        { tenant: 'acme', entityType: 'Task', attributes: [{ name: 'noPrefix', kind: 'string' }] },
      ]),
    ).toThrow(/namespaced/)
  })

  it('returns the base itself when a tenant has no extension', () => {
    // 没扩展就不该白白复制一份注册表
    expect(registryFor(base, 'nobody', extensions)).toBe(base)
  })

  it('keeps the platform attributes alongside the extension', () => {
    const acme = registryFor(base, 'acme', extensions)
    const names = acme.entityType('Task').attributes.map((a) => a.name)
    expect(names).toContain('title')
    expect(names).toContain('assignee')
  })

  it('carries the relation types over too', () => {
    // 只搬实体不搬关系的话，扩展过的那个租户会突然建不了任何关系
    const acme = registryFor(base, 'acme', extensions)
    expect(acme.relationTypes().length).toBe(base.relationTypes().length)
  })

  it('merges several extensions of the same type', () => {
    const many = [ext('acme', 'costCenter'), ext('acme', 'ticketId')]
    const acme = registryFor(base, 'acme', many)
    const names = acme.entityType('Task').attributes.map((a) => a.name)
    expect(names).toContain('x_acme_costCenter')
    expect(names).toContain('x_acme_ticketId')
  })
})

describe('the extension really validates data (FR-ONT-009)', () => {
  const acme = registryFor(base, 'acme', [ext('acme', 'costCenter')])

  it('accepts the extended field on a write', () => {
    expect(() =>
      acme.validateAttributes('Task', { title: 't', x_acme_costCenter: 'CC-100' }),
    ).not.toThrow()
  })

  it('still rejects an unknown field', () => {
    // 扩展口不是"随便写什么都行"的口子
    expect(() => acme.validateAttributes('Task', { title: 't', whatever: 'x' })).toThrow()
  })

  it('the other tenant rejects that same field', () => {
    // **这条就是"仅本租户可见"**：同一份数据，换个租户就写不进去
    const globex = registryFor(base, 'globex', [ext('acme', 'costCenter')])
    expect(() => globex.validateAttributes('Task', { title: 't', x_acme_costCenter: 'CC-100' })).toThrow()
  })
})
