/**
 * 收藏搬运：把抖音/小红书「我的收藏」里指定专辑（抖音叫收藏夹）的内容搬回灵感库。
 *
 * 只搬 config/favorites.json 名单内的专辑——收藏整表大半是当时随手存的，专辑才是主动归过类的灵感。
 * 落 content/Inbox/采集笔记/收藏/<平台>/<笔记id>.md。
 * 一条专辑里的内容要搬全：封面、逐页源图或源片、发布正文、话题、发布时间、赞藏评——
 * 搬回来就是为了让这条能直接拆、直接写，留一张只有标题的索引卡等于没搬。
 * 收尾当场叫本机 OCR/转写把「## 脚本」扒出来（零 token），不再等人工点「补采脚本」。
 * 自己的笔记不搬（那是作品不是灵感），已入库的笔记不搬第二次，所以再跑一次就是增量。
 *
 * 运行：npm run favorites（需先在 Ego Lite 里登录两个平台）
 *
 * 取数策略：签名接口直接调会 406/403，一律靠页面自己去发。
 *   小红书  专辑这一层钩不到接口，清单和内容都整页 SSR 在 window.__INITIAL_STATE__.board 里：
 *            清单 userBoardList（?tab=fav&subTab=board）、内容 boardFeedsMap[<专辑id>].notes（/board/<id>）
 *   抖音    收藏夹清单 /aweme/v1/web/collects/list/（钩子读响应）
 *            收藏夹内容 /aweme/v1/web/collects/video/list/?collects_id=<id>（点进那个收藏夹才发，按 id 认响应）
 *   详情页  源料与正文的取法与爆款采集同一条，见 scripts/note-source-core.mjs
 */
const fs = await import('node:fs/promises')
const { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } = await import('node:fs')
const { join, basename } = await import('node:path')
const { execFile } = await import('node:child_process')
const { promisify } = await import('node:util')

const run = promisify(execFile)
const ROOT = process.env.MEDIA_HUB_ROOT || process.cwd()
// 结构化进度与停止信号（一行 JSON 走 stdout；停止只在平台之间自取）
const { step, progress, plan, stopRequested, skipUnlessWanted } = await import(`file://${ROOT}/scripts/sync-step.mjs`)
const { localDay } = await import(`file://${ROOT}/scripts/day-core.mjs`)
const { cleanAlbums } = await import(`file://${ROOT}/scripts/favorites-config-core.mjs`)
const { captureNoteSource } = await import(`file://${ROOT}/scripts/note-source-core.mjs`)
const { notePublishedAt, douyinPublishedAt } = await import(`file://${ROOT}/scripts/collect-note-core.mjs`)
const cfg = JSON.parse(readFileSync(join(ROOT, 'config/favorites.json'), 'utf8'))
const OUT_DIR = join(ROOT, 'content/Inbox/采集笔记/收藏')
// 搬运卡的采集日期与 collect-runs 的落盘判据同一把尺（本机日历日）
const TODAY = localDay()
const MAX_SCROLL = cfg.maxScrollRounds ?? 30
const ALBUMS = cleanAlbums(cfg.albums)

/** accounts.json 里登记的号主昵称——收藏里自己的笔记占大头（实测小红书 66 条里 39 条、抖音 51 条里 43 条） */
const SELF = new Set(
  JSON.parse(readFileSync(join(ROOT, 'config/accounts.json'), 'utf8'))
    .map((a) => a.nickname)
    .filter(Boolean),
)

/** 全站已有卡片的笔记 id：手动采集、爆款采集、收藏三处共用一条笔记只留一张卡 */
function existingNoteIds() {
  const ids = new Set()
  const scan = (dir) => {
    if (!existsSync(dir)) return
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      if (e.isDirectory()) scan(p)
      else if (e.name.endsWith('.md')) {
        ids.add(basename(e.name, '.md'))
        for (const m of readFileSync(p, 'utf8').matchAll(/\/(?:explore|note|video|item)\/([0-9a-f]{16,}|\d{15,})/g)) ids.add(m[1])
      }
    }
  }
  scan(join(ROOT, 'content/Inbox/采集笔记'))
  scan(join(ROOT, 'content/Inbox/爆款采集'))
  return ids
}

const y = (v) => JSON.stringify(String(v ?? ''))

/** 名单里哪些专辑在这批清单里存在（按名字原样匹配），返回「要搬的」和「平台上有但没配的」 */
function matchAlbums(items) {
  const hit = items.filter((it) => ALBUMS.includes(it.name))
  const missing = ALBUMS.filter((n) => !items.some((it) => it.name === n))
  return { hit, missing, all: items.map((it) => it.name) }
}

