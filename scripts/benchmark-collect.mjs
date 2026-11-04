/**
 * 对标账号（自动线）：按 config/benchmarks.json 的平台 + 定位关键词找人 →
 * 逐个访问主页取实测数据 → 按 粉丝量 × 近期爆款 × 活跃度 打分 →
 * 每平台每天新建档 Top N 个 → content/Resources/对标账号/<平台>/<昵称>.md
 *
 * 用法（ego-browser 需已登录小红书和抖音）：npm run benchmark
 * 只补老档案头像、不搜新号：npm run benchmark:avatars
 * 手动添加的那个号补实测读数：--args --url '<主页链接>'（界面「添加对标账号」落卡后自动排这一条）
 * 与爆款采集的分工：那条线拉「作品」，这条线拉「人」——同赛道值得长期参照的创作者。
 *
 * 人工线（界面「收对标」弹层：搜号与建档是两趟浏览器，中间收谁由人定）：
 *   --search=<平台:词,词>  只按关键词聚合候选作者、一个主页都不开，每搜完一个词重写候选池给界面挑
 *   --capture=<平台:作者id,…> 开这些号的主页读实测，按手动建档的格式落档案
 *
 * 两个平台走同一条找法：搜作品 → 把命中的作者聚成候选池。
 * 因为「搜作者」这条路按语义匹配关键词，会捞进跑题大号（实测采到过清货专场、手势舞主播），
 * 而「命中过这个题材作品」的作者，才是真在同赛道做事的人。
 *
 * 字段来源（2026-09-23 实测校准）：
 *  小红书·搜索  __INITIAL_STATE__.search.feeds[].noteCard.{user,interactInfo}
 *  小红书·主页  userPageData.basicInfo.{nickname,redId,desc,ipLocation} + interactions[]
 *              interactions 只有 关注/粉丝/获赞与收藏 三项，主页不暴露笔记总数；
 *              活跃度取 user.notes[][].noteCard.time
 *  抖音·搜索    作品卡 div[id^="waterfall_item_"] 没有 <a>，作者信息不在 DOM 上，
 *              要爬 React fiber 找 memoizedProps.item.awemeInfo：
 *              authorInfo.{secUid,nickname}、stats.diggCount（不是 statistics）、createTime。
 *              URL 不能带 ?type=video——抖音会把它改写成 type=，页面换成另一套 DOM，卡片选择器全落空；
 *              卡片上 followerCount 恒为 0，粉丝数只能去主页读
 *  抖音·主页    读数在 user-detail 那一行（要等数字渲染出来，只有 label 就是没加载完）；
 *              简介默认是「... 更多」截断版，必须真点一次「更多」，展开的那份才在 DOM 里；
 *              作品卡 [data-e2e="user-post-list"] a[href*="/video/"]，卡上不显示日期，
 *              但 aweme_id 是雪花号——解出发布时间即可判活跃度，不必点进视频
 *
 * 头像落在 public/benchmarks/<平台>/<作者id>.<ext>，frontmatter 只存站内路径——
 * 平台 CDN 挡热链，界面直接引用外链会碎图。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = process.env.MEDIA_HUB_ROOT || process.cwd()
// 结构化进度与停止信号（一行 JSON 走 stdout；停止只在平台之间自取）
const { step, progress, plan, stopRequested, skipUnlessWanted, writeSearchJson, readSearchJson, BENCH_SEARCH_FILE } = await import(`file://${ROOT}/scripts/sync-step.mjs`)
// 本脚本经 stdin 喂给 ego-browser，相对路径在 link 阶段按 / 解析，故用 file:// 绝对导入
const coreMod = await import(pathToFileURL(join(ROOT, 'scripts/collect-note-core.mjs')).href)
const { douyinPublishedAt, parseProfileUrl, writeBenchmarkMd } = coreMod
const { localDay } = await import(pathToFileURL(join(ROOT, 'scripts/day-core.mjs')).href)

const cfg = JSON.parse(readFileSync(join(ROOT, 'config/benchmarks.json'), 'utf8'))
const OUT_DIR = join(ROOT, 'content/Resources/对标账号')
const AVATAR_DIR = join(ROOT, 'public/benchmarks')
// 建档日期与 collect-runs 的落盘判据同一把尺（本机日历日）
const TODAY = localDay()
const SAMPLE = cfg.noteSample || 30
/** 每平台最多打开多少个主页。够数就提前收工，少开一个页面就少一分风控暴露 */
const VISITS = cfg.visitLimit || 18
const PER_PLATFORM = cfg.dailyLimitPerPlatform ?? 5
/** 搜索结果页和作品列表都是懒加载，滚几轮把候选池和样本做大 */
const SCROLL_ROUNDS = cfg.scrollRounds ?? 2
/** 每平台每轮最多给多少个老档案补头像。补满的档案下轮就不再访问，这个数只是风控预算上限 */
const REFILL_LIMIT = (() => {
  const arg = process.argv.find((a) => a.startsWith('--refill-limit='))
  return arg ? Number(arg.split('=')[1]) || 1 : (cfg.avatarRefillLimit ?? 10)
})()
/** 只补头像、不搜新号：省下一整轮搜索与建档的页面开销，用来验证头像选择器 */
const REFILL_ONLY = process.argv.includes('--refill-only')

