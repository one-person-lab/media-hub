#!/usr/bin/env node
/**
 * 一键自检：把 docs/ONBOARDING.md 那张「首跑验收清单」搬进界面。
 *
 * 两条硬规矩：
 * 1. 判据只看盘上产物。脚本自报 ok、退出码 0 都不算过——出过自报成功但实际空数据的事故。
 * 2. 绝不碰浏览器。采集、发布检测、推草稿共用同一个已登录浏览器，同一时刻只能干一件，
 *    所以这里全部是本机读数；要占浏览器的那几项写成「只能人工」并说清去哪点。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { hasCli, justVersion } from './env-core.mjs'
import { readLlmKey } from './llm-core.mjs'
import { checkTool, REQUIRED_TOOLS, HOST_ARCH } from './fetch-binaries.mjs'
import { lastArtifactDay } from './collect-runs.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 读数超过 2 小时就当旧：号在半路退了登录，盘上那份还是「已登录」 */
const STALE_MS = 2 * 60 * 60 * 1000
/** 每日任务超过 2 天没落盘就算没在跑（周末不发文，但采集照跑） */
const CRON_DAYS = 2

const TASK_CN = { collect: '数据', viral: '爆款', favorites: '收藏', 'publish-check': '发布回认', benchmark: '对标' }
const TASK_PAGE = { collect: '复盘', viral: '爆款', favorites: '灵感库', 'publish-check': '日历', benchmark: '对标' }

function readJson(p) {
  try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return null }
}

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

const item = (id, title, state, detail, next) => ({ id, title, state, detail, next })

const basenameNoExt = (p) => p.split('/').pop().replace(/\.json$/, '')

/** 现跑一次数据层重建：这是唯一会写盘的检查，写的是 tmp+rename，多开也不会撕开 */
function rebuildData(root) {
  const r = spawnSync(process.execPath, ['scripts/build-data.mjs'], { cwd: root, encoding: 'utf8' })
  const out = `${r.stdout || ''}${r.stderr || ''}`
  const msg = String(out).split('\n').map((l) => l.trim()).find((l) => /^Error:/i.test(l)) || ''
  return { ok: r.status === 0, error: msg.replace(/^Error:\s*/i, '').slice(0, 200) }
}

/**
 * 全部读数。`data` 与 `probe` 是两处可注入的口子，让单能拿一份假产物跑判据：
 * 前者不必真去重建数据层，后者不必依赖跑单这台机器装了什么（ffmpeg 在不在 PATH 之类）。
 * 默认值都指向真正用它的那段代码，界面不许自己另定一套看起来就绪。
 * 顺序 = 一条内容在这台机器上走的路：先能不能算出界面 → 工具 → 号 → 采到的东西 → 每日读数 → 出片 → 推送。
 */