/** 封面落 public/inspiration/，扩展名按文件头认：CDN 的 content-type 会说谎，webp 报成 jpeg */
async function saveCover(url, id, referer) {
  if (!url) return ''
  try {
    const res = await fetch(url.replace(/^http:/, 'https:'), { headers: { 'User-Agent': 'Mozilla/5.0', Referer: referer } })
    if (!res.ok) return ''
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length < 500) return ''
    const ext = buf.slice(0, 4).toString('ascii') === 'RIFF' ? 'webp' : buf[0] === 0x89 ? 'png' : 'jpg'
    mkdirSync(join(ROOT, 'public/inspiration'), { recursive: true })
    await fs.writeFile(join(ROOT, 'public/inspiration', `fav-${id}.${ext}`), buf)
    return `/inspiration/fav-${id}.${ext}`
  } catch {
    return ''
  }
}

function cardMd(r, platform, mat = {}) {
  const title = `${mat.title || r.title}`.replace(/\s+/g, ' ').trim().slice(0, 80) || r.title
  const likes = mat.likes || r.likes || ''
  const collects = mat.collects || r.collects || ''
  // 正文与话题：详情页与专辑列表各有一份，谁给得多用谁——抖音的 h1 是折叠过的只露前两百字，整段正文只有列表接口有
  const pickLonger = (a, b) => (String(a || '').length >= String(b || '').length ? a || '' : b || '')
  const desc = pickLonger(mat.desc, r.desc).replace(/\s+/g, ' ').trim()
  const tagList = (mat.tags || []).length >= (r.tags || []).length ? mat.tags || [] : r.tags || []
  const tags = tagList.map((t) => `#${t}`)
  // 发布时间详情页给的是准确时刻；没读到才用列表那一份（从笔记 id 反推）
  const publishedAt = mat.timeMs ? localDay(mat.timeMs) : r.publishedAt || ''
  // format 以搬回来的源料为准：专辑列表那一份会把视频笔记报成图文
  const format = mat.videoFile ? 'video' : mat.sourceImages ? 'image' : r.format
  const fm = [
    `noteId: ${r.id}`,
    `platform: ${platform}`,
    `format: ${format}`,
    `title: ${y(title)}`,
    desc ? `desc: ${y(desc)}` : '',
    tags.length ? `tags: ${tags.join(' ')}` : '',
    `author: ${y(r.author)}`,
    'source: favorite',
    `album: ${y(r.album)}`,
    `url: ${y(r.link)}`,
    `collected: ${TODAY}`,
    // 专辑内的序号（0 = 专辑里第一条）。列表本身按收藏时间倒序发，所以这个号就是「哪天收藏的」的可靠代理
    `favOrder: ${r.rank}`,
    publishedAt ? `publishedAt: ${publishedAt}` : '',
    Number(mat.durationSec) > 0 ? `durationSec: ${Math.round(Number(mat.durationSec))}` : '',
    r.cover ? `coverImage: ${r.cover}` : '',
    mat.sourceImages ? `sourceImages: ${mat.sourceImages}` : '',
    mat.videoFile ? `videoFile: ${mat.videoFile}` : '',
    'noteData:',
    `  likes: ${y(likes)}`,
    `  collects: ${y(collects)}`,
    `  comments: ${y(mat.comments || r.comments || '')}`,
  ].filter(Boolean)
  return `---
${fm.join('\n')}
---

# ${title}

> ${platform}收藏 · 专辑「${r.album}」· 搬回于 ${TODAY} · @${r.author}${likes ? ` · ${likes} 赞` : ''}
> 原帖：${r.link}

${mat.sourceImages
    ? `## 脚本（拆解与创作的唯一材料）\n\n> 源料：逐页原图 ${mat.pages} 页 \`public/${mat.sourceImages}/\`，采集收尾由本机 Vision OCR 逐页出稿。\n`
    : mat.videoFile
      ? `## 脚本（拆解与创作的唯一材料）\n\n> 源料：视频源片 \`public/${mat.videoFile}\`${mat.muted ? '（只拿到画面轨）' : '（带音轨）'}，采集收尾由本机 OCR 出稿。\n`
      : ''}
