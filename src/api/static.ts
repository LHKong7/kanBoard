import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'

/**
 * 静态资源。
 *
 * 用**白名单**而不是拼路径：`join(root, request.params['*'])` 那种写法
 * 一旦漏了规范化就是目录穿越。白名单让穿越在结构上不可能发生，
 * 代价只是每加一个文件要登记一次——UI 只有三个文件，这个代价可以接受。
 */
const ASSET_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'public')

const ASSETS: Record<string, { file: string; type: string }> = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/index.html': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
  '/style.css': { file: 'style.css', type: 'text/css; charset=utf-8' },
}

export function registerStatic(app: FastifyInstance): void {
  for (const [route, asset] of Object.entries(ASSETS)) {
    app.get(route, async (_request, reply) => {
      const body = await readFile(join(ASSET_ROOT, asset.file), 'utf8')
      return reply
        .header('content-type', asset.type)
        // 开发期不缓存：改一行 CSS 就要清缓存的体验会让人干脆不改
        .header('cache-control', 'no-store')
        .send(body)
    })
  }
}