/** 「1.2万」/「3千」/「123」→ 数字 */
function toNum(s) {
  const t = String(s ?? '').trim()
  const m = t.match(/([\d.]+)\s*([万千wW]?)/)
  if (!m) return 0
  const n = parseFloat(m[1])
  if (isNaN(n)) return 0
  const u = m[2]
  return Math.round(n * (u === '万' || u.toLowerCase() === 'w' ? 10000 : u === '千' ? 1000 : 1))
}
const fmt = (n) => (n >= 10000 ? `${(n / 10000).toFixed(1).replace(/\.0$/, '')}万` : String(n))
const age = (d) => (d <= 0 ? '今天' : `${d} 天前`)
const median = (xs) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : 0)
/** 建档打分：三项各自归一到 0~1 再加权——粉丝看体量、爆款看质量、更新看活跃度（自动线与手动补采同一个口径） */
const scoreOf = ({ fans, top, med, days }) => +(
  100 * (0.45 * Math.min(fans / 100000, 1)
    + 0.35 * (0.6 * Math.min(top / 10000, 1) + 0.4 * Math.min(med / 1000, 1))
    + 0.20 * Math.max(0, 1 - days / 90))
).toFixed(1)
/** 候选池里没有可信粉丝数，只能按命中作品的最高赞排——门槛卡的本来就是「近期有爆款」 */
const byMaxLikes = (list) => list.sort(
  (a, b) => Math.max(0, ...b.likes) - Math.max(0, ...a.likes) || b.likes.length - a.likes.length,
)
/** 简介是多行长文本，frontmatter 解析器只认单行，压成一行并按需加引号 */
function yaml(s) {
  const t = String(s ?? '').replace(/\s*\n\s*/g, ' ').trim()
  return `"${t.replace(/["“”]/g, '”')}"`
}

/** 头像落到 public/benchmarks/ 下，返回站内路径（拿不到返回空串，界面回落平台色块） */
async function downloadAvatar(url, platform, uid) {
  if (!url) return ''
  try {
    const res = await fetch(url)
    if (!res.ok) return ''
    const type = res.headers.get('content-type') || ''
    const ext = type.includes('png') ? 'png' : type.includes('webp') ? 'webp' : 'jpg'
    mkdirSync(join(AVATAR_DIR, platform), { recursive: true })
    writeFileSync(join(AVATAR_DIR, platform, `${uid}.${ext}`), Buffer.from(await res.arrayBuffer()))
    return `/benchmarks/${platform}/${uid}.${ext}`
  } catch {
    return ''
  }
}

/** 候选池里那张头像只是给人认人用的预览，单独放 public/benchmark-search/——
 *  public/benchmarks/ 下每张都是建档留下的资产，不该被一轮没选中的搜索占掉。拿不到返回空串。 */