`
}

/* ==================== 取数 ==================== */

/** 只改 frontmatter 的 favOrder 一行，其余一个字都不动——卡上可能已有人工写的「为什么值得参考」 */
function restampOrder(file, rank) {
  const md = readFileSync(file, 'utf8')
  const next = /^favOrder:.*$/m.test(md)
    ? md.replace(/^favOrder:.*$/m, `favOrder: ${rank}`)
    : md.replace(/^(collected: .*[^\n]*)$/m, `$1\nfavOrder: ${rank}`)
  if (next !== md) writeFileSync(file, next)
}

const HOOK = `(() => {
  if (window.__favHooked) return
  window.__favHooked = 1
  window.__api = []
  const push = (u, resp) => {
    try {
      if (typeof resp !== 'string' || resp.charCodeAt(0) !== 123) return
      window.__api.push({ url: String(u), body: resp })
    } catch (e) {}
  }
  const oF = window.fetch
  window.fetch = async function (i) {
    const u = typeof i === 'string' ? i : i && i.url
    const r = await oF.apply(this, arguments)
    try { const c = r.clone(); c.text().then((t) => push(u, t)) } catch (e) {}
    return r
  }
  const oX = XMLHttpRequest.prototype.open
  const oS = XMLHttpRequest.prototype.send
  XMLHttpRequest.prototype.open = function (m, u) { this.__u = u; return oX.apply(this, arguments) }
  XMLHttpRequest.prototype.send = function () {
    this.addEventListener('load', () => { try { push(this.__u, this.responseText) } catch (e) {} })
    return oS.apply(this, arguments)
  }
})()`

/** 上次 finish 会把空间交还成 ownership:"user"，这种空间 taskSpace(同名) 在 ego 启动阶段就被挡（catch 不到），
 *  所以只要同名空间已存在一律认领回来，只有首次才按名新建。 */
async function openSpace(name) {
  const hit = (await listTaskSpaces()).find((s) => s.name === name)
  if (!hit) return await taskSpace(name)
  console.log(`[fav] 认领已存在的空间「${name}」(id ${hit.id}, ownership ${hit.ownership})`)
  try {
    return await claimTaskSpace(hit.id)
  } catch {
    return await takeOverTaskSpace(hit.id)
  }
}
const task = await openSpace('favorites-collect')
const page = (await task.pages()).find((p) => p.label === 'p1') || (await task.newPage())
await page.cdp('Page.addScriptToEvaluateOnNewDocument', { source: HOOK })

/** 读钩子攒下的列表响应（正则按字符串传进页面，闭包带不过去） */
const readResponses = (pattern) =>
  page.evaluate(
    (src) => {
      const re = new RegExp(src)
      const out = []
      for (const a of window.__api || []) {
        if (!re.test(a.url)) continue
        try {
          out.push(JSON.parse(a.body))
        } catch (e) {}
      }
      return out
    },
    pattern.source,
  )

/** 滚到底：连续 3 轮不再冒新条目就收，或滚满 MAX_SCROLL 轮。
 *  停止条件不看接口的 has_more——只看最后一条响应，页面还没发出下一页请求时就会提前收手（实测抖音因此只拿到第一页 30 条，整表是 51 条）。
 *  responded 认「接口有没有回过话」——没回话和「回了但列表是空的」是两件事，混成一个 0 条会让界面把掉登录报成「已同步」。 */
async function drain(pattern, listOf, idOf, label) {
  const seen = new Map()
  let responded = false
  let prev = 0
  let stalled = 0
  // 滚轮打在鼠标当前位置：落在左侧导航栏上就白滚（实测抖音只翻出第一页 30 条），先把指针移到列表区
  const spot = await page.evaluate(() => ({ x: Math.round(innerWidth * 0.6), y: Math.round(innerHeight * 0.7) }))
  await page.mouse.move(spot.x, spot.y, { label: `hover ${label} list` })
  for (let i = 0; i < MAX_SCROLL; i++) {
    await page.mouse.wheel(0, 8000, { label: `load more ${label}` })
    await page.waitForTimeout(2000)
    for (const j of await readResponses(pattern)) {
      responded = true
      for (const it of listOf(j)) {
        const id = idOf(it)
        if (id && !seen.has(id)) seen.set(id, it)
      }
    }
    if (seen.size === prev) {
      if (++stalled >= 3) break
    } else {
      stalled = 0
      prev = seen.size
    }
  }
  return { items: [...seen.values()], responded }
}

/** 专辑清单也不走接口：直达 ?tab=fav&subTab=board 时整页 SSR 在 __INITIAL_STATE__.board.userBoardList */
const readBoards = () =>
  page.evaluate(() => {
    const u = (o) => (o && typeof o === 'object' && ('_rawValue' in o || '_value' in o) ? u(o._rawValue !== undefined ? o._rawValue : o._value) : o)
    const st = window.__INITIAL_STATE__
    if (!st || !st.board) return null
    const list = u(u(st.board).userBoardList)
    return Array.isArray(list) ? list.map((b) => ({ name: b.name, id: b.id })) : null
  })

/** 专辑页的笔记同样整页 SSR，滚一轮读一轮——翻页时这份 store 会自己变长 */
async function readBoardNotes(boardId) {
  const seen = new Map()
  let prev = 0
  let stalled = 0
  const read = () =>
    page.evaluate(
      (id) => {
        const u = (o) => (o && typeof o === 'object' && ('_rawValue' in o || '_value' in o) ? u(o._rawValue !== undefined ? o._rawValue : o._value) : o)
        const st = window.__INITIAL_STATE__
        if (!st) return []
        const map = u(st.board && st.board.boardFeedsMap) || {}
        const v = u(map[id])
        return v && Array.isArray(v.notes) ? v.notes : []
      },
      boardId,
    )
  const spot = await page.evaluate(() => ({ x: Math.round(innerWidth * 0.6), y: Math.round(innerHeight * 0.7) }))
  await page.mouse.move(spot.x, spot.y, { label: 'hover xhs board list' })
  for (let i = 0; i < MAX_SCROLL; i++) {
    for (const n of await read()) if (n.noteId && !seen.has(n.noteId)) seen.set(n.noteId, n)
    if (seen.size === prev) {
      if (++stalled >= 2) break
    } else {
      stalled = 0
      prev = seen.size
    }
    await page.mouse.wheel(0, 8000, { label: 'load more xhs board' })
    await page.waitForTimeout(1500)
  }
  return [...seen.values()]
}

const xhsRow = (n, album) => ({
  id: n.noteId,
  title: (n.displayTitle || '').trim() || '（无标题）',
  author: n.user?.nickName || '',
  likes: n.interactInfo?.likedCount ?? '',
  collects: n.interactInfo?.collectedCount ?? '',
  format: n.type === 'video' ? 'video' : 'image',
  publishedAt: notePublishedAt(n.noteId),
  coverUrl: n.cover?.urlDefault || n.cover?.urlPre || n.cover?.infoList?.[1]?.url || n.cover?.infoList?.[0]?.url || '',
  // xsec_token 是小红书开门的钥匙，详情页没它直接 404，必须跟着链接存进卡
  link: `https://www.xiaohongshu.com/explore/${n.noteId}${n.xsecToken ? `?xsec_token=${encodeURIComponent(n.xsecToken)}&xsec_source=pc_user` : ''}`,
  album,
})

