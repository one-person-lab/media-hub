/**
 * 爆款采集（自动线）：按 config/viral.json 的定位关键词多平台搜索，
 * 过 minLikes 与 withinDays 双门槛 → content/Inbox/爆款采集/<平台>/<笔记id>.md
 * 详情页顺手把 赞/藏/评 三个计数读回来写进卡（列表页只给赞）；设了 minComments 就在搬完源料后按它退卡。
 *
 * 用法（ego-browser 需已登录各平台）：npm run viral
 * 与灵感库的分工：灵感库是你手动整篇搬回来；这里到卡片（封面/标题/作者/点赞/链接），
 * 并顺手进详情页把「源料」搬回家——图文存逐页源图、视频存源片。
 * 采集收尾当场跑本机 OCR/转写把完整脚本写进卡（零 token），不再需要人点「补采脚本」；
 * 只有源料没搬回的卡才留人工入口。
 *
 * 人工线（界面「搜爆款」弹层：搜索与入库是两趟浏览器，中间那一次判断由人做）：
 *   --search=<词,词>  只搜不入库，达标候选连封面写进候选池给界面挑
 *   --capture=<id,id> 读回那份候选，只搬人勾中的那几条落卡
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, readdirSync, copyFileSync } from 'node:fs'
import { join, basename } from 'node:path'
import { pathToFileURL } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)
const ROOT = process.env.MEDIA_HUB_ROOT || process.cwd()
// 本脚本经 stdin 喂给 ego-browser，相对路径在 link 阶段按 / 解析，故用 file:// 绝对导入
const { notePublishedAt, douyinPublishedAt } = await import(
  pathToFileURL(join(ROOT, 'scripts/collect-note-core.mjs')).href
)
const { localDay } = await import(pathToFileURL(join(ROOT, 'scripts/day-core.mjs')).href)
const { heatScore } = await import(pathToFileURL(join(ROOT, 'scripts/viral-heat-core.mjs')).href)
const { captureNoteSource } = await import(pathToFileURL(join(ROOT, 'scripts/note-source-core.mjs')).href)
// 结构化进度与停止信号（stdout 一行 JSON 给留痕，进度文件给运行中的界面；停止只在平台之间自取）
const { step, progress, plan, stopRequested, skipUnlessWanted, writeSearchJson, readSearchJson } = await import(
  pathToFileURL(join(ROOT, 'scripts/sync-step.mjs')).href
)
const cfg = JSON.parse(readFileSync(join(ROOT, 'config/viral.json'), 'utf8'))
const OUT_DIR = join(ROOT, 'content/Inbox/爆款采集')
/** 收藏搬运卡的家：目录名用平台中文名（= PLATFORMS[...].label），跟爆款卡分两处放 */
const FAV_DIR = join(ROOT, 'content/Inbox/采集笔记/收藏')
const COVER_DIR = join(ROOT, 'public/viral')
// 卡片上的采集日期 = 本机日历日（07:40 那一趟以前按 UTC 截会写成昨天，collect-runs 的落盘判据读不到）
const TODAY = localDay()

/** 硬门槛：点赞不到这个数就不叫爆款，宁缺勿滥 */
const MIN_LIKES = cfg.minLikes ?? 10000
/** 只要近 withinDays 天发布的内容。窗口外的老爆款再高也不采——采的是「现在什么在爆」 */
const WITHIN_DAYS = cfg.withinDays ?? 90
const CUTOFF = localDay(Date.now() - WITHIN_DAYS * 86400000)
/** 分平台限额：全局排序会让抖音的百万赞把小红书挤出榜，所以每个平台各留一批 */
const PER_PLATFORM = cfg.dailyLimitPerPlatform ?? 5
/** 搜索结果页是懒加载的，滚几轮把候选池做大，否则门槛一卡就整天 0 条 */
const SCROLL_ROUNDS = cfg.scrollRounds ?? 3
/** 评论门槛：只有详情页读得到评论数，所以它在搬完源料之后判，不在列表页判。0 = 不判 */
const MIN_COMMENTS = cfg.minComments ?? 0

/** 「1.2万」/「3.5千」/「123」→ 数字 */
function toNum(s) {
  const t = String(s ?? '').trim()
  const m = t.match(/([\d.]+)\s*([万千wW]?)/)
  if (!m) return 0
  const n = parseFloat(m[1])
  if (isNaN(n)) return 0
  const u = m[2]
  return Math.round(n * (u === '万' || u.toLowerCase() === 'w' ? 10000 : u === '千' ? 1000 : 1))
}


/** 封面落到 public 下：外链图有防盗链，界面上只显示盘上这一份。
 *  dirRel 是相对 public 的目录（爆款卡走 viral/<平台>，搜爆款的候选走 viral-search/<平台>）。 */
