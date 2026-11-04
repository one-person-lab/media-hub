import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SYNC_TASKS } from './server-core.mjs'
import { dayKey, dueJobs, fireAtMs, isBusy, pickReason, schedulerLockDecision, startAutoRun, takeSchedulerLock } from './auto-run.mjs'

const JOB = { name: '发布状态晨间补检', task: 'publish-check', arg: '', at: '08:42', jitterMin: 20, graceMin: 90 }
const at = (day, hm) => new Date(`${day}T${hm}`).getTime()

test('本地日按本机日历切，午夜前后不跑到前一天', () => {
  assert.equal(dayKey(at('2026-10-23', '00:04')), '2026-10-23')
  assert.equal(dayKey(at('2026-10-23', '23:59')), '2026-10-23')
})

test('触发点带抖动但同一天不挪：早上才开 app 补跑的是同一个点', () => {
  const a = fireAtMs(JOB, '2026-10-23')
  assert.equal(a, fireAtMs(JOB, '2026-10-23'))
  assert.ok(a >= at('2026-10-23', '08:42') && a < at('2026-10-23', '09:02'), `抖动没落在 08:42~09:02：${a}`)
  const next = fireAtMs(JOB, '2026-10-25')
  assert.ok(next >= at('2026-10-25', '08:42') && next < at('2026-10-25', '09:02'))
})

test('没到点不跑；到点且今天没跑过才排进去', () => {
  const day = '2026-10-23'
  const fire = fireAtMs(JOB, day)
  assert.deepEqual(dueJobs({ jobs: [JOB], now: fire - 60_000, state: {}, day }), [])
  assert.equal(dueJobs({ jobs: [JOB], now: fire + 1, state: {}, day })[0].job.name, JOB.name)
})

test('今天已经跑成的不再重跑；跑挂的也不当天重试（那是脚本的事，不是排班的事）', () => {
  const day = '2026-10-23'
  const fire = fireAtMs(JOB, day)
  for (const outcome of ['ok', 'failed', 'skipped']) {
    assert.deepEqual(dueJobs({ jobs: [JOB], now: fire + 60_000, state: { [JOB.name]: { [day]: { outcome } } }, day }), [], `${outcome} 不该再排`)
  }
  // 跑到一半 app 被关掉：短时间内还当它在跑，过了三小时重新排
  const fresh = { [JOB.name]: { [day]: { outcome: 'running', startedAt: fire + 60_000 } } }
  assert.deepEqual(dueJobs({ jobs: [JOB], now: fire + 30 * 60_000, state: fresh, day }), [])
  assert.equal(dueJobs({ jobs: [JOB], now: fire + 4 * 60 * 60_000, state: fresh, day })[0].job.name, JOB.name)
})

test('浏览器被上一趟占着：到点后每轮再试，过了宽限期如实记一笔', () => {
  const day = '2026-10-23'
  const fire = fireAtMs(JOB, day)
  const busy = { [JOB.name]: { [day]: { outcome: 'busy', at: fire } } }
  assert.equal(dueJobs({ jobs: [JOB], now: fire + 10 * 60_000, state: busy, day })[0].giveUp, undefined)
  assert.equal(dueJobs({ jobs: [JOB], now: fire + 100 * 60_000, state: busy, day })[0].giveUp, true)
})

test('认得出服务端那一撞（浏览器被别的任务占着），不当失败', () => {
  assert.ok(isBusy({ ok: false, busy: true, error: '已有同步在跑：发布回认' }))
  assert.ok(!isBusy({ ok: false, error: '已有同步在跑：发布回认' }), '撞车回话只认 busy 标志，不猜句子')
  assert.ok(!isBusy({ ok: false, error: '脚本退出码 2' }))
})

