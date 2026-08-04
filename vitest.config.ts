import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // UI 套件用 Node 内置 runner，见 tests/ui/README.md：
    // vitest 驱动浏览器子进程时会卡在启动阶段不动
    exclude: ['tests/ui/**', 'node_modules/**'],
    // 集成测试共享一个数据库，串行执行避免互相干扰
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    /**
     * 覆盖率门槛（FR-DOM-001 的验收标准里写着 ≥ 85%）。
     *
     * 阈值定在**当前真实达到的水平**略下方，而不是定在一个好看的目标值。
     * 定成目标值的话，门槛从第一天就是红的，于是它会被 `--no-coverage`
     * 绕过去，然后再也没人看——一条从不通过的检查和没有检查是一回事。
     *
     * 分支覆盖是 82.5%，**低于需求要求的 85%**，所以门槛也定在 80。
     * 这个差距记在 docs/prd-coverage.md 里，没有假装它达标了。
     * 抬高它的方式是补那些没被覆盖的分支，不是调低需求。
     */
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // 迁移是 SQL，入口只是接线——两者都不是逻辑。
      // 后三个是**纯类型文件**（零个运行期导出），按构造就不可能被覆盖：
      // 留在分母里只会稀释掉真正该被覆盖的地方。
      // 加新文件到这个清单之前先确认它真的没有运行期代码
      exclude: [
        'src/main.ts',
        'src/**/migrations/**',
        'src/domain/resource/ports.ts',
        'src/infrastructure/db/schema.ts',
        'src/workflow/types.ts',
        // 这个文件**是被测的**，只是测它的套件用 Node 内置 runner
        // （tests/ui/browser-connector.test.ts，真实 Chromium + 本地页面），
        // 而 vitest 收不到那边的覆盖率。
        //
        // 排除一个"其实测过"的文件是有风险的：它会顺带盖住这个文件里
        // 真正没测到的代码。所以不需要浏览器的那一半——声明、动作范围判定、
        // 参数校验——仍然有一份 vitest 用例（tests/browser-connector.test.ts），
        // 那部分照常被这里的门槛管着。
        'src/infrastructure/connectors/browser.ts',
      ],
      reporter: ['text-summary'],
      thresholds: {
        statements: 90,
        lines: 90,
        functions: 93,
        branches: 85,
      },
    },
  },
})
