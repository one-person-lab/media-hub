import { readFileSync, writeFileSync, renameSync } from 'node:fs'

/** 采集脚本 → 服务端的结构化进度。
 *
 *  两条通道，缺一不可：
 *  ① stdout 一行一条 JSON（`[sync:step]`）——服务端逐行认前缀，跑完收尾时用它构造留痕；
 *  ② 进度文件 /tmp/media-hub-run-progress.json ——**运行中**唯一能读到进度的通道。
 *
 *  为什么必须有 ②：ego 内嵌 Node 把子进程输出全攒到进程退出才吐（实测 8 秒脚本，
 *  两行日志同一秒到达宿主），所以 ① 天生只能事后到达，运行中的界面拿不到任何读数。
 *  任务 key 由服务端 spawn 前注入（run-ego 再写进 EGO_TASK），脚本不必各自记自己是谁。 */

const STOP_FILE = '/tmp/media-hub-sync-stop'
export const PROGRESS_FILE = '/tmp/media-hub-run-progress.json'

/** 本轮是谁：ego 脚本只有 EGO_TASK（run-ego 从 MEDIA_HUB_TASK 转注入，ego 不透传宿主环境），
 *  不走浏览器的纯 Node 脚本（取料、备份）直接继承服务端那个 MEDIA_HUB_TASK。 */
const taskKey = () => process.env.EGO_TASK || process.env.MEDIA_HUB_TASK || ''

/** 只认本轮任务的进度文件；上一轮留下的残档一律当没有 */
const readProg = () => {
  try {
    const p = JSON.parse(readFileSync(PROGRESS_FILE, 'utf8'))
    return p && p.task === taskKey() ? p : null
  } catch {
    return null
  }
}

const emptyProg = () => ({ task: taskKey(), platforms: [], steps: {}, current: null, updatedAt: 0 })

/** tmp + rename：界面每 3 秒读一次，不能读到半截 JSON。
 *  没有任务 key（不走 /__run-script 的手动跑法）就没人在读，写了反而可能盖掉正在跑那一轮的进度。 */
function writeProg(p) {
  if (!taskKey()) return
  p.updatedAt = Date.now()
  const tmp = `${PROGRESS_FILE}.${process.pid}.tmp`
  try {
    writeFileSync(tmp, JSON.stringify(p))
    renameSync(tmp, PROGRESS_FILE)
  } catch { /* 进度只是让人知道在跑到哪，写不上不该把采集带崩 */ }
}

const upsert = (p, platform) => {
  if (platform && !p.platforms.includes(platform)) p.platforms.push(platform)
  return p
}

/** 本轮计划跑哪些平台：界面据此把「还没轮到」的平台也列出来，而不是只列已经跑完的 */
export function plan(platforms) {
  const p = emptyProg()
  p.platforms = [...platforms]
  writeProg(p)
}

/** 平台内的细粒度进度。done/total 是「本阶段第几步 / 共几步」，note 放正在处理的东西。
 *  platform 传空＝不属于某个平台的整轮阶段（如收尾转写）。 */
export function progress(platform, phase, done, total, note = '') {
  const p = upsert(readProg() || emptyProg(), platform)
  p.current = { platform: platform || null, phase, ...(Number.isFinite(done) ? { done } : {}), ...(Number.isFinite(total) ? { total } : {}), note: String(note || '').slice(0, 60) }
  writeProg(p)
}

/** 一个平台整轮跑完的结果：stdout 给留痕用，文件给运行中的界面用 */
export function step(platform, state, extra = {}) {
  process.stdout.write(`[sync:step] ${JSON.stringify({ task: taskKey(), platform, state, ...extra })}\n`)
  const p = upsert(readProg() || emptyProg(), platform)
  const count = Number.isFinite(Number(extra.count)) && extra.count != null ? Number(extra.count) : undefined
  p.steps[platform] = {
    state: state === 'skip' ? 'skip' : state === 'error' ? 'error' : 'ok',
    note: String(extra.note || '').slice(0, 160),
    ...(count == null ? {} : { count }),
  }
  if (p.current && p.current.platform === platform) p.current = null
  writeProg(p)
}

const readStopSignal = () => {
  try {
    return readFileSync(STOP_FILE, 'utf8').trim()
  } catch {
    return ''
  }
}

/** 人点了「停止」：服务端把任务 key 写进这个文件，脚本在平台之间自取一次。
 *  只在整平台跑完后检查——掐在半路会把浏览器任务空间留成脏（同登录信号走文件的理由）。
 *  没有任务 key（npm run favorites 这类手动跑法）就没有人在写停止信号，文件不存在时两个空串相等，
 *  不能当成「有人按了停止」——那样整轮会在第一个平台前直接空转退出。 */
export function stopRequested() {
  const key = taskKey()
  return !!key && readStopSignal() === key
}

/** 界面点「重采这两个」时服务端带 `--only <key,key>`：只跑失败的那几个平台，其余一个不进浏览器。
 *  走参数不走环境变量——ego 不透传宿主环境（同 EGO_TASK 只能注入 stdin 的理由）。
 *  跳过的平台要喊 skip：留痕不能把「这轮没跑」记成「采到了」。 */
const onlyAt = process.argv.indexOf('--only')
const ONLY = onlyAt < 0 ? null : new Set(String(process.argv[onlyAt + 1] || '').split(',').map((s) => s.trim()).filter(Boolean))
export const wanted = (platform) => !ONLY || ONLY.has(platform)

/** 平台本轮不该跑：喊一声就跳过，别把它算成失败 */
export function skipUnlessWanted(platform) {
  if (wanted(platform)) return false
  step(platform, 'skip', { note: '本轮只重采失败平台' })
  return true
}

/** 界面「搜爆款 / 收对标」的候选池：脚本边搜边写这一份，弹层隔几秒读一次，人挑中的那几条由 --capture 读回来落卡。
 *  搜索和入库是两趟浏览器，中间那一次判断是人的，所以这一份必须活在两次进程之间。
 *  和进度文件一样走 tmp + rename：弹层隔几秒读一次，不能读到半截 JSON。
 *  两份池子按调用方传的 file 分开放——爆款摆作品、对标摆账号，混在一格里两边都会挑错东西。 */
export const SEARCH_FILE = '/tmp/media-hub-viral-search.json'
export const BENCH_SEARCH_FILE = '/tmp/media-hub-benchmark-search.json'

export function writeSearchJson(obj, file = SEARCH_FILE) {
  const tmp = `${file}.${process.pid}.tmp`
  try {
    writeFileSync(tmp, JSON.stringify(obj))
    renameSync(tmp, file)
  } catch { /* 候选池写不上，界面上就是空态，不该把已经跑完的搜索带崩 */ }
}

export function readSearchJson(file = SEARCH_FILE) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}
