/** 采集运行留痕：每次 /__run-script 收尾追加一条，供页头读数带判「上次采到 / 隔了几天 / 哪几个平台没采到」。
 *  逐平台结果一律从**产物**反推，不信脚本自报（ok:true / exit 0 都不证读数正确，
 *  见 docs/superpowers/specs/2026-10-22-collect-run-surface.md §四）。 */
import { readFileSync, writeFileSync, readdirSync, existsSync, renameSync, mkdirSync, statSync } from 'node:fs'
import { join, basename } from 'node:path'
import { localDay } from './day-core.mjs'

export const RUNS_REL = 'metrics/collect-runs.json'
/** 只留最近这么多条：一次运行一条，够回溯半年 */
const MAX_RUNS = 200

const COLLECTION_TASKS = ['collect', 'viral', 'favorites', 'benchmark', 'publish-check']
export const isCollectionTask = (t) => COLLECTION_TASKS.includes(t)

function readJson(p, fallback) {
  try {
    return JSON.parse(readFileSync(p, 'utf8'))
  } catch {
    return fallback
  }
}

const PLATFORM_BY_LABEL = { 小红书: 'xiaohongshu', 抖音: 'douyin' }
/** 卡片上的采集日期由采集脚本按本机日历日盖（day-core 的 localDay），这里必须同一把尺 */
const dayOf = (ms) => localDay(ms)

/** 卡片目录里**这一轮**入库的条数，按平台 key 归堆；字段名两套脚本各写各的（capturedAt / collected）。
 *  光认日期不够：同一天补跑两次，第二次砸了也会把第一次那批卡数进来，所以还要落盘时间落在本次窗口内。 */