async function downloadCover(url, dirRel, id) {
  if (!url) return ''
  try {
    const res = await fetch(url)
    if (!res.ok) return ''
    const type = res.headers.get('content-type') || ''
    const ext = type.includes('jpeg') || type.includes('jpg') ? 'jpg' : type.includes('png') ? 'png' : 'webp'
    mkdirSync(join(ROOT, 'public', dirRel), { recursive: true })
    writeFileSync(join(ROOT, 'public', dirRel, `${id}.${ext}`), Buffer.from(await res.arrayBuffer()))
    return `/${dirRel}/${id}.${ext}`
  } catch {
    return ''
  }
}

/** 源片体积上限：CDN 直链偶尔给到 4K 原盘，本机 OCR 用不着，也别把盘塞爆 */
const MAX_BYTES = cfg.maxSourceBytes ?? 200 * 1024 * 1024

const PLATFORMS = {
  xiaohongshu: {
    label: '小红书',
    searchUrl: (kw) => `https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(kw)}`,
    publishedAt: notePublishedAt,
    // 小红书对 URL 上的 sort=popularity 不响应（实测返回的点赞是乱序），
    // 所以只能把整页 feeds 全拿回来本地排序，绝不能只取前 N 条。
    ready: () => {
      const s = window.__INITIAL_STATE__
      const se = s?.search?._value || s?.search?._rawValue || s?.search
      const f = se?.feeds?._value || se?.feeds || se?.feedsSearch || []
      return f.length > 0
    },
    scrape: () => {
      const out = []
      const push = (o) => o.id && o.title && out.push(o)
      try {
        const state = window.__INITIAL_STATE__
        const search = state?.search?._value || state?.search?._rawValue || state?.search
        const feeds = search?.feeds?._value || search?.feeds || search?.feedsSearch || []
        for (const f of feeds) {
          const card = f?.noteCard
          if (!card) continue
          push({
            id: f.id,
            token: f.xsecToken || '',
            title: card.displayTitle || '',
            author: card.user?.nickname || card.user?.nickName || '',
            likes: card.interactInfo?.likedCount || '',
            format: f.modelType === 'video' ? 'video' : 'image',
            cover: card.cover?.urlDefault || card.cover?.url || (Array.isArray(card.cover?.urlList) ? card.cover.urlList[0] : '') || '',
          })
        }
      } catch {}
      if (out.length) return out
      for (const el of document.querySelectorAll('section.note-item, .note-item')) {
        push({
          id: (el.querySelector('a[href*="/explore/"]')?.getAttribute('href') || '').match(/\/explore\/([0-9a-f]+)/)?.[1] || '',
          token: '',
          title: el.querySelector('.title, [class*="title"]')?.innerText?.trim() || '',
          author: el.querySelector('.author .name, [class*="author"]')?.innerText?.trim() || '',
          likes: el.querySelector('.like-wrapper .count, [class*="like"] .count')?.innerText?.trim() || '',
          cover: el.querySelector('img')?.src || '',
        })
      }
      return out
    },
    link: (r) => `https://www.xiaohongshu.com/explore/${r.id}${r.token ? `?xsec_token=${encodeURIComponent(r.token)}&xsec_source=pc_search` : ''}`,
  },

  douyin: {
    label: '抖音',
    searchUrl: (kw) => `https://www.douyin.com/search/${encodeURIComponent(kw)}`,
    publishedAt: douyinPublishedAt,
    // 抖音搜索页持续拉流，load 事件基本不会触发；等「卡片真的出现了」而不是等页面加载完
    waitUntil: 'commit',
    ready: () => document.querySelectorAll('div[id^="waterfall_item_"]').length > 0,
    // 抖音搜索卡的 a 标签没有真实 href，aweme_id 只在容器的 id 属性上
    scrape: () => {
      const out = []
      for (const el of document.querySelectorAll('div[id^="waterfall_item_"]')) {
        const id = (el.id.match(/waterfall_item_(\d+)/) || [])[1] || ''
        const raw = el.innerText.replace(/\s+/g, ' ').trim()
        // 卡片文本形如「14:01 3.1万 标题 @作者 · 8月10日」：先去掉时长，再取紧跟其后的点赞数
        const body = raw.replace(/^\d{1,2}:\d{2}(:\d{2})?\s*/, '')
        const likes = (body.match(/^([\d.]+\s*[万千wW]?)/) || [])[1] || ''
        const title = body.replace(/^[\d.]+\s*[万千wW]?\s*/, '').split(/@[^\s]/)[0].trim()
        const author = (raw.match(/@\s*([^·@]+?)\s*·\s*[\d年月日\-:.]+$/) || [])[1]?.trim() || ''
        if (!id || !title || !likes) continue
        // 卡面左上角带时长的才是视频，没时长的是图文笔记
        out.push({ id, title: title.slice(0, 80), author, likes, format: raw === body ? 'image' : 'video', cover: el.querySelector('img')?.src || '' })
      }
      return out
    },
    link: (r) => `https://www.douyin.com/${r.format === 'image' ? 'note' : 'video'}/${r.id}`,
  },
}

