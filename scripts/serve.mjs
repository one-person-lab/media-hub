#!/usr/bin/env node
/**
 * 独立工作台本地服务：/__xxx 端点 + generated.json 运行时数据 + dist 静态站。
 * 端点与文件监听复用 scripts/server-core.mjs，行为和 dev server 完全一致。
 * 消费方：`npm run serve` 直接起；electron/main.mjs import createWorkbenchServer 做桌面壳。
 * 没构建过就打开界面时不让人去敲命令：这一页自己起一次构建，构建完自动刷新（见 ensureBuilt）。
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { createReadStream, existsSync, mkdirSync, readdirSync, renameSync, statSync, watch, writeFileSync } from 'node:fs'
import { dirname, extname, join, normalize, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createApiHandler, watchDataDirs, ensureGeneratedData, isRemoteMode } from './server-core.mjs'
import { humanize } from './error-catalog.mjs'
import { startScheduled } from './auto-run.mjs'

const ROOT = join(import.meta.dirname, '..')
const DIST = join(ROOT, 'dist')
const PUBLIC = join(ROOT, 'public')

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.mp4': 'video/mp4',
}

function json(res, code, obj) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.statusCode = code
  res.end(JSON.stringify(humanize(obj)))
}

/** 原文进页面前只能当文字，报错里带尖括号也不能把这一页撑破 */
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

/** 首次使用没有 dist/：界面自己构建一次。同一时刻只起一个，失败原因留着给那一页显示 */
let build = null

function ensureBuilt(logger) {
  if (existsSync(join(DIST, 'index.html'))) return 'ready'
  if (build?.state === 'running') return 'running'
  logger.info('[build] 界面还没构建，开始构建（首次约一分钟）')
  build = { state: 'running', detail: '' }
  const child = spawn('npm', ['run', 'build'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] })
  const collect = (c) => (build.detail = (build.detail + c).slice(-1500))
  child.stdout.on('data', collect)
  child.stderr.on('data', collect)
  child.on('error', (e) => (build = { state: 'failed', detail: `构建起不来：${e.message}` }))
  child.on('close', (code) => {
    build = existsSync(join(DIST, 'index.html'))
      ? { state: 'ready', detail: '' }
      : { state: 'failed', detail: build.detail || `构建没出产物（退出码 ${code}）` }
    if (build.state === 'ready') markBuilt()
    logger.info(`[build] ${build.state}`)
  })
  return build.state
}

/** npm 会先打一大段无关的行，把带 error 的那一行挑出来，末行兜底 */
function buildReason(detail) {
  const lines = String(detail || '').split('\n').map((l) => l.trim()).filter(Boolean)
  return (lines.find((l) => /error|Error|失败|ENOENT|EPERM/.test(l)) || lines.pop() || '界面构建失败').slice(0, 300)
}

/**
 * 界面构建于 <repo>/dist/.build-time（不进版本库）。
 * dist/index.html 与 public 那批渲染产物的 mtime 是拷进来的旧值，拿源码去比它们会天天误判落后，
 * 所以比的是「上一次构建完成的时刻」。
 */
const BUILD_STAMP = join(DIST, '.build-time')

function distBuiltAt() {
  if (!existsSync(join(DIST, 'index.html'))) return 0
  try {
    return statSync(BUILD_STAMP).mtimeMs
  } catch {
    return statSync(join(DIST, 'index.html')).mtimeMs // 老 dist 没这记录，只能拿它的 mtime 比
  }
}

function markBuilt() {
  try {
    writeFileSync(BUILD_STAMP, '')
  } catch { /* 记不上只是下次启动多补一次构建，不影响服务 */ }
}

/** 构建之后又有人改过 src：桌面壳一启动就自己补一次 */
function srcIsNewerThanDist() {
  const stamp = distBuiltAt()
  const hit = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'generated.json') continue // 运行时数据不进 bundle，为它重建没意义
      const p = join(dir, e.name)
      if (e.isDirectory() ? hit(p) : statSync(p).mtimeMs > stamp) return true
    }
    return false
  }
  return hit(join(ROOT, 'src')) || statSync(join(ROOT, 'index.html')).mtimeMs > stamp
}