async function downloadPreviewAvatar(url, platform, uid) {
  if (!url) return ''
  try {
    const res = await fetch(url)
    if (!res.ok) return ''
    const type = res.headers.get('content-type') || ''
    const ext = type.includes('png') ? 'png' : type.includes('webp') ? 'webp' : 'jpg'
    const dir = join(ROOT, 'public/benchmark-search', platform)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${uid}.${ext}`), Buffer.from(await res.arrayBuffer()))
    return `/benchmark-search/${platform}/${uid}.${ext}`
  } catch {
    return ''
  }
}

/** 就地给老档案补一个 frontmatter 字段；已有非空值就不动，正文一个字都不碰。
 *  手动建档的空字段写成 `key: ""`（解析器认它是空串），补采时同样要能填进去。 */
function patchFrontmatter(file, key, value) {
  const text = readFileSync(file, 'utf8')
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/)
  if (!m) return false
  const lines = m[1].split(/\r?\n/)
  const i = lines.findIndex((l) => l.startsWith(`${key}:`))
  const cur = i >= 0 ? lines[i].slice(key.length + 1).trim() : ''
  if (i >= 0 && cur && cur !== '""') return false
  if (i >= 0) lines[i] = `${key}: ${value}`
  else lines.push(`${key}: ${value}`)
  writeFileSync(file, `---\n${lines.join('\n')}\n---\n${text.slice(m[0].length)}`)
  return true
}

async function scrollMore(page, rounds = SCROLL_ROUNDS, label = 'load more') {
  for (let i = 0; i < rounds; i++) {
    await page.mouse.wheel(0, 4000, { label })
    await page.waitForTimeout(2200)
  }
}

/**
 * 抖音主页的简介默认只渲染截断版（「… 更多」），完整版要点开才进 DOM。
 * 必须用真鼠标点击：evaluate 里 el.click() 派发的合成事件抖音不认。
 */
async function expandDouyinBio(page) {
  try {
    await page.click('text="更多" >> nth=0', { label: 'expand douyin bio' })
    await page.waitForTimeout(800)
  } catch {
    // 简介本来就短就没有「更多」，点不到不是错误
  }
}

/** 已建档的 平台:作者id → 档案位置、已有头像、主页链接（自动线与手动卡共用一套去重） */
function indexed() {
  const byUser = new Map()
  if (!existsSync(OUT_DIR)) return byUser
  const scan = (dir, archived = false) => {
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, name.name)
      if (name.isDirectory()) { scan(p, archived || name.name === '归档'); continue }
      if (!name.name.endsWith('.md') || name.name === 'README.md') continue
      const text = readFileSync(p, 'utf8')
      const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)
      const uid = fm?.[1].match(/^userId:\s*(\S+)\s*$/m)?.[1]
      const platform = fm?.[1].match(/^platform:\s*(\S+)\s*$/m)?.[1] || 'xiaohongshu'
      const pick = (k) => (fm?.[1].match(new RegExp(`^${k}:\\s*(\\S+)\\s*$`, 'm')) || [])[1] || ''
      if (uid) byUser.set(`${platform}:${uid}`, { file: p, uid, platform, archived, avatar: pick('avatar'), url: pick('url') })
    }
  }
  scan(OUT_DIR)
  return byUser
}

const PLATFORMS = {
  xiaohongshu: {
    label: '小红书',
    /** 搜最热笔记 → 命中的作者进池。不带 sort 参数：实测那个参数在搜索页是空转，排序靠主页实测数据 */
    async candidates(page, kw) {
      await page.goto(`https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(kw)}`)
      await page.waitForTimeout(7000)
      return page.evaluate(() => {
        const val = (x) => (x && typeof x === 'object' && '_value' in x ? x._value : x)
        const feeds = val(val(window.__INITIAL_STATE__?.search)?.feeds) || []
        const links = [...document.querySelectorAll('a[href*="/user/profile/"]')].map((a) => a.getAttribute('href'))
        const out = []
        for (const f of feeds) {
          const nc = val(f?.noteCard)
          const us = val(nc?.user)
          if (!us?.userId) continue
          out.push({
            uid: us.userId,
            nick: us.nickname || us.nickName || '',
            // 小红书的 avatar 字段有时是图片索引号而非 URL，只认 http 那份
            avatar: [val(us.avatar), val(us.image)].find((s) => String(s || '').startsWith('http')) || '',
            likes: val(nc?.interactInfo)?.likedCount || '',
            // 主页链接要带 xsec_token，裸链常被拦
            href: links.find((h) => h.startsWith(`/user/profile/${us.userId}`)) || `/user/profile/${us.userId}`,
          })
        }
        return out
      })
    },
    /** 池子里的一条 → 主页地址（带 xsec_token 的那份优先） */
    visitUrl: (c) => `https://www.xiaohongshu.com${c.href}`,
    ready: (page) => page.waitForTimeout(6000),
    /** 主页头像：basicInfo.images 是原图那份，状态里取不到就退而求 DOM 上那个 img */
    async avatar(page) {
      return page.evaluate(() => {
        const val = (x) => (x && typeof x === 'object' && '_value' in x ? x._value : x)
        const bi = val(val(val(window.__INITIAL_STATE__?.user)?.userPageData)?.basicInfo) || {}
        const raw = val(bi.images) || val(bi.imageb) || ''
        if (String(raw).startsWith('http')) return String(raw)
        const img = document.querySelector('img[class*="avatar"], .user-info img')
        return img?.currentSrc || img?.src || ''
      })
    },
    async profile(page) {
      return page.evaluate((sample) => {
        const val = (x) => (x && typeof x === 'object' && '_value' in x ? x._value : x)
        const u = val(window.__INITIAL_STATE__?.user)
        const up = val(u?.userPageData) || {}
        const bi = val(up.basicInfo) || {}
        const inter = val(up.interactions) || []
        const count = (type) => val(inter.find((i) => i?.type === type))?.count || ''
        const flat = (val(u?.notes) || []).flatMap((col) => val(col) || [])
        const notes = flat
          .map((it) => {
            const nc = val(it?.noteCard) || {}
            return { title: (nc.displayTitle || '').trim(), likes: val(nc.interactInfo)?.likedCount || '', time: nc.time || 0 }
          })
          .filter((n) => n.time)
          .slice(0, sample)
        return {
          nick: bi.nickname || bi.nickName || '',
          accountId: bi.redId || '', desc: bi.desc || '', ip: bi.ipLocation || '',
          fans: count('fans'), likesCollects: count('interaction'), works: '', notes,
        }
      }, SAMPLE)
    },
    rank: byMaxLikes,
    profileUrl: (uid) => `https://www.xiaohongshu.com/user/profile/${uid}`,
  },

  douyin: {
    label: '抖音',
    /** 搜视频，把命中的作者聚成候选池。作品卡不挂作者信息，得从 React fiber 里挖 awemeInfo */
    async candidates(page, kw) {
      await page.goto(`https://www.douyin.com/search/${encodeURIComponent(kw)}`, { waitUntil: 'commit', timeout: 30000 })
      try {
        await page.waitForFunction(() => document.querySelectorAll('div[id^="waterfall_item_"]').length > 0, undefined, { timeout: 25000, polling: 1000 })
      } catch {
        throw new Error('搜索结果始终没出现（风控页或登录态失效）')
      }
      await scrollMore(page, SCROLL_ROUNDS, 'load more videos')
      return page.evaluate(() => {
        const infoOf = (el) => {
          const fk = Object.keys(el).find((k) => k.startsWith('__reactFiber'))
          let n = fk && el[fk]
          for (let i = 0; i < 40 && n; i++) {
            const p = n.memoizedProps
            const cand = p && (p.item || p.data || p)
            if (cand && cand.awemeInfo && cand.awemeInfo.awemeId) return cand.awemeInfo
            n = n.return
          }
          return null
        }
        const out = []
        for (const el of document.querySelectorAll('div[id^="waterfall_item_"]')) {
          const ai = infoOf(el)
          // 直播卡、广告卡挖不出 awemeInfo，跳过
          const a = ai && ai.authorInfo
          if (!a || !a.secUid) continue
          out.push({
            uid: a.secUid,
            nick: a.nickname || '',
            avatar: (a.avatarMedium || a.avatarThumb || {}).urlList?.[0] || '',
            likes: String((ai.stats && ai.stats.diggCount) ?? ''),
          })
        }
        return out
      })
    },
    rank: byMaxLikes,
    visitUrl: (c) => `https://www.douyin.com/user/${c.uid}`,
    /** 数字比 label 晚一步渲染，等到那一行真读出数为止 */
    ready: (page) => page.waitForFunction(
      () => /粉丝\s*[\d.]+\s*[万千wW]?/.test((document.querySelector('[data-e2e="user-detail"]')?.innerText || '').replace(/\s+/g, ' ')),
      undefined, { timeout: 20000, polling: 1000 },
    ).then(() => page.waitForTimeout(1500)),
    /**
     * 主页头像：页面上有好几张 aweme-avatar 图，导航栏那张 32px 的是「登录者自己」的头像——
     * 按 src 取第一条会给十个账号下回同一张图。账号本人那张是渲染尺寸最大的（实测 112×112），
     * 所以只认 60px 以上的、并取其中最大的一张。
     */
    async avatar(page) {
      return page.evaluate(() => {
        const area = (i) => {
          const r = i.getBoundingClientRect()
          return r.width * r.height
        }
        return [...document.querySelectorAll('img[src*="aweme-avatar"]')]
          .filter((i) => i.getBoundingClientRect().width >= 60)
          .sort((a, b) => area(b) - area(a))[0]?.src || ''
      })
    },
    async profile(page, c) {
      await expandDouyinBio(page)
      await scrollMore(page, 1, 'load more works')
      return page.evaluate(({ nick }) => {
        const detail = (document.querySelector('[data-e2e="user-detail"]')?.innerText || '').replace(/\s+/g, ' ')
        const pick = (label) => (detail.match(new RegExp(label + '\\s*([\\d.]+\\s*[万千wW]?)')) || [])[1] || ''
        // 简介：点过「更多」后抖音会把完整版追加成第三个子节点，但截断版并不隐藏，
        // 所以必须取「那个盒子里最长的一条」，取第一条会拿到截断版。换行留着——position 取第一行
        const text = (el) => (el.innerText || '').replace(/[ \t]+/g, ' ').replace(/\n\s*\n/g, '\n').trim()
        const more = [...document.querySelectorAll('span,div')]
          .find((e) => !e.children.length && (e.textContent || '').trim() === '更多')
        const box = more ? more.parentElement.parentElement : null
        const desc = box
          ? [...box.children].map(text).filter((t) => t && t !== '更多' && t !== '收起')
            .sort((a, b) => b.length - a.length)[0] || ''
          // 没有「更多」说明简介本来就短，一行展示完了，从 user-info 里挑最长的叶子
          : ((ui) => ui ? [...ui.querySelectorAll('div,span,p')]
            .filter((e) => [...e.children].every((x) => x.tagName === 'IMG' || x.tagName === 'BR'))
            .map(text).filter((t) => t && t !== nick).sort((a, b) => b.length - a.length)[0] || ''
            : '')(document.querySelector('[data-e2e="user-info"]'))
        const cards = [...document.querySelectorAll('[data-e2e="user-post-list"] a[href*="/video/"]')]
          .map((a) => {
            const id = (a.getAttribute('href').match(/\/video\/(\d+)/) || [])[1] || ''
            const t = (a.innerText || '').replace(/\s+/g, ' ').trim().replace(/^置顶\s*/, '')
            return { id, likes: (t.match(/^([\d.]+\s*[万千wW]?)\s/) || [])[1] || '', title: t.replace(/^[\d.]+\s*[万千wW]?\s*/, '').slice(0, 80) }
          })
          .filter((c, i, arr) => c.id && c.likes && arr.findIndex((x) => x.id === c.id) === i)
        return {
          // 昵称：手动建档时表单可以空着，靠主页这一行认回来；自动线用候选池里那份
          nick: (document.querySelector('[data-e2e="user-info"] h1')?.innerText || '').trim()
            || (document.title || '').replace(/的抖音.*$/, '').trim(),
          accountId: (detail.match(/抖音号[：:]\s*(\S+)/) || [])[1] || '',
          ip: (detail.match(/IP属地[：:]\s*(\S+)/) || [])[1] || '',
          desc,
          fans: pick('粉丝'), likesCollects: pick('获赞'),
          works: (document.querySelector('[data-e2e="user-tab-count"]')?.innerText || '').trim(),
          notes: cards,
        }
      }, { nick: c && c.nick ? c.nick : '' })
    },
    /** 作品卡不显示日期，用雪花 ID 解发布时间；只取样本里最新的一条当「最近一次更新」 */
    lastPublishTs: (note) => {
      const d = douyinPublishedAt(note.id)
      return d ? new Date(d + 'T00:00:00Z').getTime() : 0
    },
    profileUrl: (uid) => `https://www.douyin.com/user/${uid}`,
    // 抖音主页从不触发 load（长连接挂着），只能 commit + 自己等到读数出现
    gotoOpts: { waitUntil: 'commit', timeout: 30000 },
  },
}

