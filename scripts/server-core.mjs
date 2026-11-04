#!/usr/bin/env node
/**
 * 工作台本地服务核心：页面上的写操作与采集扩展共用的 /__xxx 端点组。
 * 两个消费方共用同一套处理逻辑：
 *  - 开发：vite.config.ts 把 handle 挂进 dev server
 *  - 桌面/独立：scripts/serve.mjs 喂给 http.createServer
 * 所有写操作落盘后自动重跑 gen:data 刷新 generated.json；
 * 文件监听（watchDataDirs）兜住 Agent/cron 等外部改动。
 */
import { spawn, spawnSync } from 'node:child_process'
import { randomBytes, timingSafeEqual, createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { existsSync, readFileSync, writeFileSync, appendFileSync, renameSync, mkdirSync, readdirSync, rmSync, watch as fsWatch } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import {
  handleCollect, writeDraftMd, deleteDraftMd, scheduleNote, prepareXhsPublish, buildPublishPreview, markDraftPushed,
  writeTopicMd, promoteTopic, setTopicForm, archiveTopicMd, archiveNoteMd, archiveViralMd, markTopicConverted, writeCardJson,
  writeBenchmarkMd, archiveBenchmarkMd, loadAiContext, listAccounts, writeArticleText,
} from './collect-note-core.mjs'
import { captureScriptOnce } from './capture-script.mjs'
import { pickReason } from './auto-run.mjs'
import { holdJob, runningJobs, stopJob, STOPPED_TEXT, isUserStop } from './run-jobs.mjs'
import { accountCatalog, addAccount, renameAccount } from './accounts-core.mjs'
import { readViralConfig, writeViralConfig, SUPPORTED_PLATFORMS } from './viral-config-core.mjs'
import { readBenchConfig, writeBenchConfig, SUPPORTED_PLATFORMS as BENCH_SUPPORTED_PLATFORMS } from './benchmark-config-core.mjs'
import { readFavoritesConfig, writeFavoritesConfig } from './favorites-config-core.mjs'
import { readProducts, writeProduct, listShotImages } from './products-core.mjs'
import { planSameStyle, writeSameStyle } from './same-style-core.mjs'
import { checkEnv } from './env-core.mjs'
import { runSelfCheck } from './selfcheck.mjs'
import { startSteps, writeGuide } from './start-guide.mjs'
import { humanize, classify, egoResult, labelOf, loginEvidenceOf } from './error-catalog.mjs'
import { GUARD_DENIED, corsHeaders, isMutating, originAllowed } from './api-guard-core.mjs'
import {
  SESSION_COOKIE, SESSION_TTL_SEC, emailProblem, normalizeEmail,
  signSession, verifySession, sessionCookieValue, parseCookies, publicUser,
  findOrCreateByEmail, findOrCreateByGithub, findOrCreateByGoogle, findById, sessionSecret,
  issueCode, redeemCode, resendWaitSec, CODE_TTL_SEC, RESEND_SEC,
  parseAllowEmails, emailAllowed,
} from './auth-core.mjs'
import { sendLoginCode, mailConfigured } from './mail-core.mjs'
import { guestData, guestStaticOk } from './guest-core.mjs'
import { githubConfigured, authorizeUrl, exchangeCode, githubIdentity } from './github-auth-core.mjs'
import { googleConfigured, pkcePair, authorizeUrl as googleAuthorizeUrl, exchangeCode as googleExchangeCode, googleIdentity } from './google-auth-core.mjs'
import { loadEnvFile } from './dotenv-lite.mjs'
import { buildRun, appendRun, isCollectionTask } from './collect-runs.mjs'
import { readLlmConfig, writeLlmConfig, readLlmKey, writeLlmKey, chatCompletion, pingAgent, runTeardown, runAgentJob, runGate, runReviewDraft, extractScript } from './llm-core.mjs'
import { refineTargets, runRefinePlan, applyRefineEdits } from './refine-core.mjs'
import { planClone, writeClone } from './clone-viral-core.mjs'
import { dropClone, promoteClone, sanitizeTokens, saveClone } from './clone-visual-core.mjs'
import { dropVideoCandidate, promoteVideoCandidate, saveVideoCandidates } from './video-harvest-core.mjs'

const ROOT = join(import.meta.dirname, '..')

/* 本机 dev 没有传环境变量的入口（vite 起的），所以凭据读仓根的 .env；已经在环境里的不覆盖，
   systemd 与桌面壳给的算数。文件不存在就当没这回事——开源那份的读者本来也没有发件箱。 */
loadEnvFile(ROOT)

/** 日志里的邮箱打码：这份日志会跟着桌面壳落到别人机器上，整邮箱写进去等于把用户名单抄进日志 */
const maskEmail = (raw) => {
  const e = String(raw || '')
  const at = e.indexOf('@')
  if (at < 1) return '（邮箱异常）'
  return `${e.slice(0, Math.min(2, at))}***${e.slice(at)}`
}

// 浏览器自动化可执行文件：优先环境变量，否则要求 ego-browser 在 PATH 上。
// 不要写死个人绝对路径——仓库是要公开的。
const EGO_BIN = process.env.EGO_BIN || 'ego-browser'

/* 远程模式：服务器上对外那一份。这台机器上没有本机浏览器桥（ego-browser 里那些已登录的平台账号），
   也没有渲染工具链，执行类端点接了只会让人对着报错猜。开了这个标志就一律挡在 409，界面按
   /__capabilities 的结论提前把入口换成「在桌面客户端里做」。
   判据只有这一个环境变量：本机 dev / serve / Electron 都不设它，行为一字不变。 */
const REMOTE = process.env.WORKBENCH_REMOTE === '1'

/** 这一份是不是远程那份（没有本机浏览器桥）：界面降级、排班挂不挂都读这一个结论 */
export const isRemoteMode = () => REMOTE

/** 「回桌面客户端」的去处：没配就用公开仓库那一页。能力的读数与游客那一屏的产物都带这一条 */
const clientDownloadUrl = () => process.env.WORKBENCH_DOWNLOAD_URL || 'https://github.com/one-person-lab/media-hub'

/** 依赖本机浏览器、本机登录态或本机工具链的端点，远程模式下不给用。
 *  /__env、/__selfcheck、/__extension-path 一并挡掉：那三份报的是这台机器的路径和装了什么，
 *  对外站没有理由把它们念出来。 */
const CLIENT_ONLY_ROUTES = new Set([
  '/__run-script', '/__stop-script', '/__collect', '/__script', '/__viral-search', '/__benchmark-search',
  '/__login-qr', '/__login-signal', '/__press-params', '/__publish-preview', '/__publish-signal',
  '/__push', '/__autopublish', '/__card', '/__template-thumb', '/__clone-visual', '/__video-harvest',
  '/__env', '/__selfcheck', '/__start-guide', '/__extension-path',
])

function json(res, code, obj) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.statusCode = code
  // 每个失败响应都过 error-catalog 补一句「该做什么」：界面只渲染，不各自猜
  res.end(JSON.stringify(humanize(obj)))
}

/** 登录那几个端点的错误是给界面直接念的，不过 error-catalog 那道加工：
 *  那本台账说的是平台账号掉登录，一句「验证码不对」被它认成 risk_verify，就长出一堆不相干的建议。 */
function authJson(res, status, obj) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.statusCode = status
  res.end(JSON.stringify(obj))
}

function readBody(req) {
  return new Promise((resolveBody, reject) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => resolveBody(body))
    req.on('error', reject)
  })
}

function errText(e) {
  return String(e?.message || e)
}

/** gen:data 崩了时的输出是 node ESM 的未捕获异常格式：
 *   file:///…/build-data.mjs:996
 *       throw new Error(`R4 违规：…`)
 *             ^
 *   Error: R4 违规：<哪个文件> …
 *       at …
 * 原因就在唯一那行「Error: 」上；error-catalog 的 egoCrash 是给 ego 的 CJS 堆栈用的（那里 at 后面带括号），
 * 对这种格式会挑错行，所以单独认一次。 */
function genDataErrorText(out) {
  const lines = String(out).split('\n').map((l) => l.trim()).filter(Boolean)
  const msg = lines.find((l) => /^Error:/i.test(l)) || lines.find((l) => !/^at /.test(l)) || ''
  return (msg.replace(/^Error:\s*/i, '') || 'gen:data 失败，没给出原因').slice(0, 300)
}

/** 界面数据最近一次重建失败的原文。
 *  读不到 generated.json 时界面原本只能给一句猜测（「本地服务还没准备好」），而实情多半是某个 md
 *  的表头写歪了——把报错原文留在这儿，/generated.json 负责端上屏，别让人对着一片空白猜前端坏了。 */
const dataBuild = { running: false, failed: null }

/** 同步跑一次 gen:data，返回 { ok } 或 { ok:false, detail, code }（detail 是报错那一句，不含 stack） */
function genDataOnce() {
  dataBuild.running = true
  try {
    const r = spawnSync('node', ['scripts/build-data.mjs'], { cwd: ROOT, encoding: 'utf8' })
    if (r.error) dataBuild.failed = { detail: `gen:data 起不来：${r.error.message}`, code: null }
    else if (r.status === 0) dataBuild.failed = null
    else dataBuild.failed = { detail: genDataErrorText(`${r.stdout || ''}${r.stderr || ''}`), code: r.status }
    return dataBuild.failed ? { ok: false, ...dataBuild.failed } : { ok: true }
  } finally {
    dataBuild.running = false
  }
}

/** gen:data 防抖调度：连续改动只跑一次重建；构建中收到新变动则结束后补跑；
 *  成功通知 onData，失败把原文记进 dataBuild 并通知 onError（界面开着时也要知道数据断了） */
function createGenDataRefresher(logger, onData, onError) {
  let timer = null
  let running = false
  let pending = false
  function schedule() {
    if (timer) clearTimeout(timer)
    timer = setTimeout(run, 1200)
  }
  function run() {
    if (running) {
      pending = true
      return
    }
    running = true
    const child = spawn('node', ['scripts/build-data.mjs'], { cwd: ROOT })
    let out = ''
    child.stdout.on('data', (c) => (out = (out + c).slice(-8000)))
    child.stderr.on('data', (c) => (out = (out + c).slice(-8000)))
    child.on('close', (code) => {
      running = false
      if (code === 0) {
        dataBuild.failed = null
        logger.info('[data] gen:data 已自动刷新')
        onData?.()
      } else {
        dataBuild.failed = { detail: genDataErrorText(out), code }
        logger.info(`[data] gen:data 失败（exit ${code}）：${dataBuild.failed.detail}`)
        onError?.(dataBuild.failed.detail)
      }
      if (pending) {
        pending = false
        schedule()
      }
    })
  }
  return schedule
}

/** 冷启动先同步跑一次 gen:data：装机态的数据目录是 App 自己管的，
 *  「文件在就不重算」会把上一次启动的读数当成现状摆给人看（10-23 装完搬数据，界面还报「共 0 个号」）。 */
export function ensureGeneratedData(logger) {
  if (!genDataOnce().ok) logger.info(`[data] gen:data 失败：${dataBuild.failed?.detail}`)
}

/** 数据自动刷新：content/ config/ metrics/ 任何文件变动即触发 onChange。
 *  用 fs.watch 而非 vite server.watcher——后者跳过 .gitignore 命中的文件（config/accounts.json 等）。 */
export function watchDataDirs(onChange, logger) {
  for (const dir of ['content', 'config', 'metrics']) {
    const abs = join(ROOT, dir)
    if (!existsSync(abs)) continue
    try {
      fsWatch(abs, { recursive: true }, (_event, file) => {
        if (file && !String(file).startsWith('.')) onChange()
      })
    } catch {
      logger?.info(`[data] watch ${dir}/ 失败，该目录改动需手动刷新`)
    }
  }
}

/** 一键推草稿的脚本取自账号注册表 config/accounts.json（唯一事实源），未登记直接报错。
 *  注意本文件里 /__autopublish 与 /__push 的 `platform` 字段传的是**账号 id**（同平台两个号各推各的）：
 *  历史数据里它就等于平台名，所以老调用方不用改，新号（如「抖音-成长号」）照样认。 */
function accountScript(account) {
  const s = listAccounts().find((a) => a.id === account)?.script
  if (!s) throw new Error(`账号「${account}」未登记发布脚本（config/accounts.json 的 script 字段）`)
  return resolve(ROOT, s)
}

/** 人工停止的信号文件：界面点「停止」→ 写任务 key，脚本在平台之间自取一次后收尾（exit 3）。
 *  不走进程信号：ego 的任务空间被掐在半路会留成脏（同 /tmp/media-hub-login-signal 的理由）。 */
const SYNC_STOP_FILE = '/tmp/media-hub-sync-stop'
/** 运行中进度：脚本自己原子写的文件（tmp+rename）。走文件而不是走日志是因为 ego 把子进程
 *  输出全攒到进程退出才吐，运行中读 stdout 只能读到空——界面就只能干看着一个计时器跳。 */
const SYNC_PROGRESS_FILE = '/tmp/media-hub-run-progress.json'
/** 推草稿的完整 ego 输出（追加写）：界面只摆摘要，出问题要看整段堆栈时来这里翻 */
const PUSH_RAW_LOG = '/tmp/media-hub-push-raw.log'
/** 就地发布：弹层要看的编辑器截图（脚本每轮原子写）与那三颗钮的信号文件。
 *  走文件不走进程信号，理由同 SYNC_STOP_FILE：ego 任务空间被掐在半路会留成脏。 */
const PRESS_PREVIEW = '/tmp/media-hub-publish-preview.png'
const PRESS_SIGNAL = '/tmp/media-hub-publish-signal'
/** 界面「搜爆款」的候选池（viral-collect --search 原子写）：搜索和入库是两趟浏览器，
 *  中间那一次「挑哪几条」的判断由人做，这一份就是留给人的那面盘子。 */
const VIRAL_SEARCH_FILE = '/tmp/media-hub-viral-search.json'
/** 界面「收对标」的候选池（benchmark-collect --search 边搜边原子写）：那一份装的是作者，不是作品。 */
const BENCH_SEARCH_FILE = '/tmp/media-hub-benchmark-search.json'
const readRunProgress = (task) => {
  try {
    const p = JSON.parse(readFileSync(SYNC_PROGRESS_FILE, 'utf8'))
    return p && p.task === task ? p : null
  } catch {
    return null
  }
}
const readStopSignal = () => {
  try {
    return readFileSync(SYNC_STOP_FILE, 'utf8').trim()
  } catch {
    return ''
  }
}

