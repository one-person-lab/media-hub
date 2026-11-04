/**
 * 桌面版自己的排班：到点把采集/回认交给本地服务那一套单飞队列，不往 macOS 加启动项。
 *
 * 为什么写在 app 里：定时要的是「每天真跑一趟并把结果落盘」，而机器上装的是桌面版——
 * LaunchAgents 那种办法要动登录启动项，且它叫的是仓库里那份数据，跟装机版各写各的。
 * app 没开着就不会跑，这跟「不装启动项」是同一个取舍；错过的那趟在下次起来时补一次。
 *
 * 记账在 metrics/auto-run.json：每天每趟只算一次，跑没跑成以队列回话（退出码）为准，
 * 不信脚本自报。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { localDay } from './day-core.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 本地日 YYYY-MM-DD：全项目一把尺，实现收在 day-core 里，别再留第二份 */
export const dayKey = (ms) => localDay(ms)

const hash = (s) => {
  let h = 0
  for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) >>> 0
  return h
}

/** 这一趟今天的触发时刻：at + 按「日期|任务名」哈希出来的抖动。
 *  同一天重启不挪点（否则早上起来补跑会跟着启动时间漂），每天又不撞同一秒。 */
export function fireAtMs(job, day) {
  const [h, m] = String(job.at).split(':').map(Number)
  const jitterMin = Number(job.jitterMin ?? 20)
  const jitter = hash(`${day}|${job.name}`) % Math.max(1, jitterMin)
  return new Date(`${day}T00:00:00`).getTime() + (h * 60 + m) * 60_000 + jitter * 60_000
}

/** 这一天这一趟已经收账的状态：不再自动排（stopped = 人在界面上按了停止，今天别自己再开一趟） */
const DONE = new Set(['ok', 'failed', 'skipped', 'stopped'])
/** 跑到一半 app 被关掉，账上会一直留在 running；超过三小时就当那趟没成，重新排一次 */
const RUNNING_STALE = 3 * 60 * 60_000

/** 到点该跑的趟：过了触发时刻、且这一天没记成 ok/failed/running/skipped 的都算该动。
 *  跑挂了不在当天重试——那是脚本的事，界面上有就地补跑的按钮，人看了原因自己决定要不要再来。
 *  busy（浏览器被上一趟占着）要留着重试，但重试到宽限期就如实记下「今天没排进去」，别一天到晚撞。 */
export function dueJobs({ jobs = [], now, state = {}, day }) {
  const out = []
  for (const job of jobs) {
    const at = fireAtMs(job, day)
    if (now < at) continue
    const rec = state[job.name]?.[day]
    if (rec && DONE.has(rec.outcome)) continue
    if (rec?.outcome === 'running' && now - (rec.startedAt ?? 0) < RUNNING_STALE) continue
    const grace = Number(job.graceMin ?? 90) * 60_000
    if (rec?.outcome === 'busy' && now - at > grace) {
      out.push({ job, at, giveUp: true })
      continue
    }
    out.push({ job, at })
  }
  // 按当天该跑的时刻先后排：晚上才开 app 时，补的是早上欠的那一趟，不是配置文件里排在第一的那趟
  return out.sort((a, b) => a.at - b.at)
}

/** 服务端那一撞：这一趟不算失败，下一轮再试（撞车回话都带 busy 标志） */
export const isBusy = (r) => !!r?.busy

const OUTCOME_CN = { ok: '跑完', busy: '没排进去，下一轮再试', failed: '这趟没成', stopped: '人按了停止', skipped: '今天没排进去' }

/** 脚本只报退出码，原因藏在输出尾巴里：每平台的失败都写成 `"douyin": "人工停止，该平台本轮没跑"` 这样的 JSON 行，
 *  尾巴最后又总跟着 ego 那句「process exited with code 2」和半截括号（10-23 装机实测：账上记的就是这句谎）。
 *  从后往前挑：先认 JSON 键后面那一句（那里头才是原因，且中文句子常常不带冒号），再退而求其次挑像句子的行。 */
