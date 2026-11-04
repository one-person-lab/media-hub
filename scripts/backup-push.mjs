#!/usr/bin/env node
/**
 * 云端同步备份：把这台机器上的内容事实源拍成一个提交，推到该去的那两个远端。
 *
 *   node scripts/backup-push.mjs [--dry-run] [--remotes origin,cloud] [--message "..."]
 *
 * 为什么用 git 而不是再搓一套 rsync/tar：内容本来就在这个仓里（content / config / public），
 * git 天生带历史、增量、`git clone` 就是恢复，换机重装一条命令拉回，不用另养一份同步脚本。
 * 方向只有一条：本机 → 云端。这里永不 pull、永不 merge——本地是事实源，云端只是镜像，
 * 推不上去就如实报错让人去看，绝不悄悄把远端那份合进来。
 *
 * 云端裸仓（第一条腿，在自己机器上）第一次要这么开一次：
 *   ssh smzs-server 'git init --bare -b main /opt/media-hub-backup.git'
 *   git remote add cloud smzs-server:/opt/media-hub-backup.git
 * 第二条腿是仓里本来就有的 origin（GitHub 私仓，跟那台机器不同一间机房）。
 * `oss-public` 那个公开仓永远不在名单里，判断写在 backup-core.mjs 的 PUSH_REMOTES。
 *
 * 排班：config/auto-run.json 里加一行 { "task": "backup" } 就每天自动拍一次（桌面版开着才跑）。
 */
import { execFileSync } from 'node:child_process'
import { statSync } from 'node:fs'
import { join } from 'node:path'
import { commitTitle, pickRemotes, planBackup } from './backup-core.mjs'
import { localDay } from './day-core.mjs'
import { stopRequested } from './sync-step.mjs'
import { STOPPED_TEXT } from './run-jobs.mjs'

const ROOT = join(import.meta.dirname, '..')
const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`)
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : ''
}
const has = (name) => process.argv.includes(`--${name}`)
const log = (line) => console.log(`[backup] ${line}`)

const git = (args, opts = {}) => {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, ...opts })
  } catch (e) {
    const detail = String(e.stderr || e.stdout || e.message || '').trim().split('\n').slice(-3).join(' / ')
    throw new Error(`git ${args[0]} 没跑成：${detail}`)
  }
}

/** 相对 HEAD 已改与已删的入库文件（不含未入库的新文件） */
const trackedChanges = () =>
  git(['diff', '--name-only', '-z', 'HEAD']).split('\0').filter(Boolean).map((path) => ({ path }))

/** 还没入库的新文件：带上本机大小，太大的那条由 planBackup 拦下 */
const newFiles = () => git(['ls-files', '--others', '--exclude-standard', '-z'])
  .split('\0').filter(Boolean)
  .map((path) => {
    try { return { path, bytes: statSync(join(ROOT, path)).size } } catch { return { path, bytes: 0 } }
  })

const clock = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`

function main() {
  const dryRun = has('dry-run')
  const tracked = trackedChanges()
  const untracked = newFiles()
  const plan = planBackup({ tracked, untracked })

  log(`内容改动 ${plan.stage.length} 个文件`
    + (plan.skip.length ? ` · 跳过太大的新文件 ${plan.skip.length} 个（${plan.skip.join('、')}）` : '')
    + (plan.code.length ? ` · 代码改动 ${plan.code.length} 个不在这次快照里（那是人写的，自己提交）` : ''))
  if (!dryRun && plan.code.length) {
    for (const p of plan.code.slice(0, 5)) log(`  留在工作区：${p}`)
  }

  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']).trim()
  const now = new Date()
  let committed = false
  if (plan.changed) {
    if (dryRun) {
      log(`试运行：本该提交 ${plan.stage.length} 个文件`)
    } else {
      git(['add', '--pathspec-from-file=-', '--pathspec-file-nul'], { input: plan.stage.join('\0') + '\0' })
      const title = arg('message') || commitTitle({ day: localDay(now), clock: clock(now), files: plan.stage.length })
      git(['commit', '-m', title])
      committed = true
      log(`已拍快照：${title}`)
    }
  } else {
    log('内容没改动')
  }

  const available = git(['remote']).split('\n').map((r) => r.trim()).filter(Boolean)
  const requested = (arg('remotes') || process.env.WORKBENCH_BACKUP_REMOTES || '')
    .split(',').map((s) => s.trim()).filter(Boolean)
  const wanted = requested.length ? requested : ['origin', 'cloud']
  const picked = pickRemotes(requested.length ? wanted : wanted.filter((r) => available.includes(r)), available)
  if (!picked.ok) {
    log(picked.error)
    process.exitCode = 1
    return
  }
  // 少一条腿要说出来并给出现成命令：只推到 GitHub 不等于备份做完了
  for (const r of wanted.filter((x) => !available.includes(x))) {
    log(`这一腿本机还没配：${r} —— ${r === 'cloud'
      ? "先 `ssh smzs-server 'git init --bare -b main /opt/media-hub-backup.git'` 再 `git remote add cloud smzs-server:/opt/media-hub-backup.git`"
      : `git remote add ${r} <地址>`}`)
  }

  let failed = []
  for (const remote of picked.remotes) {
    // 人在界面上按了停止：推完的那条腿不退回来，剩下的腿不再推（快照已在本机，下次排班接着推）
    if (stopRequested()) { log(`${STOPPED_TEXT}，剩下的远端这轮不推`); process.exitCode = 3; return }
    if (dryRun) { log(`试运行：本该推 ${remote}/${branch}`); continue }
    let ahead = -1
    try {
      // 这个探测只是问「比云端那一份多几个提交」，云端还没这一支时 git 的抱怨不是给界面看的
      ahead = Number(git(['rev-list', '--count', `${remote}/${branch}..HEAD`], { stdio: ['ignore', 'pipe', 'ignore'] }).trim())
    } catch { /* 还没见过这个远端那一支：第一趟就是要推过去 */ }
    if (!committed && ahead === 0) { log(`${remote}/${branch} 已经是最新的，跳过`); continue }
    try {
      git(['push', remote, `HEAD:refs/heads/${branch}`], { stdio: 'pipe' })
      log(`已推 ${remote}/${branch}`)
    } catch (e) {
      failed.push(remote)
      log(`${e.message}（${remote} 这次没推上去，快照已经拍在本机，下次或手动再推）`)
    }
  }
  if (failed.length) process.exitCode = 1
}

try {
  main()
} catch (e) {
  log(e.message)
  process.exitCode = 1
}