/** 切出「## <name>」这一段的起止（找不到返回 null） */
function sectionRange(text, name) {
  const start = text.indexOf(`## ${name}`)
  if (start < 0) return null
  const next = text.indexOf('\n## ', start)
  return { start, end: next < 0 ? text.length : next }
}

/** 往「## 数据快照」追加一行实测；同一天重跑不重复记 */
function appendSnapshot(file, line) {
  const text = readFileSync(file, 'utf8')
  const r = sectionRange(text, '数据快照')
  if (!r) return false
  const block = text.slice(r.start, r.end)
  if (block.includes(`- ${TODAY}`)) return false
  writeFileSync(file, text.slice(0, r.start) + block.replace(/\s+$/, '') + `\n- ${line}\n` + text.slice(r.end))
  return true
}

/** 「值得偷的模式」只在该段一条没有时填证据（高赞作品标题）——打法判断留给人写 */
function fillPatternEvidence(file, notes) {
  const text = readFileSync(file, 'utf8')
  const r = sectionRange(text, '值得偷的模式')
  if (!r || /^-\s+\S/m.test(text.slice(r.start, r.end))) return false
  const bullets = notes.filter((n) => n.title).map((n) => `- 「${n.title}」${fmt(n.likes)} 赞`)
  if (!bullets.length) return false
  writeFileSync(file, text.slice(0, r.start) + text.slice(r.start, r.end).replace(/\s+$/, '') + '\n\n' + bullets.join('\n') + '\n' + text.slice(r.end))
  return true
}

/**
 * 开一次主页，只把实测读数拿回来：粉丝/获赞/作品样本/头像。
 * 读数或作品列表任一样没拿到就抛错——这页没真读出来（风控、未登录或没渲染完），
 * 不能按「0 粉、近 0 条」建档，那会把一个没采到的号当成活跃号收进档案。
 */
async function readProfile(impl, page, visitUrl, hint = {}) {
  await page.goto(visitUrl, impl.gotoOpts)
  await impl.ready(page, hint)
  const p = await impl.profile(page, hint)
  const notes = (p.notes || []).slice(0, SAMPLE).map((n) => ({
    title: n.title, likes: toNum(n.likes), time: n.time || impl.lastPublishTs?.(n) || 0,
  }))
  const fans = toNum(p.fans)
  if (!notes.length || !fans) throw new Error('主页没读出粉丝数或作品列表（风控页、未登录或页面没渲染完）')
  const likes = notes.map((n) => n.likes)
  const lastTime = Math.max(0, ...notes.map((n) => n.time || 0))
  const days = lastTime ? Math.floor((Date.now() - lastTime) / 86400000) : 999
  const top = Math.max(0, ...likes)
  const med = median(likes)
  return {
    p, notes, fans, days, top, med,
    likesCollects: toNum(p.likesCollects),
    score: scoreOf({ fans, top, med, days }),
    nick: String(p.nick || '').trim(),
    // 主页那张拿不到就退用搜索卡上那份——两处都是平台给的真图，不必为此再开一页
    avatarPath: await downloadAvatar((await impl.avatar(page).catch(() => '')) || hint.avatarUrl || '', hint.platform, hint.uid),
  }
}

