import vue from '@vitejs/plugin-vue'
import { defineConfig, type Plugin } from 'vite'
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import {
  handleCollect, writeDraftMd, deleteDraftMd, autoAnalyze, writeDailyNote, scheduleNote, publishNote, prepareXhsPublish,
} from './scripts/collect-note-core.mjs'

/**
 * 采集接收端点：POST /__collect
 * 浏览器扩展「自媒体工作台采集」把小红书笔记数据 POST 到这里，服务端落盘到 content/参考资料/，
 * 落盘后自动跑 gen:data 刷新页面数据（扩展里点一下，工作台自己出现，不用任何手动步骤）。
 * 仅 dev server 可用（build 产物不包含）。
 */

let genDataTimer: ReturnType<typeof setTimeout> | null = null
function scheduleGenData(logger: { info: (m: string) => void }) {
  if (genDataTimer) clearTimeout(genDataTimer)
  genDataTimer = setTimeout(() => {
    const child = spawn('node', ['scripts/build-data.mjs'], { cwd: process.cwd() })
    child.on('close', (code) => {
      if (code === 0) logger.info('[collect] gen:data 已自动刷新')
      else logger.info(`[collect] gen:data 失败（exit ${code}），手动跑 npm run gen:data 看报错`)
    })
  }, 1200)
}

function json(res: { setHeader: (k: string, v: string) => void; statusCode: number; end: (s?: string) => void }, code: number, obj: unknown) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.statusCode = code
  res.end(JSON.stringify(obj))
}

function collectApi(): Plugin {
  return {
    name: 'collect-api',
    configureServer(server) {
      // 采集端点：浏览器扩展 → 参考资料
      server.middlewares.use('/__collect', (req, res) => {
        res.setHeader('Access-Control-Allow-Origin', '*')
        res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
        if (req.method === 'OPTIONS') {
          res.statusCode = 204
          res.end()
          return
        }
        if (req.method !== 'POST') {
          res.statusCode = 405
          res.end(JSON.stringify({ ok: false, error: 'POST only' }))
          return
        }
        let body = ''
        req.on('data', (c) => (body += c))
        req.on('end', async () => {
          try {
            const result = await handleCollect(JSON.parse(body || '{}'))
            json(res, 200, result)
            server.config.logger.info(
              `[collect] ${result.file}${result.image ? ` (+图)` : ''}${result.keptAnalysis ? ` (已保留拆解)` : ''}`,
            )
            scheduleGenData(server.config.logger)
            // 异步触发百炼自动拆解；完成后再刷一次数据（失败不阻塞，保持待拆解状态）
            autoAnalyze(result.file)
              .then((r) => {
                if (r.ok && r.analyzed) {
                  server.config.logger.info(`[collect] AI 拆解完成 → 自动刷新`)
                  scheduleGenData(server.config.logger)
                } else if (r.error) {
                  server.config.logger.info(`[collect] AI 拆解跳过：${r.error}`)
                }
              })
              .catch(() => {})
          } catch (e) {
            json(res, 400, { ok: false, error: String((e as Error).message || e) })
          }
        })
      })
    },
  }
}

/** 草稿端点：灵感一键转选题 → 落 md 文件（文件驱动，替代浏览器便签） */
function draftApi(): Plugin {
  return {
    name: 'draft-api',
    configureServer(server) {
      server.middlewares.use('/__draft', (req, res) => {
        res.setHeader('Access-Control-Allow-Origin', '*')
        res.setHeader('Access-Control-Allow-Methods', 'POST, DELETE, OPTIONS')
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
        if (req.method === 'OPTIONS') {
          res.statusCode = 204
          res.end()
          return
        }
        if (req.method === 'DELETE') {
          try {
            const rel = decodeURIComponent((req.url || '').replace(/^\/?\?file=/, ''))
            const r = deleteDraftMd(rel)
            json(res, 200, r)
            server.config.logger.info(`[draft] 已删除 ${rel}`)
            scheduleGenData(server.config.logger)
          } catch (e) {
            json(res, 400, { ok: false, error: String((e as Error).message || e), got: req.url })
          }
          return
        }
        if (req.method !== 'POST') {
          json(res, 405, { ok: false, error: 'POST/DELETE only' })
          return
        }
        let body = ''
        req.on('data', (c) => (body += c))
        req.on('end', () => {
          try {
            const r = writeDraftMd(JSON.parse(body || '{}'))
            json(res, 200, { ok: true, ...r })
            server.config.logger.info(`[draft] ${r.rel}`)
            scheduleGenData(server.config.logger)
          } catch (e) {
            json(res, 400, { ok: false, error: String((e as Error).message || e) })
          }
        })
      })
    },
  }
}

/** 标记已发布端点：写入发布链接，状态自动 published */
function publishApi(): Plugin {
  return {
    name: 'publish-api',
    configureServer(server) {
      server.middlewares.use('/__publish', (req, res) => {
        res.setHeader('Access-Control-Allow-Origin', '*')
        res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
        if (req.method === 'OPTIONS') {
          res.statusCode = 204
          res.end()
          return
        }
        if (req.method !== 'POST') {
          json(res, 405, { ok: false, error: 'POST only' })
          return
        }
        let body = ''
        req.on('data', (c) => (body += c))
        req.on('end', () => {
          try {
            const { rel, link, platform } = JSON.parse(body || '{}')
            if (!rel) throw new Error('缺少 rel')
            const r = publishNote(rel, link || '', platform || '')
            if (!r.ok) throw new Error(r.error)
            json(res, 200, { ok: true })
            server.config.logger.info(`[publish] ${rel} → ${link || '(无链接)'}`)
            scheduleGenData(server.config.logger)
          } catch (e) {
            json(res, 400, { ok: false, error: String((e as Error).message || e) })
          }
        })
      })
    },
  }
}