const dyRow = (v, album) => {
  const isImage = (v.images || []).length > 0
  // 列表接口的计数会吐粘连长数（实测收藏位 785614651151427），过亿的不算读数，留给详情页那一份
  const count = (n) => (Number(String(n ?? '').replace(/[^\d.]/g, '')) > 1e8 ? '' : n ?? '')
  // 抖音没有独立标题，正文第一句就是作者自己写的标题（这条是「一个人就能开公司」），别把整段正文当标题搬回
  const head = (v.desc || '').trim().split(/[\s。！!？?；;]+/)[0] || ''
  // 话题在抖音有两种给法：接口给的 textExtra，和直接写在正文里的 #xxx——后一种更常见，两个都收
  const tags = [
    ...(v.textExtra || []).map((t) => t?.hashtag_name || '').filter(Boolean),
    ...[...new Set((v.desc || '').match(/#[^\s#]+/g) || [])].map((s) => s.slice(1)),
  ]
  return {
    id: v.aweme_id,
    title: (head.length >= 4 ? head : (v.desc || '').replace(/\s+/g, ' ').trim().slice(0, 40)) || '（无标题）',
    desc: (v.desc || '').replace(/\s+/g, ' ').trim(),
    tags: [...new Set(tags)],
    author: v.author?.nickname || '',
    likes: count(v.statistics?.digg_count),
    collects: count(v.statistics?.collect_count),
    comments: count(v.statistics?.comment_count),
    format: isImage ? 'image' : 'video',
    publishedAt: douyinPublishedAt(v.aweme_id),
    coverUrl: isImage ? v.images[0]?.url_list?.[0] || '' : v.video?.cover?.url_list?.[0] || '',
    link: `https://www.douyin.com/${isImage ? 'note' : 'video'}/${v.aweme_id}`,
    album,
  }
}

const PLATFORMS = {
  xiaohongshu: {
    label: '小红书',
    referer: 'https://www.xiaohongshu.com/',
    async collect() {
      await page.goto(`https://www.xiaohongshu.com/user/profile/${cfg.xiaohongshuUserId}?tab=fav&subTab=board`, { waitUntil: 'commit' })
      await page.waitForFunction(() => !!(window.__INITIAL_STATE__ && window.__INITIAL_STATE__.board), undefined, { timeout: 25000 })
      const boards = await readBoards()
      if (!boards) throw new Error('专辑清单没读回（登录态失效或被风控）')
      const { hit, missing, all } = matchAlbums(boards)
      if (!hit.length) throw new Error(`名单里的专辑（${ALBUMS.join('、')}）在小红书上都没有，专辑页上有的是：${all.join('、') || '一个也没有'}`)
      const rows = []
      for (const b of hit) {
        await page.goto(`https://www.xiaohongshu.com/board/${b.id}?source=web_user_page`, { waitUntil: 'commit' })
        await page.waitForFunction((id) => {
          const u = (o) => (o && typeof o === 'object' && ('_rawValue' in o || '_value' in o) ? u(o._rawValue !== undefined ? o._rawValue : o._value) : o)
          const st = window.__INITIAL_STATE__
          if (!st) return false
          const map = u(st.board && st.board.boardFeedsMap) || {}
          const v = u(map[id])
          return !!(v && Array.isArray(v.notes))
        }, b.id, { timeout: 25000 })
        rows.push(...(await readBoardNotes(b.id)).map((n) => xhsRow(n, b.name)))
      }
      return { rows, missing }
    },
  },

  douyin: {
    label: '抖音',
    referer: 'https://www.douyin.com/',
    async collect() {
      await page.goto('https://www.douyin.com/user/self?showSubTab=favorite_folder&showTab=favorite_collection', { waitUntil: 'commit' })
      await page.waitForFunction(() => (window.__api || []).some((a) => /collects\/list/.test(a.url)), undefined, { timeout: 30000 })
      const { items: folders, responded } = await drain(/collects\/list/, (j) => j.collects_list || [], (c) => c.collects_id_str, 'dy folders')
      // 没登录时这个接口根本不会发（主页停在登录墙上），一条都不回才算失败；真收藏空了它照样是 0 条
      if (!responded) throw new Error('收藏夹清单接口一次都没回应')
      const { hit, missing } = matchAlbums(folders.map((c) => ({ name: c.collects_name, id: c.collects_id_str })))
      if (!hit.length) throw new Error(`名单里的收藏夹（${ALBUMS.join('、')}）在抖音上都没有，收藏夹页上有的是：${folders.map((c) => c.collects_name).join('、') || '一个也没有'}`)
      const rows = []
      for (const f of hit) {
        // 点进这个收藏夹，右栏才会为它发 collects/video/list；左列那一项是纯文本，按名字找到它的中心坐标真点
        const spot = await page.evaluate((nm) => {
          const leaf = [...document.querySelectorAll('p,span,div')].filter((e) => !e.children.length && (e.textContent || '').trim() === nm)
          if (!leaf.length) return null
          leaf[0].scrollIntoView({ block: 'center' })
          const r = leaf[0].getBoundingClientRect()
          return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
        }, f.name)
        if (spot) await page.mouse.click(spot.x, spot.y, { label: `open dy folder ${f.name}` })
        await page.waitForTimeout(2500)
        const { items } = await drain(new RegExp(`collects/video/list.*collects_id=${f.id}&`), (j) => j.aweme_list || [], (v) => v.aweme_id, `dy ${f.name}`)
        rows.push(...items.map((v) => dyRow(v, f.name)))
      }
      return { rows, missing }
    },
  },
}

/* ==================== 主流程 ==================== */

const known = existingNoteIds()
const report = []
plan((cfg.platforms || Object.keys(PLATFORMS)).filter((k) => PLATFORMS[k]))
let failed = 0
for (const key of cfg.platforms || Object.keys(PLATFORMS)) {
  const impl = PLATFORMS[key]
  if (!impl) continue
  if (skipUnlessWanted(key)) continue
  if (stopRequested()) break
  let rows
  let missing
  progress(key, '翻专辑')
  try {
    ;({ rows, missing } = await impl.collect())
  } catch (e) {
    failed++
    step(key, 'error', { note: String(e.message || e).slice(0, 160) })
    console.log(`[fav:${impl.label}] ${String(e.message || e).slice(0, 200)}`)
    continue
  }

  let mine = 0
  let dup = 0
  let noCover = 0
  let noSource = 0
  const saved = []
  // 序号按整张列表的位置给（列表本身按收藏时间倒序），滤掉自己的和已入库的会把它打乱
  rows.forEach((r, i) => (r.rank = i))
  for (const r of rows) {
    if (SELF.has(r.author)) {
      mine++
      continue
    }
    if (known.has(r.id)) {
      dup++
      // 老卡也要重刷序号：只有新卡会写 favOrder，不补的话它永远停在入库那天的位置
      const existed = join(OUT_DIR, impl.label, `${r.id}.md`)
      if (existsSync(existed)) restampOrder(existed, r.rank)
      continue
    }
    // 一条要下载封面 + 进详情页搬源图/拉片，是这段最慢的地方，按列表原序号报进度，滤掉的不占号
    progress(key, '搬源料', r.rank + 1, rows.length, r.title)
    r.cover = await saveCover(r.coverUrl, r.id, impl.referer)
    if (!r.cover) {
      noCover++
      continue
    }
    const mat = await captureNoteSource(page, key, { id: r.id, link: r.link, format: r.format }, `inspiration/fav-${r.id}`, { root: ROOT })
    if (mat.error) noSource++
    mkdirSync(join(OUT_DIR, impl.label), { recursive: true })
    const file = join(OUT_DIR, impl.label, `${r.id}.md`)
    await fs.writeFile(file, cardMd(r, impl.label, mat))
    known.add(r.id)
    // 详情页没读到标题时（抖音就没有独立标题），别让空串把列表那一份的标题盖掉
    saved.push({ ...r, ...mat, title: mat.title || r.title })
  }
  const albumLine = [...new Set(rows.map((r) => r.album))].map((n) => `${n} ${rows.filter((r) => r.album === n).length}`).join('、')
  console.log(
    `[fav:${impl.label}] 专辑「${albumLine || '空'}」→ 自己的 ${mine}、已入库 ${dup}${noCover ? `、没拿到封面 ${noCover}` : ''}${noSource ? `、源料没搬回 ${noSource}` : ''} → 新入库 ${saved.length} 条`,
  )
  for (const r of saved) {
    const src = r.sourceImages ? `源图 ${r.pages} 页` : r.videoFile ? `源片${r.muted ? '（无音轨）' : ''}` : `无源料（${r.error}）`
    console.log(`  · ${r.likes ? `${r.likes} 赞 | ` : ''}@${r.author} | ${src} | ${r.title.slice(0, 30)}`)
  }
  report.push({ platform: impl.label, total: rows.length, saved: saved.length })
  step(key, 'ok', { count: saved.length, ...(missing.length ? { note: `名单里的「${missing.join('、')}」这个平台没有` } : {}) })
}

if (!report.length) console.log('[fav] 两个平台都没取到数据，本轮没有新内容入库。')

/* 采集即出稿：源料已落 public/，收尾当场本机 OCR/转写把卡里的「## 脚本」扒出来，不留人工尾巴。
 * 子进程必须用宿主 Node（run-ego 注入 MEDIA_HUB_NODE；process.execPath 是 ego 私有运行时，跑不了脚本）。 */
if (report.some((r) => r.saved)) {
  // 转写阶段由子进程自己续报进度（逐卡一条），这里先占一行让界面立刻知道浏览器已经收工
  progress('', '本机转写', 0, 0, 'OCR 与语音转写，不再动浏览器')
  try {
    const { stdout } = await run(process.env.MEDIA_HUB_NODE || 'node', ['scripts/capture-script.mjs', '--pending'], {
      cwd: ROOT,
      timeout: 50 * 60_000,
      maxBuffer: 8 * 1024 * 1024,
    })
    console.log(stdout.trimEnd())
  } catch (e) {
    console.log(`[fav] 自动出稿没跑成（${String(e?.message || e).slice(0, 120)}）——卡片已入库，可在详情里重跑`)
  }
}
await task.finish({ keep: [] })
// 界面那颗按钮只认退出码：只要有一个平台没取到就不能报「已同步」，掉登录必须让它红给用户看。
// （ego 会把内层退出码统一改报成 1，非 0 即达意，别去追那个 2）
if (failed) process.exitCode = 2