/** 把一次主页读数落进档案：只补空值，人工改过的定位与理由不会被覆盖（patchFrontmatter 认「已有非空值就不动」） */
function applyReadings(rec, d) {
  const { p, notes, fans, days, top, med, score, nick, avatarPath } = d
  patchFrontmatter(rec.file, 'nickname', nick)
  patchFrontmatter(rec.file, 'accountId', p.accountId || '')
  patchFrontmatter(rec.file, 'ipLocation', p.ip || '')
  patchFrontmatter(rec.file, 'desc', yaml(p.desc))
  patchFrontmatter(rec.file, 'position', ((p.desc || '').split(/[\n|｜]/).find((l) => l.trim()) || '').trim().slice(0, 50))
  patchFrontmatter(rec.file, 'followers', fans)
  patchFrontmatter(rec.file, 'likesCollects', toNum(p.likesCollects))
  if (p.works) patchFrontmatter(rec.file, 'works', toNum(p.works))
  patchFrontmatter(rec.file, 'recentSample', notes.length)
  patchFrontmatter(rec.file, 'recentTopLikes', top)
  patchFrontmatter(rec.file, 'recentMedianLikes', med)
  patchFrontmatter(rec.file, 'lastPublishDays', days)
  patchFrontmatter(rec.file, 'score', score)
  patchFrontmatter(rec.file, 'capturedAt', TODAY)
  if (d.keywords?.length) patchFrontmatter(rec.file, 'matchedKeywords', [...d.keywords].join(', '))
  if (avatarPath) patchFrontmatter(rec.file, 'avatar', avatarPath)
  appendSnapshot(rec.file, `${TODAY}：粉丝 ${fmt(fans)} · ${p.works ? `作品 ${p.works} 条 · ` : ''}获赞 ${fmt(toNum(p.likesCollects))} · 近 ${notes.length} 条最高 ${fmt(top)} 赞（中位 ${fmt(med)}）· 最近发布 ${age(days)}`)
  fillPatternEvidence(rec.file, [...notes].sort((a, b) => b.likes - a.likes).slice(0, 5))
}

/**
 * 单号模式：手动添加的那个号，开一次主页把实测读数补进档案（档案由界面「添加对标账号」先落好）。
 * 只补空值——patchFrontmatter 认「已有非空值就不动」，所以重跑不会覆盖人工改过的定位与理由。
 */
async function captureOne(raw) {
  const { platform, userId, url } = parseProfileUrl(raw)
  const impl = PLATFORMS[platform]
  const rec = indexed().get(`${platform}:${userId}`)
  if (!rec) throw new Error(`没有这个号的对标档案（${platform} ${userId}）——先在页面上添加`)
  if (rec.archived) throw new Error('这份档案已归档，要重新对标就在页面上再添加一次')
  const task = await taskSpace('benchmark-collect')
  const page = (await task.pages()).find((p) => p.label === 'p1') || (await task.newPage())
  const d = await readProfile(impl, page, url, { platform, uid: userId })
  applyReadings(rec, d)
  console.log(`[bench:单号] ${d.nick || userId}：${fmt(d.fans)}粉 · 最高${fmt(d.top)}赞 · ${d.days}天前更新 · 分 ${d.score}${d.avatarPath ? ' · 头像已存' : ''}`)
}

/** --url 既可能是脚本参数里的独立两项（run-ego 的 --args 传法），也可能写成 --url=… */
const ONE_URL = (() => {
  const i = process.argv.indexOf('--url')
  if (i >= 0 && process.argv[i + 1]) return String(process.argv[i + 1])
  return (process.argv.find((a) => a.startsWith('--url=')) || '').slice(6)
})()
if (ONE_URL) {
  try {
    await captureOne(ONE_URL)
    process.exit(0)
  } catch (e) {
    console.log(`[bench:单号] ${String(e.message || e).slice(0, 200)}`)
    process.exit(2)
  }
}

const task = await taskSpace('benchmark-collect')
// 一个页面轮流走：多开页面会撞平台风控
let page = (await task.pages()).find((p) => p.label === 'p1') || (await task.newPage())

const seen = indexed()
const allSaved = []

/* ---------- 人工线：界面「收对标」弹层 ----------
 *  搜号与建档分成两趟浏览器，中间那一次「收谁」的判断归人：
 *  --search 只按关键词把「发过这个题材作品」的作者聚成候选池、连头像写进去，一个主页都不开，
 *  所以每搜完一个词就能出候选；--capture 才逐个开主页读实测、按手动建档的格式落档案。 */
/** 既可能是脚本参数里的独立两项（run-ego 的 --args 传法），也可能写成 --flag=… */
const argValue = (flag) => {
  const i = process.argv.indexOf(flag)
  if (i >= 0 && process.argv[i + 1]) return String(process.argv[i + 1])
  return (process.argv.find((a) => a.startsWith(`${flag}=`)) || '').slice(flag.length + 1)
}
const SEARCH_ARG = argValue('--search')
const CAPTURE_ARG = argValue('--capture')
/** 候选池每个平台最多摆几个号：人要的是翻得过来的那一屏，前几个够了就别再往后翻 */
const SEARCH_SHOW = cfg.searchLimit ?? 5

/** --search 的参数是「平台:词,词」，与搜爆款同一份格式：一次只搜一个平台才快得起来。
 *  没带前缀是命令行手跑，退回配置里的平台。 */
function parseSearchArg(s) {
  const list = (t) => t.split(/[,，]/).map((x) => x.trim()).filter(Boolean)
  const all = (cfg.platforms || Object.keys(PLATFORMS)).filter((p) => PLATFORMS[p])
  const i = s.indexOf(':')
  if (i < 0) return { plats: all, kws: list(s) }
  const plats = list(s.slice(0, i)).filter((p) => PLATFORMS[p])
  return { plats: plats.length ? plats : all, kws: list(s.slice(i + 1)) }
}