// 浏览器自动化可执行文件：优先环境变量，否则要求 ego-browser 在 PATH 上。
// 不要写死个人绝对路径——仓库是要公开的。
const EGO_BIN = process.env.EGO_BIN || 'ego-browser'

/** 一键发布端点：组装 payload → spawn ego-browser 自动填小红书发布页（停在发布按钮前，最后一下人点） */
function autopublishApi(): Plugin {
  return {
    name: 'autopublish-api',
    configureServer(server) {
      server.middlewares.use('/__autopublish', (req, res) => {
        res.setHeader('Access-Control-Allow-Origin', '*')
        res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
        if (req.method === 'OPTIONS') {
          res.statusCode = 204
          res.end()
          return
        }
        if (req.method !== 'POST') {
          json(res, 405, { ok: false, error: 'POST only' })
          return
        }
        let body = ''
        req.on('data', (c) => (body += c))
        req.on('end', () => {
          try {
            const { rel, platform } = JSON.parse(body || '{}')
            if (platform && platform !== '小红书') throw new Error('一键发布目前只支持小红书（图文）；其他平台先手动')
            const info = prepareXhsPublish(rel)
            server.config.logger.info(`[autopublish] 组装完成：${info.title}（${info.lines} 行 / ${info.tags} 话题）`)

            const script = readFileSync('./scripts/publish-xhs.mjs', 'utf8')
            const child = spawn(EGO_BIN, ['nodejs'], { stdio: ['pipe', 'pipe', 'pipe'] })
            let out = ''
            const timer = setTimeout(() => child.kill('SIGKILL'), 330000)
            child.stdin.write(script)
            child.stdin.end()
            child.stdout.on('data', (c) => (out += c))
            child.stderr.on('data', (c) => (out += c))
            child.on('close', () => {
              clearTimeout(timer)
              try {
                const m = out.match(/\{[\s\S]*\}/)
                const result = m ? JSON.parse(m[0]) : { ok: false, error: out.slice(-400) }
                json(res, 200, { ...result, log: out.slice(-600) })
                server.config.logger.info(`[autopublish] 结果: ${JSON.stringify(result).slice(0, 200)}`)
              } catch (e) {
                json(res, 500, { ok: false, error: String((e as Error).message || e), log: out.slice(-600) })
              }
            })
          } catch (e) {
            json(res, 400, { ok: false, error: String((e as Error).message || e) })
          }
        })
      })
    },
  }
}

/** 排期端点：待排期 → 已排期（mv 文件 + 日期命名） */
function scheduleApi(): Plugin {
  return {
    name: 'schedule-api',
    configureServer(server) {
      server.middlewares.use('/__schedule', (req, res) => {
        res.setHeader('Access-Control-Allow-Origin', '*')
        res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
        if (req.method === 'OPTIONS') {
          res.statusCode = 204
          res.end()
          return
        }
        if (req.method !== 'POST') {
          json(res, 405, { ok: false, error: 'POST only' })
          return
        }
        let body = ''
        req.on('data', (c) => (body += c))
        req.on('end', () => {
          try {
            const { rel, date } = JSON.parse(body || '{}')
            if (!rel || !date) throw new Error('缺少 rel 或 date')
            const r = scheduleNote(rel, date)
            json(res, 200, { ...r, ok: true })
            server.config.logger.info(`[schedule] ${date} ← ${rel}`)
            scheduleGenData(server.config.logger)
          } catch (e) {
            json(res, 400, { ok: false, error: String((e as Error).message || e) })
          }
        })
      })
    },
  }
}

/** AI 创作端点：草稿 → 日更成稿（Token Plan qwen3.7-plus） */
function writeApi(): Plugin {
  return {
    name: 'write-api',
    configureServer(server) {
      server.middlewares.use('/__write', (req, res) => {
        res.setHeader('Access-Control-Allow-Origin', '*')
        res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
        if (req.method === 'OPTIONS') {
          res.statusCode = 204
          res.end()
          return
        }
        if (req.method !== 'POST') {
          json(res, 405, { ok: false, error: 'POST only' })
          return
        }
        let body = ''
        req.on('data', (c) => (body += c))
        req.on('end', async () => {
          try {
            const { rel } = JSON.parse(body || '{}')
            if (!rel) throw new Error('缺少 rel')
            const r = await writeDailyNote(rel)
            if (!r.ok) throw new Error(r.error)
            json(res, 200, { ok: true })
            server.config.logger.info(`[write] AI 已完成日更 ${rel}`)
            scheduleGenData(server.config.logger)
          } catch (e) {
            json(res, 400, { ok: false, error: String((e as Error).message || e) })
          }
        })
      })
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [vue(), collectApi(), draftApi(), writeApi(), scheduleApi(), publishApi(), autopublishApi()],
})