function cardsByPlatform(dir, day, field, sinceMs = 0) {
  const out = {}
  if (!existsSync(dir)) return out
  for (const top of readdirSync(dir, { withFileTypes: true })) {
    const sub = top.isDirectory() ? join(dir, top.name) : ''
    const files = top.isDirectory()
      ? readdirSync(sub).filter((f) => f.endsWith('.md') && f !== 'README.md')
      : [top.name]
    for (const f of files) {
      const abs = join(sub || dir, f)
      let md = ''
      try {
        md = readFileSync(abs, 'utf8')
      } catch {
        continue
      }
      const dayMatch = md.match(new RegExp(`^${field}:\\s*"?(\\d{4}-\\d{2}-\\d{2})`, 'm'))
      if (!dayMatch || dayMatch[1] !== day) continue
      try {
        if (statSync(abs).mtimeMs < sinceMs) continue
      } catch { continue }
      const plat = (md.match(/^platform:\s*"?([a-z-]+)/m) || [])[1]
        || PLATFORM_BY_LABEL[(sub ? basename(sub) : '')] || 'unknown'
      out[plat] = (out[plat] || 0) + 1
    }
  }
  return out
}

/** collect / publish-check 写同一份 metrics/raw/<日>.json，各自只认自己那半张脸：
 *  指标读数（collect）与已发布列表（publish-check）。errors 只当原因，不当判据。
 *  sinceMs：那份读数的时间戳必须晚于本次开始，否则是今天早先那一轮留下的，不算本轮采到。 */
function snapshotPlatforms(root, day, task, sinceMs = 0) {
  const doc = readJson(join(root, 'metrics/raw', `${day}.json`), null)
  const plats = doc?.platforms || {}
  const errors = doc?.errors || {}
  const landedAt = Date.parse(task === 'collect' ? (doc?.collectedAt || '') : (doc?.publishedListAt || '')) || 0
  const fresh = landedAt >= sinceMs
  const out = {}
  const keys = task === 'collect'
    ? ['xiaohongshu', 'douyin']
    : Object.keys(plats).length
      ? Object.keys(plats)
      : ['xiaohongshu', 'douyin', 'mp', 'kuaishou', 'sph']
  for (const k of keys) {
    const p = plats[k] || {}
    const note = errors[k] ? String(errors[k]).slice(0, 160) : ''
    if (task === 'collect') {
      const got = fresh && (Object.keys(p.metrics || {}).length > 0 || (p.daily || []).length > 0 || p.followers != null)
      out[k] = { state: got ? 'ok' : 'error', count: (p.daily || []).length, note }
    } else {
      const list = p.publishedList
      const got = fresh && Array.isArray(list)
      out[k] = { state: got ? 'ok' : 'error', count: got ? list.length : 0, note }
    }
  }
  return out
}

/** 卡片数只说「拿到几条」，拿到就算 ok；失败原因由脚本的 [sync:step] 补 */
const countToPlatforms = (counts) =>
  Object.fromEntries(Object.entries(counts).map(([k, count]) => [k, { state: 'ok', count, note: '' }]))

/** 对标档案没有采集日期字段，认文件落盘时间落在本次运行窗口内 */
function benchmarksSince(root, sinceMs) {
  const dir = join(root, 'content/Resources/对标账号')
  const out = {}
  if (!existsSync(dir)) return out
  for (const plat of readdirSync(dir)) {
    const sub = join(dir, plat)
    if (!statSync(sub).isDirectory()) continue
    const files = readdirSync(sub).filter((f) => f.endsWith('.md') && statSync(join(sub, f)).mtimeMs >= sinceMs)
    if (files.length) out[PLATFORM_BY_LABEL[plat] || plat] = files.length
  }
  return out
}

/** 一次运行 → 一条留痕。steps 是脚本自己报的结构化进度（[sync:step]），只补产物说不出来的原因。 */
export function buildRun({ root, task, startedAt, finishedAt, exitCode, stopped, steps = {}, tail = '' }) {
  const day = dayOf(finishedAt)
  let platforms = {}
  if (task === 'collect' || task === 'publish-check') platforms = snapshotPlatforms(root, day, task, startedAt)
  else if (task === 'viral') platforms = countToPlatforms(cardsByPlatform(join(root, 'content/Inbox/爆款采集'), day, 'capturedAt', startedAt))
  else if (task === 'favorites') platforms = countToPlatforms(cardsByPlatform(join(root, 'content/Inbox/采集笔记/收藏'), day, 'collected', startedAt))
  else if (task === 'benchmark') platforms = countToPlatforms(benchmarksSince(root, startedAt))

  // 产物说条数、脚本说原因：自报失败但产物确实落了卡，只把原因记下不当失败；
  // 产物说不出来的平台（0 条 / 没文件）才采信脚本报的错。
  for (const [k, s] of Object.entries(steps)) {
    // 「重采这两个」轮里没跑的平台：昨天那份读数是旧的，不能算进本轮
    if (s.state === 'skip') { delete platforms[k]; continue }
    const prev = platforms[k]
    if (s.state === 'error') {
      if (prev && prev.state === 'ok') {
        if (s.note && !prev.note) prev.note = s.note
      } else platforms[k] = { state: 'error', count: prev?.count ?? 0, note: s.note || prev?.note || '' }
    } else if (!prev) platforms[k] = { state: 'ok', count: 0, note: s.note || '' }
    else if (s.note && !prev.note) prev.note = s.note
  }
  const counts = Object.fromEntries(Object.entries(platforms).map(([k, v]) => [k, v.count]))
  const failed = Object.entries(platforms).filter(([, v]) => v.state === 'error').map(([k]) => k)
  const gotAny = Object.values(platforms).some((v) => v.state === 'ok')
  return {
    task,
    day,
    startedAt,
    finishedAt,
    exitCode,
    stopped: !!stopped,
    ok: exitCode === 0 && !stopped,
    // 部分成功不只看退出码：脚本自己只在被挡时退 2，砸一个平台照样退 1。
    // 有平台真采到了、有平台没采到，界面就该说「N 个平台没采到」而不是整条判死。
    partial: exitCode === 2 || (!stopped && exitCode !== 0 && gotAny && failed.length > 0),
    failedPlatforms: failed,
    platforms,
    counts,
    // 尾巴留一小段：界面上「为什么失败」优先用人话，兜底才翻日志。
    // 进度行已经拆进 platforms，这里再留一份只会把机器话挤进人话位
    tail: String(tail).split('\n').map((s) => s.trim()).filter((s) => s && !s.startsWith('[sync:step]')).slice(-3).join(' ').slice(0, 300),
  }
}

/** 一个任务在本机的产物落盘日（最近一天有它采回来的东西）。
 *  留痕是改造后才有的，之前的轮次只能靠产物判新旧；自检与界面回退都走这一把尺。 */
export function lastArtifactDay(root, task) {
  if (task === 'collect' || task === 'publish-check') {
    const dir = join(root, 'metrics/raw')
    if (!existsSync(dir)) return null
    const days = readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).map((f) => f.slice(0, 10)).sort().reverse()
    for (const day of days) {
      const got = Object.values(snapshotPlatforms(root, day, task)).some((v) => v.state === 'ok')
      if (got) return day
    }
    return null
  }
  if (task === 'viral' || task === 'favorites') {
    const dir = join(root, task === 'viral' ? 'content/Inbox/爆款采集' : 'content/Inbox/采集笔记/收藏')
    const field = task === 'viral' ? 'capturedAt' : 'collected'
    if (!existsSync(dir)) return null
    let max = ''
    for (const top of readdirSync(dir, { withFileTypes: true })) {
      const sub = top.isDirectory() ? join(dir, top.name) : ''
      const files = top.isDirectory() ? readdirSync(sub).filter((f) => f.endsWith('.md')) : [top.name]
      for (const f of files) {
        const md = (() => { try { return readFileSync(sub ? join(sub, f) : join(dir, f), 'utf8') } catch { return '' } })()
        const d = (md.match(new RegExp(`^${field}:\\s*"?(\\d{4}-\\d{2}-\\d{2})`, 'm')) || [])[1]
        if (d && d > max) max = d
      }
    }
    return max || null
  }
  if (task === 'benchmark') {
    const dir = join(root, 'content/Resources/对标账号')
    if (!existsSync(dir)) return null
    let max = 0
    for (const plat of readdirSync(dir)) {
      const sub = join(dir, plat)
      if (!statSync(sub).isDirectory()) continue
      for (const f of readdirSync(sub).filter((x) => x.endsWith('.md'))) max = Math.max(max, statSync(join(sub, f)).mtimeMs)
    }
    return max ? dayOf(max) : null
  }
  return null
}

export function readRuns(root) {
  const arr = readJson(join(root, RUNS_REL), [])
  return Array.isArray(arr) ? arr : []
}

/** 追加一条（tmp + rename：并发会话同仓跑时不许留半截文件） */
export function appendRun(root, rec) {
  const all = [...readRuns(root), rec].slice(-MAX_RUNS)
  const dir = join(root, 'metrics')
  mkdirSync(dir, { recursive: true })
  const tmp = join(dir, '.collect-runs.tmp')
  writeFileSync(tmp, JSON.stringify(all, null, 1) + '\n')
  renameSync(tmp, join(root, RUNS_REL))
  return all
}
