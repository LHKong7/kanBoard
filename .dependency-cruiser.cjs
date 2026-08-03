/**
 * 分层依赖方向的强制校验（FR-ARCH-001）。
 *
 * ADR-0007 换到 TypeScript 后，Go 侧的静态分析没有了，这份配置是它的替代。
 * 层次从下到上：
 *
 *   platform  →  ontology  →  identity  →  domain  →  infrastructure  →  api
 *
 * 上层可以依赖下层，反向一律禁止。
 * 最关键的是 domain 层不得接触任何框架——领域模型一旦跟 Kysely 或 Fastify
 * 绑在一起，换存储或换传输就得改业务代码，DDD 的边界也就名存实亡了。
 */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      comment: '循环依赖说明层次划分出了问题，不是加个接口就能绕过去的',
      from: {},
      to: { circular: true },
    },
    {
      name: 'platform-is-the-bottom',
      severity: 'error',
      comment: 'platform 是纯工具层，不得依赖任何业务层',
      from: { path: '^src/platform' },
      to: { path: '^src/(ontology|identity|domain|infrastructure|api)' },
    },
    {
      name: 'ontology-stays-pure',
      severity: 'error',
      comment: '本体层只描述"世界上有什么"，不该知道谁在用它',
      from: { path: '^src/ontology' },
      to: { path: '^src/(identity|domain|infrastructure|api)' },
    },
    {
      name: 'identity-stays-pure',
      severity: 'error',
      comment: 'PDP 必须是纯函数式的：输入 (主体, 动作, 资源, 上下文)，输出决策。依赖领域层会让它无法被单独测试',
      from: { path: '^src/identity' },
      to: { path: '^src/(domain|infrastructure|api)' },
    },
    {
      name: 'domain-does-not-know-about-adapters',
      severity: 'error',
      comment: 'domain 只认端口（ports.ts），不认实现',
      from: { path: '^src/domain' },
      to: { path: '^src/(infrastructure|api)' },
    },
    {
      name: 'infrastructure-does-not-know-about-api',
      severity: 'error',
      from: { path: '^src/infrastructure' },
      to: { path: '^src/api' },
    },
    {
      name: 'domain-is-framework-free',
      severity: 'error',
      comment:
        '领域层不得 import fastify / kysely / pg / zod。' +
        '这条是分层的试金石：一旦破了，后面所有关于"可替换存储"的说法都不成立',
      from: { path: '^src/domain' },
      // 匹配的是**解析后**的路径。pnpm 下形如
      // `node_modules/.pnpm/kysely@0.27.6/node_modules/kysely/dist/esm/index.js`，
      // 所以必须锚在 `node_modules/<pkg>/` 这一段上，写 `^kysely` 永远匹配不到。
      to: {
        dependencyTypes: ['npm'],
        path: '(^|/)node_modules/(fastify|kysely|pg)(/|$)',
      },
    },
    {
      name: 'ontology-and-identity-are-framework-free',
      severity: 'error',
      comment: 'zod 是本体层生成校验器用的，允许；数据库与 HTTP 框架不允许',
      from: { path: '^src/(ontology|identity)' },
      to: {
        dependencyTypes: ['npm'],
        path: '(^|/)node_modules/(fastify|kysely|pg)(/|$)',
      },
    },
    {
      name: 'no-orphans',
      severity: 'warn',
      comment: '孤儿模块要么是死代码，要么是忘了接上去',
      from: { orphan: true, pathNot: ['^src/main\\.ts$'] },
      to: {},
    },
    {
      name: 'no-dev-deps-in-src',
      severity: 'error',
      from: { path: '^src' },
      to: { dependencyTypes: ['npm-dev'] },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
      extensions: ['.ts', '.js'],
    },
    reporterOptions: {
      text: { highlightFocused: true },
    },
  },
}
