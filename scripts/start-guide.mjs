#!/usr/bin/env node
/**
 * 起步向导：把「这台机器第一次跑通」拆成四步，每步只认盘上产物。界面落在看板顶部那张卡（GuideCard.vue），
 * 四步齐了卡自己消失——它不占侧栏一站。
 *
 * 与一键自检的分工：自检管「现在哪里坏了」（13 项读数，给排查用），
 * 向导管「第一天按什么顺序装起来」（4 步，给第一次打开的人用）。两边的读数在设置里合成一屏「本机」。
 * 同源判据：浏览器执行器看 hasCli，号看 config/accounts.json，登录态看 metrics/login-state.json。
 *
 * 向导自己不碰浏览器：第 4 步那一下采集走 /__run-script 的既有单飞队列（和采集/推草稿共用一只浏览器），
 * 这里只读它落下来的卡——采没采成，看卡上有没有封面、逐页原图和赞藏评，不看脚本自报。
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { hasCli } from './env-core.mjs'
import { HOST_ARCH } from './fetch-binaries.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 登录态读数超过 2 小时就当旧：号在半路退了，盘上那份还写着「已登录」 */
const STALE_MS = 2 * 60 * 60 * 1000

function readJson(p) {
  try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return null }
}

/** 只认 frontmatter 的顶层 `key: value`；noteData 那种缩进子键单独按行取 */
function frontmatter(md) {
  const m = String(md).match(/^---\n([\s\S]*?)\n---/)
  if (!m) return {}
  const out = {}
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([A-Za-z][\w-]*):\s*(.*)$/)
    if (kv) out[kv[1]] = kv[2].replace(/^["']|["']$/g, '')
  }
  return out
}

function newestMd(dir) {
  if (!existsSync(dir)) return null
  let best = null
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name.endsWith('.md') && (!best || statSync(p).mtimeMs > statSync(best).mtimeMs)) best = p
    }
  }
  walk(dir)
  return best
}