if (SEARCH_ARG) {
  const { plats, kws } = parseSearchArg(SEARCH_ARG)
  plan(plats)
  /** 每平台各自攒候选（作者 id → 命中的作品赞数与关键词）；池子每搜完一个词重写一次，界面隔几秒读它 */
  const accByPlat = new Map()
  const avatarOf = new Map()
  const poolRows = () => {
    const rows = []
    for (const [platform, acc] of accByPlat) {
      const impl = PLATFORMS[platform]
      for (const a of byMaxLikes([...acc.values()]).slice(0, SEARCH_SHOW)) {
        rows.push({
          platform,
          uid: a.uid,
          nick: a.nick,
          url: impl.profileUrl(a.uid),
          // 主页地址留着带 xsec_token 的那份：入库那一趟要开的就是它，裸链常被拦
          href: a.href,
          avatarUrl: a.avatar,
          avatar: avatarOf.get(`${platform}/${a.uid}`) || '',
          topLikes: Math.max(0, ...a.likes),
          hits: a.likes.length,
          keywords: [...a.keywords],
          already: seen.has(`${platform}:${a.uid}`),
          captured: false,
        })
      }
    }
    return rows.sort((x, y) => y.topLikes - x.topLikes || y.hits - x.hits)
  }
  /** 每轮都重写池子：新进来的那几个要先有头像，界面摆出去才不会是一排空图 */
  async function flush() {
    for (const [platform, acc] of accByPlat) {
      for (const a of byMaxLikes([...acc.values()]).slice(0, SEARCH_SHOW)) {
        const key = `${platform}/${a.uid}`
        if (!avatarOf.has(key)) avatarOf.set(key, await downloadPreviewAvatar(a.avatar, platform, a.uid))
      }
    }
    writeSearchJson(
      {
        at: new Date().toISOString(),
        keywords: kws,
        platforms: plats,
        minFollowers: cfg.minFollowers ?? 0,
        rows: poolRows(),
      },
      BENCH_SEARCH_FILE,
    )
  }

  let blockedAll = true
  for (const platform of plats) {
    if (stopRequested()) break
    const impl = PLATFORMS[platform]
    const acc = accByPlat.get(platform) || new Map()
    accByPlat.set(platform, acc)
    let blocked = 0
    for (const [ki, kw] of kws.entries()) {
      if (stopRequested()) break
      progress(platform, '搜索关键词', ki + 1, kws.length, kw)
      let rows = []
      try {
        rows = await impl.candidates(page, kw)
      } catch (e) {
        blocked++
        console.log(`[bench:search] ${impl.label} ${kw} 的结果没出现：${String(e.message || e).slice(0, 80)}`)
        continue
      }
      blockedAll = false
      for (const r of rows) {
        const a = acc.get(r.uid) || { uid: r.uid, nick: r.nick, href: r.href || '', avatar: '', likes: [], keywords: new Set() }
        if (r.likes !== undefined) a.likes.push(toNum(r.likes))
        if (!a.avatar && r.avatar) a.avatar = r.avatar
        // 主页地址要带 xsec_token 那份，裸链常被拦——搜索页给的另一条链接才算数（同自动线的合并口径）
        if (r.href && !String(a.href).includes('xsec_token') && String(r.href).includes('xsec_token')) a.href = r.href
        a.keywords.add(kw)
        acc.set(r.uid, a)
      }
      console.log(`[bench:search] ${impl.label} ${kw} → ${rows.length} 条命中，累计候选 ${acc.size} 个号`)
      await flush()
      // 前几个号已经到手，后面的词再搜也只是把同一屏换成人翻不动的长列表
      if (acc.size >= SEARCH_SHOW) break
    }
    // 留痕不报条数：这一趟只搜不建档，报数会被排班线读成「采到了」
    step(platform, blocked === kws.length && !acc.size ? 'error' : 'ok', {
      note: blocked === kws.length && !acc.size ? `${blocked} 个关键词的结果始终没出现（登录态失效或被风控）` : '',
    })
  }
  const rows = poolRows()
  console.log(`[bench:search] ${kws.join('、')} → 候选 ${rows.length} 个号（每平台最多 ${SEARCH_SHOW} 个）`)
  if (blockedAll && !rows.length) {
    console.log(`${plats.map((p) => PLATFORMS[p].label).join('、')}的结果始终没出现（登录态失效或被风控）`)
    process.exitCode = 2
  }
  // 人按了停在下一个边界退 3，不能报 0 把「这轮没跑完」说成收成功了；风控那笔（2）更要紧，不被盖掉
  if (stopRequested() && process.exitCode !== 2) process.exitCode = 3
  await task.finish({ keep: [] })
  process.exit(process.exitCode || 0)
}