export function pickReason(text) {
  for (const raw of String(text || '').split('\n').reverse()) {
    const kv = raw.trim().match(/^"[^"]*"\s*:\s*(.+)$/)
    const s = (kv ? kv[1] : raw.trim()).replace(/^["']+|["',]+$/g, '').trim()
    if (s.length < 6 || /^[{}[\],\s]+$/.test(s)) continue
    if (/exited with code|nodejs process|ego-browser:notice/i.test(s)) continue
    // 「"file": "metrics/raw/2026-10-23.json"」这种纯 ASCII 路径/日期是统计块里的字段，不是原因
    if (/^[\w.@/-]+$/.test(s)) continue
    if (!kv && !/[：:（(]/.test(s)) continue
    return s.slice(0, 200)
  }
  return ''
}

/** 一次轮询的间隔与最长等待：等待上限按最慢的那趟（爆款采集自己给 60 分钟）再留一圈，
 *  超了就不陪它耗着——服务端只留一格 syncJob，等错了会把别人的结局记在这一趟头上。 */
const POLL_MS = 15_000
const MAX_WAIT_MS = 90 * 60_000
/** 两趟之间给浏览器喘口气：晚上才开 app 时四趟欠着的活儿一口气连着撞平台，风控那边看到的是一整晚的搜索 */
const DEFAULT_COOLDOWN_MIN = 12

/**
 * 起排班。port 由调用方给（服务已经 listen 上）；跑任务走 /__run-script 那条单飞队列，
 * 所以定时和人在界面上点的那一趟共用同一只浏览器、不会并发。
 */
export function startAutoRun({ root = process.cwd(), port, logger = console, run = null } = {}) {
  const cfgPath = join(root, 'config', 'auto-run.json')
  let jobs
  let cooldownMin = DEFAULT_COOLDOWN_MIN
  try {
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'))
    jobs = (cfg.jobs || []).filter((j) => j?.name && j?.task && j?.at)
    if (Number.isFinite(Number(cfg.cooldownMin))) cooldownMin = Number(cfg.cooldownMin)
  } catch {
    return null // 没这份文件（比如装机的人自己删了）就等于不开定时
  }
  const statePath = join(root, 'metrics', 'auto-run.json')
  const load = () => {
    try {
      return JSON.parse(readFileSync(statePath, 'utf8'))
    } catch {
      return {}
    }
  }
  const save = (s) => {
    mkdirSync(dirname(statePath), { recursive: true })
    const tmp = `${statePath}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(s, null, 1))
    renameSync(tmp, statePath)
  }
  const base = `http://127.0.0.1:${port}`
  const exec =
    run ||
    (async ({ task, arg }) => {
      const started = await fetch(`${base}/__run-script`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(arg ? { task, arg } : { task }),
      }).then((r) => r.json().catch(() => ({})))
      if (!started?.ok) return started
      for (;;) {
        await sleep(POLL_MS)
        const { job } = await fetch(`${base}/__run-script?startedAt=${started.startedAt}`).then((r) => r.json().catch(() => ({})))
        // startedAt 对不上是被后来的那一趟顶掉了，别拿别人的结局记这一笔的账
        if (job && job.startedAt === started.startedAt && !job.running) {
          // 跑砸时服务端已经把脚本最后两行归成一行人话放在 job.error，记账就认这句
          return { ok: job.exitCode === 0, exitCode: job.exitCode, error: job.error, tail: job.tail, stopped: job.stopped, finishedAt: Date.now() }
        }
        if (Date.now() - started.startedAt > MAX_WAIT_MS) {
          return { ok: false, error: `这一趟超过 ${Math.round(MAX_WAIT_MS / 60000)} 分钟还没收工，排班不再等它` }
        }
      }
    })

  let busy = false
  const tick = async () => {
    if (busy) return
    busy = true
    try {
      const now = Date.now()
      const day = dayKey(now)
      const state = load()
      for (const { job, at, giveUp } of dueJobs({ jobs, now, state, day })) {
        if (giveUp) {
          state[job.name] = { ...state[job.name], [day]: { outcome: 'skipped', at, note: '到点后浏览器一直被人占着，今天没排进去' } }
          save(state)
          logger.info(`[auto-run] 「${job.name}」今天没排进去（一直有别的任务在跑），不再重试`)
          continue
        }
        // 刚跑完一趟就接着开下一趟，四趟欠着的活儿会在一个晚上连着撞同一批后台
        const last = state._meta?.lastFinishedAt
        if (last && Date.now() - last < cooldownMin * 60_000) {
          logger.info(`[auto-run] 「${job.name}」等下一轮：离上一趟收工还不满 ${cooldownMin} 分钟`)
          break
        }
        state[job.name] = { ...state[job.name], [day]: { outcome: 'running', at, startedAt: now, task: job.task, arg: job.arg || null } }
        save(state)
        logger.info(`[auto-run] 开跑「${job.name}」(${job.task}${job.arg ? ` ${job.arg}` : ''})`)
        let r = {}
        try {
          r = (await exec(job)) || {}
        } catch (e) {
          r = { ok: false, error: String(e?.message || e).split('\n')[0] }
        }
        const outcome = isBusy(r) ? 'busy' : r.ok ? 'ok' : r.stopped ? 'stopped' : 'failed'
        if (outcome !== 'busy') state._meta = { lastFinishedAt: Date.now() }
        const note =
          outcome === 'ok'
            ? ''
            : outcome === 'stopped'
              ? '人在界面上按了停止，今天不再自动开这一趟'
              : pickReason(r.error) || pickReason(r.tail) || `脚本自己报了退出码 ${r.exitCode ?? '未知'}`
        state[job.name] = {
          ...state[job.name],
          [day]: {
            outcome,
            at,
            startedAt: now,
            finishedAt: Date.now(),
            task: job.task,
            arg: job.arg || null,
            exitCode: r.exitCode ?? null,
            note,
          },
        }
        save(state)
        logger.info(`[auto-run] 「${job.name}」${OUTCOME_CN[outcome]}${outcome === 'ok' ? '' : ` · ${note}`}`)
      }
    } finally {
      busy = false
    }
  }

  // 起来先补一次：app 早上才开，那一趟该在 07:40 跑的现在照样该补
  const timer = setInterval(tick, 60_000)
  const ready = tick()
  logger.info(`[auto-run] 排班已挂上：${jobs.map((j) => `${j.name} ${j.at}`).join('、')}`)
  return { timer, tick, ready, stop: () => clearInterval(timer) }
}

/* ==================== 一把锁：同一时刻只许一个执行体在排班 ====================
 * 开发服务（vite）和独立服务/桌面壳挂的是同一套排班，两边同时开着就会各记各的账、
 * 到点各开一趟采集——两只手抢同一只浏览器。谁抢到锁谁排，另一个只报告不重复挂。 */
export const LOCK_REL = 'metrics/auto-run-lock.json'
/** 心跳超过这个间隔就当那个进程已经不在了，直接接管（不留死锁） */
export const LOCK_STALE = 3 * 60_000

/** 纯判据：锁文件里那份记录是不是别人还活着时占的。
 *  光看心跳不够——开发服务天天重启，新进程起来时旧锁的心跳还新鲜，就会谁都排不了。
 *  所以同机器上直接问一句那个 pid 还在不在；isAlive 不给时退回只看心跳。 */
export function schedulerLockDecision(cur, { pid, now = Date.now(), staleMs = LOCK_STALE, isAlive = null } = {}) {
  if (!cur || cur.pid === pid) return { owned: true }
  if (isAlive && !isAlive(cur.pid)) return { owned: true }
  if (now - (cur.beatAt || 0) >= staleMs) return { owned: true }
  return { owned: false, holder: cur }
}

const pidAlive = (p) => {
  try {
    process.kill(Number(p), 0)
    return true
  } catch {
    return false
  }
}

/** 抢锁：抢到就写 pid + 心跳（心跳不撑住事件循环，放掉时删文件） */
export function takeSchedulerLock({ root, port, pid = process.pid, now = Date.now(), isAlive = pidAlive } = {}) {
  const path = join(root, LOCK_REL)
  let cur = null
  try {
    cur = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    cur = null
  }
  const decision = schedulerLockDecision(cur, { pid, now, isAlive })
  if (!decision.owned) return decision
  const beat = () => {
    const body = JSON.stringify({ pid, port, beatAt: Date.now(), startedAt: cur?.pid === pid ? cur.startedAt : Date.now() }, null, 1)
    try {
      mkdirSync(dirname(path), { recursive: true })
      const tmp = `${path}.${pid}.tmp`
      writeFileSync(tmp, body)
      renameSync(tmp, path)
    } catch { /* 锁文件写不动就照常排班，最坏是多挂一份 */ }
  }
  beat()
  let timer = null
  try {
    timer = setInterval(beat, 60_000)
    timer.unref?.()
  } catch { /* 拿不到定时器就不刷心跳 */ }
  return {
    owned: true,
    release: () => {
      if (timer) clearInterval(timer)
      try {
        unlinkSync(path)
      } catch { /* 已经不在了 */ }
    },
  }
}

/** 挂排班的唯一入口：先抢锁，抢到才开定时器。serve.mjs 与 vite 开发服务都走这里 */
export function startScheduled({ root = process.cwd(), port, logger = console, run = null } = {}) {
  const lock = takeSchedulerLock({ root, port })
  if (!lock.owned) {
    logger.info(`[auto-run] 排班已经挂在 pid ${lock.holder.pid}（端口 ${lock.holder.port}）那个进程里，这个进程不开第二份`)
    return null
  }
  const api = startAutoRun({ root, port, logger, run })
  if (!api) {
    lock.release()
    return null
  }
  return { ...api, stop: () => { api.stop(); lock.release() } }
}
