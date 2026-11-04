/**
 * 打包态入口（构建时由 scripts/build-app.mjs 复制进 .app/Contents/Resources/app/main.cjs）。
 *
 * 与开发态 electron/main.mjs 只差一件事：数据根不能是包内目录。
 * 首启把包内 seed（脚本 + 静态站 + 配置骨架 + 二进制）复制到 ~/Library/Application Support/创作者增长平台，
 * 之后稿件、读数、登录态全写在那儿——包放 /Applications 只读位也照样能干活。
 * serve.mjs 与各采集脚本的 ROOT 都按 `import.meta.dirname/..` 或注入的 cwd 解析，
 * 所以只要从数据目录里 import 那一份 serve.mjs，整条链就落在数据目录上，包内一个字节都不写。
 *
 * 必须是 CJS：Electron 的 main 进程里 `import { app } from 'electron'` 拿不到具名导出，
 * 包内 ESM 入口会直接 SyntaxError 退出（10-23 装机实测）。
 */
const { app, BrowserWindow, shell } = require('electron')
const { appendFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const { pathToFileURL } = require('node:url')

const NAME = '创作者增长平台'
app.setName(NAME)
const SEED = join(process.resourcesPath, 'seed')
const DATA = join(app.getPath('appData'), NAME)

/** 双击启动时 stdout 全丢，出问题只能靠这份启动日志定位（崩溃的人不会自己开终端）。
 *  而且这条 stdout 是一根已经断掉的管子：写它直接 EPIPE 抛穿主进程（10-23 装机实测，Finder 双击即死），
 *  所以 console 的每一条也得拐进这份日志，不能只靠 try/catch 哑着。 */
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`
  try {
    appendFileSync(join(DATA, 'app-boot.log'), `${line}\n`)
  } catch { /* 数据目录还没建就先哑着 */ }
}
for (const k of ['log', 'warn', 'error']) {
  console[k] = (...args) => log(`[${k}] ${args.map((a) => (typeof a === 'string' ? a : String(a))).join(' ')}`)
}
process.on('uncaughtException', (e) => log(`未捕获异常：${e?.stack || e}`))
process.on('unhandledRejection', (e) => log(`未处理的 Promise 失败：${e?.stack || e}`))

/** GUI 起的进程 PATH 只有系统那几条，而采集要 spawn node 与 ego-browser，两个都得到。
 *  构建时把那台机器跑通过的 PATH 记在包内 env.json；换机分发不能靠它，要走检测/引导安装（docs/ONBOARDING.md）。 */
function fixPath() {
  const extra = [join(process.env.HOME || '', '.local/bin')]
  try {
    extra.push(...String(JSON.parse(readFileSync(join(process.resourcesPath, 'app', 'env.json'), 'utf8')).PATH).split(':'))
  } catch { /* 没记下就只认 ~/.local/bin 与系统那几条 */ }
  const cur = String(process.env.PATH || '').split(':')
  process.env.PATH = [...new Set([...extra, ...cur].filter(Boolean))].join(':')
}

/** 带着这个变量启动时，Electron 退化成纯 Node：主脚本静默跑完、0 退出、连窗口都不开，
 *  且会透传给采集里 spawn 的每个子进程。装机排查被它骗过一次（10-23），开跑就摘掉。 */
delete process.env.ELECTRON_RUN_AS_NODE

/** 首启复制整套；之后每次换包只刷代码那几样。
 *  config / content / metrics / public 里是他登记的号、写的稿、本机登录态和采集回来的图，
 *  换版本绝不能覆盖——public 尤其不能删：包内那一份只有两个图标，删了重拷等于把封面全清了（10-25 事故）。 */
const CODE_ONLY = ['scripts', 'dist', 'bin', 'package.json']

function seedStamp() {
  try {
    return readFileSync(join(SEED, 'build.json'), 'utf8')
  } catch {
    return ''
  }
}

function installOrUpdate() {
  const stamp = seedStamp()
  const at = join(DATA, 'build.json')
  let cur = ''
  try {
    cur = readFileSync(at, 'utf8')
  } catch { /* 没有戳 */ }
  // 老包首启时还没有 build.json：数据目录里已经有一套代码，就按升级走，别拿包内空配置盖掉他登记的号
  const seeded = existsSync(join(DATA, 'scripts', 'serve.mjs'))
  mkdirSync(DATA, { recursive: true })
  if (cur && cur === stamp) return
  if (!cur && !seeded) {
    log('首次启动：把包内的程序复制一份到数据目录')
    cpSync(SEED, DATA, { recursive: true, verbatimSymlinks: true })
    return
  }
  log('换版本了：只刷代码，数据目录里的 config/content/metrics/public 不动')
  for (const d of CODE_ONLY) {
    rmSync(join(DATA, d), { recursive: true, force: true })
    cpSync(join(SEED, d), join(DATA, d), { recursive: true, verbatimSymlinks: true })
  }
  // 包内自带的 config 与 public 只补数据目录还没有的那几样：登记、口径与采集图不覆盖，
  // 但排班（config/auto-run.json）和程序自己的图标（public/*.svg）不落进去就永远不跑、界面缺件
  for (const dir of ['config', 'public']) {
    mkdirSync(join(DATA, dir), { recursive: true })
    for (const f of readdirSync(join(SEED, dir))) {
      const to = join(DATA, dir, f)
      if (!existsSync(to)) cpSync(join(SEED, dir, f), to, { recursive: true, verbatimSymlinks: true })
    }
  }
  writeFileSync(at, stamp)
}

installOrUpdate()
fixPath()

const PORT = Number(process.env.PORT) || 5173

if (!app.requestSingleInstanceLock()) app.quit()
app.on('second-instance', () => BrowserWindow.getAllWindows()[0]?.show())

function createWindow(url) {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    title: NAME,
    autoHideMenuBar: true,
  })
  // 平台后台、原文链接交给系统浏览器打开，工作台窗口里只留工作台
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })
  win.loadURL(url)
}

app.whenReady().then(async () => {
  const { createWorkbenchServer } = await import(pathToFileURL(join(DATA, 'scripts', 'serve.mjs')).href)
  // 日志只认这份文件：GUI 起来的进程没有能写的 stdout，交给 console 会 EPIPE 抛穿主进程
  const server = createWorkbenchServer({ logger: { info: log } })
  let triedFallback = false
  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE' && !triedFallback) {
      triedFallback = true
      log(`${PORT} 被占用（dev server 在跑？），改用随机端口`)
      server.listen(0, '127.0.0.1')
    } else {
      log(`本地服务启动失败：${e?.stack || e}`)
      app.quit()
    }
  })
  server.listen(PORT, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${server.address().port}`
    log(`工作台已启动：${url}（数据目录 ${DATA}）`)
    createWindow(url)
  })
})

app.on('window-all-closed', () => app.quit())