if (CAPTURE_ARG) {
  const pool = readSearchJson(BENCH_SEARCH_FILE)
  const ids = CAPTURE_ARG.split(',').map((s) => s.trim()).filter(Boolean)
  const chosen = ids.map((id) => (pool?.rows || []).find((r) => `${r.platform}:${r.uid}` === id)).filter(Boolean)
  if (!chosen.length) {
    console.log('界面上挑的那几个不在候选池里了，重新搜一轮再收')
    process.exitCode = 1
    await task.finish({ keep: [] })
    process.exit(process.exitCode || 0)
  }
  let saved = 0
  let dup = 0
  let failed = 0
  for (const [i, row] of chosen.entries()) {
    if (stopRequested()) break
    progress(row.platform, '读主页建档', i + 1, chosen.length, row.nick)
    const key = `${row.platform}:${row.uid}`
    // 已建档的（这一轮搜的时候就在库）不碰页面，直接算「库里已有」
    if (seen.get(key) && !seen.get(key).archived) {
      dup++
      row.captured = true
      continue
    }
    const impl = PLATFORMS[row.platform]
    try {
      // 先读主页：读不到就一个文件都不落，免得留下一张全空档案让人以为收成功了
      const d = await readProfile(impl, page, impl.visitUrl({ uid: row.uid, href: row.href }), {
        nick: row.nick, avatarUrl: row.avatarUrl, platform: row.platform, uid: row.uid,
      })
      const r = writeBenchmarkMd({
        url: impl.profileUrl(row.uid),
        nickname: d.nick || row.nick,
        why: `人工挑入（${TODAY}）：命中「${(row.keywords || []).join('、')}」`,
      })
      applyReadings({ file: join(ROOT, r.rel), uid: row.uid, platform: row.platform }, { ...d, keywords: row.keywords })
      row.captured = true
      saved++
      console.log(`[bench:收对标] ${d.nick || row.uid}：${fmt(d.fans)}粉 · 最高${fmt(d.top)}赞 · ${d.days}天前更新 · 分 ${d.score}`)
    } catch (e) {
      const msg = String(e.message || e)
      if (/已经在对标档案里/.test(msg)) { dup++; row.captured = true; continue }
      failed++
      console.log(`[bench:收对标] ${row.nick || row.uid} 没收进来：${msg.slice(0, 90)}`)
      // 连续两个主页读不到就是登录态或风控的问题，再开第三页只会多挨一次
      if (failed >= 2) { console.log('[bench:收对标] 连续两个主页取不到数据，停止收剩余候选'); break }
    }
  }
  if (pool) writeSearchJson(pool, BENCH_SEARCH_FILE)
  console.log(`[bench:capture] 挑中 ${chosen.length} 个 → 建档 ${saved} 个${dup ? ` · 库里已有 ${dup} 个` : ''}`)
  if (stopRequested() && process.exitCode !== 2) process.exitCode = 3
  await task.finish({ keep: [] })
  process.exit(process.exitCode || 0)
}