test('跑一趟：成功记 ok，并把结果落在 metrics/auto-run.json', async () => {
  const root = join(tmpdir(), `mh-auto-${Date.now()}`)
  mkdirSync(join(root, 'config'), { recursive: true })
  const day = dayKey(Date.now())
  writeFileSync(join(root, 'config', 'auto-run.json'), JSON.stringify({ jobs: [{ ...JOB, at: '00:00', jitterMin: 1 }] }))
  const logs = []
  const runs = []
  const api = startAutoRun({
    root,
    port: 1,
    logger: { info: (m) => logs.push(m) },
    run: async (job) => {
      runs.push(job.name)
      return { ok: true, exitCode: 0 }
    },
  })
  try {
    await api.ready
    const state = JSON.parse(readFileSync(join(root, 'metrics', 'auto-run.json'), 'utf8'))
    assert.equal(runs.length, 1, '起来补跑一趟，跑完不再重排')
    assert.equal(state[JOB.name][day].outcome, 'ok')
    assert.equal(state[JOB.name][day].task, 'publish-check')
    assert.ok(logs.some((l) => l.includes('开跑')), logs.join('\n'))
  } finally {
    api.stop()
  }
})

test('那一趟没排进去（别人占着浏览器）：先记 busy 重试，宽限期过了记 skipped 并说清原因', async () => {
  const root = join(tmpdir(), `mh-auto-${Date.now()}-busy`)
  mkdirSync(join(root, 'config'), { recursive: true })
  // 宽限期给满一天：这一条只验「busy 会重试」，过期收账交给下面 graceMin 0 那一条
  writeFileSync(join(root, 'config', 'auto-run.json'), JSON.stringify({ jobs: [{ ...JOB, at: '00:00', jitterMin: 1, graceMin: 1440 }] }))
  let n = 0
  const api = startAutoRun({
    root,
    port: 1,
    logger: { info: () => {} },
    run: async () => {
      n++
      return n === 1 ? { ok: false, busy: true, error: '已有推送在跑，等它结束' } : { ok: true, exitCode: 0 }
    },
  })
  try {
    await api.ready
    await api.tick()
    const day = dayKey(Date.now())
    const state = JSON.parse(readFileSync(join(root, 'metrics', 'auto-run.json'), 'utf8'))
    assert.equal(n, 2, '第一趟被占着，第二趟要重试')
    assert.equal(state[JOB.name][day].outcome, 'ok')
  } finally {
    api.stop()
  }

  // 一直占着：宽限期到了就该收账，不再无限撞
  const root2 = join(tmpdir(), `mh-auto-${Date.now()}-giveup`)
  mkdirSync(join(root2, 'config'), { recursive: true })
  writeFileSync(join(root2, 'config', 'auto-run.json'), JSON.stringify({ jobs: [{ ...JOB, at: '00:00', jitterMin: 1, graceMin: 0 }] }))
  let m = 0
  const api2 = startAutoRun({
    root: root2,
    port: 1,
    logger: { info: () => {} },
    run: async () => {
      m++
      return { ok: false, busy: true, error: '已有同步在跑：发布回认' }
    },
  })
  try {
    await api2.ready
    await api2.tick()
    const day = dayKey(Date.now())
    const st2 = JSON.parse(readFileSync(join(root2, 'metrics', 'auto-run.json'), 'utf8'))
    assert.equal(st2[JOB.name][day].outcome, 'skipped')
    assert.match(st2[JOB.name][day].note, /没排进去/)
    assert.equal(m, 1, '记了 skipped 之后不再撞第三趟')
  } finally {
    api2.stop()
  }
})

test('失败原因从尾巴里挑第一句人话，不留 JSON 残片和 ego 的收工话', () => {
  // 10-23 装机实测：晨检那笔账上写的是「} ego's nodejs process exited with code 2.」，没人看得懂
  const tail = ['  "errors": {', '    "sph": "视频号助手未登录：Profile not found"', '  }', '}', "ego's nodejs process exited with code 2"].join('\n')
  assert.equal(pickReason(tail), '视频号助手未登录：Profile not found')
  assert.equal(pickReason("}\nego's nodejs process exited with code 2"), '')
  assert.equal(pickReason(''), '')
})