/**
 * 桌面壳开发态的实时构建：改 src 下的 .vue/.ts/.css/.svg 就重跑一次 vite build，
 * 成功即回调，窗口据此重载。
 * 只跑 vite build 不走 npm run build——vue-tsc 那一趟太慢，类型检查留给正式构建。
 * 构建失败继续服务旧 dist（reload 时人看到的还是上一版界面），原因写进日志，没产物时才显示失败页。
 */
function startLiveBuild({ logger, onRebuilt }) {
  const MAX_RERUN = 6
  let child = null
  let timer = null
  let dirty = false
  let reruns = 0
  let last = { state: 'idle', detail: '' }

  function schedule() {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => ((timer = null), run()), 400)
  }

  function run() {
    if (child) return (dirty = true)
    last = { state: 'running', detail: '' }
    child = spawn(join(ROOT, 'node_modules', '.bin', 'vite'), ['build'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] })
    const collect = (c) => (last.detail = (last.detail + c).slice(-4000))
    child.stdout.on('data', collect)
    child.stderr.on('data', collect)
    child.on('error', (e) => {
      child = null
      last = { state: 'failed', detail: `构建起不来：${e.message}` }
      logger.info(`[live] ${last.detail}`)
    })
    child.on('close', (code) => {
      child = null
      const ok = code === 0 && existsSync(join(DIST, 'index.html'))
      last = ok ? { state: 'ready', detail: '' } : { state: 'failed', detail: last.detail || `构建没出产物（退出码 ${code}）` }
      if (ok) markBuilt()
      logger.info(ok ? '[live] 界面已重建' : `[live] 构建失败：${buildReason(last.detail)}`)
      // 构建途中又有改动就补一趟；连着补满 6 趟还没清完说明不是人在打字（10-24 是一次空转刷了 28 趟），
      // 那就拿现有产物先重载让人看见，别陪着无限建下去
      if (ok && dirty && ++reruns < MAX_RERUN) return schedule()
      reruns = 0
      dirty = false
      if (ok) onRebuilt?.() // 失败不重载：旧界面还在服务，别把人的页刷成 503
    })
  }

  /** 界面产物的状态：构建途中 vite 会先清空 dist，那一瞬不能让每次请求都点着第二趟 */
  function distState() {
    if (existsSync(join(DIST, 'index.html'))) return 'ready'
    if (last.state === 'failed') return 'failed'
    if (!child && !timer) schedule()
    return 'running'
  }

  // 只认源码：gen:data 会往 src/data 里写 generated.json 与它的 .tmp，不按扩展名收口的话
  // 一次数据刷新就牵一趟界面重建；src 下真正进 bundle 的料只有 vue/ts/css/svg。
  const isSource = (file) => /\.(vue|ts|css|svg)$/.test(String(file))
  try {
    watch(join(ROOT, 'src'), { recursive: true }, (_event, file) => {
      if (isSource(file)) schedule()
    })
    // 根 index.html 故意不盯：macOS 上 fs.watch 盯单个文件是「盯所在目录按文件名过滤」，
    // 而 vite build 每趟都要写 dist/index.html —— 自己勾着自己，构建永远停不下来
    // （10-24 实测：真实 index.html 的 mtime 一动没动，半小时报了 28 次触发）。
    // 它改了要自己重启一次进程，改动面比 src 小得多。
  } catch (e) {
    logger.info(`[live] 源码监听没挂上：${e.message}`)
  }
  if (srcIsNewerThanDist()) schedule()

  return { distState, detail: () => last.detail }
}