export async function checkItems({ root = ROOT, data = rebuildData(root), probe = {} } = {}) {
  const {
    hasEgo = hasCli('ego-browser'),
    llmKey = readLlmKey(),
    bins = () => Promise.all(REQUIRED_TOOLS.map((t) => checkTool(HOST_ARCH, t))),
  } = probe
  const items = []
  const now = Date.now()

  /* 1. 数据层 */
  const gen = readJson(join(root, 'src/data/generated.json'))
  if (!data.ok) items.push(item('data', '内容库读得出界面', 'missing', data.error || '数据层重建失败', '按上面那句把它点名的文件改好，再点一次自检'))
  else if (!gen) items.push(item('data', '内容库读得出界面', 'missing', '重建说成功了，但界面数据文件不在', '再点一次自检；还是这样就重启工作台'))
  else items.push(item('data', '内容库读得出界面', 'ready', `选题 ${(gen.topics || []).length} · 采集 ${(gen.articles || []).length} · 作品 ${(gen.snapshots || []).length}`, ''))

  /* 2. 取料二进制 + 执行器 */
  for (const r of await bins()) {
    items.push(item(`bin-${r.tool}`, r.tool === 'ffmpeg' ? '视频取料 ffmpeg' : '时长读取 ffprobe', r.ready ? 'ready' : 'missing',
      r.ready ? justVersion(r.version) || '已装' : r.reason === 'invalid' ? r.detail : '没装',
      r.ready ? '' : '到环境那一屏点「安装」，装完回来再检一次'))
  }
  items.push(item('cli-ego', '浏览器执行器', hasEgo ? 'ready' : 'missing', hasEgo ? '叫得动' : '这台机器上没有',
    hasEgo ? '' : '先装 Ego Lite 的命令行工具，装完点「重新检查」'))

  /* 3. 生成引擎 */
  items.push(item('llm', 'AI 引擎 Key', llmKey ? 'ready' : 'missing', llmKey ? '已填' : '还没填',
    llmKey ? '' : '到配置页填一次 Key，拆解和创作两条线都要它'))

  /* 4. 号登记全没 */
  const accounts = readJson(join(root, 'config/accounts.json')) || []
  const broken = accounts.filter((a) => !a.platform || !a.key || !a.script || !existsSync(join(root, String(a.script))))
  items.push(item('accounts', `${accounts.length} 个号的登记`, accounts.length && !broken.length ? 'ready' : 'missing',
    accounts.length ? (broken.length ? `缺发布脚本：${broken.map((a) => a.platform || a.key).join('、')}` : '平台、后台地址、发布脚本都齐') : '一个号都没登记',
    accounts.length && !broken.length ? '' : '在「账号」页把号补全'))

  /* 5. 登录态：没测过、测出没登、读数太旧是三件事 */
  const got = readJson(join(root, 'metrics/login-state.json'))?.platforms || {}
  const ok = [], out = [], stale = [], none = []
  for (const a of accounts) {
    const r = got[a.platform]
    if (!r) none.push(a.platform)
    else if (r.state !== 'ok') out.push(a.platform)
    else if (now - new Date(r.checkedAt || 0).getTime() > STALE_MS) stale.push(a.platform)
    else ok.push(a.platform)
  }
  const loginState = out.length ? 'missing' : stale.length || none.length ? 'stale' : ok.length ? 'ready' : 'missing'
  items.push(item('login', '后台登录态', loginState,
    [ok.length && `${ok.length} 个已登录`, out.length && `要重新扫码：${out.join('、')}`, stale.length && `读数超过 2 小时：${stale.join('、')}`, none.length && `没体检过：${none.join('、')}`].filter(Boolean).join(' · '),
    loginState === 'ready' ? '' : '在「账号」页逐个扫码；这一项要占浏览器，别和采集同时点'))

  /* 6. 采集通路：最近一张卡有没有封面和逐页原图 */
  const cardFile = newestMd(join(root, 'content/Inbox/采集笔记'))
  if (!cardFile) {
    items.push(item('collect', '采回来的东西', 'missing', '一条采集卡都没有', '去「起步」第 4 步粘一条链接采一次'))
  } else {
    const fm = frontmatter(readFileSync(cardFile, 'utf8'))
    const cover = fm.coverImage ? existsSync(join(root, 'public', fm.coverImage.replace(/^\//, ''))) : false
    const pages = fm.sourceImages ? existsSync(join(root, 'public/inspiration', fm.sourceImages)) : false
    const miss = [!cover && '封面', !pages && '逐页原图'].filter(Boolean)
    items.push(item('collect', '采回来的东西', miss.length ? 'stale' : 'ready',
      `最近一张「${fm.title || '无标题'}」${miss.length ? `缺${miss.join('和')}` : '：封面与原图都在'}`,
      miss.length ? '这条算半采；到那张卡上点重新采集把图补回来' : ''))
  }

  /* 7. 每日读数：粉丝数由夜间数据同步写、已发布列表由发布检测写，两班任务落在同一份日快照里
   *    但谁先谁后不定。所以各自回看最近 7 天里第一份读得到的，别拿「今天这份缺」判成没采到。 */
  const rawDir = join(root, 'metrics/raw')
  const days = existsSync(rawDir)
    ? readdirSync(rawDir).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().reverse().slice(0, 7)
    : []
  const snaps = days.map((f) => ({ day: f.replace('.json', ''), plats: Object.values(readJson(join(rawDir, f))?.platforms || {}) }))
  const fansOf = (ps) => ps.filter((p) => Number(p?.followers) > 0).length
  const listsOf = (ps) => ps.filter((p) => (p?.publishedList || []).length).length
  const fanHit = snaps.find((x) => fansOf(x.plats))
  const listHit = snaps.find((x) => listsOf(x.plats))
  items.push(item('daily', '粉丝与作品读数', fanHit ? 'ready' : 'missing',
    fanHit ? `${fanHit.day} 有 ${fansOf(fanHit.plats)} 个平台读到粉丝数` : '最近 7 天没有一份快照读到粉丝数',
    fanHit ? '' : '跑一次数据同步；读数一直是 0，通常是后台登录掉了，先去「账号」页看'))
  items.push(item('publish-list', '已发布列表', listHit ? 'ready' : 'missing',
    listHit ? `${listHit.day} 有 ${listsOf(listHit.plats)} 个平台列出了已发条目` : '最近 7 天没有一份快照列出已发条目',
    listHit ? '' : '跑一次发布检测；采不到不等于没发，检测失败只会留「未检测」'))
  /* 7.5 每日任务健康度：一个任务一条，判据是它自己的产物落盘日（不看任务定义文件在不在、
   *    也不看调度器自报成没成功）。聚合卡说「在跑」是撒谎——爆款断了 20 天时它照样绿。 */
  for (const t of ['collect', 'viral', 'favorites', 'publish-check']) {
    const day = lastArtifactDay(root, t)
    const gap = day ? Math.floor((now - new Date(`${day}T23:59:59`).getTime()) / 86400000) : null
    const live2 = day && gap <= CRON_DAYS
    items.push(item(`task-${t}`, `${TASK_CN[t]}落盘`, live2 ? 'ready' : day ? 'stale' : 'missing',
      day ? `最近 ${day}${live2 ? '' : ` · 隔了 ${gap} 天`}` : '本机没有它采回来的东西',
      live2 ? '' : `到「${TASK_PAGE[t]}」页点立即${t === 'publish-check' ? '检测' : '采集'}；先确认那个平台的后台还登录着`))
  }
  // 对标线 2026-09-30 起暂停，不参与每日健康度判定，只在档案一条没有时提醒
  const benchDay = lastArtifactDay(root, 'benchmark')
  if (!benchDay) items.push(item('task-benchmark', '对标账号建档', 'missing', '一个对标账号都没有', '这条线已暂停自动跑；要用的话在「对标」页手动跑一次'))

  /* 8. 图卡产物：页数对不上就是渲坏了或半套 */
  const cardsDir = join(root, 'content/Projects/卡片')
  const jsons = existsSync(cardsDir) ? readdirSync(cardsDir).filter((f) => f.endsWith('.json')) : []
  if (!jsons.length) {
    items.push(item('cards', '图卡成片', 'missing', '一张图卡都没有', '先在创作台写一篇，让它自己渲'))
  } else {
    const newest = jsons.map((f) => join(cardsDir, f)).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0]
    const c = readJson(newest)
    const want = (c?.pages || []).length
    const dir = join(root, 'public/cards', String(c?.slug || basenameNoExt(newest)))
    const have = existsSync(dir) ? readdirSync(dir).filter((f) => /^\d+\.png$/.test(f)).length : 0
    items.push(item('cards', '图卡成片', want && have >= want ? 'ready' : 'missing',
      `最近一张「${c?.title || ''}」${have}/${want} 页`, want && have >= want ? '' : '到那篇稿子上点重新渲染'))
  }

  /* 9. 推草稿：铁律要求人工到平台草稿箱肉眼确认，机器不替这一步签字 */
  items.push(item('push', '草稿落到平台草稿箱', 'manual', '这一步只能人工确认', '到对应平台的创作者后台，草稿箱里看到那条才算过'))

  return {
    ok: !items.some((i) => i.state === 'missing'),
    at: new Date().toISOString(),
    arch: HOST_ARCH,
    items,
  }
}

/** 跑一次并把结果落到本机（不进 git）；界面读这份文件，不重复跑 */
export async function runSelfCheck({ root = ROOT, logger = console } = {}) {
  const result = await checkItems({ root })
  const out = join(root, 'metrics/selfcheck.json')
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, JSON.stringify(result, null, 2))
  logger.info(`[selfcheck] ${result.ok ? '全过' : '有没过的项目'}：${result.items.filter((i) => i.state !== 'ready' && i.state !== 'manual').length} 项待处理`)
  return result
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const r = await runSelfCheck()
  for (const i of r.items) console.log(`${i.state === 'ready' ? '✓' : i.state === 'manual' ? '·' : '✗'} ${i.title} — ${i.detail}${i.next ? `｜${i.next}` : ''}`)
  process.exit(r.ok ? 0 : 1)
}