test('中文原因不带冒号也要认，统计块里的路径与 ego 的通知都不算原因', () => {
  // 逐字取自 10-23 装机那趟被掐断的 collect 尾巴（600 字窗口）：真原因是 errors 里那句，
  // 而它既不带冒号、后面还压着 ego 的通知与收工话
  const live = [
    'ollect","platform":"douyin","state":"error","note":"人工停止，该平台本轮没跑"}',
    '[ego-browser:notice] Ego Lite update is available (current 0.6.0.16). Finish the current browser task, then ask the user before running `ego-browser upgrade`.',
    '{',
    '"date": "2026-10-23",',
    '"file": "metrics/raw/2026-10-23.json",',
    '"xiaohongshu": {',
    '"账号": "醒醒老己",',
    '"粉丝": 61,',
    '"日序列": 30',
    '},',
    '"errors": {',
    '"douyin": "人工停止，该平台本轮没跑"',
    '}',
    '}',
    "ego's nodejs process exited with code 3.",
  ].join('\n')
  assert.equal(pickReason(live), '人工停止，该平台本轮没跑')
})

test('账上的 note 用挑出来那句；挑不到就如实说退出码', async () => {
  const root = join(tmpdir(), `mh-auto-${Date.now()}-note`)
  mkdirSync(join(root, 'config'), { recursive: true })
  writeFileSync(
    join(root, 'config', 'auto-run.json'),
    JSON.stringify({ cooldownMin: 0, jobs: [{ ...JOB, name: '有原因', at: '00:00', jitterMin: 1 }, { ...JOB, name: '没原因', at: '00:01', jitterMin: 1 }] }),
  )
  const api = startAutoRun({
    root,
    port: 1,
    logger: { info: () => {} },
    run: async (j) =>
      j.name === '有原因'
        ? { ok: false, exitCode: 2, tail: '    "sph": "视频号助手未登录：Profile not found"\n  }\n}\nego\'s nodejs process exited with code 2' }
        : { ok: false, exitCode: 1, tail: "ego's nodejs process exited with code 1" },
  })
  try {
    await api.ready
    const day = dayKey(Date.now())
    const st = JSON.parse(readFileSync(join(root, 'metrics', 'auto-run.json'), 'utf8'))
    assert.equal(st['有原因'][day].note, '视频号助手未登录：Profile not found')
    assert.equal(st['没原因'][day].note, '脚本自己报了退出码 1')
  } finally {
    api.stop()
  }
})

test('欠下的几趟按当天该跑的时刻先后补，不按配置文件里的书写顺序', () => {
  const day = '2026-10-23'
  const early = { ...JOB, name: '早的那趟', at: '07:40', jitterMin: 1 }
  const late = { ...JOB, name: '晚的那趟', at: '21:47', jitterMin: 1 }
  const list = dueJobs({ jobs: [late, early], now: at(day, '23:00'), state: {}, day })
  assert.deepEqual(list.map((d) => d.job.name), ['早的那趟', '晚的那趟'])
})

test('一个晚上欠下四趟也不连着撞：两趟之间要歇够 cooldownMin 才开下一趟', async () => {
  const root = join(tmpdir(), `mh-auto-${Date.now()}-cool`)
  mkdirSync(join(root, 'config'), { recursive: true })
  writeFileSync(
    join(root, 'config', 'auto-run.json'),
    JSON.stringify({ cooldownMin: 30, jobs: [{ ...JOB, name: '甲', at: '00:00', jitterMin: 1 }, { ...JOB, name: '乙', at: '00:01', jitterMin: 1 }] }),
  )
  const runs = []
  const ledger = join(root, 'metrics', 'auto-run.json')
  const api = startAutoRun({
    root,
    port: 1,
    logger: { info: () => {} },
    run: async (j) => {
      runs.push(j.name)
      return { ok: true, exitCode: 0 }
    },
  })
  try {
    await api.ready
    assert.deepEqual(runs, ['甲'], '一趟跑完，同一轮不该接着开第二趟')
    await api.tick()
    assert.deepEqual(runs, ['甲'], '冷却没过还不该开')
    const st = JSON.parse(readFileSync(ledger, 'utf8'))
    st._meta.lastFinishedAt = Date.now() - 31 * 60_000
    writeFileSync(ledger, JSON.stringify(st))
    await api.tick()
    assert.deepEqual(runs, ['甲', '乙'], '冷却过了该把欠着的下一趟补上')
  } finally {
    api.stop()
  }
})