// 纯脚本同步任务（不需要 Agent 判断）。同一时刻只允许一个（共用 ego 浏览器登录态，并发易触发平台限流）；
// 产物落盘后由文件监听自动重建界面数据。
/** 单飞队列认得的同步任务（config/auto-run.json 的排班只能填这里的键，测试会逐个对） */
export const SYNC_TASKS = {
  collect: { args: ['scripts/run-ego.mjs', 'scripts/collect-platforms.mjs'], timeoutMs: 8 * 60_000, argFlag: '--only' },
  viral: { args: ['scripts/run-ego.mjs', 'scripts/viral-collect.mjs'], timeoutMs: 60 * 60_000, argFlag: '--only' },
  // 界面「搜爆款」：人现点一个平台、现输几个关键词就地搜，只出候选不入库（挑中的另走 viral-capture）。
  // 每搜完一个词就把候选重写进池子，够 SEARCH_SHOW 条就收工，所以一趟通常一两分钟。
  'viral-search': { args: ['scripts/run-ego.mjs', 'scripts/viral-collect.mjs'], timeoutMs: 8 * 60_000, argFlag: '--search', argKind: 'platkw', argRequired: true },
  // 挑中的那几条才进详情页搬源料落卡：一条一次详情页 + 逐页原图/源片，超时按十几条给
  'viral-capture': { args: ['scripts/run-ego.mjs', 'scripts/viral-collect.mjs'], timeoutMs: 30 * 60_000, argFlag: '--capture', argRequired: true },
  // 收藏搬运：两平台各滚到底（最多 30 轮 × 2s）+ 逐条下载封面，实测整表一轮 3~5 分钟
  favorites: { args: ['scripts/run-ego.mjs', 'scripts/favorites-collect.mjs'], timeoutMs: 15 * 60_000, argFlag: '--only' },
  benchmark: { args: ['scripts/run-ego.mjs', 'scripts/benchmark-collect.mjs'], timeoutMs: 25 * 60_000, argFlag: '--only' },
  // 界面「收对标」：人点一个平台、现输几个关键词，只把候选作者连头像写进池子，一个主页都不开。
  // 每搜完一个词重写池子，够 searchLimit 个就收工，所以一趟比自动线快一个量级。
  'benchmark-search': { args: ['scripts/run-ego.mjs', 'scripts/benchmark-collect.mjs'], timeoutMs: 8 * 60_000, argFlag: '--search', argKind: 'platkw', argRequired: true },
  // 挑中的那几个才逐个开主页读实测、建档：一个号一页，超时按十几个人给
  'benchmark-capture': { args: ['scripts/run-ego.mjs', 'scripts/benchmark-collect.mjs'], timeoutMs: 30 * 60_000, argFlag: '--capture', argKind: 'platid', argRequired: true },
  // 手动添加对标账号：只开这一个主页，把实测读数补进刚建的那张卡（一次一页，几分钟都算多）
  'benchmark-one': { args: ['scripts/run-ego.mjs', 'scripts/benchmark-collect.mjs'], timeoutMs: 3 * 60_000, argFlag: '--url', argKind: 'url', argRequired: true },
  'publish-check': { args: ['scripts/run-ego.mjs', 'scripts/publish-check.mjs'], timeoutMs: 12 * 60_000, argFlag: '--only' },
  // 账号页「授权」：把该平台创作者后台开在 Ego Lite 里，脚本盯到扫码登录完成才收工，
  // 所以超时按「人从掏手机到扫完」的量级给（open-login 自己 135 秒到点，这里留收尾余量）
  login: { args: ['scripts/run-ego.mjs', 'scripts/open-login.mjs'], timeoutMs: 6 * 60_000, argFlag: '--platform', argRequired: true },
  // 「授权账号」：登记表上还没有这一行，扫进去的号自己报名字（open-login --new 现登记），所以参数是平台中文名
  'login-new': { args: ['scripts/run-ego.mjs', 'scripts/open-login.mjs'], timeoutMs: 6 * 60_000, argFlag: '--platform', argKind: 'platform', argRequired: true, scriptArgs: ['--new'] },
  // 「打开后台」：本机已有这一号的登录态，只换气、开页、确认没被弹回登录页，秒级收工，不进等扫码的循环
  'open-backend': { args: ['scripts/run-ego.mjs', 'scripts/open-login.mjs'], timeoutMs: 60_000, argFlag: '--platform', argRequired: true, scriptArgs: ['--open'] },
  // 就地发布：开抽屉认那一格 → 进编辑器回读截图 → 等人在工作台弹层按下 → 点「发布」→ 回读取证。
  // 一次跑要等表单水合（实测最慢 40 秒）再等人看图决定（脚本内 240 秒到点），超时按「人从看图到拍板」的量级给。
  // --confirm 写死在登记表里而不是让界面传：界面只能传 argFlag 那一个参数，档位开关不给外部拨——
  // 即便带上 --confirm，脚本没收到人按下的信号也一个按钮都不点（手跑忘带开关就是只读探针）。
  'press-publish': { args: ['scripts/run-ego.mjs', 'scripts/press-publish.mjs'], timeoutMs: 8 * 60_000, argFlag: '--platform', argRequired: true, scriptArgs: ['--confirm'] },
  // 起步向导第 4 步：粘一条小红书笔记链接 → 一张采全的卡（正文+封面+逐页原图+赞藏评）。
  // 占浏览器，所以排在单飞队列里；链接只走参数数组，不进 shell。
  note: { args: ['scripts/run-ego.mjs', 'scripts/collect-note.mjs'], timeoutMs: 5 * 60_000, argFlag: '--url', argKind: 'url', argRequired: true },
  // 视频取料：ffmpeg 与 ffprobe 一起装，分开装会出现半套跑不出片。
  // 35 分钟这道掐条只是兜底：镜像源正常十几秒就完事，慢到要 15 分钟的是单个源被 curl 自己的
  // --max-time 900 管着；这里给到够换完两轮源，绝不在一次正经下载中途动手。
  // 掐在半路也不会留下半个二进制：下载先落 tmp，能力校验过了才 rename 到位。
  'fetch-bin': { args: ['scripts/fetch-binaries.mjs'], timeoutMs: 35 * 60_000 },
  // 内容快照推到云端：不碰浏览器，所以跟在那几趟采集后面排；第一次推要把整份历史搬过去，超时按那趟给。
  backup: { args: ['scripts/backup-push.mjs'], timeoutMs: 10 * 60_000 },
}

/** 撞车时给界面的那句只许说人话：任务 key 是内部名，摆到 toast 上就成了 meta。
 *  这份名字跟 config/auto-run.json 的排班名一致；界面上那颗运行键叫什么（同步收藏 / 重新检测）归 src/data/store.ts 的 SYNC_TASK_LABEL。 */
const TASK_CN = {
  collect: '数据复盘', viral: '爆款采集', 'viral-search': '搜爆款', 'viral-capture': '爆款入库', favorites: '收藏搬运', benchmark: '对标采集', 'benchmark-one': '对标采集',
  'benchmark-search': '收对标', 'benchmark-capture': '对标建档',
  'publish-check': '发布回认', login: '账号授权', 'login-new': '账号授权', 'open-backend': '打开后台', 'press-publish': '就地发布',
  note: '笔记采集', 'fetch-bin': '组件下载', backup: '内容备份',
}
const taskCn = (t) => TASK_CN[t] || t

/** 界面传进来的那一个参数按任务认格式：url = 一条链接，platform = 一个平台中文名（授权新号时登记表上还没有这一行），
 *  kw = 人现输的搜索关键词（可逗号分隔多个），默认 key = 小写平台键（可逗号分隔多个）。
 *  三道闸都在服务端挡，脚本只收已经过检的字符串。 */
const ARG_RE = {
  url: /^https?:\/\/[^\s<>"'`]{1,500}$/,
  platform: /^[一-龥A-Za-z0-9-]{1,16}$/,
  kw: /^[一-龥A-Za-z0-9 ,，、]{1,160}$/,
  // 搜爆款与收对标都吃这一份：先点名平台再给词，一次只搜一个平台才快得起来
  platkw: /^[a-z0-9-]+(,[a-z0-9-]+)*:[一-龥A-Za-z0-9 ,，、]{1,160}$/,
  key: /^[a-z0-9-]+(,[a-z0-9-]+)*$/,
  // 收对标入库那一条：作者 id 带平台前缀（抖音的 secUid 长得像 MS4wLjABAAAA…，容点号和下划线）
  platid: /^[a-z0-9-]+:[A-Za-z0-9._~-]{1,120}(,[a-z0-9-]+:[A-Za-z0-9._~-]{1,120})*$/,
}
const ARG_ASK = {
  url: '链接得是 http(s) 开头的一条完整地址',
  platform: '参数只能是一个平台名',
  kw: '关键词只能是中文或英文词，几个词用逗号分开',
  platkw: '要先点名搜哪个平台，再写关键词',
  key: '参数只能是平台 key（小写字母/数字/短横线，逗号分隔）',
  platid: '要先点名平台，再写作者 id，几个号用逗号分开',
}

/** 定时发布那格时间在服务端先过三道：格式、读得出来、留够脚本跑到平台那边的余量。
 *  界面那颗日期控件给的是「2026-11-04T21:52」，平台时间框里是空格那一版，归一在这里做。 */
export function scheduleGate(mode, at, now = Date.now()) {
  if (!['publish', 'schedule'].includes(mode)) throw new Error('mode 只有 publish / schedule')
  if (mode !== 'schedule') return ''
  const atText = String(at || '').trim()
  if (!/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}$/.test(atText)) throw new Error('定时发布要给「年-月-日 时:分」')
  const t = new Date(atText.replace(' ', 'T'))
  if (Number.isNaN(t.getTime())) throw new Error('这个时间读不出来')
  if (t.getTime() < now + 5 * 60_000) throw new Error('定时发布的时间要留够 5 分钟，脚本跑到平台那边还要一会儿')
  return atText.replace('T', ' ')
}

/** 三条渲染路（图卡 / 模板小样 / 克隆皮预览）共用的起跑：同一把闩、同一只看门狗、
 *  同一格「跑着的活儿」登记（scripts/run-jobs.mjs）——界面上按停才只有一条路可走。
 *  渲染可以直接掐：它只往 public/ 写 png，掐了最多这一版没生成，
 *  不像采集那样会把 ego 的任务空间留成脏（超时看门狗本来就是这么掐的）。 */
let cardRendering = null
function runRender(args, { timeoutMs, label, busy }) {
  if (cardRendering) return Promise.reject(new Error(`「${cardRendering.label}」在跑，${busy}`))
  return new Promise((done, fail) => {
    const child = spawn('node', args, { cwd: ROOT })
    cardRendering = { label }
    const releaseJob = holdJob('render', { label, startedAt: Date.now(), limitMs: timeoutMs, stop: () => child.kill('SIGKILL') })
    let out = ''
    const killer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    child.stdout.on('data', (c) => (out += c))
    child.stderr.on('data', (c) => (out += c))
    child.on('close', (code) => {
      clearTimeout(killer)
      releaseJob()
      cardRendering = null
      done({ code, out })
    })
  })
}

/** 脚本只往 stdout 尾巴上吐一行结果 JSON；认不出来就当它跑砸，把尾巴端回去给人看 */
const renderJson = (out) => {
  const m = out.match(/\{[\s\S]*\}\s*$/)
  return m ? JSON.parse(m[0]) : { ok: false, error: out.slice(-400) }
}

/**
 * 卡片重渲：跑 ego 截图（实测单页 10-15s），只渲染改动页；pageIdx 传 null 则全量。
 * 与采集/发布共用同一个浏览器登录态，所以同一时刻只允许一个渲染在跑。
 */
async function renderCardPages(jsonRel, pageIdx) {
  const args = ['scripts/run-ego.mjs', 'scripts/render-cards.mjs', '--args', '--card', jsonRel]
  if (pageIdx?.length) args.push('--only', pageIdx.map((i) => i + 1).join(','))
  const n = pageIdx?.length || 12
  const { code, out } = await runRender(args, {
    timeoutMs: 90_000 + n * 60_000, label: '图卡渲染', busy: '等它跑完再存这一张',
  })
  const result = renderJson(out)
  if (code === 0 && result.ok) return { ...result, rel: jsonRel }
  throw new Error(result.error || `渲染失败（退出码 ${code}）：${out.slice(-300)}`)
}

/** 模板小样补渲：与图文渲染共用同一把闩——两条路都开同一个浏览器任务空间，并行会互抢登录态。 */
async function renderTemplateThumbs(keys) {
  const args = ['scripts/run-ego.mjs', 'scripts/render-template-thumbs.mjs', '--args', '--templates', keys.join(',')]
  const { code, out } = await runRender(args, {
    timeoutMs: 90_000 + keys.length * 60_000, label: '模板小样', busy: '等它跑完再补小样',
  })
  const result = renderJson(out)
  if (code === 0 && result.ok) return result
  throw new Error(result.error || (result.failed?.length
    ? result.failed.map((f) => `${f.key}：${f.error}`).join('；')
    : `补渲失败（退出码 ${code}）：${out.slice(-300)}`))
}

/** 克隆皮预览渲：参数是一段 base64（不写 /tmp 那个共享单例），产物按色值哈希命名。
 *  跟上面两条共用同一把闩——三条路都开同一个浏览器任务空间，并行会互抢登录态。 */
async function renderClonePreview(b64) {
  const args = ['scripts/run-ego.mjs', 'scripts/render-clone-preview.mjs', '--args', '--b64', b64]
  const { code, out } = await runRender(args, {
    timeoutMs: 150_000, label: '皮肤预览', busy: '等它跑完再看预览',
  })
  const result = renderJson(out)
  if (code === 0 && result.ok) return result
  throw new Error(result.error || `预览渲失败（退出码 ${code}）：${out.slice(-300)}`)
}

/**
 * 建一套端点处理器。返回：
 *  - handle(req, res, next)：中间件形态，vite/自建 http server 通用；未命中路由交给 next
 *  - refresh()：手动触发一次 gen:data 防抖重建
 */