/** 一张采集卡到底算不算「采全了」：封面、逐页原图、赞藏评，缺一样就是半条 */
function cardGap(root, md) {
  const fm = frontmatter(md)
  const cover = fm.coverImage ? existsSync(join(root, 'public', String(fm.coverImage).replace(/^\//, ''))) : false
  const pagesDir = fm.sourceImages ? join(root, 'public/inspiration', String(fm.sourceImages)) : ''
  const pages = pagesDir && existsSync(pagesDir) ? readdirSync(pagesDir).filter((f) => /\.(png|jpe?g|webp)$/i.test(f)).length : 0
  const hit = (k) => (md.match(new RegExp(`^\\s{2}${k}:\\s*(.*)$`, 'm'))?.[1] || '').trim()
  const numbers = ['likes', 'collects', 'comments'].filter((k) => hit(k))
  return {
    title: fm.title || (String(md).match(/^# (.+)$/m) || [])[1] || '无标题',
    gap: [!cover && '封面', !pages && '逐页原图', !numbers.length && '赞藏评'].filter(Boolean),
  }
}

/** 向导状态落在本机（不进 git）：只记一件事——这个人说过「别再给我看这个」 */
export function readGuide({ root = ROOT } = {}) {
  return readJson(join(root, 'metrics/start-guide.json')) || { dismissed: false, doneAt: '' }
}

export function writeGuide(patch, { root = ROOT } = {}) {
  const out = join(root, 'metrics/start-guide.json')
  const next = { ...readGuide({ root }), ...patch }
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, JSON.stringify(next, null, 2))
  return next
}

/**
 * 四步读数。`probe` 是可注入的口子，让单能拿一份假产物跑判据；默认值都指向真正用它的那段代码。
 * 顺序 = 一条内容在这台机器上走的路：先要有能替你点页面的浏览器 → 登记号 → 逐个登上号 → 采回第一条。
 */
export async function startSteps({ root = ROOT, probe = {} } = {}) {
  const { hasEgo = hasCli('ego-browser'), now = Date.now() } = probe
  const guide = readGuide({ root })
  const steps = []

  /* 1. 浏览器执行器：没有它，后面三步一步都走不了 */
  steps.push({
    n: 1,
    id: 'bin',
    title: '接上浏览器执行器',
    state: hasEgo ? 'ready' : 'todo',
    detail: hasEgo ? '现在：叫得动' : '现在：没检测到',
    next: hasEgo ? '' : '装完 Ego Lite 的命令行工具，回这一点「重新检查」',
    jump: hasEgo ? '' : 'machine',
  })

  /* 2. 号登记 */
  const accounts = readJson(join(root, 'config/accounts.json')) || []
  const broken = accounts.filter((a) => !a.platform || !a.key || !a.script || !existsSync(join(root, String(a.script))))
  const regOk = accounts.length > 0 && !broken.length
  steps.push({
    n: 2,
    id: 'accounts',
    title: '登记你的号',
    state: regOk ? 'ready' : 'todo',
    detail: accounts.length
      ? (broken.length ? `缺发布脚本：${broken.map((a) => a.platform || a.key).join('、')}` : `现在：${accounts.map((a) => a.platform).join('、')}`)
      : '现在：一个号都没登记',
    next: regOk ? '' : '去「账号」页把号补全',
    jump: regOk ? '' : 'accounts',
  })

  /* 3. 逐平台登录：没测过 / 掉了 / 读数太旧是三件事，别拿一份旧账说「都登着」 */
  const got = readJson(join(root, 'metrics/login-state.json'))?.platforms || {}
  const platforms = []
  let loggedIn = 0
  for (const a of accounts) {
    const r = got[a.platform]
    const fresh = r?.state === 'ok' && now - new Date(r.checkedAt || 0).getTime() <= STALE_MS
    if (fresh) loggedIn++
    platforms.push({
      platform: a.platform,
      state: !r ? 'none' : r.state !== 'ok' ? 'out' : fresh ? 'ok' : 'stale',
    })
  }
  const loginOk = loggedIn > 0
  // 同一原因的几个号并成一句：五个号都旧了就念一遍「读数超过 2 小时」，不念五遍
  const LOGIN_WORD = { ok: '已登录', out: '要重新扫码', stale: '读数超过 2 小时', none: '待登录' }
  const loginDetail = ['ok', 'out', 'stale', 'none']
    .map((st) => ({ st, names: platforms.filter((p) => p.state === st).map((p) => p.platform) }))
    .filter((g) => g.names.length)
    .map((g) => `${LOGIN_WORD[g.st]}：${g.names.join('、')}`)
    .join(' · ')
  steps.push({
    n: 3,
    id: 'login',
    title: '给每个号登录',
    state: loginOk ? 'ready' : 'todo',
    detail: platforms.length ? loginDetail : '先把号登记上，这里才有可扫的平台',
    next: loginOk ? '' : '去「账号」页逐个扫码；这一步要占浏览器，别和采集同时点',
    jump: loginOk ? '' : 'accounts',
  })

  /* 4. 采回第一条：只看最近那张卡采全没有 */
  const cardFile = newestMd(join(root, 'content/Inbox/采集笔记'))
  const card = cardFile ? cardGap(root, readFileSync(cardFile, 'utf8')) : null
  const collectOk = !!card && !card.gap.length
  steps.push({
    n: 4,
    id: 'collect',
    title: '采回第一条内容',
    state: collectOk ? 'ready' : 'todo',
    detail: card ? `最近一张「${card.title}」${card.gap.length ? `缺${card.gap.join('、')}` : '：封面、原图、读数都在'}` : '现在：一条采集卡都没有',
    next: collectOk ? '' : '粘一条小红书笔记链接点「采」；缺哪样就重采那条',
    jump: '',
  })

  const done = steps.every((s) => s.state === 'ready')
  if (done && !guide.doneAt) writeGuide({ doneAt: new Date().toISOString() }, { root })
  return {
    ok: done,
    at: new Date().toISOString(),
    arch: HOST_ARCH,
    dismissed: !!guide.dismissed,
    doneAt: guide.doneAt || '',
    steps,
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const r = await startSteps()
  for (const s of r.steps) console.log(`${s.state === 'ready' ? '✓' : '·'} ${s.n}. ${s.title} — ${s.detail}${s.next ? `｜${s.next}` : ''}`)
  console.log(`[start-guide] ${r.ok ? '四步都过了' : '还有没过的步'}${r.dismissed ? '（已收起）' : ''}`)
  process.exit(r.ok ? 0 : 1)
}