const task = await taskSpace('viral-collect')
// 一个页面轮流搜各关键词：多开页面会撞风控
let page = (await task.pages()).find((p) => p.label === 'p1') || (await task.newPage())

/** 进详情页把源料搬回家：图文→逐页原图，视频→源片（带音轨），顺带读回发布正文与赞藏评（取料口径见 note-source-core.mjs）。
 *  只影响「这张卡能不能就地扒出脚本」，采不到也不拦卡片落盘。 */
const captureSource = (platform, r) =>
  captureNoteSource(page, platform, { id: r.id, link: r.link || PLATFORMS[platform].link(r), format: r.format }, `viral/${platform}/${r.id}`, {
    root: ROOT,
    maxBytes: MAX_BYTES,
  })

/** 「## 脚本」段的占位话术：有什么料说什么话；源料齐的卡由采集收尾自动出稿，占位会被覆盖 */
function scriptPlaceholder(mat) {
  if (mat.videoFile) {
    return `> 源料：视频源片 \`public/${mat.videoFile}\`${mat.muted ? '（只拿到画面轨——硬字幕 OCR 照跑，语音兜底用不了）' : '（带音轨）'}。采集收尾由本机 OCR 自动出稿，全程不花 token；没出稿时点「补采脚本」重跑。`
  }
  if (mat.sourceImages) {
    return `> 源料：逐页原图 ${mat.pages} 页 \`public/${mat.sourceImages}/\`。采集收尾由本机 Vision OCR 逐页自动识别出稿，全程不花 token；没出稿时点「补采脚本」重跑。`
  }
  return `> 现在还是空的：采集时没拿到源料${mat.error ? `（${mat.error}）` : ''}。点「补采脚本」回详情页搬源料并出稿，或去灵感库整篇搬回来（口径见 content/Knowledge/爆款拆解.md「拆的输入：完整脚本」）。`
}

/** 只补源料、不再搜索：给已经入库却没源料的老卡回填（--backfill[=N]，默认 8 张，怕撞风控） */
const BACKFILL_ARG = (process.argv.find((a) => a.startsWith('--backfill')) || '')
const BACKFILL = !!BACKFILL_ARG
const BACKFILL_N = Number(BACKFILL_ARG.split('=')[1] || 8)

/** 往已有采集卡的 frontmatter 里补写/覆盖一个字段（有 coverImage 就挂在它后面） */
function patchFrontmatter(md, kv) {
  let out = md
  for (const [k, v] of Object.entries(kv)) {
    const re = new RegExp(`^${k}:.*$`, 'm')
    out = re.test(out) ? out.replace(re, `${k}: ${v}`) : out.replace(/^(coverImage: .*)$/m, `$1\n${k}: ${v}`)
  }
  return out
}

