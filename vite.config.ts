import vue from '@vitejs/plugin-vue'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { defineConfig, type Plugin } from 'vite'
import { createApiHandler, watchDataDirs } from './scripts/server-core.mjs'
import { startScheduled } from './scripts/auto-run.mjs'

/**
 * 记下这一趟构建完成的时刻（dist/.build-time）。
 * 桌面壳据此判断界面产物有没有落后于源码：dist/index.html 与 public 那批渲染图卡的 mtime 是拷进来的旧值，
 * 拿源码去比它们会天天误判，每次开壳白重建一趟（10-24 实测）。
 */
function markBuildTime(): Plugin {
  return {
    name: 'mark-build-time',
    apply: 'build',
    writeBundle: () => writeFileSync(join(import.meta.dirname, 'dist', '.build-time'), ''),
  }
}

/**
 * 工作台本地服务（开发态）：/__xxx 端点 + 数据目录变动自动刷新 + 每天那几趟排班。
 * 端点逻辑全在 scripts/server-core.mjs——桌面壳（scripts/serve.mjs）挂载的是同一套。
 * 排班在开发态也得挂：读数采集排在 21:47，以前只有 npm run serve 和装机壳会挂它，
 * 只开着 5173 干活的那些天，「平台数据每日采集」一趟都没跑（10-24 至 10-27 复盘整块空）。
 * 两边同时开时由 metrics/auto-run-lock.json 定谁排，抢到的那个挂，另一个只报告。
 */
function workbenchServer(): Plugin {
  return {
    name: 'workbench-server',
    configureServer(server) {
      const logger = server.config.logger
      const api = createApiHandler({
        logger: { info: (m) => logger.info(m) },
      })
      server.middlewares.use((req, res, next) => api.handle(req, res, next))
      watchDataDirs(() => api.refresh(), { info: (m) => logger.info(m) })
      let scheduled: { stop?: () => void } | null = null
      server.httpServer?.once('listening', () => {
        if (server.config.command !== 'serve' || process.env.VITEST) return
        const addr = server.httpServer?.address()
        const port = typeof addr === 'object' && addr ? addr.port : server.config.server.port
        if (!port) return
        scheduled = startScheduled({ root: process.cwd(), port, logger: { info: (m: string) => logger.info(m) } })
      })
      // 关掉开发服务要放锁，否则下一个进程得等心跳过期才敢排班
      server.httpServer?.on('close', () => scheduled?.stop?.())
      process.once('SIGTERM', () => scheduled?.stop?.())
      process.once('SIGINT', () => scheduled?.stop?.())
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [vue(), workbenchServer(), markBuildTime()],
  // content/、metrics/、config/ 与 generated.json 由 watchDataDirs → gen:data → SSE 管刷新：vite 别再
  // 为一次数据重建整页 reload，那会把创作台正开着的编辑弹层冲掉。
  // 图卡 manifest.json 同理——它只是渲染产物清单，被 tailwind 当候选源扫，每次渲图都重发一次 style.css。
  // public/ 的 png 必须留着监听：vite 只在启动时扫一次 public/，新渲的图要靠 watcher 登记才拿得到。
  server: {
    // 跟 npm run serve（scripts/serve.mjs 绑 127.0.0.1）对齐：不写的话 vite 只认 localhost，
    // macOS 上解析成 ::1，用 http://127.0.0.1:5173/ 打不开，采集插件与 curl 走的都是这个地址
    host: '127.0.0.1',
    watch: {
      ignored: [
        '**/content/**',
        '**/metrics/**',
        '**/config/**',
        '**/generated.json',
        '**/cards/**/manifest.json',
      ],
    },
  },
})