test('人在界面上按了停止：如实记一笔，今天不再自动开这一趟', async () => {
  const root = join(tmpdir(), `mh-auto-${Date.now()}-stop`)
  mkdirSync(join(root, 'config'), { recursive: true })
  writeFileSync(join(root, 'config', 'auto-run.json'), JSON.stringify({ jobs: [{ ...JOB, at: '00:00', jitterMin: 1 }] }))
  let n = 0
  const api = startAutoRun({
    root,
    port: 1,
    logger: { info: () => {} },
    run: async () => {
      n++
      return { ok: false, exitCode: 143, stopped: true }
    },
  })
  try {
    await api.ready
    const day = dayKey(Date.now())
    await api.tick()
    const st = JSON.parse(readFileSync(join(root, 'metrics', 'auto-run.json'), 'utf8'))
    assert.equal(st[JOB.name][day].outcome, 'stopped')
    assert.match(st[JOB.name][day].note, /按了停止/)
    assert.equal(n, 1, '人停的不该自动再来一趟')
  } finally {
    api.stop()
  }
})

test('没有 config/auto-run.json 就不开定时（装机的人可以自己关掉）', () => {
  assert.equal(startAutoRun({ root: join(tmpdir(), 'mh-auto-none'), port: 1, logger: { info: () => {} } }), null)
})

test('随包那份排班对得上单飞队列：任务名登记过、时间点格式对、名字不重', () => {
  const cfg = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'config', 'auto-run.json'), 'utf8'))
  const seen = new Set()
  for (const j of cfg.jobs) {
    assert.ok(SYNC_TASKS[j.task], `「${j.name}」填的任务 ${j.task} 没在单飞队列登记，每天只会撞回一句未登记`)
    assert.match(j.at, /^\d{2}:\d{2}$/, `${j.name} 的 at 要写 HH:MM`)
    assert.ok(!seen.has(j.name), `任务名重复：${j.name}`)
    seen.add(j.name)
    const scheduled = new Date(`2026-10-23T${j.at}:00`).getTime()
    const fire = fireAtMs(j, '2026-10-23')
    assert.ok(fire >= scheduled && fire < scheduled + (j.jitterMin ?? 20) * 60_000, `${j.name} 的点没落在 ${j.at} 之后 ${j.jitterMin} 分钟里`)
  }
})

test('排班只许一个执行体：别人心跳还新鲜、进程还活着才不开第二份', () => {
  const now = at('2026-10-28', '12:00')
  const alive = { isAlive: () => true }
  const dead = { isAlive: () => false }
  assert.equal(schedulerLockDecision({ pid: 111, port: 5173, beatAt: now - 30_000 }, { pid: 222, now, ...alive }).owned, false)
  assert.equal(
    schedulerLockDecision({ pid: 111, port: 5173, beatAt: now - 30_000 }, { pid: 222, now, ...dead }).owned,
    true,
    '开发服务天天重启：旧锁心跳还新鲜但那个进程已经没了，新进程要能接管',
  )
  assert.equal(schedulerLockDecision({ pid: 111, port: 5173, beatAt: now - 4 * 60_000 }, { pid: 222, now, ...alive }).owned, true, '心跳停了三分钟以上也接管')
  assert.equal(schedulerLockDecision(null, { pid: 222, now }).owned, true)
  assert.equal(schedulerLockDecision({ pid: 222, port: 5198, beatAt: now }, { pid: 222, now, ...alive }).owned, true, '自己原先拿过的锁要能拿回来')
})

test('锁文件写 pid 与心跳，放掉就删', () => {
  const root = join(tmpdir(), `mh-lock-${Math.random().toString(36).slice(2)}`)
  mkdirSync(join(root, 'metrics'), { recursive: true })
  const one = takeSchedulerLock({ root, port: 5173, pid: 111, isAlive: () => false })
  assert.ok(one.owned)
  const written = JSON.parse(readFileSync(join(root, 'metrics', 'auto-run-lock.json'), 'utf8'))
  assert.equal(written.pid, 111)
  assert.equal(written.port, 5173)
  const two = takeSchedulerLock({ root, port: 5198, pid: 222, isAlive: (p) => p === 111 })
  assert.equal(two.owned, false)
  assert.equal(two.holder.pid, 111)
  one.release()
  assert.equal(takeSchedulerLock({ root, port: 5198, pid: 222, isAlive: () => false }).owned, true, '前一个放掉后就能接手')
})