/** 构建中 / 构建失败这两屏，样式不能依赖 dist 里的 CSS（它还不存在），所以内联 */
export function pendingPage(state, reason) {
  const card = state === 'failed'
    ? `<h1>界面没建起来</h1><p>${esc(reason)}</p><button onclick="location.reload()">再试一次</button>`
    : '<h1>界面正在准备</h1><p>第一次打开要先构建一次界面，通常不到一分钟。建好这一页自己就跳过去。</p>'
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${state === 'failed' ? '' : '<meta http-equiv="refresh" content="5">'}
<title>创作者增长平台</title>
<style>body{margin:0;background:#f7efe1;color:#111;display:grid;place-items:center;min-height:100vh;
font:15px/1.7 -apple-system,"PingFang SC","Hiragino Sans GB",sans-serif}
.card{background:#fffcf5;border:2px solid #111;border-radius:12px;box-shadow:4px 4px 0 #111;
padding:28px 30px;max-width:30rem;text-align:center}
h1{font-size:19px;margin:0 0 10px}p{margin:0 0 18px;color:#4a4438;font-size:13.5px;word-break:break-word}
button{font:inherit;font-weight:700;padding:9px 20px;border:2px solid #111;border-radius:999px;
background:#ffe89b;cursor:pointer}</style></head><body><div class="card">${card}</div></body></html>`
}

/**
 * 静态文件定位：先查构建快照 dist，再查 public。
 * build 之后才落盘的运行时产物（渲出来的图卡、动效成片）只存在于 public，
 * dev 下 vite 会直接服务 public，独立服务与 Electron 壳必须自己回查，否则 URL 会静默回退到 index.html。
 */
export function resolveStaticFile(pathname, bases = [DIST, PUBLIC]) {
  let escaped = true
  for (const base of bases) {
    const file = normalize(join(base, pathname))
    if (file === base || !file.startsWith(base + sep)) continue
    escaped = false
    if (existsSync(file) && !statSync(file).isDirectory()) return { file }
  }
  return escaped ? { forbidden: true } : { miss: true }
}

/** 带扩展名的是资源（封面、图卡、源片、字体），不是界面路由。
 *  这类请求没命中就不能回 index.html：浏览器会拿到一份 200 的 HTML 当图解码，
 *  界面裂成一片而日志里一条异常都没有（10-25 客户端封面全丢就是这么藏过去的）。 */
export function isAssetPath(pathname) {
  const ext = extname(pathname)
  return ext !== '' && ext !== '.html' && ext !== '.htm'
}

/** 桌面版抢不到 5173 就用随机端口，外面（定时任务、采集脚本、排查的人）得能不猜就连上当前这一个。 */
function writeEndpointFile(port, logger) {
  const file = join(ROOT, 'metrics', 'server.json')
  try {
    mkdirSync(dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify({ port, url: `http://127.0.0.1:${port}`, pid: process.pid, startedAt: Date.now() }, null, 1))
    renameSync(tmp, file)
  } catch (e) {
    logger.info(`[serve] 端口文件没写成：${e.message}`)
  }
}

/**
 * 建工作台 HTTP 服务（未 listen）。监听 content/config/metrics 变动自动重建数据并 SSE 通知前端。
 * liveBuild 只给桌面壳的开发态用（electron/main.mjs）：打包态不传，界面永远不会自己重建。
 */
export function createWorkbenchServer({ logger = { info: (m) => console.log(m) }, liveBuild } = {}) {
  ensureGeneratedData(logger)
  const api = createApiHandler({ logger })
  watchDataDirs(() => api.refresh(), logger)
  const builder = liveBuild
    ? startLiveBuild({ logger, onRebuilt: liveBuild.onRebuilt })
    : { distState: () => ensureBuilt(logger), detail: () => build?.detail ?? '' }
  const { distState, detail } = builder

  /** 构建中/构建失败那一屏：样式不能依赖 dist 里的 CSS（它还不存在），所以内联在 pendingPage 里 */
  function pending(res, state) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    res.statusCode = 503
    res.end(pendingPage(state, state === 'failed' ? buildReason(detail()) : ''))
  }

  function serveStatic(req, res) {
    if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'GET only' })
    // 只在要端界面文件时管产物状态：接口那侧照常走，否则一趟构建会把 /__run-script 挡成 503
    const state = distState()
    if (state !== 'ready') return pending(res, state)
    const path = decodeURIComponent(new URL(req.url || '/', 'http://media-hub.local').pathname)
    const found = resolveStaticFile(path)
    if (found.forbidden) return json(res, 403, { ok: false, error: 'forbidden' })
    // 内容图片走的是这一路，压根不查端点那张表：不补这一刀，未登录的人直接 GET /cards/<短码>/01.png
    // 就拿到号主没发布那篇的真图卡了。服务器上游客只许拿自己那一屏引用到的文件。
    if (!api.assetAllowed(req, path)) return json(res, 401, { ok: false, error: '请先登录' })
    // 纯静态托管那一份（外网上 nginx 直发 dist，没有本地服务）：界面开局 fetch 的读数文件取仓库里现成的这一份。
    // 缺了它界面就是一屏空壳——9 月那次拷上去没人看得见东西，缺的正是这一步。
    if (!found.file && path === '/generated.json') {
      res.setHeader('Content-Type', 'application/json; charset=utf-8')
      return createReadStream(join(ROOT, 'src', 'data', 'generated.json')).pipe(res)
    }
    if (!found.file && isAssetPath(path)) {
      logger.info(`[serve] 资源缺件：${path}`)
      return json(res, 404, { ok: false, error: `not found: ${path}` })
    }
    const file = found.file ?? join(DIST, 'index.html') // SPA 路由回退
    res.setHeader('Content-Type', MIME[extname(file)] || 'application/octet-stream')
    createReadStream(file).pipe(res)
  }

  const server = createServer((req, res) => api.handle(req, res, () => serveStatic(req, res)))
  // 端口可能被别的进程占着（Electron 壳会退回随机端口），每次 listening 都重写端口文件；
  // 排班只挂一次，占着同一只浏览器的单飞队列在服务端，定时和人点的那一趟不会并发。
  let scheduled = false
  let scheduledApi = null
  server.on('listening', () => {
    const port = server.address()?.port
    if (!port) return
    writeEndpointFile(port, logger)
    if (scheduled) return
    scheduled = true
    // 远程那份没有本机浏览器桥：排班照常挂只会到点空跑一趟采集然后报「脚本没起来」
    if (isRemoteMode()) {
      logger.info('[serve] 远程模式：自动排班不挂（采集、检测、推草稿都归桌面客户端）')
      return
    }
    scheduledApi = startScheduled({ root: ROOT, port, logger })
  })
  // 收工就把锁放掉：留着下一个进程等三分钟心跳过期才敢排班（开发服务天天重启）
  const releaseScheduler = () => scheduledApi?.stop?.()
  process.once('SIGTERM', releaseScheduler)
  process.once('SIGINT', releaseScheduler)
  return server
}

/* 直接运行（npm run serve）才监听端口；被 Electron import 时不产生副作用 */
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const PORT = Number(process.env.PORT) || 5173
  // 默认只听回环：采集扩展、cron、Electron 走的都是 127.0.0.1。
  // 要同一局域网里别的设备也能开，才 WORKBENCH_HOST=0.0.0.0 —— 这一步不附带鉴权，只在可信网络里开
  const HOST = process.env.WORKBENCH_HOST || '127.0.0.1'
  createWorkbenchServer().listen(PORT, HOST, () => {
    console.log(`[serve] 工作台已就绪：http://localhost:${PORT}（采集扩展默认连 5173，监听 ${HOST}）`)
    if (!existsSync(join(DIST, 'index.html'))) console.log('[serve] dist/ 还没构建：第一次打开界面会自己构建，建好那页自动刷新')
  })
}