/** 补采到源料后，「## 脚本」段的占位话术得跟着换真话，否则卡上还挂着「还没补采」 */
function patchScriptBody(md, mat) {
  const start = md.search(/^## 脚本/m)
  if (start < 0) return `${md.trimEnd()}\n\n## 脚本（拆解与创作的唯一材料）\n\n${scriptPlaceholder(mat)}\n`
  const rest = md.slice(start)
  const bodyLen = rest.indexOf('\n## ', 1)
  const tail = bodyLen < 0 ? '' : rest.slice(bodyLen)
  return `${md.slice(0, start)}## 脚本（拆解与创作的唯一材料）\n\n${scriptPlaceholder(mat)}\n${tail}`
}

/** 源料落到卡上：frontmatter 记字段 + format（源料类型是详情页读出来的，比列表页猜的准）+ 「## 脚本」段换口径 */
function writeSourceIntoCard(file, md, mat) {
  const fmPatch = mat.sourceImages
    ? { sourceImages: mat.sourceImages, format: 'image' }
    : { videoFile: mat.videoFile, format: 'video' }
  // 回填顺手把计数补齐：老卡全是 collects: ""，模板库按热度挑模板全靠这几个数
  // 收藏卡的计数写在 noteData 块里（缩进的 likes），顶层再写一份就成了两个读数
  if (!/^noteData:/m.test(md)) {
    for (const k of ['likes', 'collects', 'comments', 'durationSec']) if (mat[k]) fmPatch[k] = mat[k]
  }
  if (mat.desc) fmPatch.desc = JSON.stringify(mat.desc)
  if (mat.tags?.length) fmPatch.tags = mat.tags.map((t) => `#${t}`).join(' ')
  if (mat.timeMs) fmPatch.publishedAt = localDay(mat.timeMs)
  // 收藏卡自带的「只到索引」注释到此作废，留着会让下一个读的人以为卡上还没料
  const next = patchScriptBody(patchFrontmatter(md, fmPatch), mat).replace(/^<!-- 收藏搬运卡：[^\n]*-->\n/gm, '')
  writeFileSync(file, next)
}

async function backfillSources() {
  const fmOf = (md, k) => (md.match(new RegExp('^' + k + ':\\s*(.*)$', 'm')) || [])[1]?.trim() || ''
  let done = 0
  for (const [platform, impl] of Object.entries(PLATFORMS)) {
    const dir = join(OUT_DIR, platform)
    if (!existsSync(dir)) continue
    for (const f of readdirSync(dir).filter((n) => n.endsWith('.md'))) {
      if (done >= BACKFILL_N) break
      const file = join(dir, f)
      const md = readFileSync(file, 'utf8')
      if (fmOf(md, 'sourceImages') || fmOf(md, 'videoFile') || fmOf(md, 'videoSrc')) continue
      const id = fmOf(md, 'noteId') || basename(f, '.md')
      const r = { id, format: fmOf(md, 'format') || (/\/video\//.test(fmOf(md, 'url')) ? 'video' : 'image'), link: fmOf(md, 'url') }
      const mat = await captureSource(platform, r)
      if (mat.error) {
        console.log(`[viral:${platform}] 回填失败 ${id}：${mat.error}`)
        continue
      }
      writeSourceIntoCard(file, md, mat)
      console.log(`[viral:${platform}] 回填 ${id} → ${mat.sourceImages ? `逐页原图 ${mat.pages} 页` : `源片${mat.muted ? '（无音轨）' : ''}`}`)
      done++
    }
  }
  console.log(`[viral] 源料回填完成 ${done} 张（上限 ${BACKFILL_N}，一张约一次详情页访问）`)
}

/** 单卡补源料（工作台「补扒脚本」按钮用）：--source=<文件名.md>，末行输出 JSON 供端点判成败。
 *  爆款卡和收藏卡都走这里——新采集的卡当场已经把源料搬回，这条是给源料没搬全的老卡留的人工入口。 */
const SOURCE_ARG = (process.argv.find((a) => a.startsWith('--source=')) || '').slice(9)

async function captureSourceForCard(name) {
  // 收藏卡的 url 写在引号里（标题带冒号必须引），不去掉引号 page.goto 直接打不开
  const fmOf = (md, k) => (md.match(new RegExp('^' + k + ':\\s*(.*)$', 'm')) || [])[1]?.trim().replace(/^["']|["']$/g, '') || ''
  const out = (o) => console.log(`[viral:source] ${JSON.stringify(o)}`)
  for (const [platform, impl] of Object.entries(PLATFORMS)) {
    const file = [join(OUT_DIR, platform, name), join(FAV_DIR, impl.label, name)].find((f) => existsSync(f))
    if (!file) continue
    const md = readFileSync(file, 'utf8')
    const id = fmOf(md, 'noteId') || basename(name, '.md')
    const r = { id, format: fmOf(md, 'format') || (/\/video\//.test(fmOf(md, 'url')) ? 'video' : 'image'), link: fmOf(md, 'url') }
    const mat = await captureSource(platform, r)
    if (mat.error) return out({ ok: false, error: mat.error })
    writeSourceIntoCard(file, md, mat)
    return out({ ok: true, id, ...mat })
  }
  out({ ok: false, error: `找不到采集卡：${name}` })
}

if (SOURCE_ARG || BACKFILL) {
  if (SOURCE_ARG) await captureSourceForCard(SOURCE_ARG)
  else await backfillSources()
  await task.finish({ keep: [] })
  process.exit(0)
}

/* ---------- 人工线与自动线共用的取数段 ---------- */

/** 过了赞数门槛与时间窗的候选，按热度倒序。
 *  先过点赞门槛，再过时间窗：门槛是「算不算爆款」的定义，不能被排序绕过。 */
function qualify(impl, seen) {
  let belowLikes = 0
  let stale = 0
  let undated = 0
  const qualified = []
  for (const r of seen.values()) {
    const n = toNum(r.likes)
    if (n < MIN_LIKES) {
      belowLikes++
      continue
    }
    const publishedAt = impl.publishedAt(r.id)
    if (!publishedAt) undated++
    else if (publishedAt < CUTOFF) stale++
    // 列表页只有点赞，heat 此刻就等于赞；藏/评是详情页补进来的，那之后没人再排序
    else qualified.push({ ...r, publishedAt, n, heat: heatScore(r) })
  }
  return { qualified: qualified.sort((a, b) => b.heat - a.heat), belowLikes, stale, undated }
}

/** 一个关键词在一趟搜索页里跑完：开页 → 等结果出现 → 滚几轮 → 整页扒回来本地筛。
 *  blocked 是「结果页始终没出现」——登录掉了或被风控，跟「今天没新爆款」是两件事。 */
async function searchOneKeyword(platform, impl, kw, { scrollRounds = SCROLL_ROUNDS } = {}) {
  const seen = new Map()
  try {
    await page.goto(impl.searchUrl(kw), { waitUntil: impl.waitUntil || 'load', timeout: 30000 })
    try {
      await page.waitForFunction(impl.ready, undefined, { timeout: 25000, polling: 1000 })
    } catch {
      console.log(`[viral:${platform}] ${kw} 结果始终没出现（风控页或登录态失效），本关键词跳过`)
      return { qualified: [], blocked: true }
    }
    for (let i = 0; i < scrollRounds; i++) {
      await page.mouse.wheel(0, 4000, { label: 'load more results' })
      await page.waitForTimeout(2500)
    }
    const rows = await page.evaluate(impl.scrape)
    for (const r of rows) if (!seen.has(r.id)) seen.set(r.id, { ...r, keyword: kw })
    console.log(`[viral:${platform}] ${kw} → 全量 ${rows.length} 条候选`)
  } catch (e) {
    console.log(`[viral:${platform}] ${kw} 抓取失败：${String(e.message || e).slice(0, 80)}`)
    return { qualified: [], blocked: true }
  }
  const { qualified, belowLikes, stale, undated } = qualify(impl, seen)
  console.log(
    `[viral:${platform}] 候选 ${seen.size} → 不足 ${MIN_LIKES} 赞筛掉 ${belowLikes}、窗口外 ${stale}${undated ? `、日期解不出 ${undated}` : ''} → 达标 ${qualified.length}`,
  )
  return { qualified, blocked: false }
}

/** 一个平台把这一轮的关键词全搜完，返回过了双门槛的候选（按热度排好）。 */
async function searchCandidates(platform, impl, kws) {
  const seen = new Map()
  let blocked = 0
  for (const [ki, kw] of kws.entries()) {
    progress(platform, '搜索关键词', ki + 1, kws.length, kw)
    const r = await searchOneKeyword(platform, impl, kw)
    if (r.blocked) blocked++
    for (const q of r.qualified) if (!seen.has(q.id)) seen.set(q.id, q)
  }
  return { qualified: [...seen.values()].sort((a, b) => b.heat - a.heat), blocked }
}

/** 退卡要把已经落盘的封面与源料一起清掉，否则 public/ 里留一堆没人认领的文件 */
function dropCardFiles(platform, id) {
  for (const ext of ['jpg', 'png', 'webp']) rmSync(join(COVER_DIR, platform, `${id}.${ext}`), { force: true })
  rmSync(join(COVER_DIR, platform, id), { recursive: true, force: true })
}

/** 一条候选 → 一张采集卡：封面进 public/viral，进详情页搬源料，卡片进 content/Inbox/爆款采集。
 *  commentGate=false 给人工挑中的那几条——门槛是机器判「算不算爆款」的，人已经判过了。
 *  localCover 是搜爆款那一趟已经下好的候选封面：搜索页的 CDN 直链会过期，盘上有就别再回源。 */
async function saveViralCard(platform, impl, r, { commentGate = true, localCover = '' } = {}) {
  const file = join(OUT_DIR, platform, `${r.id}.md`)
  // 归档过的等于人工判过没用：别再采回来占列表
  if (existsSync(file) || existsSync(join(OUT_DIR, '归档', platform, `${r.id}.md`))) return { skipped: '已有' }
  mkdirSync(join(OUT_DIR, platform), { recursive: true })
  let cover = ''
  if (localCover && existsSync(join(ROOT, 'public', localCover))) {
    const ext = localCover.split('.').pop()
    mkdirSync(join(COVER_DIR, platform), { recursive: true })
    copyFileSync(join(ROOT, 'public', localCover), join(COVER_DIR, platform, `${r.id}.${ext}`))
    cover = `/viral/${platform}/${r.id}.${ext}`
  } else {
    cover = await downloadCover(r.cover, `viral/${platform}`, r.id)
  }
  // 没有封面就不落盘：工作台只认带封面的卡，存一条空壳等于给自己添噪
  if (!cover) {
    console.log(`[viral:${platform}] 跳过（封面没拿到）：${r.title}`)
    return { skipped: '封面没拿到' }
  }
  const mat = await captureSource(platform, r)
  /* 评论门槛只能在搬完源料之后判：列表页不给评论数。
     读不到评论的（详情页没渲染出来）不拦——拦了等于把「没读到」当成「不火」，整条线会静默清零。 */
  if (commentGate && MIN_COMMENTS > 0 && mat.comments && toNum(mat.comments) < MIN_COMMENTS) {
    dropCardFiles(platform, r.id)
    console.log(`[viral:${platform}] 跳过（${mat.comments} 评论，不到 ${MIN_COMMENTS}）：${r.title}`)
    return { skipped: '评论不足' }
  }
  // format 以搬回来的源料为准：列表页的 modelType 会把视频笔记报成图文
  const format = mat.videoFile ? 'video' : mat.sourceImages ? 'image' : r.format || 'image'
  // 发布时间详情页给的是准确时刻，比从笔记 id 反推的可信；没读到才沿用 id 那一版
  const publishedAt = mat.timeMs ? localDay(mat.timeMs) : r.publishedAt
  const fmLines = [
    `noteId: ${r.id}`,
    `platform: ${platform}`,
    `format: ${format}`,
    `title: ${r.title}`,
    mat.desc ? `desc: ${JSON.stringify(mat.desc)}` : '',
    mat.tags?.length ? `tags: ${mat.tags.map((t) => `#${t}`).join(' ')}` : '',
    `author: ${r.author}`,
    `likes: ${mat.likes || r.likes}`,
    mat.collects ? `collects: ${mat.collects}` : '',
    mat.comments ? `comments: ${mat.comments}` : '',
    mat.durationSec ? `durationSec: ${mat.durationSec}` : '',
    `coverImage: ${cover}`,
    mat.sourceImages ? `sourceImages: ${mat.sourceImages}` : '',
    mat.videoFile ? `videoFile: ${mat.videoFile}` : '',
    `url: ${r.link || impl.link(r)}`,
    `keyword: ${r.keyword}`,
    `publishedAt: ${publishedAt}`,
    `capturedAt: ${TODAY}`,
    `source: viral`,
  ].filter(Boolean)
  writeFileSync(file, `---
${fmLines.join('\n')}
---

# ${r.title}

> ${impl.label}爆款卡片 · 采集于 ${TODAY} · 发布于 ${publishedAt} · ${mat.likes || r.likes} 赞${mat.collects ? ` · ${mat.collects} 藏` : ''}${mat.comments ? ` · ${mat.comments} 评` : ''} · 关键词「${r.keyword}」

## 脚本（拆解与创作的唯一材料，缺它不许拆、不许写）

${scriptPlaceholder(mat)}
`)
  console.log(
    `[viral:${platform}] ${mat.sourceImages ? `源图 ${mat.sourceImages}（${mat.pages} 页）` : mat.videoFile ? `源片 ${mat.videoFile}${mat.muted ? '（无音轨）' : ''}` : `没拿到源料：${mat.error}`}`,
  )
  return { saved: true, mat }
}

/** 采集即出稿：源料已搬回 public/，收尾当场本机 OCR/转写把「## 脚本」扒出来，
 *  不再等人在工作台点「补采脚本」。子进程必须用宿主 Node（run-ego 注入 MEDIA_HUB_NODE；
 *  process.execPath 是 ego 私有运行时，跑不了脚本），失败不拦落卡。 */
async function ocrPending() {
  try {
    // 转写阶段由子进程自己续报进度（逐卡一条），这里先占一行让界面立刻知道浏览器已经收工
    progress('', '本机转写', 0, 0, 'OCR 与语音转写，不再动浏览器')
    const { stdout } = await run(process.env.MEDIA_HUB_NODE || 'node', ['scripts/capture-script.mjs', '--pending'], { cwd: ROOT, timeout: 50 * 60_000, maxBuffer: 8 * 1024 * 1024 })
    console.log(stdout.trimEnd())
  } catch (e) {
    console.log(`[viral] 自动补扒脚本没跑成（${String(e?.message || e).slice(0, 120)}）——卡片已入库，可在工作台点「补采脚本」`)
  }
}

/* ---------- 人工线：界面「搜爆款」弹层 ----------
 *  搜索与入库分成两趟浏览器，中间那一次判断归人：--search 只把达标候选连封面写进候选池，
 *  --capture 读回那份池子，只搬人勾中的那几条。 */
/** 既可能是脚本参数里的独立两项（run-ego 的 --args 传法），也可能写成 --flag=… */
const argValue = (flag) => {
  const i = process.argv.indexOf(flag)
  if (i >= 0 && process.argv[i + 1]) return String(process.argv[i + 1])
  return (process.argv.find((a) => a.startsWith(`${flag}=`)) || '').slice(flag.length + 1)
}
const SEARCH_ARG = argValue('--search')
const CAPTURE_ARG = argValue('--capture')
/** 候选池每个平台最多摆几条：人要的是翻得过来的那一屏，前几条够了就别再翻后面的词 */
const SEARCH_SHOW = cfg.searchLimit ?? 5
/** 人工线只等得起一轮滚动：三轮是给自动线把候选池做大的 */
const SEARCH_SCROLL_ROUNDS = cfg.searchScrollRounds ?? 1

/** --search 的参数是「平台:词,词」。平台必须点名：一次只搜一个平台才快得起来，
 *  两个平台各搜一轮等于把等待时间摊成两倍。没带前缀是命令行手跑，退回配置里的平台。 */
function parseSearchArg(s) {
  const list = (t) => t.split(/[,，]/).map((x) => x.trim()).filter(Boolean)
  const all = Object.keys(PLATFORMS).filter((p) => (cfg.platforms || Object.keys(PLATFORMS)).includes(p))
  const i = s.indexOf(':')
  if (i < 0) return { plats: all, kws: list(s) }
  const plats = list(s.slice(0, i)).filter((p) => PLATFORMS[p])
  return { plats: plats.length ? plats : all, kws: list(s.slice(i + 1)) }
}

if (SEARCH_ARG) {
  const { plats, kws } = parseSearchArg(SEARCH_ARG)
  plan(plats)
  /** 每个平台各自攒到达标的候选（热度序）；池子每搜完一个词就重写一次，界面是实时读它的 */
  const accByPlat = new Map()
  const coverOf = new Map()
  const poolRows = () => {
    const rows = []
    for (const [platform, list] of accByPlat) {
      const impl = PLATFORMS[platform]
      for (const r of list.slice(0, SEARCH_SHOW)) {
        rows.push({
          platform,
          id: r.id,
          title: r.title,
          author: r.author,
          likes: r.likes,
          format: r.format,
          url: impl.link(r),
          coverUrl: r.cover,
          cover: coverOf.get(`${platform}/${r.id}`) || '',
          keyword: r.keyword,
          publishedAt: r.publishedAt,
          heat: r.heat,
          already: existsSync(join(OUT_DIR, platform, `${r.id}.md`)) || existsSync(join(OUT_DIR, '归档', platform, `${r.id}.md`)),
        })
      }
    }
    return rows.sort((a, b) => b.heat - a.heat)
  }
  /** 每轮都重写池子：新进来的那几条要先有封面，界面摆出去才不会是一排空图 */
  async function flush() {
    for (const [platform, list] of accByPlat) {
      for (const r of list.slice(0, SEARCH_SHOW)) {
        const key = `${platform}/${r.id}`
        if (!coverOf.has(key)) coverOf.set(key, await downloadCover(r.cover, `viral-search/${platform}`, r.id))
      }
    }
    writeSearchJson({
      at: new Date().toISOString(),
      keywords: kws,
      platforms: plats,
      minLikes: MIN_LIKES,
      withinDays: WITHIN_DAYS,
      rows: poolRows(),
    })
  }

  let blockedAll = true
  for (const platform of plats) {
    if (stopRequested()) break
    const impl = PLATFORMS[platform]
    const acc = accByPlat.get(platform) || []
    accByPlat.set(platform, acc)
    let blocked = 0
    for (const [ki, kw] of kws.entries()) {
      if (stopRequested()) break
      progress(platform, '搜索关键词', ki + 1, kws.length, kw)
      const r = await searchOneKeyword(platform, impl, kw, { scrollRounds: SEARCH_SCROLL_ROUNDS })
      if (r.blocked) {
        blocked++
        continue
      }
      blockedAll = false
      for (const q of r.qualified) if (!acc.some((x) => x.id === q.id)) acc.push(q)
      acc.sort((a, b) => b.heat - a.heat)
      await flush()
      // 前几条已经到手，后面的词再搜也只是把同一屏换成人翻不动的长列表
      if (acc.length >= SEARCH_SHOW) break
    }
    // 留痕不报条数：这一趟只搜不入库，报数会被采集成线读成「采到了」
    step(platform, blocked === kws.length && !acc.length ? 'error' : 'ok', {
      note: blocked === kws.length && !acc.length ? `${blocked} 个关键词的结果始终没出现（登录态失效或被风控）` : '',
    })
  }
  const rows = poolRows()
  console.log(`[viral:search] ${kws.join('、')} → 达标候选 ${rows.length} 条（门槛 ${MIN_LIKES} 赞 / 近 ${WITHIN_DAYS} 天）`)
  if (blockedAll && !rows.length) {
    console.log(`${plats.map((p) => PLATFORMS[p].label).join('、')}的结果始终没出现（登录态失效或被风控）`)
    process.exitCode = 2
  }
  // 人按了停在下一个边界退 3；风控那笔（2）更要紧，不被盖掉
  if (stopRequested() && process.exitCode !== 2) process.exitCode = 3
  await task.finish({ keep: [] })
  process.exit(process.exitCode || 0)
}

if (CAPTURE_ARG) {
  const pool = readSearchJson()
  const ids = CAPTURE_ARG.split(',').map((s) => s.trim()).filter(Boolean)
  const chosen = ids.map((id) => (pool?.rows || []).find((r) => r.id === id)).filter(Boolean)
  if (!chosen.length) {
    console.log('界面上挑的那几条不在候选池里了，重新搜一轮再收')
    process.exitCode = 1
    await task.finish({ keep: [] })
    process.exit(process.exitCode || 0)
  }
  let saved = 0
  for (const [i, row] of chosen.entries()) {
    if (stopRequested()) break
    progress('', '搬源料', i + 1, chosen.length, row.title)
    const out = await saveViralCard(row.platform, PLATFORMS[row.platform], { ...row, cover: row.coverUrl, link: row.url }, { commentGate: false, localCover: row.cover })
    if (out.saved) saved++
    // 挑中的在池子里标成已收：界面回来接着挑同一批时，不该再让人勾第二遍
    row.captured = true
  }
  if (pool) writeSearchJson(pool)
  console.log(`[viral:capture] 挑中 ${chosen.length} 条 → 新入库 ${saved} 条`)
  if (stopRequested() && process.exitCode !== 2) process.exitCode = 3
  await ocrPending()
  await task.finish({ keep: [] })
  process.exit(process.exitCode || 0)
}

const report = []
const kws = cfg.keywords || []
plan(Object.keys(PLATFORMS).filter((p) => (cfg.platforms || Object.keys(PLATFORMS)).includes(p)))
let blockedAny = false
for (const [platform, impl] of Object.entries(PLATFORMS)) {
  if (!(cfg.platforms || Object.keys(PLATFORMS)).includes(platform)) continue
  // 「重采这两个」带 --only：不该跑的平台一个页面都不进
  if (skipUnlessWanted(platform)) continue
  if (stopRequested()) break

  const { qualified, blocked } = await searchCandidates(platform, impl, kws)
  const picked = qualified.slice(0, PER_PLATFORM)
  let saved = 0
  let dropped = 0
  for (const [ri, r] of picked.entries()) {
    // 一条源料要进详情页搬图/拉片，是本轮最慢的一段，不报数就成了黑盒
    progress(platform, '搬源料', ri + 1, picked.length, r.title)
    const out = await saveViralCard(platform, impl, r)
    if (out.saved) {
      saved++
      console.log(`  · ${r.likes} 赞 | ${r.publishedAt} | ${r.title.slice(0, 30)} （${r.keyword}）`)
    } else if (out.skipped !== '已有') dropped++
  }
  console.log(`[viral:${platform}] 达标 ${qualified.length} → 取 Top ${picked.length} → 新入库 ${saved}${dropped ? `、退掉 ${dropped}` : ''}`)
  report.push({ platform, qualified: qualified.length, saved })
  // 全部关键词都「结果始终没出现」= 这个平台本轮根本没进去，跟「今天没新爆款」是两件事
  blockedAny = blockedAny || (blocked > 0 && !qualified.length)
  step(platform, blocked > 0 && !qualified.length ? 'error' : 'ok', {
    note: blocked > 0 && !qualified.length ? `${blocked} 个关键词的结果始终没出现（登录态失效或被风控）` : '',
    count: saved,
  })
}

if (!report.some((r) => r.saved || r.qualified)) {
  console.log(`[viral] 本轮没有任何平台采到达标内容（门槛 ${MIN_LIKES} 赞${MIN_COMMENTS ? ` + ${MIN_COMMENTS} 评论` : ''} / 近 ${WITHIN_DAYS} 天）。若持续为 0，考虑放宽窗口而非门槛。`)
}
// 有平台整轮没进去就报 2：以前这里也 exit 0，界面上只能显示「成功 0 条」，把登录掉了说成没爆款
if (blockedAny) process.exitCode = 2
if (stopRequested() && !blockedAny) process.exitCode = 3

await ocrPending()
await task.finish({ keep: [] })
