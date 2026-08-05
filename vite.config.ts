import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * React 前端的构建配置。
 *
 * 产物**固定文件名**，不带内容 hash。理由是 `src/api/static.ts` 用的是
 * 白名单而不是拼路径——那条设计挡死了目录穿越，值得保留。
 * hash 文件名会逼着静态服务改成"放开一个目录"，用一点缓存效率
 * 换掉一条结构性的安全保证，不划算（开发期本来就 no-store）。
 *
 * 源码放在 `web/` 而不是 `src/`：`src/` 由 dependency-cruiser 按七层
 * 依赖方向管着，前端代码塞进去只会让那套规则失去意义。
 */
export default defineConfig({
  root: 'web',
  // 产物挂在 /app 下，所以引用路径也要带这个前缀，否则页面会去
  // 根路径找 enterprise.js，而那里是 vanilla 看板的地盘
  base: '/app/',
  plugins: [react()],
  build: {
    outDir: '../public/app',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        entryFileNames: 'enterprise.js',
        chunkFileNames: 'enterprise-[name].js',
        assetFileNames: 'enterprise.[ext]',
      },
    },
  },
})