const benchPlan = (cfg.platforms || ['xiaohongshu']).filter((p) => {
  if (PLATFORMS[p]) return true
  console.log(`[bench] 不认识的平台 ${p}，跳过`)
  return false
})
plan(benchPlan)
for (const [pi, platform] of benchPlan.entries()) {
  const impl = PLATFORMS[platform]
  if (skipUnlessWanted(platform)) continue
  if (stopRequested()) break
  progress(platform, '聚合候选号', pi + 1, benchPlan.length)
  if (REFILL_ONLY) console.log(`[bench:${impl.label}] 只补头像：本轮不搜新号、不建档`)

  // ---------- ① 聚合候选池 ----------
  const pool = new Map()
  for (const kw of REFILL_ONLY ? [] : cfg.keywords || []) {
    try {
      const rows = await impl.candidates(page, kw)
      for (const r of rows) {
        const a = pool.get(r.uid) || { uid: r.uid, nick: r.nick, href: r.href || '', desc: r.desc || '', avatar: '', fans: toNum(r.fans), likes: [], keywords: new Set() }
        if (r.likes !== undefined) a.likes.push(toNum(r.likes))
        if (!a.fans && r.fans) a.fans = toNum(r.fans)
        if (!a.desc && r.desc) a.desc = r.desc
        if (!a.avatar && r.avatar) a.avatar = r.avatar
        if (r.href && !a.href.includes('xsec_token') && r.href.includes('xsec_token')) a.href = r.href
        a.keywords.add(kw)
        pool.set(r.uid, a)
      }
      console.log(`[bench:${impl.label}] ${kw} → ${rows.length} 条命中，累计候选 ${pool.size}`)
    } catch (e) {
      console.log(`[bench:${impl.label}] ${kw} 抓取失败：${String(e.message || e).slice(0, 80)}`)
    }
  }

  // ---------- ② 逐个访问主页取实测数据 ----------
  // 两平台都没可信粉丝数，按命中作品的最高赞排；先刷掉已建档的
  const ranked = byMaxLikes([...pool.values()].filter((a) => !seen.has(`${platform}:${a.uid}`)))
  const visits = REFILL_ONLY ? [] : ranked.slice(0, VISITS)
  console.log(`[bench:${impl.label}] 候选 ${pool.size} 人 → 未建档可访 ${ranked.length} 人 → 本轮访问 ${visits.length} 个主页`)

  const scored = []
  let miss = 0
  for (const c of visits) {
    try {
      await page.goto(impl.visitUrl(c), impl.gotoOpts)
      try {
        await impl.ready(page, c)
      } catch {
        console.log(`[bench:${impl.label}] ${c.nick || c.uid} 主页没加载出读数（风控或登录态失效），跳过`)
        continue
      }
      const p = await impl.profile(page, c)
      // 主页那份拿不到就退用搜索卡上的头像——两处都是平台给的真图，不必为此再开一页
      const avatarUrl = (await impl.avatar(page).catch(() => '')) || c.avatar || ''
      const notes = (p.notes || []).slice(0, SAMPLE).map((n) => ({
        title: n.title, likes: toNum(n.likes),
        time: n.time || impl.lastPublishTs?.(n) || 0,
      }))
      // 读数或作品列表任一样没拿到，就是这一页没真读出来（风控/选择器失效），
      // 不能按「近 0 条、0 天前更新」给它算分——那会把一个没采到的号当成活跃号选中
      if (!notes.length || !toNum(p.fans)) {
        miss += 1
        console.log(`[bench:${impl.label}] ${c.nick || c.uid} 没读到${toNum(p.fans) ? '作品列表' : '粉丝数'}（风控页或页面没渲染）`)
        if (miss >= 2) { console.log(`[bench:${impl.label}] 连续两个主页取不到数据，停止访问该平台剩余候选`); break }
        continue
      }
      miss = 0

      const likes = notes.map((n) => n.likes)
      const lastTime = Math.max(0, ...notes.map((n) => n.time || 0))
      const days = lastTime ? Math.floor((Date.now() - lastTime) / 86400000) : 999
      const fans = toNum(p.fans)
      const top = Math.max(0, ...likes)
      const med = median(likes)

      const score = scoreOf({ fans, top, med, days })

      const rejected = []
      if (fans < (cfg.minFollowers ?? 0)) rejected.push(`粉丝 ${fmt(fans)} < 门槛 ${fmt(cfg.minFollowers)}`)
      if (days > (cfg.maxInactiveDays ?? 999)) rejected.push(`${days} 天未更新 > ${cfg.maxInactiveDays} 天`)
      if (top < (cfg.minRecentTopLikes ?? 0)) rejected.push(`近 ${notes.length} 条最高 ${fmt(top)} 赞 < ${fmt(cfg.minRecentTopLikes)}`)

      scored.push({
        uid: c.uid, keywords: [...c.keywords], score, rejected,
        nickname: c.nick, accountId: String(p.accountId || ''),
        desc: p.desc || c.desc || '', ip: p.ip || '',
        avatar: avatarUrl,
        fans, likesCollects: toNum(p.likesCollects), works: p.works || '', top, med, days,
        sampleCount: notes.length,
        notes: [...notes].sort((a, b) => b.likes - a.likes).slice(0, 5),
      })
      console.log(`[bench:${impl.label}] ${c.nick || c.uid}：${fmt(fans)}粉 · 最高${fmt(top)}赞 · ${days}天前更新 · 分 ${score}${rejected.length ? ' ✗ ' + rejected.join('；') : ''}`)
      if (scored.filter((s) => !s.rejected.length).length >= PER_PLATFORM) {
        console.log(`[bench:${impl.label}] 已过门槛 ${PER_PLATFORM} 个，停止访问剩余候选`)
        break
      }
    } catch (e) {
      console.log(`[bench:${impl.label}] ${c.nick || c.uid} 主页抓取失败：${String(e.message || e).slice(0, 80)}`)
    }
  }

  // ---------- ③ 过门槛的 Top N 建档 ----------
  const picked = scored.filter((s) => !s.rejected.length).sort((a, b) => b.score - a.score).slice(0, PER_PLATFORM)
  const dir = join(OUT_DIR, platform)
  mkdirSync(dir, { recursive: true })
  for (const s of picked) {
    const slug = (s.nickname || s.uid).replace(/[\\/:*?"<>|\s]+/g, '-').slice(0, 40)
    const file = join(dir, `${slug}.md`)
    if (existsSync(file)) { console.log(`[bench:${impl.label}] 同名档案已存在，跳过：${slug}.md`); continue }
    const position = (s.desc.split(/[\n|｜]/).find((l) => l.trim()) || '').trim().slice(0, 50)
    const avatarPath = await downloadAvatar(s.avatar, platform, s.uid)
    writeFileSync(file, `---
nickname: ${s.nickname}
userId: ${s.uid}
platform: ${platform}
url: ${impl.profileUrl(s.uid)}
accountId: ${yaml(s.accountId)}
ipLocation: ${s.ip}
desc: ${yaml(s.desc)}
position: ${position || ''}
why: 自动选入（${TODAY}）：命中「${s.keywords.join('、')}」
source: auto
capturedAt: ${TODAY}
followers: ${s.fans}
likesCollects: ${s.likesCollects}
${s.works ? `works: ${toNum(s.works)}\n` : ''}recentSample: ${s.sampleCount}
recentTopLikes: ${s.top}
recentMedianLikes: ${s.med}
lastPublishDays: ${s.days}
matchedKeywords: ${s.keywords.join(', ')}
score: ${s.score}
avatar: ${avatarPath}
---

## 数据快照

<!-- 自动线只在新建档当天写一行；老档案的快照由人工复查时追加 -->

- ${TODAY}：粉丝 ${fmt(s.fans)} · ${s.works ? `作品 ${s.works} 条 · ` : ''}获赞 ${fmt(s.likesCollects)} · 近 ${s.sampleCount} 条最高 ${fmt(s.top)} 赞（中位 ${fmt(s.med)}）· 最近发布 ${age(s.days)}

## 值得偷的模式

<!-- 自动线只留证据（高赞作品标题），打法与模式由人工复盘时提炼 -->

${s.notes.map((n) => `- 「${n.title}」${fmt(n.likes)} 赞`).join('\n')}
`)
    allSaved.push({ platform: impl.label, nickname: s.nickname, fans: s.fans, top: s.top, score: s.score, file: `${platform}/${slug}.md` })
  }
  console.log(`[bench:${impl.label}] 打分 ${scored.length} 人 → 过门槛 ${picked.length} 人`)

  // ---------- ④ 老档案补头像 ----------
  // 只补 frontmatter 里 avatar 为空的，补上后下轮起不再访问该主页——页面预算只花一轮就收。
  // 主页地址优先用候选池里带 xsec_token 的那份，池子这轮没再命中此人时退回档案里的 url。
  const pending = [...seen.values()].filter((r) => r.platform === platform && !r.archived && !r.avatar)
  let refilled = 0
  for (const rec of pending.slice(0, REFILL_LIMIT)) {
    const c = pool.get(rec.uid)
    try {
      await page.goto(c ? impl.visitUrl(c) : rec.url, impl.gotoOpts)
      await impl.ready(page, c || { nick: '' })
      const url = (await impl.avatar(page).catch(() => '')) || (c && c.avatar) || ''
      const path = await downloadAvatar(url, platform, rec.uid)
      if (path && patchFrontmatter(rec.file, 'avatar', path)) {
        rec.avatar = path
        refilled++
      } else {
        console.log(`[bench:${impl.label}] 头像没拿到（${url ? '下载失败' : '页面没给出像'}）：${rec.uid}`)
      }
    } catch (e) {
      console.log(`[bench:${impl.label}] ${rec.uid} 补头像失败：${String(e.message || e).slice(0, 80)}`)
    }
  }
  if (pending.length) console.log(`[bench:${impl.label}] 待补头像 ${pending.length} 个 → 本轮补成 ${refilled} 个`)
  step(platform, 'ok', { count: picked.length })
}

console.log(`[bench] 本轮新建档 ${allSaved.length} 个`)
for (const s of allSaved) console.log(`  · [${s.platform}] ${s.nickname}｜${fmt(s.fans)}粉｜${fmt(s.top)}赞｜分 ${s.score}｜${s.file}`)
if (!allSaved.length) console.log('[bench] 今天没有新账号过门槛（多为已建档或粉丝/活跃不达标），属正常，不要放宽门槛重试')
if (stopRequested()) process.exitCode = 3
await task.finish({ keep: [] })
