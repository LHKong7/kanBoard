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
  },
})