export function createApiHandler({ logger }) {
  const sseClients = new Set()
  const refresh = createGenDataRefresher(
    logger,
    () => {
      for (const res of sseClients) res.write(`data: ${JSON.stringify({ type: 'data-refreshed' })}\n\n`)
    },
    // 界面已经挂着的时候数据断了（改坏一个 md 最常见）：把原文推下去，别等下次刷新才发现
    (detail) => {
      for (const res of sseClients) {
        // 与 /generated.json 同一把尺子：重建失败一律按数据类给下一步，别让报错里的字眼抢分类
        const body = humanize({ ok: false, code: 'data_read_failed', error: detail })
        res.write(`data: ${JSON.stringify({ type: 'data-error', error: body.error, action: body.action })}\n\n`)
      }
    },
  )
  let syncJob = null
  /** 最近跑完的那一笔，按任务 key 存着：syncJob 只有一格，界面点完授权后自动补的那次体检会把
   *  授权那一笔顶掉，报错就查无对证了（2026-10-23「授权砸了但界面只说「脚本没回话」」）。 */
  const lastJob = new Map()
  /** 推草稿互斥锁：payload 文件（/tmp/media-hub-publish.json）与浏览器登录态都是共享单例，并发必打架 */
  let publishing = null

  /* 数据端点：前端运行时拉最新 generated.json（改动即时可见这条不许破：每次都要问服务器）。
     读不到就先当场同步补一次重建（冷启动、或上一次重建失败的残留）；补完仍不行，
     把 build-data 的报错原文交给界面——它点名到文件，界面不许自己编原因。
     服务器上那份按身份给数：没登录的人拿到的是游客那一屏的演示产物，不是号主的真数据。
     传输按内容指纹复验：产物 3.3MB，以前每开一次界面全搬一遍。现在没变回 304（0 字节），
     变了也只搬 gzip 后的那一份（实测 826KB）。压缩结果按指纹存一格，改一次内容才压一次。 */
  let zipped = { etag: '', buf: null }
  function sendJson(req, res, text) {
    // 指纹取内容前 16 字节的 base64 足够了：这里只要「变了没有」，不防碰撞
    const etag = `"${createHash('sha256').update(text).digest('base64url').slice(0, 16)}"`
    res.setHeader('ETag', etag)
    // no-cache 不是「不缓存」，是「用之前先来问一次」——界面刷新仍拿最新，白搬的那部分省掉
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Vary', 'Accept-Encoding')
    if (String(req.headers['if-none-match'] || '').split(/\s*,\s*/).includes(etag)) {
      res.statusCode = 304
      return res.end()
    }
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    const wantsGzip = /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''))
    if (wantsGzip && text.length > 1024) {
      if (zipped.etag !== etag) zipped = { etag, buf: gzipSync(text, { level: 6 }) }
      res.setHeader('Content-Encoding', 'gzip')
      res.setHeader('Content-Length', zipped.buf.length)
      res.statusCode = 200
      return res.end(zipped.buf)
    }
    res.statusCode = 200
    res.end(text)
  }

  function generatedData(req, res) {
    const file = join(ROOT, 'src/data/generated.json')
    const read = () => {
      try { return readFileSync(file, 'utf8') } catch { return null }
    }
    let body = read()
    if (body === null) {
      if (dataBuild.running) {
        return json(res, 503, humanize({ ok: false, error: '数据正在重建，稍等一下再试' }))
      }
      const retry = genDataOnce()
      body = read()
      if (body === null) {
        return json(res, 500, humanize({
          ok: false,
          // 数据读不出来的原因可能是任何一份 md 写歪，一律按数据类给下一步，别让脚本自己的分类抢走
          code: 'data_read_failed',
          error: retry.ok ? '数据文件读不到，但重建这步没报错' : retry.detail,
        }))
      }
    }
    if (REMOTE && !currentUser(req)) {
      const view = guestScreen(body)
      if (!view.body) {
        return json(res, 503, humanize({ ok: false, error: '这一屏的演示数据没造出来', action: '看服务端日志里 [guest] 那一行' }))
      }
      body = view.body
    }
    sendJson(req, res, body)
  }

  /* ==================== 未登录看到的那一屏 ====================
   * 演示产物挑哪几个字段、引用到哪几个文件都在 guest-core / demo-data-core 里算，这里只管按身份取。
   * 缓存按产物的 generatedAt：重建一次才算新的一屏，别让每个静态请求重跑一遍挑数据。
   * 泄漏自查没过就整屏不发（body 给空串）——宁缺不漏，界面顶多一片空态，漏出去的是号主的真东西。 */
  let guestView = { stamp: '', body: '', referenced: new Set() }
  function guestScreen(text) {
    let raw = null
    try {
      raw = JSON.parse(text)
    } catch {
      return guestView
    }
    const stamp = String(raw.generatedAt || '')
    if (guestView.stamp === stamp) return guestView
    const next = { stamp, body: '', referenced: new Set() }
    const { guest, referenced, leaks } = guestData(raw, { downloadUrl: clientDownloadUrl() })
    if (leaks.length) logger.info(`[guest] 演示产物里还有不该出门的字段，这一屏不发：${leaks.join('、')}`)
    else {
      next.body = JSON.stringify(guest)
      next.referenced = referenced
    }
    guestView = next
    return guestView
  }

  /** 静态层那道判断要的产物文本：端点那条路自己会补重建，这里只读盘上现成的这一份 */
  const generatedText = () => {
    try {
      return readFileSync(join(ROOT, 'src/data/generated.json'), 'utf8')
    } catch {
      return ''
    }
  }

  /* 知识原文端点：知识库页「复制 MD」拉 content/Knowledge/<file> 全文 */
  function knowledgeMd(req, res, url) {
    if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'GET only' })
    const f = url.searchParams.get('file') || ''
    if (!/^[^/\\]+\.md$/.test(f) || f.includes('..')) {
      return json(res, 400, { ok: false, error: 'file 只接受 Knowledge 目录下的 *.md 文件名' })
    }
    const abs = resolve(ROOT, 'content/Knowledge', f)
    if (!existsSync(abs)) return json(res, 404, { ok: false, error: `content/Knowledge/${f} 不存在` })
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8')
    res.setHeader('Cache-Control', 'no-store')
    res.statusCode = 200
    // 与 gen:data 同口径：剥离 HTML 注释后即为页面所见的原文
    res.end(readFileSync(abs, 'utf8').replace(/<!--[\s\S]*?-->/g, ''))
  }

  /* 事件端点（SSE）：gen:data 重建完成即推送，前端收到后整页刷新 */
  function events(req, res) {
    if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'GET only' })
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.write('retry: 3000\n\n')
    sseClients.add(res)
    req.on('close', () => sseClients.delete(res))
  }

  /* 采集端点：浏览器扩展 → content/Inbox/采集笔记/，入库后当场自动扒脚本 + 自动拆解 */
  async function collect(req, res) {
    if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'POST only' })
    try {
      const result = await handleCollect(JSON.parse((await readBody(req)) || '{}'))
      json(res, 200, result)
      logger.info(`[collect] ${result.file}${result.image ? ' (+图)' : ''}${result.videoFile ? ` (+源片 public/${result.videoFile})` : ''}${result.keptAnalysis ? ' (已保留拆解)' : ''}${result.converted ? ` (已转选题「${result.converted}」)` : ''}`)
      refresh()
      autoTeardown(result.file, { rescan: true })
    } catch (e) {
      json(res, 400, { ok: false, error: errText(e) })
    }
  }

  /* 采集收尾：脚本是拆与写的唯一原料，先本机 OCR 出稿，紧接着按五层框架自动拆解。
   * 全程本机跑完，不给用户留「记得让 AI 补拆解」这类手工尾巴；拆完再刷一次界面。
   * rescan=false 用于「补扒/重扒」端点——脚本刚扒完，只需补拆。 */
  function autoTeardown(rel, { rescan = false } = {}) {
    const run = () => {
      const abs = join(ROOT, rel)
      if (!existsSync(abs)) return
      const md = readFileSync(abs, 'utf8')
      if (/^analysis:/m.test(md)) return
      if (!extractScript(md)) {
        logger.info(`[teardown] 跳过 ${rel}：没有「## 脚本」段（源料没拿到，可在详情页点「补扒脚本」）`)
        return
      }
      logger.info(`[teardown] 开始 ${rel}`)
      runTeardown(rel, (m) => logger.info(`[teardown] ${rel} ${m}`))
        .then((r) => logger.info(r.ok ? `[teardown] ✓ ${rel} 五层已写回` : `[teardown] 失败 ${rel}：${r.error}`))
        .then(refresh)
    }
    if (!rescan) return run()
    // 脚本是拆与写的唯一原料：采集当场就扒（图文逐页 OCR / 视频抽帧 OCR），跑完再刷一次界面
    captureScriptOnce(rel, { root: ROOT })
      .then((s) => logger.info(s.ok ? `[script] ${s.name}：${s.kind} ${s.chars} 字` : `[script] 跳过 ${rel}：${s.error}`))
      .catch((e) => logger.info(`[script] 失败 ${rel}：${errText(e)}`))
      .then(refresh)
      .then(run)
      .catch((e) => logger.info(`[teardown] 失败 ${rel}：${errText(e)}`))
  }

  /* 收藏搬运线只碰浏览器、不碰模型：脚本由采集收尾本机 OCR 扒完，同步一结束在这里补拆解（含那一句话为什么火）。
   * 只认有脚本又没拆过的收藏卡，一张拆完再拆下一张，不并发压模型接口。
   * 「分析里缺 why」也算没拆完：那一句话是后加的一层，老卡补一次就齐了。 */
  async function teardownFavoritePending() {
    const dir = join(ROOT, 'content/Inbox/采集笔记/收藏')
    if (!existsSync(dir)) return
    const files = []
    const walk = (d) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        if (e.isDirectory()) walk(join(d, e.name))
        else if (e.name.endsWith('.md')) files.push(join(d, e.name))
      }
    }
    walk(dir)
    const todo = files.filter((f) => {
      const md = readFileSync(f, 'utf8')
      return (!/^analysis:/m.test(md) || !/^\s*why:\s*\S/m.test(md)) && extractScript(md)
    })
    if (!todo.length) return
    logger.info(`[teardown] 收藏卡待拆 ${todo.length} 张`)
    for (const abs of todo) {
      const rel = abs.startsWith(`${ROOT}/`) ? abs.slice(ROOT.length + 1) : abs
      const r = await runTeardown(rel, (m) => logger.info(`[teardown] ${rel} ${m}`)).catch((e) => ({ ok: false, error: errText(e) }))
      logger.info(`[teardown] ${rel} ${r.ok ? '五层已写回' : `失败：${r.error}`}`)
    }
    refresh()
  }

  /* 脚本端点：详情弹层「补采/重扒脚本」——全程本机自动跑，不经 Agent。
   * 爆款老卡与收藏卡采集时没带源料，先拉 ego 回详情页把源料搬回家，再本机 OCR/转写出稿。
   * 一条视频转写要按分钟计，所以这两段都得能按停：ego 那段先 SIGTERM 让脚本自己收尾，
   * 本机那段把 AbortSignal 交下去，ffmpeg/whisper/OCR 的子进程当场断。 */
  async function captureScriptWithSource(rel) {
    if (!existsSync(join(ROOT, rel))) return { ok: false, error: '采集卡文件不存在' }
    const ac = new AbortController()
    let egoChild = null
    const releaseJob = holdJob('script', {
      label: '补扒脚本',
      stop: () => {
        ac.abort()
        if (egoChild && egoChild.exitCode === null) egoChild.kill('SIGTERM')
      },
    })
    try {
      const md = readFileSync(join(ROOT, rel), 'utf8')
      const hasMaterial = /^(sourceImages|videoFile|videoSrc):\s*\S/m.test(md)
      if (/^source: (viral|favorite)$/m.test(md) && !hasMaterial) {
        if (syncJob && syncJob.finishedAt === null) {
          return { ok: false, error: `已有同步在跑（${taskCn(syncJob.task)}），共用浏览器登录态，等它跑完再补采` }
        }
        const name = rel.split('/').pop()
        const { code, out } = await new Promise((done) => {
          egoChild = spawn('node', ['scripts/run-ego.mjs', 'scripts/viral-collect.mjs', '--args', `--source=${name}`], { cwd: ROOT })
          let tail = ''
          egoChild.stdout.on('data', (c) => (tail = (tail + c).slice(-8000)))
          egoChild.stderr.on('data', (c) => (tail = (tail + c).slice(-8000)))
          const killer = setTimeout(() => egoChild.kill('SIGKILL'), 6 * 60_000)
          egoChild.on('close', (code) => {
            clearTimeout(killer)
            const m = tail.match(/\[viral:source\] (\{.*\})/)
            done({ code, out: m ? JSON.parse(m[1]) : null, tail })
          })
        })
        logger.info(`[script] 补源料 ${rel} exit=${code} ${JSON.stringify(out || {})}`)
        if (ac.signal.aborted) return { ok: false, aborted: true, error: STOPPED_TEXT }
        if (!out?.ok) return { ok: false, error: out?.error || `补源料失败（exit ${code}）：${(out?.tail || '').split('\n').filter(Boolean).pop() || 'ego 没回话'}` }
      }
      return await captureScriptOnce(rel, { root: ROOT, signal: ac.signal })
    } finally {
      releaseJob()
    }
  }

  async function captureScriptApi(req, res) {
    if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'POST only' })
    try {
      const { file } = JSON.parse((await readBody(req)) || '{}')
      if (!file) throw new Error('缺少 file')
      const r = await captureScriptWithSource(file)
      logger.info(`[script] ${file} → ${r.ok ? `${r.kind} ${r.chars} 字` : r.error}`)
      json(res, 200, r)
      refresh()
      if (r.ok) autoTeardown(file, { rescan: false })
    } catch (e) {
      json(res, 400, { ok: false, error: errText(e) })
    }
  }

  /* 灵感库端点：DELETE 淘汰＝归档（卡片移进 采集笔记/归档/，源图不动，复盘可回溯） */
  async function note(req, res, url) {
    if (req.method !== 'DELETE') return json(res, 405, { ok: false, error: 'DELETE only' })
    const rel = url.searchParams.get('file') || ''
    try {
      json(res, 200, { ...archiveNoteMd(rel), ok: true })
      logger.info(`[note] archive ${rel}`)
      refresh()
    } catch (e) {
      json(res, 400, { ok: false, error: errText(e) })
    }
  }

  /* 爆款采集端点：DELETE 删除＝归档（卡片移进 爆款采集/归档/<平台>/，源料不动，采集线认归档不再采回） */
  async function viral(req, res, url) {
    if (req.method !== 'DELETE') return json(res, 405, { ok: false, error: 'DELETE only' })
    const rel = url.searchParams.get('file') || ''
    try {
      json(res, 200, { ...archiveViralMd(rel), ok: true })
      logger.info(`[viral] archive ${rel}`)
      refresh()
    } catch (e) {
      json(res, 400, { ok: false, error: errText(e) })
    }
  }

  /* 搜爆款候选池：viral-search 那一趟浏览器写在 /tmp 的达标候选，弹层跑完自己来读。
   *  没这份文件＝这台机器还没搜过；这里只报有没有，空态怎么说由弹层定。 */
  function viralSearch(req, res) {
    if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'GET only' })
    try {
      json(res, 200, { ok: true, ...JSON.parse(readFileSync(VIRAL_SEARCH_FILE, 'utf8')) })
    } catch {
      json(res, 200, { ok: true, rows: [] })
    }
  }

  /* 收对标候选池：benchmark-collect --search 边搜边写的那份作者候选，弹层隔几秒来读一次。
   *  没这份文件＝这台机器还没搜过；这里只报有没有，空态怎么说由弹层定。 */
  function benchmarkSearch(req, res) {
    if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'GET only' })
    try {
      json(res, 200, { ok: true, ...JSON.parse(readFileSync(BENCH_SEARCH_FILE, 'utf8')) })
    } catch {
      json(res, 200, { ok: true, rows: [] })
    }
  }

  /* 对标账号端点：POST 手动建档（只落链接与理由），DELETE 不再对标＝归档。
   *  实测读数不在这里取——建档成功后界面接着排一次 benchmark-one，那才是碰浏览器的动作。 */
  async function benchmark(req, res, url) {
    if (req.method === 'DELETE') {
      const rel = url.searchParams.get('file') || ''
      try {
        json(res, 200, { ...archiveBenchmarkMd(rel), ok: true })
        logger.info(`[benchmark] archive ${rel}`)
        refresh()
      } catch (e) {
        json(res, 400, { ok: false, error: errText(e) })
      }
      return
    }
    if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'POST/DELETE only' })
    try {
      const payload = JSON.parse((await readBody(req)) || '{}')
      if (!payload.url) throw new Error('先把主页链接粘进来')
      const r = writeBenchmarkMd(payload)
      json(res, 200, r)
      logger.info(`[benchmark] 手动建档 ${r.rel}`)
      refresh()
    } catch (e) {
      json(res, 400, { ok: false, error: errText(e) })
    }
  }

  /* 安装引导用：告诉页面扩展目录在哪（本机绝对路径），供「复制路径」按钮 */
  function extensionPath(req, res) {
    json(res, 200, { ok: true, dir: join(ROOT, 'extension') })
  }

  /* 草稿端点：灵感一键转选题 → 落 md 文件（文件驱动，替代浏览器便签） */
  async function draft(req, res, url) {
    if (req.method === 'DELETE') {
      const rel = url.searchParams.get('file') || ''
      try {
        json(res, 200, deleteDraftMd(rel))
        logger.info(`[draft] 已删除 ${rel}`)
        refresh()
      } catch (e) {
        json(res, 400, { ok: false, error: errText(e), got: req.url })
      }
      return
    }
    if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'POST/DELETE only' })
    try {
      const payload = JSON.parse((await readBody(req)) || '{}')
      if (!payload.account) throw new Error('缺少 account')
      const r = writeDraftMd(payload)
      json(res, 200, { ok: true, ...r })
      logger.info(`[draft] ${r.rel}`)
      refresh()
    } catch (e) {
      json(res, 400, { ok: false, error: errText(e) })
    }
  }

  /* 选题池端点：立项闸门。POST 入池/立项，DELETE 淘汰＝归档 */
  async function topic(req, res, url) {
    if (req.method === 'DELETE') {
      const rel = url.searchParams.get('file') || ''
      try {
        json(res, 200, { ...archiveTopicMd(rel), ok: true })
        logger.info(`[topic] archive ${rel}`)
        refresh()
      } catch (e) {
        json(res, 400, { ok: false, error: errText(e) })
      }
      return
    }
    if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'POST/DELETE only' })
    try {
      const p = JSON.parse((await readBody(req)) || '{}')
      // 只带 form = 改这条选题的产出形态（图文 / 视频），不重新立项
      if (p.rel && p.form && !p.platforms) {
        const r = setTopicForm(p.rel, p.form)
        json(res, 200, { ...r, ok: true })
        logger.info(`[topic] form ${p.rel} → ${p.form}`)
        refresh()
        return
      }
      const r = p.rel ? promoteTopic(p.rel, p.platforms) : writeTopicMd(p)
      // 从采集卡入池：给源卡打「已转选题」标记，收集列表默认隐藏（文件保留）
      let convertMarkError
      if (p.sourceRel && !(p.rel && p.account)) {
        try {
          markTopicConverted(p.sourceRel)
        } catch (e) {
          convertMarkError = errText(e)
        }
      }
      json(res, 200, { ...r, ok: true, ...(convertMarkError ? { convertMarkError } : {}) })
      logger.info(`[topic] ${p.rel ? 'promote' : 'create'} ${p.rel || p.title}`)
      refresh()
    } catch (e) {
      json(res, 400, { ok: false, error: errText(e) })
    }
  }

  /* 排期端点：待排期 → 已排期（mv 文件 + 日期命名） */
  async function schedule(req, res) {
    if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'POST only' })
    try {
      const { rel, date } = JSON.parse((await readBody(req)) || '{}')
      if (!rel || !date) throw new Error('缺少 rel 或 date')
      const r = scheduleNote(rel, date)
      json(res, 200, { ...r, ok: true })
      logger.info(`[schedule] ${date} ← ${rel}`)
      refresh()
    } catch (e) {
      json(res, 400, { ok: false, error: errText(e) })
    }
  }

  /* 复盘学习环端点：写回稿的「## 这篇教会了我们什么」段（数据复盘页的输入位，原来只能改 md）。
     一次可写同题的几版稿：复盘答的是「这个题这么做成不成」，五版各抄一遍是假工作量。 */
  async function lesson(req, res) {
    if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'POST only' })
    try {
      const p = JSON.parse((await readBody(req)) || '{}')
      const rels = (Array.isArray(p.files) && p.files.length ? p.files : [p.rel])
        .map((x) => String(x || '').replaceAll('\\', '/'))
        .filter(Boolean)
      if (!rels.length) throw new Error('缺少 rel')
      const body = String(p.text || '').trim()
      const section = body ? `## 这篇教会了我们什么\n\n${body}\n` : ''
      // 先全量校验再落盘：写到第三版才发现路径不对，前两版已经改了，界面却说「失败」
      const targets = rels.map((rel) => {
        if (!/^content\/Projects\/发布排期\//.test(rel)) throw new Error('只能写发布排期里的稿件：' + rel)
        const abs = join(ROOT, rel)
        if (!existsSync(abs)) throw new Error('稿件不存在：' + rel)
        return { rel, abs, md: readFileSync(abs, 'utf8') }
      })
      const written = []
      for (const { rel, abs, md } of targets) {
        let updated = md
        if (/^## 这篇教会了我们什么/m.test(md)) {
          // 替换整段：段头行 + 后续所有非「## 」开头的行
          updated = md.replace(/^## 这篇教会了我们什么[^\n]*(?:\n(?!## ).*)*/m, section)
          // 清空时段前那个空行会留在文件尾：删一次结论不该在稿尾留一串空行
          if (!section) updated = updated.replace(/\s*$/, '\n')
        } else if (section) {
          updated = md.trimEnd() + '\n\n' + section
        }
        if (updated === md) continue
        writeFileSync(abs, updated)
        written.push(rel)
      }
      json(res, 200, { ok: true, written: written.length })
      logger.info(`[lesson] ${written.length} 版写回${written.length ? `：${written.map((x) => x.split('/').pop()).join(' ')}` : '（内容没变化）'}`)
      refresh()
    } catch (e) {
      json(res, 400, { ok: false, error: errText(e) })
    }
  }

  /* 复盘预答：机器把「这篇教会了我们什么」的三件套草稿答出来，人改完再走 /__lesson 落盘。
     不落盘是故意的——结论要人认账，替人写完再让人改，等于系统自己签了个字。 */
  async function review(req, res) {
    if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'POST only' })
    try {
      const p = JSON.parse((await readBody(req)) || '{}')
      const rel = String(p.rel || '')
      if (!/^content\/Projects\/发布排期\//.test(rel.replaceAll('\\', '/'))) {
        throw new Error('只能复盘发布排期里的稿')
      }
      if (!existsSync(join(ROOT, rel))) throw new Error('稿件不存在：' + rel)
      const r = await runReviewDraft({
        rel,
        dataScore: typeof p.dataScore === 'number' ? p.dataScore : null,
        scoreNote: String(p.scoreNote || ''),
      }, (m) => logger.info(`[review] ${m}`))
      json(res, 200, r)
      if (r.ok) logger.info(`[review] 预答完成 ${rel}（草稿 ${r.draft.length} 字，未落盘）`)
    } catch (e) {
      json(res, 200, { ok: false, error: errText(e) })
    }
  }

  /* 产品档案端点：产品页的新建/编辑 → config/products.json（入口、口径、真截图的唯一登记处）。
     GET 顺带列出本机真存在的图片：界面只让人勾选，不给人留打错路径的机会。 */
  async function product(req, res) {
    if (req.method === 'GET') {
      json(res, 200, { ok: true, products: readProducts().products, images: listShotImages() })
      return
    }
    if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'GET/POST only' })
    try {
      const p = JSON.parse((await readBody(req)) || '{}')
      const saved = writeProduct(p.product ?? p, { originalName: p.originalName })
      json(res, 200, { ok: true, product: saved })
      logger.info(`[product] ${p.originalName ? '改' : '建'} ${saved.name}`)
      refresh()
    } catch (e) {
      json(res, 400, { ok: false, error: errText(e) })
    }
  }

  /* 一键同款：plan 只算不写（界面预览与生成前检查都读它），write 才落盘并渲图。
   * 事实与入口一律由 same-style-core 从产品档案取，界面传进来的同名字段一概不吃。 */
  async function sameStyle(req, res) {
    if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'POST only' })
    try {
      const p = JSON.parse((await readBody(req)) || '{}')
      const plan = await planSameStyle(p)
      if (p.mode !== 'write') {
        json(res, 200, { ok: true, plan })
        return
      }
      if (!plan.ok) {
        json(res, 400, { ok: false, error: plan.errors.join('；'), errors: plan.errors })
        return
      }
      if (syncJob && syncJob.finishedAt === null) {
        json(res, 200, { ok: false, error: `${taskCn(syncJob.task)} 正在跑（共用浏览器登录态），等它跑完再生成` })
        return
      }
      const written = writeSameStyle(plan)
      let rendered = []
      let renderError = ''
      try {
        const r = await renderCardPages(written.cardRel, null)
        rendered = r.rendered || []
      } catch (e) {
        // 文字与草稿已经落盘，只是图没跟上：如实报，别把这趟说成失败（与 /__card 同一口径）
        renderError = errText(e)
      }
      logger.info(`[same-style] ${plan.product.name} ← 方案「${plan.playbook.name}」：${written.slug}（${rendered.length} 页成图${renderError ? ' · 渲染未完成' : ''}）`)
      json(res, 200, { ok: true, plan, written, rendered, renderError })
      refresh()
    } catch (e) {
      json(res, 400, { ok: false, error: errText(e) })
    }
  }

  /* 图卡文字端点：创作台编辑卡片文字 → 写单源 json → 只重渲改动页（渲染要开浏览器，请求会挂十几秒） */
  async function card(req, res) {
    if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'POST only' })
    try {
      const { jsonRel, data, renderAll = false, renderPages = null } = JSON.parse((await readBody(req)) || '{}')
      if (!jsonRel || !data) throw new Error('缺少 jsonRel 或 data')
      if (syncJob && syncJob.finishedAt === null) throw new Error(`${taskCn(syncJob.task)} 正在跑（共用浏览器登录态），稍后再存图卡`)
      const { changedPages } = writeCardJson(jsonRel, data)
      /* renderPages 是 0 基页号，给「选主题只看封面」用：换主题时 pages[] 一个字没动，
         changedPages 是空的，不显式指定页就会存了不渲——界面看着像没生效。 */
      const only = Array.isArray(renderPages) && renderPages.length ? renderPages.map((i) => Number(i)) : null
      const pages = renderAll ? null : only || changedPages
      if (pages && !pages.length) {
        json(res, 200, { ok: true, saved: true, rendered: [] })
        logger.info('[card] 文字无改动，不渲染')
        return
      }
      try {
        const r = await renderCardPages(jsonRel, pages)
        json(res, 200, { ok: true, saved: true, rendered: r.rendered, pageCount: r.pages })
        logger.info(`[card] 已存并重渲 ${r.rendered.join(',') || '全部'} 页`)
      } catch (e) {
        // 文字已落盘，只是图没跟上：让界面如实报「已保存、图待重渲」而不是假装失败
        json(res, 200, { ok: true, saved: true, rendered: [], renderError: errText(e) })
        logger.info(`[card] 文字已存，渲染失败：${errText(e)}`)
      }
      // 必须在渲染之后：build-data 要把新生成的 png 扫进 urls，早跑一次就是空列表
      refresh()
    } catch (e) {
      json(res, 400, { ok: false, error: errText(e) })
    }
  }

  /* 模板小样补渲：选择器里的图是预渲的，改了皮肤/版式 HTML/示例文案后指纹对不上，
   * 界面显示「小样过期」并把这几条 key 点名传过来——一次最多一屏，12 张要三分多钟。 */
  async function templateThumb(req, res) {
    if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'POST only' })
    try {
      const p = JSON.parse((await readBody(req)) || '{}')
      const keys = (Array.isArray(p.templates) ? p.templates : []).map(String).filter(Boolean).slice(0, 12)
      if (!keys.length) throw new Error('没说要补渲哪几条模板')
      const r = await renderTemplateThumbs(keys)
      json(res, 200, { ok: true, rendered: r.rendered || [], failed: r.failed || [] })
      logger.info(`[template-thumb] 已补渲 ${r.rendered?.join(',') || '无'}`)
      refresh()
    } catch (e) {
      json(res, 400, { ok: false, error: errText(e) })
    }
  }

  /* 一键克隆爆款视觉：预览 → 存候选 → 转正 / 删掉，三步都走这一个端点。
   * 预览吃界面当场从参考图取到的色值（还没入库），渲一张真图给人对着看；
   * 存下来的东西一律 status=candidate，进不了推荐位，人在候选栏点头才转 active。 */
  async function cloneVisual(req, res) {
    if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'POST only' })
    let p
    try {
      p = JSON.parse((await readBody(req)) || '{}')
    } catch {
      return json(res, 400, { ok: false, error: '参数不是合法 JSON' })
    }
    const mode = String(p.mode || '')
    try {
      if (mode === 'preview') {
        const layouts = (Array.isArray(p.layouts) ? p.layouts : []).map((s) => String(s)).filter(Boolean).slice(0, 3)
        if (!layouts.length) throw new Error('没说要预览哪几个版式')
        const themesCfg = JSON.parse(readFileSync(join(ROOT, 'config/card-themes.json'), 'utf8'))
        const { tokens, rejected } = sanitizeTokens(p.tokens, themesCfg)
        if (rejected.length) throw new Error(`这些色位收不下：${rejected.join('；')}`)
        if (!Object.keys(tokens).length) throw new Error('一个色位都没取到，预览出来也没得看')
        const r = await renderClonePreview(Buffer.from(JSON.stringify({ layouts, tokens })).toString('base64'))
        logger.info(`[clone-visual] 预览 ${r.pages.map((x) => `${x.layout}${x.cached ? '(复用)' : ''}`).join('、')}`)
        return json(res, 200, { ok: true, pages: r.pages })
      }
      if (mode === 'save') {
        const r = saveClone(p, { root: ROOT })
        // 撞库里已有那条（同皮同排法）时没写盘，也就不必重建数据
        if (r.duplicate) return json(res, 200, { ok: true, ...r })
        logger.info(`[clone-visual] 存候选 ${r.templateKey}${r.reusedTheme ? '（沿用现有皮）' : ''}`)
        json(res, 200, { ok: true, ...r })
        refresh()
        return
      }
      if (mode === 'promote' || mode === 'drop') {
        const r = mode === 'promote' ? promoteClone(p, { root: ROOT }) : dropClone(p, { root: ROOT })
        logger.info(`[clone-visual] ${mode === 'promote' ? '转正' : '删掉'} ${r.templateKey}${r.droppedTheme ? `（连皮 ${r.droppedTheme} 一起清）` : ''}`)
        json(res, 200, { ok: true, ...r })
        refresh()
        return
      }
      throw new Error(`不认识的克隆模式「${mode || '未填'}」`)
    } catch (e) {
      json(res, 400, { ok: false, error: errText(e) })
    }
  }

  /* 视频爆款结构收编：界面把选中的抖音/小红书视频爆款整批发来（含逐字稿），
   * 服务端从时间码量出节奏、落成候选，一条一次写盘。
   * 与图文那条的分工：图文要取像素只能在本机浏览器里读，视频读的是文本，交给服务端算。 */
  async function videoHarvest(req, res) {
    if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'POST only' })
    let p
    try {
      p = JSON.parse((await readBody(req)) || '{}')
    } catch {
      return json(res, 400, { ok: false, error: '参数不是合法 JSON' })
    }
    const mode = String(p.mode || 'save')
    try {
      if (mode === 'save') {
        const items = Array.isArray(p.items) ? p.items.slice(0, 60) : []
        if (!items.length) throw new Error('没说要收哪几条爆款')
        const r = saveVideoCandidates(items, { root: ROOT })
        logger.info(`[video-harvest] 收候选 ${r.saved.map((x) => x.key).join('、') || '无'}${r.skipped.length ? `（跳过 ${r.skipped.length}：${r.skipped.map((s) => s.why).join('；')}）` : ''}`)
        json(res, 200, { ok: true, ...r })
        if (r.saved.length) refresh()
        return
      }
      if (mode === 'promote' || mode === 'drop') {
        const r = mode === 'promote' ? promoteVideoCandidate(p, { root: ROOT }) : dropVideoCandidate(p, { root: ROOT })
        logger.info(`[video-harvest] ${mode === 'promote' ? '转正' : '删掉'} ${r.templateKey}`)
        json(res, 200, { ok: true, ...r })
        refresh()
        return
      }
      throw new Error(`不认识的收编模式「${mode || '未填'}」`)
    } catch (e) {
      json(res, 400, { ok: false, error: errText(e) })
    }
  }

  /* 局部优化端点：一句意见改所有版。
   * plan 只问模型、一个字都不写；apply 才落盘——模型交整段新文字，写回是整段替换（见 refine-core.mjs），
   * 图卡跟着自动重渲改动页，不给人留「记得去终端跑一次」的尾巴。 */
  async function refine(req, res) {
    if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'POST only' })
    try {
      const p = JSON.parse((await readBody(req)) || '{}')
      if (p.mode === 'apply') {
        const edits = Array.isArray(p.edits) ? p.edits.filter((e) => e && e.rel && String(e.after || '').trim()) : []
        if (!edits.length) return json(res, 400, { ok: false, error: '没有勾选要写回的改动' })
        if (syncJob && syncJob.finishedAt === null) {
          return json(res, 200, { ok: false, error: `${taskCn(syncJob.task)} 正在跑（共用浏览器登录态），等它跑完再写回` })
        }
        const { results, writes } = applyRefineEdits(ROOT, edits)
        const rendered = []
        for (const w of writes) {
          if (w.kind === 'md') {
            const tmp = `${w.abs}.${process.pid}.tmp`
            writeFileSync(tmp, w.md)
            renameSync(tmp, w.abs)
            logger.info(`[refine] 已改 ${w.rel}`)
            continue
          }
          const { changedPages } = writeCardJson(w.rel, w.data)
          if (!changedPages.length) continue
          try {
            const r = await renderCardPages(w.rel, changedPages)
            rendered.push(...r.rendered)
            logger.info(`[refine] ${w.rel} 已重渲第 ${r.rendered.join(',')} 页`)
          } catch (e) {
            // 文字已落盘，只是图没跟上：如实报，别把整次写回说成失败
            results.push({ rel: w.rel, error: `图卡文字已存，页没重渲：${errText(e)}` })
            logger.info(`[refine] 图卡文字已存，渲染失败：${errText(e)}`)
          }
        }
        json(res, 200, { ok: true, results, rendered })
        refresh()
        return
      }

      const targets = refineTargets(ROOT, Array.isArray(p.targets) ? p.targets : [])
      const chars = targets.reduce((n, t) => n + t.text.length, 0)
      logger.info(`[refine] 问模型：${targets.length} 个可改单元 / ${chars} 字`)
      const r = await runRefinePlan({
        instruction: p.instruction,
        targets,
        // 来源脚本是复刻的事实锚：不带上，优化着优化就把原话的意思改丢了
        basis: String(p.basis || '').slice(0, 4000),
        knowledge: loadAiContext(ROOT),
        chat: (a) => chatCompletion(a),
      })
      json(res, 200, r)
    } catch (e) {
      json(res, 200, { ok: false, error: errText(e) })
    }
  }

  /* 一键推草稿：组装 payload → spawn ego-browser 自动填平台发布页 → 只进草稿箱（铁律：最后一下人点） */

  /** 脚本回传的进箱凭据字段各平台不同（草稿箱计数 / 未发布横幅 / 快手只填单不进箱） */
  function pushEvidenceOf(o) {
    const c = o.draftCount || o.drafts
    if (c && typeof c.before === 'number') return `草稿箱 ${c.before} → ${c.after}`
    if (o.draftBanner) return '已存草稿'
    if (o.filled) return '发布页已填好'
    return o.savedToDraft ? '已存草稿' : ''
  }

  /** 推一版（account = 账号 id）：resolve 脚本自报的 JSON（含 draftCount / draftBanner / filled 等凭据），
   *  reject 只在进程起不来时发生 */
  function runPush(rel, account) {
    const scriptFile = accountScript(account)
    if (!existsSync(scriptFile)) {
      throw new Error(`缺少 ${account} 推草稿脚本（${scriptFile}），请手动到平台后台创建草稿`)
    }
    const info = prepareXhsPublish(rel, undefined, account)
    logger.info(`[autopublish] ${account} 组装完成：${info.title}（${info.lines} 行 / ${info.tags} 话题${info.music ? ` / 配乐 ${info.music}` : ''}）`)
    publishing = account

    return new Promise((done, fail) => {
      const child = spawn(EGO_BIN, ['nodejs'], { stdio: ['pipe', 'pipe', 'pipe'], cwd: ROOT })
      let out = ''
      let settled = false
      const killer = setTimeout(() => child.kill('SIGKILL'), 330_000)
      const unlock = () => { settled = true; clearTimeout(killer); publishing = null }
      // 和 run-ego.mjs 同一套注入：ego 内嵌 Node 不保证跑在 spawn 的 cwd 里（官方文档原话：
      // 「脚本不跑在你的 shell 工作目录，读写文件一律用绝对路径」）。推草稿脚本里的
      // `${process.cwd()}/scripts/ego-space.mjs` 正踩这个坑——装机版的数据目录带空格与中文
      // （~/Library/Application Support/创作者增长平台），cwd 一旦不是项目根，动态 import 就把
      // 路径当 URL 解析，直接炸成 ERR_INVALID_FILE_URL_HOST，两版连错就中止整串（2026-10-23）。
      // 这里在脚本正文之前把 cwd 与关键 env 钉死，脚本再拿 process.cwd() 就是项目根。
      child.stdin.write(
        `process.chdir(${JSON.stringify(ROOT)});` +
        `process.env.MEDIA_HUB_ROOT=${JSON.stringify(ROOT)};` +
        `process.env.MEDIA_HUB_NODE=${JSON.stringify(process.execPath)};` +
        `process.env.PATH=${JSON.stringify(process.env.PATH || '')};` +
        `process.env.EGO_TASK=${JSON.stringify(process.env.MEDIA_HUB_TASK || '')};\n`,
      )
      child.stdin.write(readFileSync(scriptFile, 'utf8'))
      child.stdin.end()
      child.stdout.on('data', (c) => (out += c))
      child.stderr.on('data', (c) => (out += c))
      // ego 不在 PATH 时只有 error 没有 close：不解锁会永久卡住推草稿
      child.on('error', (e) => { if (!settled) { unlock(); fail(e) } })
      child.on('close', (code) => {
        if (settled) return
        unlock()
        const result = egoResult(out)
        // 完整输出落一份盘：界面只留尾巴（600 字），定位 TypeError 这类问题要的是整段堆栈。
        // 追加写、带分隔线，一次推送里几版各记一段；失败时把它写进返回的 error 尾巴里，人能直接看到路径。
        try {
          appendFileSync(PUSH_RAW_LOG, `${'='.repeat(72)}\n[${new Date().toISOString()}] ${account} · ${rel}\nexit=${code} ok=${!!result.ok}\n${out}\n`)
        } catch { /* 日志写不进去不影响推送结果 */ }
        // 进箱成功 → 在 md 里记「草稿已推-平台」，队列据此显示中间态。
        // 记账不能让队列陪葬：这段在 child 的 close 回调里，抛出去是未捕获异常，整个 dev server 当场死，
        // done() 也就再也回不来 —— 界面上那条会一直「正在填」数秒，后面的平台全卡在排队中。
        if (result.ok) {
          try {
            markDraftPushed(rel, account)
          } catch (e) {
            logger.info(`[autopublish] 草稿标记写入失败（不影响进箱结果）: ${errText(e)}`)
          }
        }
        // 归类与「该做什么」在这里补齐一次：单版端点和队列拿到的都是同一份成品，
        // 登录证据也一并写回 —— 谁推的都算数，不许只有界面那条链会记住
        const body = result.ok ? result : humanize({ ok: false, error: result.error || '推送失败', code: result.code || undefined })
        recordPushEvidence(account, {
          state: body.ok ? 'done' : 'fail',
          code: body.code || '',
          error: body.error || '',
          action: body.action || '',
          evidence: body.ok ? pushEvidenceOf(body) : '',
        })
        refresh()
        logger.info(`[autopublish] 结果: ${JSON.stringify(body).slice(0, 200)}`)
        done({ ...body, log: out.slice(-2000) })
      })
    })
  }

  /* POST 启动队列 / GET 轮询进度；单版走 /__autopublish 照旧保留（推送提示词发给外部 Agent 时用的是它） */
  async function autopublish(req, res) {
    if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'POST only' })
    try {
      const { rel, platform = '小红书' } = JSON.parse((await readBody(req)) || '{}')
      if (!rel) throw new Error('缺少 rel')
      if (publishing) throw new Error(`「${publishing}」正在推草稿，一次只能推一个（共用浏览器和参数文件）`)
      if (syncJob && syncJob.finishedAt === null) throw new Error(`${taskCn(syncJob.task)} 正在跑（共用浏览器登录态），等它结束再推草稿`)
      json(res, 200, await runPush(rel, platform))
    } catch (e) {
      publishing = null
      json(res, 400, { ok: false, error: errText(e) })
    }
  }

  /* ==================== 推草稿队列：整串在服务端串行跑，页面刷新与关窗都不丢进度 ====================
   * 2026-09-28：以前逐版循环活在页面里，刷新就断在半路、剩下的版再也不推。
   * 一次只推一版不改动——payload 文件与浏览器登录态是共享单例，抖音草稿还是单槽。 */
  let pushQueue = null

  const pushView = () => pushQueue && {
    ...pushQueue,
    running: pushQueue.finishedAt === null,
    steps: pushQueue.steps.map((s) => ({ ...s })),
  }

  /** 推草稿这一趟本身就是最硬的登录证据：进了草稿箱记 ok，砸在「号不行」上记 out，
   *  写回 metrics/login-state.json（publish-check 每晚只是补一次全量）。
   *  不写回去的话，「视频号没登录」这件事每晚的体检都被一次浏览器接管盖掉，
   *  界面上永远显示「没测出来」，每次起串都要撞满两分钟才知道。 */
  function recordPushEvidence(account, s) {
    const dead = s.state === 'done' ? '' : loginEvidenceOf(s.code)
    if (!dead && s.state !== 'done') return
    const p = `${ROOT}/metrics/login-state.json`
    try {
      const doc = existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : { checkedAt: null, platforms: {} }
      if (!doc.platforms || typeof doc.platforms !== 'object') doc.platforms = {}
      const at = new Date().toISOString()
      const prev = doc.platforms[account] || {}
      doc.platforms[account] = s.state === 'done'
        ? { ...prev, state: 'ok', evidence: s.evidence || '草稿已推', error: '', code: '', label: '', action: '', checkedAt: at }
        : { ...prev, state: 'out', error: s.error, code: s.code, label: labelOf(s.code), action: s.action, checkedAt: at }
      doc.checkedAt = at
      mkdirSync(`${ROOT}/metrics`, { recursive: true })
      writeFileSync(`${p}.tmp`, JSON.stringify(doc, null, 2) + '\n')
      renameSync(`${p}.tmp`, p)
      logger.info(`[push] ${account} 登录证据写回：${doc.platforms[account].state}`)
    } catch (e) {
      logger.info(`[push] 登录证据写回失败（不影响推送结果）: ${errText(e)}`)
    }
  }

  /** 串行跑完整串：单版失败只标它自己，后面的接着推（各平台草稿箱互不相干）；
   *  连错两版才中止整串——多半是风控弹窗或登录态掉了，继续撞只会更伤号。
   *  版与版之间随机停 10–30s：同一账号被紧跟着连续自动化，是风控眼下最显眼的特征。
   *  失败的那版把脚本日志尾巴留在 step 上，界面上能直接展开看到页面文案，不用去翻终端。 */
  const nap = (ms) => new Promise((r) => setTimeout(r, ms))
  async function runPushQueue() {
    const j = pushQueue
    let streak = 0
    /* 按停走「这一版推完就收手」，不掐在半路：脚本正填着平台的发布页，掐了会留下半张表单。
     * 版间那 10–30 秒的随机停顿按到就立刻生效，所以最长等一版（实测两分钟）就能停干净。 */
    const releaseJob = holdJob('push', { label: '推草稿', startedAt: j.startedAt, stop: () => (j.stopRequested = true) })
    for (let i = 0; i < j.steps.length; i++) {
      if (j.stopRequested) {
        j.stopped = true
        break
      }
      if (i) {
        const ms = 10_000 + Math.round(Math.random() * 20_000)
        j.napUntil = Date.now() + ms
        // 觉拆成半秒一小段：按停不必等满这一觉
        for (let left = ms; left > 0 && !j.stopRequested; left -= 500) await nap(Math.min(500, left))
        j.napUntil = 0
        if (j.stopRequested) {
          j.stopped = true
          break
        }
      }
      const s = j.steps[i]
      j.current = i
      s.state = 'running'
      s.startedAt = Date.now()
      let crashed = false
      try {
        let rel = s.rel
        if (j.date && !rel.includes('/已排期/')) rel = scheduleNote(rel, j.date).rel
        s.file = rel.replace(/^content\//, '')
        const r = await runPush(rel, s.platform)
        s.log = r.ok ? '' : String(r.log || '')
        if (r.ok) s.evidence = pushEvidenceOf(r)
        else {
          s.error = r.error || '推送失败'
          s.code = r.code || ''
          s.action = r.action || ''
        }
      } catch (e) {
        // 起手上就砸（本机没这个号的脚本、排期没挪成）：脚本根本没跑起来，归类与证据都由这里补
        crashed = true
        s.error = errText(e)
        const h = humanize({ ok: false, error: s.error })
        s.code = h.code || ''
        s.action = h.action || ''
      }
      s.endedAt = Date.now()
      s.state = s.error ? 'fail' : 'done'
      if (crashed) recordPushEvidence(s.platform, s)
      streak = s.error ? streak + 1 : 0
      if (streak >= 2) {
        j.aborted = true
        break
      }
    }
    for (const s of j.steps) if (s.state === 'queued') s.state = 'skipped'
    j.finishedAt = Date.now()
    releaseJob()
    logger.info(`[push] 队列结束：${j.steps.map((s) => `${s.platform}=${s.state}`).join(' ')}${j.aborted ? '（连错两版已中止）' : j.stopped ? '（人按了停止）' : ''}`)
    refresh()
  }

  /* 发布预览：只读稿与卡片清单，返回推草稿脚本实际会填进去的那份（不写 /tmp、不碰浏览器）。
   *  和 /__push 共用 buildPublishPayload——预览与真推不一致，这个功能就没有意义。 */
  async function previewApi(req, res) {
    if (req.method !== 'POST' && req.method !== 'GET') return json(res, 405, { ok: false, error: 'GET/POST only' })
    try {
      const url = new URL(req.url || '/', 'http://media-hub.local')
      const body = req.method === 'POST' ? JSON.parse((await readBody(req)) || '{}') : {}
      const rel = String(body.rel || url.searchParams.get('rel') || '')
      const account = String(body.account || url.searchParams.get('account') || '')
      if (!rel.startsWith('content/') || rel.includes('..')) return json(res, 400, { ok: false, error: 'rel 必须是 content/ 下的路径' })
      if (!account) return json(res, 400, { ok: false, error: '缺 account' })
      json(res, 200, { ok: true, preview: buildPublishPreview(rel, ROOT, account) })
    } catch (e) {
      json(res, 200, { ok: false, error: errText(e) })
    }
  }

  async function pushApi(req, res) {
    if (req.method === 'GET') return json(res, 200, { ok: true, job: pushView() })
    if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'GET/POST only' })
    try {
      const { items = [], date = '' } = JSON.parse((await readBody(req)) || '{}')
      if (pushQueue && pushQueue.finishedAt === null) {
        return json(res, 200, { ok: false, busy: true, job: pushView(), error: '已有推送在跑，等它结束' })
      }
      const list = items.filter((x) => x?.rel && x?.platform)
      if (!list.length) return json(res, 400, { ok: false, error: '缺少 items：[{rel, platform}]' })
      if (publishing) return json(res, 200, { ok: false, busy: true, error: `「${publishing}」正在推草稿，一次只能推一个` })
      if (syncJob && syncJob.finishedAt === null) {
        return json(res, 200, { ok: false, busy: true, error: `${taskCn(syncJob.task)} 正在跑（共用浏览器登录态），等它结束再推草稿` })
      }
      pushQueue = {
        date, startedAt: Date.now(), finishedAt: null, current: 0, aborted: false, napUntil: 0,
        steps: list.map((x) => ({
          platform: x.platform, rel: x.rel, file: '', state: 'queued',
          evidence: '', error: '', code: '', action: '', log: '', startedAt: null, endedAt: null,
        })),
      }
      logger.info(`[push] 队列启动：${list.map((x) => x.platform).join('、')}${date ? ` 排期 ${date}` : ''}`)
      runPushQueue()
      json(res, 200, { ok: true, started: true, job: pushView() })
    } catch (e) {
      json(res, 400, { ok: false, error: errText(e) })
    }
  }

  /* ==================== 内置生成：拆解走 chat 模型；图文/视频创作走本机 Agent CLI ==================== */
  /** 同一时刻只允许一个生成任务（创作会整批改稿文件） */
  let genJob = null

  function startGenJob(kind, detail, runner, limitMs = 0) {
    genJob = { kind, detail, key: '', startedAt: Date.now(), finishedAt: null, ok: null, error: '', progress: '', limitMs, log: [], stopped: false }
    logger.info(`[generate] ${kind} ${detail} 启动`)
    /* 界面上点了「停止」就掐在这里：Agent 子进程收 SIGKILL、chat 模型的请求收 abort。
     * 创作是整批改稿文件，停在半路会留下改了一半的那几份——这一条和超时看门狗本来就会做的事一样，
     * 人要的就是别让它再往下改，所以不再另设「等它写完」的温和档。 */
    const ac = new AbortController()
    const releaseJob = holdJob('gen', {
      label: KIND_CN[kind] || kind, startedAt: genJob.startedAt, limitMs,
      stop: () => { genJob.stopped = true; ac.abort() },
    })
    const done = runner((p) => {
      genJob.progress = p
      // 对话要把进度逐行留在界面上（其他任务只读最后一行）
      if (p && genJob.log[genJob.log.length - 1] !== p) genJob.log.push(p)
      if (genJob.log.length > 120) genJob.log.shift()
    }, ac.signal)
      .then((r) => {
        genJob.ok = !!r.ok
        genJob.error = r.error || ''
        if (r.aborted) genJob.stopped = true
        logger.info(`[generate] ${kind} 完成 ok=${!!r.ok}${r.error ? ' error=' + r.error : ''}`)
      })
      .catch((e) => {
        genJob.ok = false
        // 人按的停止会被 fetch/子进程抛成 AbortError——那句系统话要换成「人在界面上按了停止」
        genJob.error = isUserStop(e) ? STOPPED_TEXT : errText(e)
        genJob.stopped = isUserStop(e) || genJob.stopped
        logger.info(`[generate] ${kind} 失败: ${genJob.error}`)
      })
    /* 界面按了停止：done 那条链本身要等子进程真退出、请求真断开才 resolve，
     * 所以走到这里活儿已经停了——只是它自报的话是「超时/失败」那一类，这里换成「人在界面上按了停止」。 */
    const stopGenJob = async () => {
      if (!genJob.stopped) return
      genJob.ok = false
      genJob.error = STOPPED_TEXT
      genJob.finishedAt = Date.now()
      logger.info(`[generate] ${kind} ${STOPPED_TEXT}`)
    }
    done.then(stopGenJob).then(() => {
      releaseJob()
      if (genJob.finishedAt === null) genJob.finishedAt = Date.now()
      refresh()
    })
    return genJob
  }

  const genView = () => genJob && { ...genJob, running: genJob.finishedAt === null }

  /* POST 启动 / GET 轮询。teardown 同步校验脚本段（缺脚本直接报错，不白跑任务） */
  async function generate(req, res) {
    if (req.method === 'GET') return json(res, 200, { ok: true, job: genView() })
    if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'GET/POST only' })
    try {
      const p = JSON.parse((await readBody(req)) || '{}')
      if (genJob && genJob.finishedAt === null) {
        return json(res, 200, { ok: false, busy: true, job: genView(), error: `已有生成在跑（${genJob.kind} ${genJob.detail}），等它结束` })
      }
      if (p.kind === 'teardown') {
        if (!p.file) return json(res, 400, { ok: false, error: '缺少 file' })
        const abs = join(ROOT, p.file)
        if (!existsSync(abs)) return json(res, 400, { ok: false, error: '采集卡文件不存在' })
        if (!extractScript(readFileSync(abs, 'utf8'))) {
          return json(res, 400, { ok: false, error: '这条还没有「## 脚本」段——先点「补扒脚本」，拆解只认完整脚本' })
        }
        startGenJob('teardown', p.file.split('/').pop(), (log, signal) => runTeardown(p.file, log, signal))
        return json(res, 200, { ok: true, started: true })
      }
      if (p.kind === 'gate') {
        if (!p.file) return json(res, 400, { ok: false, error: '缺少 file' })
        const abs = join(ROOT, p.file)
        if (!existsSync(abs)) return json(res, 400, { ok: false, error: '选题卡文件不存在' })
        startGenJob('gate', p.file.split('/').pop(), (log, signal) => runGate(p.file, log, signal))
        return json(res, 200, { ok: true, started: true })
      }
      if (p.kind === 'create') {
        if (!p.prompt) return json(res, 400, { ok: false, error: '缺少 prompt' })
        const timeoutMs = 25 * 60_000
        // 上限也带给界面：「已跑 3:12 / 上限 25 分」比转圈至少说得清什么时候该怀疑它挂了
        startGenJob(p.kind, p.detail || '', (log, signal) => runAgentJob(p.prompt, { timeoutMs, label: p.kind, log, signal }), timeoutMs)
        // key = 选题卡 key：界面右上角浮层靠它跳回正在创作的这条选题
        genJob.key = typeof p.key === 'string' ? p.key : ''
        return json(res, 200, { ok: true, started: true })
      }
      json(res, 400, { ok: false, error: `未知生成类型：${p.kind}` })
    } catch (e) {
      json(res, 400, { ok: false, error: errText(e) })
    }
  }

  /* ==================== 一键克隆爆款：结构 → 我的号 → 成品，先预览后落盘 ==================== */
  /** 一次只克隆一条；结果留在服务端，界面拿它预览，点「存进创作台」才写盘 */
  let cloneJob = null
  const cloneView = () => cloneJob && {
    ...cloneJob, running: cloneJob.finishedAt === null,
    plan: cloneJob.finishedAt !== null && cloneJob.ok ? cloneJob.plan : undefined,
  }

  function startCloneJob(detail, runner) {
    cloneJob = { detail, startedAt: Date.now(), finishedAt: null, ok: null, error: '', progress: '', plan: null, log: [] }
    logger.info(`[clone] ${detail} 启动`)
    runner((p) => {
      cloneJob.progress = p
      if (p && cloneJob.log[cloneJob.log.length - 1] !== p) cloneJob.log.push(p)
    })
      .then((r) => { cloneJob.ok = !!r.ok; cloneJob.error = r.error || ''; cloneJob.plan = r || null })
      .catch((e) => { cloneJob.ok = false; cloneJob.error = errText(e) })
      .then(() => { cloneJob.finishedAt = Date.now(); logger.info(`[clone] 完成 ok=${!!cloneJob.ok}${cloneJob.error ? ' error=' + cloneJob.error : ''}`) })
    return cloneJob
  }

  async function clone(req, res) {
    if (req.method === 'GET') return json(res, 200, { ok: true, job: cloneView() })
    if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'GET/POST only' })
    try {
      const p = JSON.parse((await readBody(req)) || '{}')
      if (p.write === true) {
        if (!cloneJob || cloneJob.finishedAt === null) return json(res, 400, { ok: false, error: '还没有生成结果可存' })
        if (!cloneJob.ok) return json(res, 400, { ok: false, error: cloneJob.error || '上一次生成没成功' })
        const r = writeClone(cloneJob.plan, { root: ROOT })
        json(res, 200, r)
        if (r.ok) refresh()
        return
      }
      if (cloneJob && cloneJob.finishedAt === null) return json(res, 200, { ok: false, busy: true, error: '已经在克隆一条了，等它跑完' })
      if (genJob && genJob.finishedAt === null) return json(res, 200, { ok: false, busy: true, error: `「${genJob.kind}」还在跑，一次只做一件生成` })
      if (!p.file) return json(res, 400, { ok: false, error: '缺少 file' })
      startCloneJob(String(p.file).split('/').pop(), (log) => planClone(p, { root: ROOT, log }))
      json(res, 200, { ok: true, started: true })
    } catch (e) {
      json(res, 400, { ok: false, error: errText(e) })
    }
  }

  /* ==================== 对话入口：一句话交给本机 Agent，问答落 metrics/chats/<id>.json ==================== */
  /** 红线跟着进对话框：只推到平台草稿箱，真发布仍归人点 */
  const CHAT_PREAMBLE =
    '你在「创作者增长平台」里工作，可以读写本仓库文件、跑脚本。铁律：任何发布动作只推到平台草稿箱，不要真的发布。' +
    '做完用中文回一段结论，说清楚改了哪些文件、下一步该谁动。\n\n'
  const CHAT_DIR = join(ROOT, 'metrics/chats')
  /** 撞车提示要说人话：任务位是共用的，挡下来得讲清是谁占着 */
  const KIND_CN = { chat: '对话', create: '图文创作', video: '视频创作', teardown: '拆解', gate: '拟判据' }
  const chatPath = (id) => join(CHAT_DIR, `${id}.json`)
  const stamp = () => new Date().toISOString().slice(0, 16).replace('T', ' ')

  function readChat(id) {
    if (!/^[a-z0-9-]{4,40}$/.test(String(id || ''))) return null
    try {
      return JSON.parse(readFileSync(chatPath(id), 'utf8'))
    } catch {
      return null
    }
  }

  function writeChat(c) {
    mkdirSync(CHAT_DIR, { recursive: true })
    const tmp = `${chatPath(c.id)}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(c, null, 1))
    renameSync(tmp, chatPath(c.id))
  }

  function listChats() {
    if (!existsSync(CHAT_DIR)) return []
    return readdirSync(CHAT_DIR)
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        try {
          const c = JSON.parse(readFileSync(join(CHAT_DIR, f), 'utf8'))
          return { id: c.id, title: c.title, at: c.at, turns: c.messages.length }
        } catch {
          return null
        }
      })
      .filter(Boolean)
      .sort((a, b) => String(b.at).localeCompare(String(a.at)))
  }

  async function chat(req, res) {
    if (req.method === 'GET') {
      const url = new URL(req.url || '/', 'http://media-hub.local')
      // 不带 id 时认任务位：跑着的那条会话就是当前会话，否则中途刷新会掉回空首页
      const active = genJob && genJob.kind === 'chat' ? genJob.convId : ''
      const id = url.searchParams.get('id') || active
      return json(res, 200, {
        ok: true,
        conversation: readChat(id),
        conversations: listChats(),
        job: genJob && genJob.kind === 'chat' ? genView() : null,
      })
    }
    if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'GET/POST only' })
    try {
      const p = JSON.parse((await readBody(req)) || '{}')
      const prompt = String(p.prompt || '').trim()
      if (!prompt) return json(res, 400, { ok: false, error: '没说话呢' })
      if (genJob && genJob.finishedAt === null) {
        return json(res, 200, { ok: false, busy: true, error: `已有任务在跑（${KIND_CN[genJob.kind] || genJob.kind}｜${genJob.detail}），一次只能做一件` })
      }
      // 引用只认盘上真有的文件：界面给的路径不存在或想跳出仓库，一律丢掉，不拿它拼提示
      const refs = (Array.isArray(p.refs) ? p.refs : []).slice(0, 8).map((r) => ({
        label: String(r?.label || '').slice(0, 40),
        file: String(r?.file || ''),
      })).filter((r) => {
        const abs = resolve(ROOT, r.file)
        return r.file && abs.startsWith(ROOT + '/') && existsSync(abs)
      })
      const refBlock = refs.length
        ? `\n\n【引用的仓库文件】先读这几份再动手：\n${refs.map((r) => `- 《${r.label}》：${r.file}`).join('\n')}`
        : ''
      const conv = readChat(p.id) || {
        id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
        title: prompt.slice(0, 24),
        at: stamp(),
        messages: [],
      }
      conv.at = stamp()
      conv.messages.push({ role: 'user', text: prompt, at: conv.at, refs })
      writeChat(conv)
      startGenJob('chat', conv.title, (log, signal) =>
        runAgentJob(CHAT_PREAMBLE + prompt + refBlock, { timeoutMs: 15 * 60_000, label: '对话', log, signal }).then((r) => {
          genJob.answer = r.ok ? String(r.answer || r.tail || '').trim() : ''
          genJob.sessionId = r.sessionId || ''
          conv.sessionId = r.sessionId || conv.sessionId || ''
          conv.messages.push({ role: 'assistant', text: genJob.answer || r.error || '没跑出来', at: stamp(), ok: !!r.ok })
          conv.at = stamp()
          writeChat(conv)
          return r
        }), 15 * 60_000)
      genJob.convId = conv.id
      return json(res, 200, { ok: true, started: true, id: conv.id })
    } catch (e) {
      json(res, 400, { ok: false, error: errText(e) })
    }
  }

  /* AI 引擎配置端点：GET 读（不含 Key 内容），POST 写（baseUrl/model/Key/Agent 命令与端点） */
  async function llmConfig(req, res) {
    const view = () => {
      const c = readLlmConfig()
      return { ok: true, baseUrl: c.baseUrl, model: c.model, keyConfigured: !!readLlmKey(), agent: c.agent }
    }
    if (req.method === 'GET') return json(res, 200, view())
    if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'GET/POST only' })
    try {
      const p = JSON.parse((await readBody(req)) || '{}')
      for (const [k, v] of [['baseUrl', p.baseUrl], ['agentBaseUrl', p.agentBaseUrl]]) {
        if (v !== undefined && !/^https?:\/\//.test(v || '')) throw new Error(`${k} 需是 http(s) 地址`)
      }
      writeLlmConfig(p)
      if (typeof p.apiKey === 'string' && p.apiKey.trim()) writeLlmKey(p.apiKey)
      logger.info('[llm] 配置已更新')
      json(res, 200, view())
    } catch (e) {
      json(res, 400, { ok: false, error: errText(e) })
    }
  }

  /* 连通性测试：target=chat 测拆解模型，target=agent 测创作 Agent 的端点与模型 */
  async function llmTest(req, res) {
    if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'POST only' })
    try {
      const { target = 'chat' } = JSON.parse((await readBody(req)) || '{}')
      const reply = target === 'agent'
        ? await pingAgent()
        : await chatCompletion({ system: '你是连通性测试助手，只回复这两个字。', user: '回复：正常', maxTokens: 16, timeoutMs: 30_000 })
      json(res, 200, { ok: true, reply: reply.slice(0, 40) })
    } catch (e) {
      json(res, 200, { ok: false, error: errText(e) })
    }
  }

  /* 环境读数：这台机器缺什么，一次列全。判据住在 env-core，界面不碰命令行也不碰路径。 */
  async function envReport(req, res) {
    if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'GET only' })
    json(res, 200, await checkEnv())
  }

  /* 一键自检：判据只看盘上产物，一次约 0.2 秒（含数据层重建）。
   * 这里绝不叫浏览器——采集、发布检测、推草稿共用同一个已登录会话，抢不得。 */
  let selfChecking = false
  async function selfCheck(req, res) {
    if (req.method === 'GET') {
      let last = null
      try { last = JSON.parse(readFileSync(join(ROOT, 'metrics/selfcheck.json'), 'utf8')) } catch { /* 这台机器还没跑过自检 */ }
      return json(res, 200, last || { ok: false, at: '', items: [], never: true })
    }
    if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'GET/POST only' })
    if (selfChecking) return json(res, 409, { ok: false, error: '自检正在跑，等它出结果' })
    selfChecking = true
    try {
      json(res, 200, await runSelfCheck({ root: ROOT, logger }))
    } catch (e) {
      json(res, 400, { ok: false, error: errText(e) })
    } finally {
      selfChecking = false
    }
  }

  /* 起步向导：GET 现算四步读数（全是本机读数，不占浏览器），POST 只改「别再给我看」这个开关。
   * 第 4 步那一下采集不在这条端点上——它走 /__run-script 的单飞队列，和采集/推草稿共用一只浏览器。 */
  async function startGuide(req, res) {
    try {
      if (req.method === 'POST') {
        const { action } = JSON.parse((await readBody(req)) || '{}')
        if (!['dismiss', 'again'].includes(action)) return json(res, 400, { ok: false, error: 'action 只有 dismiss / again' })
        writeGuide({ dismissed: action === 'dismiss' }, { root: ROOT })
      } else if (req.method !== 'GET') {
        return json(res, 405, { ok: false, error: 'GET/POST only' })
      }
      json(res, 200, await startSteps({ root: ROOT }))
    } catch (e) {
      json(res, 400, { ok: false, error: errText(e) })
    }
  }

  /* 账号登记端点：授权页「新增账号」与「改昵称」。判据与落盘全在 accounts-core，界面不碰 JSON。
   * 写完即 refresh()：gen:data 重建后经 /__events 广播，界面靠 holdSelfWrite + resync 原地长出这一行。 */
  async function accountsApi(req, res) {
    if (req.method === 'GET') {
      try {
        return json(res, 200, { ok: true, platforms: accountCatalog(ROOT) })
      } catch (e) {
        return json(res, 400, { ok: false, error: errText(e) })
      }
    }
    if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'GET/POST only' })
    try {
      const { action, platform, nickname, id } = JSON.parse((await readBody(req)) || '{}')
      const account = action === 'add'
        ? addAccount({ platform, nickname }, ROOT)
        : action === 'rename'
          ? renameAccount({ id, nickname }, ROOT)
          : (() => { throw new Error('action 只有 add / rename') })()
      logger.info(`[accounts] ${action} ${account.id}（${account.nickname}）`)
      json(res, 200, { ok: true, account })
      refresh()
    } catch (e) {
      json(res, 400, { ok: false, error: errText(e) })
    }
  }

  /* 爆款采集口径端点：采集页「口径」弹窗的读与写。
   * 校验与落盘全在 viral-config-core（界面不碰 JSON 也不碰路径）；
   * 写完即 refresh()：gen:data 重建后经 /__events 广播，弹窗关掉后页面就地换成新口径。 */
  async function viralConfigApi(req, res) {
    if (req.method === 'GET') {
      const config = readViralConfig(ROOT)
      if (!config) return json(res, 400, { ok: false, error: 'config/viral.json 读不到，先确认文件在' })
      return json(res, 200, {
        ok: true,
        config: {
          keywords: config.keywords || [],
          platforms: config.platforms || [],
          minLikes: config.minLikes ?? 0,
          withinDays: config.withinDays ?? 0,
          dailyLimitPerPlatform: config.dailyLimitPerPlatform ?? 0,
        },
        supportedPlatforms: SUPPORTED_PLATFORMS,
      })
    }
    if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'GET/POST only' })
    try {
      const p = JSON.parse((await readBody(req)) || '{}')
      const config = writeViralConfig(p, ROOT)
      logger.info(`[viral-config] 口径已更新：${(config.keywords || []).length} 词 / ${(config.platforms || []).join('+')} / ≥${config.minLikes} 赞`)
      json(res, 200, { ok: true, config })
      refresh()
    } catch (e) {
      json(res, 400, { ok: false, error: errText(e) })
    }
  }

  /* 对标采集口径端点：对标账号页「采集条件」弹窗的读与写（config/benchmarks.json）。
   * 与爆款那一份各管各的门槛——两条线的判据不同，别让对标页去改爆款的口径。 */
  async function benchConfigApi(req, res) {
    if (req.method === 'GET') {
      const config = readBenchConfig(ROOT)
      if (!config) return json(res, 400, { ok: false, error: 'config/benchmarks.json 读不到，先确认文件在' })
      return json(res, 200, {
        ok: true,
        config: {
          keywords: config.keywords || [],
          platforms: config.platforms || [],
          minFollowers: config.minFollowers ?? 0,
          maxInactiveDays: config.maxInactiveDays ?? 0,
          dailyLimitPerPlatform: config.dailyLimitPerPlatform ?? 0,
        },
        supportedPlatforms: BENCH_SUPPORTED_PLATFORMS,
      })
    }
    if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'GET/POST only' })
    try {
      const p = JSON.parse((await readBody(req)) || '{}')
      const config = writeBenchConfig(p, ROOT)
      logger.info(`[benchmark-config] 口径已更新：${(config.keywords || []).length} 词 / ${(config.platforms || []).join('+')} / ≥${config.minFollowers} 粉`)
      json(res, 200, { ok: true, config })
      refresh()
    } catch (e) {
      json(res, 400, { ok: false, error: errText(e) })
    }
  }

  /* 收藏搬运口径端点：灵感库「采集配置」弹窗的读与写（名单 + 平台）。
   * 校验与落盘全在 favorites-config-core；写完即 refresh() 广播，页面就地换成新名单。 */
  async function favoritesConfigApi(req, res) {
    if (req.method === 'GET') {
      const config = readFavoritesConfig(ROOT)
      if (!config) return json(res, 400, { ok: false, error: 'config/favorites.json 读不到，先确认文件在' })
      return json(res, 200, {
        ok: true,
        config: { albums: config.albums || [], platforms: config.platforms || [] },
        supportedPlatforms: SUPPORTED_PLATFORMS,
      })
    }
    if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'GET/POST only' })
    try {
      const p = JSON.parse((await readBody(req)) || '{}')
      const config = writeFavoritesConfig(p, ROOT)
      logger.info(`[favorites-config] 口径已更新：${config.albums.join('、')} / ${(config.platforms || []).join('+')}`)
      json(res, 200, { ok: true, config })
      refresh()
    } catch (e) {
      json(res, 400, { ok: false, error: errText(e) })
    }
  }

  /* 手动同步端点：GET 查询当前任务状态，POST 启动任务，/ 停止走 /__stop-script。
   * 跑完那一笔落进 metrics/collect-runs.json 留痕——界面判「上次采到 / 隔了几天 / 哪几个平台没采到」
   * 只认留痕与产物，内存里的 syncJob 只当实时态（刷新页面不能把历史弄丢）。 */
  function takeStep(job, chunk) {
    job.lineBuf = (job.lineBuf || '') + chunk
    const lines = job.lineBuf.split('\n')
    job.lineBuf = lines.pop() || ''
    for (const line of lines) {
      const m = line.match(/^\[sync:step\] (\{.*\})$/)
      if (!m) continue
      try {
        const s = JSON.parse(m[1])
        const state = s.state === 'skip' ? 'skip' : s.state === 'error' ? 'error' : 'ok'
        const count = Number.isFinite(Number(s.count)) && s.count != null ? Number(s.count) : undefined
        if (s.platform) job.steps[s.platform] = { state, note: String(s.note || '').slice(0, 160), ...(count == null ? {} : { count }) }
      } catch { /* 半截 JSON 丢掉这块，下一行再接 */ }
    }
  }

  async function runScript(req, res) {
    if (req.method === 'GET') {
      // 界面带上它启动那一笔的 startedAt 来回话：syncJob 只有一格，授权跑完后界面自己叫的那次体检
      // 会把授权那一笔顶掉，不带 startedAt 就只剩「脚本没回话」这句谎（2026-10-23 实测）
      const wantAt = Number((req.url.match(/startedAt=(\d+)/) || [])[1]) || 0
      const source = wantAt
        ? (syncJob && syncJob.startedAt === wantAt ? syncJob : [...lastJob.values()].find((j) => j.startedAt === wantAt))
        : syncJob
      const running = !!source && source.finishedAt === null
      // 运行中的逐平台结果以进度文件为准（stdout 要到进程退出才到达），内存 steps 只当兜底
      const prog = running ? readRunProgress(source.task) : null
      const merged = { ...(source?.steps || {}), ...(prog?.steps || {}) }
      const job = source && {
        ...source, running, tail: source.tail.slice(-600), lineBuf: undefined,
        steps: Object.entries(merged).map(([platform, s]) => ({ platform, ...s })),
        progress: prog ? { platforms: prog.platforms || [], current: prog.current || null, updatedAt: prog.updatedAt || 0 } : null,
      }
      // 跑砸了要把脚本最后一句端给界面：起步那一步只写「没采回来」，没人看得懂为什么。
      // 归类看整段尾巴，展示只留最后两行——ego 的栈帧会把真正那句（Profile not found）挤出 600 字窗口，
      // 只看尾巴两行就只剩「exited with code 1」，会被错判成「太慢，重试一次」（2026-10-23 实测）
      if (job && !job.running && job.exitCode !== 0) {
        const lines = job.tail.split('\n').map((s) => s.trim()).filter(Boolean)
        // 人按了停止时不必抄尾巴：那一段是被掐断的半截 JSON 加 ego 的收工话，端给界面只会被当成故障原因
        const shown = source.stopped ? '人在界面上按了停止，这一趟没跑完' : pickReason(job.tail) || lines.slice(-2).join(' ')
        Object.assign(job, humanize({ ok: false, error: shown || '这一条没跑成', code: classify(source.tail) || undefined }))
      }
      json(res, 200, { ok: true, job })
      return
    }
    if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'GET/POST only' })
    const { task, arg } = JSON.parse((await readBody(req)) || '{}')
    const cfg = SYNC_TASKS[task]
    if (!cfg) return json(res, 400, { ok: false, error: `未登记的同步任务：${task}` })
    const kind = cfg.argKind || 'key'
    if (cfg.argRequired && !arg) {
      const ask = { url: '先把链接粘进来', platform: '先选一个平台', kw: '先输入关键词' }[kind]
      return json(res, 400, { ok: false, error: ask || `${task} 需要平台 key` })
    }
    if (arg && !ARG_RE[kind].test(String(arg))) return json(res, 400, { ok: false, error: ARG_ASK[kind] })
    if (syncJob && syncJob.finishedAt === null) {
      return json(res, 409, { ok: false, busy: true, error: `已有同步在跑：${taskCn(syncJob.task)}` })
    }
    // 授权页进页面会自动补一次过期体检（无人点击），所以这道撞车必须由服务端挡：
    // 采集脚本和推草稿用的是同一个浏览器、同一份 /tmp 参数文件，并行必出事。
    const busyWith = pushQueue && pushQueue.finishedAt === null
      ? '草稿推送'
      : publishing ? `「${publishing}」推草稿` : ''
    if (busyWith) return json(res, 409, { ok: false, busy: true, error: `${busyWith}正在进行（共用浏览器登录态），等它结束再同步` })
    try {
      rmSync(SYNC_STOP_FILE)
    } catch { /* 上一轮的停止信号没清干净，这一轮自己会覆盖 */ }
    try {
      rmSync(SYNC_PROGRESS_FILE)
    } catch { /* 上一轮的进度残档：本轮脚本第一次写就覆盖掉 */ }
    syncJob = { task, label: taskCn(task), arg: arg || null, startedAt: Date.now(), finishedAt: null, exitCode: null, tail: '', steps: {}, stopped: false, stopping: false, limitMs: cfg.timeoutMs }
    const thisJob = syncJob
    logger.info(`[sync] ${task} 启动`)
    const child = spawn('node', cfg.argFlag && arg ? [...cfg.args, '--args', cfg.argFlag, String(arg), ...(cfg.scriptArgs || [])] : cfg.args, {
      cwd: ROOT,
      // 任务 key 透传给脚本：进度行与停止信号都靠它认自己是谁（run-ego 再转注入进 ego 的进程环境）
      env: { ...process.env, MEDIA_HUB_TASK: task },
    })
    child.stdout.on('data', (c) => {
      syncJob.tail = (syncJob.tail + c).slice(-4000)
      takeStep(syncJob, String(c))
    })
    // ego 的 nodejs 运行时里 process.stdout.write 实际落在 stderr：进度行两条流都得接，
    // 否则逐平台结果全丢，留痕只能靠产物数（当天旧卡会把失败轮次记成成功）
    child.stderr.on('data', (c) => {
      syncJob.tail = (syncJob.tail + c).slice(-4000)
      takeStep(syncJob, String(c))
    })
    const killer = setTimeout(() => child.kill('SIGKILL'), cfg.timeoutMs)
    /* 登记进「跑着的活儿」：界面上任何一处看到它在跑，都得能按停。
     * 停止走信号文件而不是掐进程——脚本在一个平台跑完后自己收尾（exit 3），
     * 掐在半路会把 ego 的任务空间留成脏。 */
    const releaseJob = holdJob('sync', {
      label: taskCn(task), key: task, startedAt: syncJob.startedAt, limitMs: cfg.timeoutMs,
      // stopping 当场就翻：脚本要走到下一个边界才退，界面得先如实说「已按停」而不是让人再点一次
      stop: () => { writeFileSync(SYNC_STOP_FILE, task); thisJob.stopping = true },
    })
    child.on('close', (code) => {
      releaseJob()
      clearTimeout(killer)
      const stopped = readStopSignal() === task
      syncJob.finishedAt = Date.now()
      syncJob.exitCode = code
      syncJob.stopped = stopped
      lastJob.set(task, syncJob)
      logger.info(`[sync] ${task} 结束 exit=${code}${stopped ? '（人工停止）' : ''}`)
      // 每一笔跑完都留一行整段输出：装机版没有终端可看，上一笔的报错被下一笔顶掉就再也查不到了
      // （2026-10-23 授权砸在「搬二维码」那一步，界面只留下一句「脚本没回话」）。落 metrics/，不进版本管理。
      try {
        mkdirSync(join(ROOT, 'metrics'), { recursive: true })
        appendFileSync(join(ROOT, 'metrics', 'run-log.jsonl'), `${JSON.stringify({
          at: new Date(syncJob.startedAt).toISOString(), task, arg: arg || null, exitCode: code, stopped,
          secs: Math.round((syncJob.finishedAt - syncJob.startedAt) / 1000), tail: syncJob.tail,
        })}\n`)
      } catch { /* 留痕写不上不该把任务带崩 */ }
      try {
        rmSync(SYNC_STOP_FILE)
      } catch { /* 没写过信号就没有要清的 */ }
      if (!isCollectionTask(task)) return
      try {
        const rec = buildRun({
          root: ROOT, task, startedAt: syncJob.startedAt, finishedAt: syncJob.finishedAt,
          exitCode: code, stopped, steps: syncJob.steps, tail: syncJob.tail,
        })
        appendRun(ROOT, rec)
        // 留痕进了 metrics/ 不在文件监听范围里，得自己叫一次重建
        refresh()
        logger.info(`[sync] ${task} 留痕：${rec.ok ? '成功' : rec.partial ? '部分成功' : rec.stopped ? '已停止' : '失败'}·${Object.keys(rec.platforms).length} 个平台`)
      } catch (e) {
        logger.info(`[sync] ${task} 留痕没写成：${errText(e)}`)
      }
      // 搬运线跑完才有的脚本是本机 OCR 出的，拆解（含那一句话）在这里补，不占浏览器时间
      if (task === 'favorites') teardownFavoritePending().catch((e) => logger.info(`[teardown] 收藏卡补拆失败：${errText(e)}`))
    })
    json(res, 200, { ok: true, startedAt: syncJob.startedAt })
  }

  /** 界面点「停止」：一律走登记处（scripts/run-jobs.mjs），按活儿种类路由到各自的收尾方式。
   *  不带 job 的老调用仍当采集那一格处理，并且照旧认 task：
   *  正在跑的是爆款，不能因为谁点了复盘的停止就把爆款掐了。 */
  async function stopScript(req, res) {
    if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'POST only' })
    const { task, job } = JSON.parse((await readBody(req)) || '{}')
    const id = job || 'sync'
    if (id === 'sync' && task && syncJob && syncJob.finishedAt === null && syncJob.task !== task) {
      return json(res, 200, { ok: false, error: `正在跑的是「${taskCn(syncJob.task)}」，停的不是这一个` })
    }
    json(res, 200, stopJob(id))
  }

  /** 现在这台机器上在跑什么：界面上凡是摆「正在跑」那一格的地方，都要能从这里拿到按停的靶子 */
  function runningJobsApi(req, res) {
    if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'GET only' })
    json(res, 200, { ok: true, jobs: runningJobs() })
  }

  /** 账号页授权弹层 → 正在等的 open-login 脚本：raise=把登录窗口再弹一次，cancel=别等了直接收工，
   *  quick=替人点登录页上的「微信快捷登录」，swap=把那一屏换成二维码。
   *  走文件不走进程信号：脚本每 2.5 秒自己取一次，取到就退出，浏览器任务空间不会被掐成半截。 */
  async function loginSignal(req, res) {
    if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'POST only' })
    const { action } = JSON.parse((await readBody(req)) || '{}')
    if (!['raise', 'cancel', 'quick', 'swap'].includes(action)) {
      return json(res, 400, { ok: false, error: 'action 只有 raise / cancel / quick / swap' })
    }
    try {
      writeFileSync('/tmp/media-hub-login-signal', action)
    } catch (e) {
      return json(res, 200, { ok: false, error: errText(e) })
    }
    json(res, 200, { ok: true, action })
  }

  /** 授权弹层的二维码：open-login 每轮把登录页里的码搬到 /tmp/media-hub-login-qr.png，这里原样吐给 <img>。
   *  没码（还没取到 / 平台取不到 / 已收工）回 404，界面按「没取到码」显示兜底文案。 */
  async function loginQr(req, res) {
    if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'GET only' })
    try {
      const buf = readFileSync('/tmp/media-hub-login-qr.png')
      // 各平台登录页给的不是同一种图（公众号实测 JPEG），按魔数认类型
      const type = buf[0] === 0x89 ? 'image/png' : buf[0] === 0xff ? 'image/jpeg' : 'application/octet-stream'
      res.writeHead(200, {
        'Content-Type': type,
        'Cache-Control': 'no-store',
        'Content-Length': buf.length,
      })
      res.end(buf)
    } catch {
      json(res, 404, { ok: false, error: '没有二维码（还没取到或授权已结束）' })
    }
  }

  /* 就地发布：创作台弹层用的三条通道（参数、预览、信号） */

  /** 人在弹层里按下之前，先把「这一版要发什么、怎么发」写给脚本。
   *  走每号一份参数文件而不是 argv：argv 有白名单（只收小写 key），中文标题过不去。 */
  async function pressParams(req, res) {
    if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'POST only' })
    try {
      const { rel, account, mode = 'publish', at = '' } = JSON.parse((await readBody(req)) || '{}')
      if (!rel || !String(rel).startsWith('content/') || String(rel).includes('..')) throw new Error('rel 不合法')
      const atText = scheduleGate(mode, at)
      const entry = listAccounts().find((a) => a.id === account)
      if (!entry) throw new Error(`账号「${account}」没在 config/accounts.json 登记`)
      // 与 press-publish 开头那份适配器名单一致：接了草稿箱回读的平台才许走这条路（脚本自己还会再挡一道）
      if (!['小红书', '抖音'].includes(entry.platform)) throw new Error(`「${account}」还没接就地发布，这一版请到平台后台人工点`)
      let md
      try {
        md = readFileSync(join(ROOT, rel), 'utf8')
      } catch {
        throw new Error('稿子文件读不到')
      }
      const title = (md.match(/^# (.+)$/m) || [])[1]?.trim() || ''
      if (!title) throw new Error('稿子里没有 # 标题，脚本认不出草稿箱里那一格')
      // 脚本用这个时间在「同名多条草稿」里分辨（实测箱里五条同标题）；一进「编辑」平台的保存时间就会被刷成当下
      const pushedLine = md.split('\n').find((l) => l.startsWith(`- 草稿已推-${account}：`)) || ''
      const pushedAt = pushedLine ? pushedLine.split('：').slice(1).join('：').trim() : ''
      writeFileSync(`/tmp/media-hub-press-${entry.key}.json`, JSON.stringify({
        account, key: entry.key, platform: entry.platform, title,
        firstLine: '', pushedAt, rel, mode, at: mode === 'schedule' ? atText : '',
      }))
      json(res, 200, { ok: true, key: entry.key, title, pushedAt, mode, at: atText })
    } catch (e) {
      json(res, 200, { ok: false, error: errText(e) })
    }
  }

  /** 弹层里那张「从平台回读」的图：press-publish 每轮把编辑器整屏搬到 /tmp，这里原样吐给 <img>。
   *  没图（还在找那一格 / 已收工）回 404，界面按「还没截到」显示进度文案。 */
  async function publishPreview(req, res) {
    if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'GET only' })
    try {
      const buf = readFileSync(PRESS_PREVIEW)
      // 各平台截图给的不一定是同一种图，按魔数认类型（同 /__login-qr）
      const type = buf[0] === 0x89 ? 'image/png' : buf[0] === 0xff ? 'image/jpeg' : 'application/octet-stream'
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store', 'Content-Length': buf.length })
      res.end(buf)
    } catch {
      json(res, 404, { ok: false, error: '还没有截图（脚本还在草稿箱里找那一格）' })
    }
  }

  /** 弹层上那三颗钮 → 正在等的 press-publish 脚本：publish=就是这一条，可以点发布；cancel=不发了；raise=把后台窗口再抬一次。
   *  只有 publish 会让脚本动平台上的按钮，另外两颗都是收手。
   *  先确认在跑的就是 press-publish：别让一颗迟到的按钮把正在采集的浏览器叫停。 */
  async function publishSignal(req, res) {
    if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'POST only' })
    const { action } = JSON.parse((await readBody(req)) || '{}')
    if (!['publish', 'cancel', 'raise'].includes(action)) {
      return json(res, 400, { ok: false, error: 'action 只有 publish / cancel / raise' })
    }
    if (!syncJob || syncJob.finishedAt !== null || syncJob.task !== 'press-publish') {
      return json(res, 200, { ok: false, error: '现在没有在等的发布，弹层可以关了' })
    }
    try {
      writeFileSync(PRESS_SIGNAL, action)
    } catch (e) {
      return json(res, 200, { ok: false, error: errText(e) })
    }
    json(res, 200, { ok: true, action })
  }

  /** 模型那边的报错是英文一串，直接摊到界面上没人看得懂：换成一句能行动的人话。
   *  fix=settings 时界面给一颗「去设置」；原始原因跟着回，收在「看原因」里，不挡在正路上。 */
  function llmErrHuman(raw) {
    const s = String(raw || '')
    if (/access to model denied|not eligible|permission/i.test(s)) return { error: '这次没生成：当前模型无法访问。', detail: s, fix: 'settings' }
    if (/timeout|ETIMEDOUT|ENOTFOUND|ECONNREFUSED|fetch failed|network/i.test(s)) return { error: '这次没生成：模型没回音，再试一次。', detail: s, fix: 'retry' }
    if (/401|unauthorized|invalid.*api.?key|no api key/i.test(s)) return { error: '这次没生成：模型密钥不对。', detail: s, fix: 'settings' }
    return { error: '这次没生成。', detail: s, fix: 'retry' }
  }

  /** 手改一版稿：界面里直接改标题与这一版真正发出去的那段文字，不用回终端。
   *  只认 rel + 两个字段，段名由内核按账号目录所属平台推（与推草稿同源）。 */
  async function articleApi(req, res) {
    try {
      if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'POST only' })
      const body = JSON.parse((await readBody(req)) || '{}')
      const r = writeArticleText(String(body.rel || ''), { title: body.title, copy: body.copy }, ROOT)
      refresh()
      return json(res, 200, { ok: true, ...r })
    } catch (e) {
      return json(res, 200, { ok: false, error: errText(e) })
    }
  }

  /** 这一份跑在什么机器上：界面开局问一次，据此决定执行类入口是照常还是换成下载提示。
   *  客户端下载地址先读环境变量，没配就回公开仓库那一页。
   *  auth 那三个读数顺带报出去：没配 OAuth 凭据的机器，界面上不该摆一个点了只会报错的按钮。 */
  function capabilities(_req, res) {
    json(res, 200, {
      ok: true,
      mode: REMOTE ? 'remote' : 'local',
      downloadUrl: clientDownloadUrl(),
      auth: { github: githubConfigured(), google: googleConfigured(), mail: mailConfigured() },
    })
  }

  /* ==================== 人的登录（不是平台账号那套扫码）====================
   * 远程那一份是挂在公网上的，内容和读数谁打开都能看，所以那一版要挡；本机那一份跑在自己的
   * 机器上，挡自己等于每天进门被自己拦一次，因此本机只存身份、不设墙，端点照常可用。
   * 登录三条路：邮箱收 6 位码，或 GitHub、Google 授权。没有口令这一层——能打开收件箱或能登进
   * 那个邮箱的人就是号主。 */
  const AUTH_ROUTES = new Set([
    '/__auth/code', '/__auth/verify', '/__auth/logout', '/__auth/me',
    '/__auth/github', '/__auth/github/callback',
    '/__auth/google', '/__auth/google/callback',
  ])

  /** 这个邮箱能不能登进来：远程那份只认 WORKBENCH_ALLOW_EMAILS 里点过的，本机那份不设这层。
   *  每次现读 env，改名单只要重启进程，不必跟着改代码。 */
  const openTo = (email) =>
    !REMOTE || emailAllowed(email, parseAllowEmails(process.env.WORKBENCH_ALLOW_EMAILS))

  /** 请求里的会话是不是一个还在表里的用户：删了账号，他手里的 cookie 应该立刻失效 */
  function currentUser(req) {
    const uid = verifySession(sessionSecret(), parseCookies(req.headers.cookie)[SESSION_COOKIE])
    return uid ? findById(uid) : null
  }

  /** 走没走 https：远程那份在反代后面，明文口只有代理到容器这一段，
   *  cookie 不加 Secure 就等于把会话挂在 HTTP 上游里跑。 */
  const isSecureReq = (req) =>
    String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https' || !!req.socket?.encrypted

  const authCookie = (req, token, maxAgeSec) =>
    sessionCookieValue(token, { maxAgeSec, secure: isSecureReq(req) })

  const signMeIn = (req, res, user) => {
    res.setHeader('Set-Cookie', authCookie(req, signSession(sessionSecret(), user.id), SESSION_TTL_SEC))
    return publicUser(user)
  }

  /** 发邮件 + 建号那一步失败时给界面的人话；错误细节留在日志里，不甩给访客 */
  const sayError = (res, status, message, extra = {}) => authJson(res, status, { ok: false, error: message, ...extra })

  async function authCode(req, res) {
    if (req.method !== 'POST') return sayError(res, 405, 'POST only')
    let p
    try {
      p = JSON.parse((await readBody(req)) || '{}')
    } catch {
      return sayError(res, 400, '邮箱格式不对')
    }
    const bad = emailProblem(p.email)
    if (bad) return sayError(res, 400, bad)
    // 名单外的一封码都不发：这台机器的发信额度不是公共传送门，也别替陌生人建号
    if (!openTo(p.email)) return sayError(res, 403, '这个邮箱不在开放名单里')
    const issued = issueCode(p.email)
    if (issued.error === 'too_fast') {
      return sayError(res, 429, `刚发过一封，${issued.waitSec} 秒后再试`, { resendIn: issued.waitSec })
    }
    if (issued.error) return sayError(res, 400, '邮箱格式不对')
    // 没配发件箱：本机那份把码打进日志，人还能就地登进去；远程那份没日志可看，只能判不可用
    if (!mailConfigured()) {
      if (REMOTE) return sayError(res, 503, '这台服务器还没配发件箱，先用 GitHub 登录')
      logger.info(`[auth] 本机未配发件箱，${maskEmail(p.email)} 的登录码：${issued.code}`)
      return authJson(res, 200, { ok: true, mailSent: false, ttlSec: CODE_TTL_SEC, resendSec: RESEND_SEC })
    }
    let sent
    try {
      // 发件服务商挂了不能让这一份跟着挂：一个访客的登录请求不该掀掉整台站
      sent = await sendLoginCode(normalizeEmail(p.email), issued.code)
    } catch (e) {
      logger.info(`[auth] 发信抛异常 ${errText(e)}`)
      return sayError(res, 502, '验证码发不出去，稍后再试或改用 GitHub 登录')
    }
    if (!sent.ok) {
      logger.info(`[auth] 发信失败 ${sent.error}`)
      return sayError(res, 502, '验证码发不出去，稍后再试或改用 GitHub 登录')
    }
    logger.info(`[auth] 已发登录码到 ${maskEmail(p.email)}`)
    authJson(res, 200, { ok: true, mailSent: true, ttlSec: CODE_TTL_SEC, resendSec: RESEND_SEC })
  }

  async function authVerify(req, res) {
    if (req.method !== 'POST') return sayError(res, 405, 'POST only')
    let p
    try {
      p = JSON.parse((await readBody(req)) || '{}')
    } catch {
      return sayError(res, 400, '邮箱格式不对')
    }
    if (!openTo(p.email)) return sayError(res, 403, '这个邮箱不在开放名单里')
    const r = redeemCode(p.email, p.code)
    if (!r.ok) {
      const say = {
        invalid_email: '邮箱格式不对',
        no_code: '还没发验证码，或这码已经作废',
        expired: '这码过期了，重新发一封',
        bad_code: '验证码不对',
        too_many: '错过太多次，重新发一封',
      }[r.reason] || '验证码不对'
      return sayError(res, 401, say, { reason: r.reason, resendIn: resendWaitSec(p.email) })
    }
    const user = findOrCreateByEmail(p.email)
    logger.info(`[auth] 邮箱码登录 ${maskEmail(user.email)}`)
    authJson(res, 200, { ok: true, user: signMeIn(req, res, user) })
  }

  /* OAuth 那两家共用的三件：回调地址、一次性 state cookie、登一半失败时把人送回工作台 */
  const GH_STATE_COOKIE = 'mh_gh_state'
  const GG_STATE_COOKIE = 'mh_gg_state'

  /** 回调地址跟着请求走：本机是 127.0.0.1:5173，服务器是 media.smzsapp.com，
   *  写死一个就等于另一头登不进来。两条都要在对方那侧登记过。 */
  const oauthCallbackUrl = (req, path) => {
    const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() || (req.socket?.encrypted ? 'https' : 'http')
    const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim()
    return `${proto}://${host}/${path}`
  }

  /** 一次性条子：跳出去前写、回来立刻清，对不上就是别人造的回调（CSRF） */
  const oauthStateCookie = (req, name, value, maxAgeSec) =>
    [
      `${name}=${value || ''}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Lax',
      `Max-Age=${Math.max(0, maxAgeSec)}`,
      isSecureReq(req) ? 'Secure' : '',
    ].filter(Boolean).join('; ')

  /** 登一半失败不弹错误页：清掉两家的一次性条子，还是把人送回工作台，界面上带一句原因 */
  const backToWorkbench = (req, res, reason) => {
    res.setHeader('Set-Cookie', [oauthStateCookie(req, GH_STATE_COOKIE, '', 0), oauthStateCookie(req, GG_STATE_COOKIE, '', 0)])
    res.writeHead(302, { Location: reason ? `/?login_failed=${reason}` : '/' })
    res.end()
  }

  /* GitHub OAuth 那一段 */

  const ghCallbackUrl = (req) => oauthCallbackUrl(req, '__auth/github/callback')

  /** state 是一次性随机串，同时写进跳转和 cookie：回来对不上就是别人造的回调（CSRF） */
  const ghStateCookie = (req, state, maxAgeSec) => oauthStateCookie(req, GH_STATE_COOKIE, state, maxAgeSec)

  function githubStart(req, res) {
    if (!githubConfigured()) return sayError(res, 503, '这台机器没配 GitHub 登录')
    const state = randomBytes(16).toString('hex')
    res.setHeader('Set-Cookie', ghStateCookie(req, state, 600))
    res.writeHead(302, {
      Location: authorizeUrl({
        clientId: process.env.GITHUB_CLIENT_ID,
        redirectUri: ghCallbackUrl(req),
        state,
      }),
    })
    res.end()
  }

  async function githubCallback(req, res, url) {
    const cookies = parseCookies(req.headers.cookie)
    const state = String(url.searchParams.get('state') || '')
    const want = String(cookies[GH_STATE_COOKIE] || '')
    const same = state.length > 0 && want.length === state.length &&
      timingSafeEqual(Buffer.from(want), Buffer.from(state))
    res.setHeader('Set-Cookie', ghStateCookie(req, '', 0))
    if (!same) return backToWorkbench(req, res, 'state')
    if (url.searchParams.get('error')) return backToWorkbench(req, res, 'denied')
    const code = String(url.searchParams.get('code') || '')
    if (!code) return backToWorkbench(req, res, 'nocode')
    try {
      const token = await exchangeCode({
        code,
        redirectUri: ghCallbackUrl(req),
        clientId: process.env.GITHUB_CLIENT_ID,
        clientSecret: process.env.GITHUB_CLIENT_SECRET,
      })
      const who = await githubIdentity(token)
      if (!who.id) return backToWorkbench(req, res, 'noid')
      if (!openTo(who.email)) return backToWorkbench(req, res, 'notallowed')
      const user = findOrCreateByGithub(who)
      res.setHeader('Set-Cookie', authCookie(req, signSession(sessionSecret(), user.id), SESSION_TTL_SEC))
      logger.info(`[auth] GitHub 登录 ${user.name || user.email || user.id}`)
      res.writeHead(302, { Location: '/' })
      res.end()
    } catch (e) {
      logger.info(`[auth] GitHub 登录失败：${errText(e)}`)
      backToWorkbench(req, res, 'github')
    }
  }

  /* Google OAuth 那一段：授权码 + PKCE，state 和 verifier 同压在一个一次性条子里 */

  const ggCallbackUrl = (req) => oauthCallbackUrl(req, '__auth/google/callback')

  /** 条子值 = `<state>.<verifier>`：回来时 state 用来认这趟是不是自己发起的，verifier 留给换 token */
  const ggStateCookie = (req, value, maxAgeSec) => oauthStateCookie(req, GG_STATE_COOKIE, value, maxAgeSec)

  function googleStart(req, res) {
    if (!googleConfigured()) return sayError(res, 503, '这台机器没配 Google 登录')
    const state = randomBytes(16).toString('hex')
    const { verifier, challenge } = pkcePair()
    res.setHeader('Set-Cookie', ggStateCookie(req, `${state}.${verifier}`, 600))
    res.writeHead(302, {
      Location: googleAuthorizeUrl({
        clientId: process.env.GOOGLE_CLIENT_ID,
        redirectUri: ggCallbackUrl(req),
        state,
        codeChallenge: challenge,
      }),
    })
    res.end()
  }

  async function googleCallback(req, res, url) {
    const cookies = parseCookies(req.headers.cookie)
    const state = String(url.searchParams.get('state') || '')
    const [want, verifier = ''] = String(cookies[GG_STATE_COOKIE] || '').split('.')
    const same = state.length > 0 && want.length === state.length &&
      timingSafeEqual(Buffer.from(want), Buffer.from(state))
    if (!same) return backToWorkbench(req, res, 'g_state')
    if (url.searchParams.get('error')) return backToWorkbench(req, res, 'g_denied')
    const code = String(url.searchParams.get('code') || '')
    if (!code) return backToWorkbench(req, res, 'g_nocode')
    try {
      const token = await googleExchangeCode({
        code,
        redirectUri: ggCallbackUrl(req),
        clientId: process.env.GOOGLE_CLIENT_ID,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET,
        codeVerifier: verifier,
      })
      const who = await googleIdentity(token)
      if (!who.id) return backToWorkbench(req, res, 'g_noid')
      if (!openTo(who.email)) return backToWorkbench(req, res, 'notallowed')
      const user = findOrCreateByGoogle(who)
      res.setHeader('Set-Cookie', authCookie(req, signSession(sessionSecret(), user.id), SESSION_TTL_SEC))
      logger.info(`[auth] Google 登录 ${user.name || user.email || user.id}`)
      res.writeHead(302, { Location: '/' })
      res.end()
    } catch (e) {
      logger.info(`[auth] Google 登录失败：${errText(e)}`)
      // 连不上 Google 与授权没走通是两件事：墙内机器要的是「这台得挂出墙代理」这句实话
      const net = /timeout|aborted|ENOTFOUND|EAI_AGAIN|ECONN|ETIMEDOUT|ERR_NETWORK|fetch failed|socket hang up/i.test(errText(e))
      backToWorkbench(req, res, net ? 'gg_net' : 'google')
    }
  }

  function authLogout(req, res) {
    if (req.method !== 'POST') return sayError(res, 405, 'POST only')
    res.setHeader('Set-Cookie', authCookie(req, '', 0))
    authJson(res, 200, { ok: true })
  }

  /** 我是谁：没登录也回 200，user 给 null。登录墙与否是远程那份的事，界面自己按 mode 判。 */
  function authMe(req, res) {
    authJson(res, 200, { ok: true, user: publicUser(currentUser(req)) })
  }

  const routes = {
    '/generated.json': generatedData,
    '/__capabilities': capabilities,
    '/__auth/code': authCode,
    '/__auth/verify': authVerify,
    '/__auth/github': githubStart,
    '/__auth/github/callback': githubCallback,
    '/__auth/google': googleStart,
    '/__auth/google/callback': googleCallback,
    '/__auth/logout': authLogout,
    '/__auth/me': authMe,
    '/__knowledge-md': knowledgeMd,
    '/__events': events,
    '/__run-script': runScript,
    '/__stop-script': stopScript,
    '/__jobs': runningJobsApi,
    '/__login-signal': loginSignal,
    '/__login-qr': loginQr,
    '/__press-params': pressParams,
    '/__publish-preview': publishPreview,
    '/__publish-signal': publishSignal,
    '/__collect': collect,
    '/__script': captureScriptApi,
    '/__extension-path': extensionPath,
    '/__draft': draft,
    '/__topic': topic,
    '/__note': note,
    '/__viral': viral,
    '/__viral-search': viralSearch,
    '/__benchmark-search': benchmarkSearch,
    '/__benchmark': benchmark,
    '/__schedule': schedule,
    '/__lesson': lesson,
    '/__review': review,
    '/__product': product,
    '/__same-style': sameStyle,
    '/__card': card,
    '/__article': articleApi,
    '/__template-thumb': templateThumb,
    '/__clone-visual': cloneVisual,
    '/__video-harvest': videoHarvest,
    '/__refine': refine,
    '/__autopublish': autopublish,
    '/__preview': previewApi,
    '/__push': pushApi,
    '/__generate': generate,
    '/__clone': clone,
    '/__chat': chat,
    '/__llm': llmConfig,
    '/__llm-test': llmTest,
    '/__viral-config': viralConfigApi,
    '/__benchmark-config': benchConfigApi,
    '/__favorites-config': favoritesConfigApi,
    '/__env': envReport,
    '/__accounts': accountsApi,
    '/__selfcheck': selfCheck,
    '/__start-guide': startGuide,
  }

  return {
    refresh,
    handle(req, res, next) {
      const url = new URL(req.url || '/', 'http://media-hub.local')
      const route = routes[url.pathname]
      if (!route) return next?.()
      if (REMOTE && CLIENT_ONLY_ROUTES.has(url.pathname)) {
        return json(res, 409, { ok: false, error: '这一步网页版做不了，要在桌面客户端里做' })
      }
      for (const [k, v] of Object.entries(corsHeaders(req.headers))) res.setHeader(k, v)
      if (req.method === 'OPTIONS') {
        // 预检只有本机的来路能过：别的网页连「能不能发」都问不出来
        if (!originAllowed(req.headers)) return json(res, 403, { ok: false, error: GUARD_DENIED })
        res.statusCode = 204
        res.end()
        return
      }
      if (isMutating(req.method) && !originAllowed(req.headers)) {
        return json(res, 403, { ok: false, error: GUARD_DENIED })
      }
      /* 远程那份的登录墙：除了问「要不要登录」和登录本身，未登录只许读一样东西——/generated.json，
         而且那一趟给的是游客那一屏的演示产物（见 guestScreen），不是号主的真数据。
         写操作动的都是号主盘上的东西，一律先登录。界面壳与内容图片不在这张表里、也不查这道墙，
         静态那一路由 serve.mjs 按 api.assetAllowed 放行，两处合起来才是一套门禁。
         本机那份不设墙——这台机器本来就是你的，进门还要输口令是自找麻烦。 */
      if (REMOTE && !AUTH_ROUTES.has(url.pathname) && url.pathname !== '/__capabilities' && !currentUser(req)) {
        if (req.method !== 'GET' || url.pathname !== '/generated.json') {
          return json(res, 401, { ok: false, error: '请先登录' })
        }
      }
      route(req, res, url)
    },
    /** 静态文件那一趟能不能走：本机那份与登录了的人照常；游客只认自己那一屏引用到的内容文件 */
    assetAllowed(req, pathname) {
      if (!REMOTE || currentUser(req)) return true
      return guestStaticOk(pathname, guestScreen(generatedText()).referenced)
    },
  }
}
