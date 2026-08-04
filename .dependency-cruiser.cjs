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
      to: { path: '^src/(ontology|identity|workflow|domain|infrastructure|api)' },
    },
    {
      name: 'ontology-stays-pure',
      severity: 'error',
      comment: '本体层只描述"世界上有什么"，不该知道谁在用它',
      from: { path: '^src/ontology' },
      to: { path: '^src/(identity|workflow|domain|infrastructure|api)' },
    },
    {
      name: 'workflow-stays-pure',
      severity: 'error',
      comment:
        '工作流引擎只回答"这个迁移合不合法"，不该知道资源怎么存、请求从哪来。' +
        '守卫求值所需的数据由调用方装配后传入',
      from: {
        path: '^src/workflow',
        // 显式豁免：automation.ts 只引入 DomainEventType 这个**类型**，
        // 用来声明规则响应哪个事件，不构成对领域逻辑的运行时依赖。
        // 更干净的做法是把事件类型下沉到 platform，M1 按 BC 重组时处理。
        // 豁免写成一条有名字、有理由的例外，而不是把整条规则放松掉。
        pathNot: '^src/workflow/automation\\.ts$',
      },
      to: { path: '^src/(domain|infrastructure|api)' },
    },
    {
      name: 'identity-stays-pure',
      severity: 'error',
      comment: 'PDP 必须是纯函数式的：输入 (主体, 动作, 资源, 上下文)，输出决策。依赖领域层会让它无法被单独测试',
      from: { path: '^src/identity' },
      to: { path: '^src/(workflow|domain|infrastructure|api)' },
    },
    {
      name: 'domain-does-not-know-about-adapters',
      severity: 'error',
      comment: 'domain 只认端口（ports.ts），不认实现',
      from: { path: '^src/domain' },
      to: { path: '^src/(infrastructure|api)' },
    },
    {
      // FR-CON-002：Agent 无法绕过 Connector 直连外部系统。
      //
      // 需求原文说"网络策略 + 代码审查证明无直连路径"。代码审查是人做的，
      // 人会漏——所以这条改成 CI 强制：Agent 运行时里出现任何
      // fetch / http / axios 的痕迹，构建就红。
      //
      // 绕过网关意味着那一次调用**没有审计、没有限流、没有脱敏，
      // 而且凭据可能被写进 prompt**，且全部是静默发生的。
      // 这不是"不应该"，是必须做不到。
      name: 'agents-cannot-reach-the-network-directly',
      severity: 'error',
      comment:
        'Agent 运行时只能经 ConnectorGateway 访问外部系统（FR-CON-002）。' +
        '需要新的外部能力时，写一个 Connector，不要在这里发请求。',
      from: { path: '^src/domain/agent' },
      // 两种写法都要盖住，而且**都验证过会触发**：
      //   npm 包  → 解析后是 node_modules/… 的完整路径
      //   核心模块 → 解析后是裸名 `http`，**不是** `node:http`
      // 第一版只写了 `^node:http$`，种了 `import http from 'node:http'` 也不报——
      // 又一条从不触发的规则。这个项目在这上面栽过，不能再栽第二次。
      to: {
        path:
          '(^|/)node_modules/(axios|node-fetch|got|undici|superagent)(/|$)' +
          '|^(node:)?(http|https|net|dgram|tls)$',
      },
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
      from: { path: '^src/(ontology|identity|workflow)' },
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
