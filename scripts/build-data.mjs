#!/usr/bin/env node
/**
 * 内容数据管道：扫描 content/ 下的 markdown，生成 src/data/generated.json
 *
 * 这是工作台与文件系统之间的唯一接缝：
 *  - 本地内容：本脚本读 content/（现状）
 *  - 飞书对接：以后写一个 scripts/build-data.feishu.mjs 输出同结构的 JSON 即可替换
 *
 * 用法：npm run gen:data（dev/build 前会自动执行）
 */
import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync, renameSync, statSync } from 'node:fs'
import { join, dirname, relative, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { activeTarget } from '../config/active-target.mjs'
import { withUtm, targetUi } from '../config/promotion-target.mjs'
import { normalizeProduct } from './products-core.mjs'
import { readRuns } from './collect-runs.mjs'
import { localDay, shiftDay } from './day-core.mjs'
import { propagateUsedTopics } from './note-identity.mjs'
import { lessonIndex, reviewTopics, renderLedger, LEDGER_REL } from './lesson-core.mjs'
import { LLM_BASE_URL, LLM_MODEL, LLM_KEY_PATH, notePublishedAt, douyinPublishedAt, readCardSidecar, SHORT_COPY_SECTION, publishTextFor, PUBLISH_MUSIC, publishMusic } from './collect-note-core.mjs'
import { readIfThere } from './snapshot-read.mjs'
import { heatScore } from './viral-heat-core.mjs'
import { scriptDurationSec } from './video-harvest-core.mjs'
import { templateFingerprint } from './card-core.mjs'

/**
 * 生成落地链接（带 UTM）。
 * campaign 传文章 id（或文章里手填的「活动标识」）—— 这样每条内容的转化
 * 在统计后台能单独归因。传空 = 站点级链接，不拼 UTM（否则会出现 utm_source=unknown 这种噪声）。
 */
function landingFor(campaign = '') {
  const L = activeTarget.landing || {}
  const enabled = L.utm !== false && !!campaign
  const byPlatform = {}
  for (const [pf, v] of Object.entries(L.byPlatform || {})) {
    byPlatform[pf] = { url: withUtm(v.url, pf, campaign, enabled), placement: v.placement || '' }
  }
  return {
    primary: withUtm(L.primary, 'direct', campaign, enabled),
    byPlatform,
    utm: L.utm !== false,
    campaign,
  }
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CONTENT = join(ROOT, 'content')
const OUT = join(ROOT, 'src/data/generated.json')

/** LLM key 是否已配置（环境变量或 ~/.config/media-hub/dashscope.key） */
function keyConfigured() {
  if (process.env.DASHSCOPE_API_KEY) return true
  try {
    return readFileSync(join(process.env.HOME || '', '.config/media-hub/dashscope.key'), 'utf8').trim().length > 0
  } catch {
    return false
  }
}

const today = new Date()
today.setHours(0, 0, 0, 0)

/** 递归找 md 文件 */
function walk(dir, filter) {
  const out = []
  if (!existsSync(dir)) return out
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...walk(p, filter))
    else if (e.name.endsWith('.md') && filter(p)) out.push(p)
  }
  return out
}

/** 按 ## 标题切分 section，返回 name→body（name 已去掉括号后缀） */
function sections(md) {
  const map = {}
  const parts = md.split(/^## (.+)$/m)
  for (let i = 1; i < parts.length; i += 2) {
    const name = parts[i].replace(/[（(].*$/, '').trim()
    map[name] = (parts[i + 1] || '').trim()
  }
  return map
}

/** "- key：value" 列表 → 对象 */
function kvList(text) {
  const o = {}
  for (const line of (text || '').split('\n')) {
    const m = line.match(/^-\s*([^：:]+)[：:]\s*(.*)$/)
    if (m) o[m[1].trim()] = m[2].trim()
  }
  return o
}

/** "5000" / "1.2w" / "3.4千" / "12,000" → 数字，解析失败返回 null */
function toNumber(s) {
  if (!s) return null
  const m = String(s).replace(/,/g, '').match(/^([\d.]+)\s*([wW万千]?)$/)
  if (!m) return null
  const v = parseFloat(m[1])
  if (Number.isNaN(v)) return null
  return ['w', 'W', '万'].includes(m[2]) ? Math.round(v * 10000)
    : m[2] === '千' ? Math.round(v * 1000) : Math.round(v)
}

/** 账号身份 → 平台名。accounts.json 的 id 是号的身份（目录名 / md 里的「草稿已推-x」后缀 / 登录态键），
 *  platform 才决定版式。老登记没写 id，补齐后 id 就是平台名 —— 一平台一号的历史数据零迁移。
 *  accounts 在文件后段才初始化，这里按调用时点查（解析稿件时它已就位）。 */
const platformOf = (account) => accounts.find((a) => a.id === account)?.platform ?? account

function parseArticle(path) {
  const rel = relative(CONTENT, path).replaceAll('\\', '/')
  const md = readIfThere(path)
  if (md === null) return null // 列到它、读它之前被排期搬走了：这一轮没有这条稿，交给下面的 filter
  const sec = sections(md)
  const info = kvList(sec['创作信息'])
  const metricsRaw = kvList(sec['发布后数据'])
  const h1 = md.match(/^#\s+(.+)$/m)
  const fname = basename(path, '.md')
  const dateM = rel.match(/(\d{4}-\d{2}-\d{2})/)
  const date = dateM ? dateM[1] : null
  const am = rel.match(/(?:^|\/)发布排期\/([^/]+)\/(待发布|已排期)(?:\/|$)/)
  if (!am) throw new Error(`R4 违规：${rel} 不在 发布排期/<账号>/(待发布|已排期)/ 结构内`)
  const account = am[1]
  const stage = am[2] === '待发布' ? 'pending' : 'scheduled'
  // 「发布后数据」段里还混着「草稿已推-平台」「发布链接」这类非读数行：
  // 只有真数字才算回填过，否则界面会拿一个推送时间标出「✓ 已复盘」。
  const filled = Object.entries(metricsRaw).some(
    ([k, v]) => v !== '' && !/^(草稿已推|发布链接|发布日)/.test(k),
  )
  const unfence = (s) => (s || '').replace(/^```[a-z]*\n?/gm, '').replace(/```\s*$/gm, '').trim()
  // 两套 section 名并存：老模板「备忘录正文/话题标签」，逆向图文「正文/话题」
  const body = unfence(sec['备忘录正文'] || sec['正文'])
  // 界面展示与推草稿同源：短文案形态（抖音/快手/视频号图文、公众号贴图）真正发出去的是自己那一段，
  // 长正文是母本。把母本摆在最显眼的位置，验收时会盯着一段永远不发出去的文字。
  // 段名与形态只跟**平台**走：账号目录可能是「抖音-成长号」，取版式得先折算回平台名。
  const platform = platformOf(account)
  const shortSec = SHORT_COPY_SECTION[platform]
  const shortCopy = shortSec ? (sec[shortSec] || '').replace(/<!--[\s\S]*?-->/g, '').trim() : ''
  const copy = unfence(publishTextFor(platform, body, shortCopy))
  const copyLabel = !shortSec ? '正文' : shortSec === '贴图描述' ? '贴图描述' : '文案'

  // 平台级状态：发布链接-<平台> / 草稿已推-<平台>（Buffer 式泳道用它决定每个平台卡片停在哪一格）
  const publishLinks = {}
  for (const [k, v] of Object.entries(metricsRaw)) {
    const m = k.match(/^发布链接-(.+)$/)
    if (m && v) publishLinks[m[1]] = v
  }
  const publishedPlatforms = Object.keys(publishLinks)
  const draftPushed = {}
  for (const [k, v] of Object.entries(metricsRaw)) {
    const m = k.match(/^草稿已推-(.+)$/)
    if (m && v) draftPushed[m[1]] = v
  }

  let status
  // 【铁律】只有真的填了「发布链接」才算已发布 —— 排期日期到了 ≠ 发过了。
  // 旧逻辑把「已排期且日期≤今天」直接判为 published，导致内容一到日期就从
  // 待发队列里消失，发布日历的到期条（ready && date<=today）永远为空。
  if (metricsRaw['发布链接'] || publishedPlatforms.length) status = 'published'
  else if (stage === 'pending') status = body || copy ? 'creating' : 'not_start'
  else status = 'ready'

  return {
    id: fname,
    title: sec['标题'] || (h1 ? h1[1].trim() : fname.replace(/^\d{4}-\d{2}-\d{2}-/, '')),
    file: rel,
    date,
    stage,
    account,
    status,
    identity: info['身份主题'] || '',
    intent: info['创作意图'] || '',
    source: info['灵感来源'] || '',
    openingType: info['开头类型'] || '',
    /** 手填的转化活动标识（UTM campaign）。留空则用文章 id */
    campaign: info['活动标识'] || '',
    /** 归属品牌（创作信息「归属品牌」）：多品牌推广的分格字段，空 = 人格内容（不挂品牌） */
    product: normalizeProduct(info['归属品牌']),
    body,
    /** 这一版真正发出去的文字 + 它在稿里的段名（正文 / 文案 / 贴图描述） */
    copy,
    copyLabel,
    caption: unfence(sec['发布配文']),
    tags: sec['话题标签'] || sec['话题'] || '',
    firstComment: unfence(sec['首评引导']),
    /** 这一版会吃到的默认配乐（config/publish-music.json，脚本按平台决定用不用）；空 = 这个平台不配乐 */
    music: PUBLISH_MUSIC[platform] ? publishMusic(ROOT)?.title || '' : '',
    // 图卡与视频素材：同名 .json（render-cards 的输入）→ public/cards/<slug>/ 的页清单。
    // 创作台的「成果预览」读这个字段；纯文字稿为 null。
    card: readCardSidecar(`content/${rel}`, ROOT),
    metrics: {
      link: metricsRaw['发布链接'] || Object.values(publishLinks)[0] || '',
      views: toNumber(metricsRaw['播放量']),
      likes: toNumber(metricsRaw['点赞']),
      collects: toNumber(metricsRaw['收藏']),
      comments: toNumber(metricsRaw['评论数']),
      shares: toNumber(metricsRaw['分享数'] || metricsRaw['分享']),
      follows: toNumber(metricsRaw['关注转化']),
      completeRate: metricsRaw['完播率'] || metricsRaw['完读率'] || '',
      bounce: metricsRaw['划走率'] || '',
    },
    metricsFilled: filled,
    /** 读数状态：filled=有数 / platform_gap=平台给了这篇但没给这项 / not_collected=还没采到（backfillMetrics 按实况修正） */
    dataState: filled ? 'filled' : 'not_collected',
    /** 复盘学习环：T+3 后答「这篇教会了我们什么」（数据复盘页有输入位，写回本段） */
    lesson: sec['这篇教会了我们什么'] || '',
    publishedPlatforms,
    publishLinks,
    draftPushed,
    /** 平台 → 自动检测命中（{publishedAt, url}），由 detectPublished 在快照合并后回填；空 = 未判到 */
    detected: {},
    // 「## 转化数据」段（手填）：这条内容到底带来了什么转化。
    // 内容数据（点赞/曝光）只能说明传播，转化数据才能说明「值不值」。
    conversion: kvList(sec['转化数据']),
  }
}

/** 金句摘录：按分类 section 解析引用块 */
function parseQuotes() {
  const path = join(CONTENT, 'Resources/金句摘录.md')
  if (!existsSync(path)) return []
  const md = readFileSync(path, 'utf8')
  const quotes = []
  let category = ''
  let block = []
  const flush = () => {
    if (!block.length) return
    const textLines = []
    let source = ''
    for (const line of block) {
      const t = line.replace(/^>\s?/, '').trim()
      if (/^(——|—|--)/.test(t)) source = t.replace(/^(——|—|--)\s*/, '')
      else if (t && !t.startsWith('说明') && !t.startsWith('筛选')) textLines.push(t)
    }
    if (textLines.length) {
      quotes.push({
        id: `Q${quotes.length + 1}`,
        category,
        text: textLines.join('\n'),
        source,
      })
    }
    block = []
  }
  for (const line of md.split('\n')) {
    const h = line.match(/^##\s+(.+)$/)
    if (h) {
      flush()
      category = h[1].replace(/^[一二三四五六七八九十]+、\s*/, '')
      continue
    }
    if (/^>/.test(line)) block.push(line)
    else if (line.trim() === '') { if (block.length && block.some((b) => !/^>\s*$/.test(b))) flush() }
    else flush()
  }
  flush()
  // 文档开头（第一个 ## 之前）的说明性引用不算金句
  return quotes.filter((q) => q.category && q.text.length > 4)
}

/** 极简 frontmatter 解析：支持 `key: value` 与一层嵌套（两空格缩进），值自动去成对引号 */
function unquote(s) {
  const t = s.trim()
  if (t.length >= 2 && ((t[0] === '"' && t.at(-1) === '"') || (t[0] === "'" && t.at(-1) === "'"))) {
    return t.slice(1, -1)
  }
  return t
}

function parseFrontmatter(md) {
  const m = md.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/)
  if (!m) return { attrs: {}, body: md }
  const attrs = {}
  let current = null
  for (const line of m[1].split(/\r?\n/)) {
    const nested = line.match(/^ {2}([A-Za-z_][\w-]*):\s*(.*)$/)
    if (current && nested) {
      attrs[current][nested[1]] = unquote(nested[2])
      continue
    }
    const top = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/)
    if (top) {
      current = top[1]
      attrs[current] = top[2].trim() ? unquote(top[2]) : {}
    }
  }
  // 空值键（`author:` 后面什么都没有）先留一个空对象是给嵌套字段占位的；没人填就退回 ''。
  // 不退回的话下游 String(attrs.author || '') 拿到的是 {}，界面上就印成 "[object Object]"。
  for (const k of Object.keys(attrs)) {
    if (attrs[k] && typeof attrs[k] === 'object' && !Object.keys(attrs[k]).length) attrs[k] = ''
  }
  return { attrs, body: md.slice(m[0].length) }
}

/** 参考资料拆解块字段：口径见 content/Knowledge/爆款拆解.md（subject…mechanism 五层，五层是基准、允许加维度）；
 *  why 是详情右栏那一句话爆款理由，不在五层里 */
const ANALYSIS_KEYS = ['why', 'subject', 'hook', 'structure', 'emotion', 'mechanism']

/** 源图逐页清单：frontmatter sourceImages 是 public/ 下的目录——灵感库卡写裸目录名（落在 inspiration/），
 *  爆款采集卡带路径（viral/<平台>/<id>）；按文件名序（采集时即滑动顺序） */
function noteImages(dirName, cover) {
  if (!dirName) return [cover]
  const rel = String(dirName).includes('/') ? String(dirName) : `inspiration/${dirName}`
  try {
    return readdirSync(join(ROOT, 'public', rel))
      .filter((f) => /\.(webp|jpe?g|png)$/i.test(f))
      .sort()
      .map((f) => `/${rel}/${f}`)
  } catch {
    return [cover]
  }
}

/** 图文/视频形态：卡上有源片就是视频——源片只在详情页确认是视频后才落盘，比列表页猜的 format 可信。
 *  其次认采集时写下的 format；老卡按线索倒推
 *  （小红书/抖音的 /video/ 链接、采集卡引用行里的「视频笔记」标记），默认图文 */
function inferFormat(attrs, md = '') {
  if (attrs.videoFile || attrs.videoSrc) return 'video'
  const f = String(attrs.format || '')
  if (f === 'video' || f === 'image') return f
  const url = String(attrs.url || '')
  if (/\/video\//.test(url) || /^>[^\n]*视频笔记/m.test(md)) return 'video'
  return 'image'
}

/** 收藏卡只到索引、卡上没写日期；笔记/作品 ID 本身就编码了发布时间，解出来当展示与排序的兜底 */
function noteDateOf(noteId, attrs) {
  if (attrs.source !== 'favorite') return ''
  return attrs.platform === '抖音' ? douyinPublishedAt(noteId) : notePublishedAt(noteId)
}

/** 灵感库：只收 content/Inbox/采集笔记/（归档/ 子目录除外），且必须有封面——没封面的说明采集没拿全，不进工作台 */
function parseReadings() {
  const dir = join(CONTENT, 'Inbox/采集笔记')
  return walk(dir, (p) => basename(p) !== 'README.md' && !p.includes('归档')).map((p) => {
      const md = readIfThere(p)
      if (md === null) return null
      const { attrs, body } = parseFrontmatter(md)
      const coverImage = typeof attrs.coverImage === 'string' ? attrs.coverImage : ''
      if (!coverImage) return null
      const analysis = attrs.analysis && typeof attrs.analysis === 'object'
        ? Object.fromEntries(ANALYSIS_KEYS.filter((k) => attrs.analysis[k]).map((k) => [k, attrs.analysis[k]]))
        : null
      const analyzedAt = analysis && attrs.analyzedAt ? attrs.analyzedAt : null
      const h1 = body.match(/^#\s+(.+)$/m)
      const text = body
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/^---$/gm, '')
        .replace(/^#.*$/m, '')
        .replace(/^>.*$/gm, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim()
      const firstPara = text.split(/\n\s*\n/).find((s) => s.trim().length > 20) || ''
      return {
        id: basename(p, '.md'),
        title: h1 ? h1[1].trim() : basename(p, '.md'),
        file: relative(CONTENT, p).replaceAll('\\', '/'),
        chars: text.length,
        format: inferFormat(attrs, md),
        excerpt: firstPara.replace(/[*#>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 120),
        analysis,
        analyzedAt,
        tags: typeof attrs.tags === 'string' ? attrs.tags : '',
        source: typeof attrs.source === 'string' ? attrs.source : '',
        platform: typeof attrs.platform === 'string' ? attrs.platform : '',
        author: typeof attrs.author === 'string' ? attrs.author : '',
        url: typeof attrs.url === 'string' ? attrs.url : '',
        /** 发布时的那篇正文（详情页原话读回来的）：与「## 脚本」分两栏摆，老卡没写就是空 */
        desc: typeof attrs.desc === 'string' ? attrs.desc : '',
        coverImage,
        images: noteImages(attrs.sourceImages, coverImage),
        // 视频卡的源片落盘在 public/inspiration/<id>/source.mp4：详情弹层就地播，不用回原页
        videoUrl: typeof attrs.videoFile === 'string' && attrs.videoFile ? `/${attrs.videoFile}` : '',
        likes: attrs.noteData?.likes ?? null,
        collects: attrs.noteData?.collects ?? null,
        comments: attrs.noteData?.comments ?? null,
        postedAt: attrs.publishedAt || attrs.noteData?.postedAt || noteDateOf(basename(p, '.md'), attrs) || null,
        // 收藏搬运卡的入库日期（frontmatter collected）：卡上只有日期无时刻
        collectedAt: typeof attrs.collected === 'string' ? attrs.collected : '',
        // 收藏列表的序号（0 = 当时最新的一条）：每次同步都重刷，「最新收藏排最前」按它排
        favOrder: attrs.favOrder === undefined || attrs.favOrder === '' ? null : Number(attrs.favOrder),
        converted: String(attrs.convertedToTopic || ''),
        convertedTopic: '',
        script: cardScript(body),
        body: text,
      }
    })
    .filter(Boolean)
}

/** "1,598" / "2.78万" / "11.6%" / "6.3s" → number */
function toNum(v) {
  if (v == null || v === '') return null
  const t = String(v).replace(/,/g, '')
  const m = t.match(/-?\d+(?:\.\d+)?/)
  if (!m) return null
  const n = Number(m[0])
  return /万/.test(t) ? Math.round(n * 10000) : n
}

/**
 * 平台账号快照：读 metrics/raw/*.json（由 `npm run collect` 用 ego-browser 采集）
 * 一个文件 = 一个快照点（按采集日期）。累计量（粉丝/赞藏）可画趋势，周期量为区间值。
 */
function parseSnapshots() {
  const dir = join(ROOT, 'metrics/raw')
  if (!existsSync(dir)) return []

  const DAILY_KEYS = ['views', 'exposure', 'likes', 'collects', 'comments', 'shares', 'new_followers']

  const METRIC_KEYS = {
    xiaohongshu: ['曝光数', '观看数', '封面点击率', '视频完播率', '点赞数', '评论数', '收藏数', '分享数', '净涨粉', '新增关注', '取消关注', '主页访客'],
    douyin: ['播放量', '互动率', '完播率', '作品数', '粉丝净增', '总播放量', '总点赞量', '总分享量', '总评论量', '5秒完播率', '2秒跳出率', '封面点击率', '平均播放时长', '总粉丝量', '吸粉量', '脱粉量', '回访粉丝量'],
    kuaishou: ['播放量', '点赞量', '评论量', '分享量', '净增粉丝量', '完播率'],
    sph: ['净增粉丝量'],
  }

  const mapNotes = (notes = []) =>
    notes
      .map((row) => {
        const info = row['笔记基础信息'] || ''
        return {
          title: info.replace(/\s*发布于.*$/, '').replace(/^未通过\s*/, '').trim(),
          published: (info.match(/发布于\s*(\d{4}-\d{2}-\d{2} \d{2}:\d{2})/) || [])[1] || null,
          rejected: /^未通过/.test(info),
          exposure: toNum(row['曝光']),
          views: toNum(row['观看']),
          ctr: toNum(row['封面点击率']),
          likes: toNum(row['点赞']),
          comments: toNum(row['评论']),
          collects: toNum(row['收藏']),
          follows: toNum(row['涨粉']),
          shares: toNum(row['分享']),
          avgWatch: row['人均观看时长'] || null,
        }
      })
      .filter((n) => n.title)

  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try {
        return JSON.parse(readFileSync(join(dir, f), 'utf8'))
      } catch {
        console.warn(`[gen:data] 跳过无法解析的快照: metrics/raw/${f}`)
        return null
      }
    })
    .filter((raw) => raw && raw.date && raw.platforms)
    .map((raw) => {
      const platforms = {}
      // 五平台都要过（publish-check 采的 publishedList 不必有指标读数），指标只映射已登记的键
      for (const [name, p] of Object.entries(raw.platforms)) {
        if (!p) continue
        const metrics = {}
        for (const k of METRIC_KEYS[name] || []) {
          const v = p.metrics?.[k]
          if (v != null && v !== '') metrics[k] = toNum(v)
        }
        platforms[name] = {
          nickname: p.nickname || '',
          followers: p.followers ?? null,
          following: p.following ?? null,
          likesCollects: p.likesCollects ?? null,
          likes: p.likes ?? null,
          period: p.period || null,
          metrics,
          // publish-check 采的「已发布内容列表」：{title, publishedAt, url}，发布状态自动判定的输入
          publishedList: Array.isArray(p.publishedList)
            ? p.publishedList
                .filter((n) => n && n.title)
                .map((n) => ({ title: String(n.title), publishedAt: n.publishedAt || null, url: n.url || '' }))
            : [],
          daily: Array.isArray(p.daily)
            ? p.daily
                .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d?.date)))
                .map((d) => {
                  const o = { date: d.date }
                  for (const k of DAILY_KEYS) o[k] = d[k] ?? null
                  return o
                })
            : [],
          notes: mapNotes(p.notes),
        }
      }
      return { date: raw.date, collectedAt: raw.collectedAt || null, publishedListAt: raw.publishedListAt || null, platforms }
    })
    .sort((a, b) => a.date.localeCompare(b.date))
}

/** 采集卡的脚本段（拆解与创作的唯一材料，口径见 Knowledge/爆款拆解.md）：
 *  新卡写「## 脚本」，老卡只认「全文」与逐字／逐帧转录两类真正文——章节要点、读数、评论都不算脚本，
 *  宁可让界面显示「脚本还没采」，也不能拿摘要冒充原文。
 *  段名匹配必须容得下括号补充（如「## 脚本（拆解与创作的唯一材料）」）——采集卡里这是最常见的写法，
 *  只认裸「脚本」会让绝大多数卡明明写了却读不出来。
 *  引导性引用行（> 开头）不是脚本内容，剔掉后空段视为未采到。 */
const SCRIPT_SECTION = /^脚本$|^脚本[（(]|^全文$|逐字|逐帧/
/** 兜底：脚本没落在「## 脚本」段，而是写在补采段的子标题下（老卡常见）。
 *  只认真正文类子标题——「章节要点」「读数」「评论」「弹幕」都不算脚本。 */
const SCRIPT_SUB = /^#{3,4}\s*(完整脚本|口播逐字稿|逐字稿|视频转录|逐字转录)/
function cardScript(body) {
  const src = body || ''
  const sec = sections(src)
  const key = Object.keys(sec).find((k) => SCRIPT_SECTION.test(k))
  const text = key
    ? sec[key]
        .split('\n')
        .filter((l) => !/^>/.test(l))
        .join('\n')
        .trim()
    : ''
  if (text) return text
  // 本节是空的（只有一句「还没补采」的引导）：看看补采段的子标题下有没有真正文
  const lines = src.split('\n')
  const start = lines.findIndex((l) => SCRIPT_SUB.test(l))
  if (start < 0) return ''
  const level = (lines[start].match(/^#+/) || [''])[0].length
  const out = []
  for (let i = start + 1; i < lines.length; i++) {
    const h = lines[i].match(/^(#+)\s/)
    if (h && h[1].length <= level) break
    out.push(lines[i])
  }
  return out.join('\n').trim()
}

/** 爆款采集（自动线）：content/Inbox/爆款采集/ 里的卡片，同样必须有封面。归档/ 里是删掉的，不进列表。
 *  与灵感库的分工：那边是你手动整篇搬回来，这边是脚本按 config/viral.json 每天搜最热。 */
function parseViral() {
  const dir = join(CONTENT, 'Inbox/爆款采集')
  return walk(dir, (p) => basename(p) !== 'README.md' && !p.includes('归档'))
    .map((p) => {
      const md = readIfThere(p)
      if (md === null) return null
      const { attrs, body } = parseFrontmatter(md)
      const coverImage = typeof attrs.coverImage === 'string' ? attrs.coverImage : ''
      if (!coverImage) return null
      const analysis = attrs.analysis && typeof attrs.analysis === 'object'
        ? Object.fromEntries(ANALYSIS_KEYS.filter((k) => attrs.analysis[k]).map((k) => [k, attrs.analysis[k]]))
        : null
      const analyzedAt = analysis && attrs.analyzedAt ? attrs.analyzedAt : null
      return {
        id: basename(p, '.md'),
        platform: String(attrs.platform || 'xiaohongshu'),
        format: inferFormat(attrs, md),
        // 老卡片没写 publishedAt：发布日期本来就在笔记 ID 里，现场算，不必回填
        publishedAt: String(attrs.publishedAt || '') || notePublishedAt(basename(p, '.md')),
        title: String(attrs.title || basename(p, '.md')),
        /** 发布时的那篇正文（详情页原话读回来的）：与「## 脚本」分两栏摆，老卡没写就是空 */
        desc: String(attrs.desc || ''),
        /** 原笔记自带话题（详情页读回来的）：右栏排在发布文案下面 */
        tags: String(attrs.tags || ''),
        author: String(attrs.author || ''),
        likes: String(attrs.likes || ''),
        collects: String(attrs.collects || ''),
        comments: String(attrs.comments || ''),
        /** 互动分（赞1/藏2/评3，算法见 viral-heat-core）：模板库按它挑爆款，界面只显示这一个数 */
        heat: heatScore(attrs),
        /** 视频源片时长（秒）：采集时量到就用量到的，没写就从逐字稿末拍补；两者都没有才是 0 */
        durationSec: Number(attrs.durationSec || 0) || scriptDurationSec(cardScript(body)),
        coverImage,
        url: String(attrs.url || ''),
        // 采集时顺手搬回的源料：逐页原图目录 / 源片，缺哪个都意味着脚本只能人工补
        images: noteImages(attrs.sourceImages, coverImage),
        videoFile: String(attrs.videoFile || ''),
        keyword: String(attrs.keyword || ''),
        capturedAt: String(attrs.capturedAt || ''),
        converted: String(attrs.convertedToTopic || ''),
        convertedTopic: '',
        analysis: analysis && Object.keys(analysis).length ? analysis : null,
        analyzedAt,
        script: cardScript(body),
        researchScore: attrs.researchScore != null && attrs.researchScore !== '' ? Number(attrs.researchScore) : null,
        file: relative(CONTENT, p).replaceAll('\\', '/'),
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.capturedAt.localeCompare(a.capturedAt) || a.title.localeCompare(b.title))
}

/** 对标账号：每篇 md → benchmark 条目（frontmatter 元数据 + 数据快照 + 模式） */
const PLATFORM_BY_LABEL = { 小红书: 'xiaohongshu', 抖音: 'douyin' }
/** 空值与脏值统一收成 null，让界面能区分「没读到」和「读到了 0」 */
const numOr = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v))
function parseBenchmarks() {
  const dir = join(CONTENT, 'Resources/对标账号')
  // 归档子目录（归档/）不进对标列表
  return walk(dir, (p) => basename(p) !== 'README.md' && !p.includes('归档')).map((p) => {
    const md = readIfThere(p)
    if (md === null) return null
    const { attrs, body } = parseFrontmatter(md)
    const sec = sections(body)
    const snapshots = (sec['数据快照'] || '')
      .split('\n')
      .map((l) => l.match(/^-\s*(.+)$/)?.[1]?.trim())
      .filter(Boolean)
    const patterns = (sec['值得偷的模式'] || '')
      .split('\n')
      .map((l) => l.match(/^-\s*(.+)$/)?.[1]?.trim())
      .filter(Boolean)
    // 手动卡习惯写中文平台名，跟 PLATFORM_META 的 key 对不上就归不到一组
    const platform = PLATFORM_BY_LABEL[String(attrs.platform || '').trim()] || String(attrs.platform || '').trim()
    return {
      /** 昵称会撞车（抖音和小红书各有一个「小五狼」），id 必须带平台，否则界面 v-for 出重复行 */
      id: `${platform}:${basename(p, '.md')}`,
      nickname: attrs.nickname || basename(p, '.md'),
      platform,
      url: attrs.url || '',
      position: attrs.position || '',
      /** 账号自我介绍原文（自动线采平台主页那份），界面当「简介」展示 */
      desc: String(attrs.desc || ''),
      why: attrs.why || '',
      /** 站内头像路径（public/benchmarks/ 下），空 = 还没采到，界面回落平台色块 */
      avatar: String(attrs.avatar || ''),
      /** 建档时的综合分（粉丝量 45% × 近期爆款 35% × 活跃度 20%），列表按它倒序 */
      score: Number(attrs.score) || 0,
      /** 主页实测读数：榜单表格的列。缺值一律 null，界面显示 —，不拿 0 冒充「读到了 0」 */
      followers: numOr(attrs.followers),
      likesCollects: numOr(attrs.likesCollects),
      works: numOr(attrs.works),
      recentSample: numOr(attrs.recentSample),
      recentTopLikes: numOr(attrs.recentTopLikes),
      recentMedianLikes: numOr(attrs.recentMedianLikes),
      lastPublishDays: numOr(attrs.lastPublishDays),
      ipLocation: String(attrs.ipLocation || '').trim(),
      capturedAt: String(attrs.capturedAt || '').trim(),
      keywords: String(attrs.matchedKeywords || '')
        .split(/[,，、]/)
        .map((s) => s.trim())
        .filter(Boolean),
      snapshots,
      patterns,
      /** 相对 content/ 的档案路径：界面「不再对标」要拿它调归档端点 */
      file: relative(CONTENT, p).replaceAll('\\', '/'),
    }
  })
    .filter(Boolean)
}

/**
 * 「知识库」页：content/Knowledge/*.md 全文 → 结构化块，前端只读渲染。
 * 源文件是唯一事实源（R1），这里只切块，不复制、不改写正文。
 * `_` 前缀的页只给人看（如「我的版图」），不进 AI 注入 —— ai: false 由前端标注。
 */
function parseKnowledge() {
  const dir = join(CONTENT, 'Knowledge')
  if (!existsSync(dir)) return []

  const blocks = (text) => {
    const out = []
    const lines = text.split('\n')
    const cells = (l) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim())
    const isSep = (l) => /^\|[\s:|-]+\|$/.test(l.trim()) && l.includes('-')
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (!line.trim() || /^# /.test(line)) continue
      if (line.startsWith('```')) {
        const code = []
        while (i + 1 < lines.length && !lines[i + 1].startsWith('```')) code.push(lines[++i])
        i++
        out.push({ t: 'code', text: code.join('\n') })
      } else if (line.startsWith('### ')) {
        out.push({ t: 'h', text: line.slice(4).trim() })
      } else if (/^(- |\d+\. )/.test(line)) {
        // 编号列表把序号带下去（ordered）：评分体系的规则互相引用「第 6 条」「§四」，序号是内容
        const ordered = /^\d+\. /.test(line)
        const items = []
        while (i < lines.length && (/^(- |\d+\. )/.test(lines[i]) || /^\s{2,}\S/.test(lines[i]))) {
          if (/^(- |\d+\. )/.test(lines[i])) items.push(lines[i].replace(/^(- |\d+\. )/, '').trim())
          else if (items.length) items[items.length - 1] += ' ' + lines[i].trim()
          i++
        }
        i--
        out.push({ t: 'ul', items, ordered })
      } else if (line.startsWith('> ')) {
        const q = []
        while (i < lines.length && lines[i].startsWith('> ')) q.push(lines[i++].slice(2).trim())
        i--
        // 保留源文件的换行（账号简介靠逐行断句），前端用 whitespace-pre-line 渲染
        out.push({ t: 'quote', text: q.join('\n') })
      } else if (/^-{3,}$/.test(line.trim())) {
        out.push({ t: 'hr' })
      } else if (line.trim().startsWith('|') && isSep(lines[i + 1] || '')) {
        const head = cells(line)
        const rows = []
        i += 2
        while (i < lines.length && lines[i].trim().startsWith('|')) rows.push(cells(lines[i++]))
        i--
        out.push({ t: 'table', head, rows })
      } else {
        const p = [line.trim()]
        while (i + 1 < lines.length && lines[i + 1].trim() && !/^(```|# |- |\d+\. |> |-{3,}\s*$|\|)/.test(lines[i + 1])) p.push(lines[++i].trim())
        out.push({ t: 'p', text: p.join(' ') })
      }
    }
    return out
  }

  return readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .sort()
    .map((f) => {
      const raw = readIfThere(join(dir, f))
      if (raw === null) return null
      const md = raw.replace(/<!--[\s\S]*?-->/g, '')
      const title = (md.match(/^# (.+)$/m) || [, f.replace(/\.md$/, '')])[1].trim()
      const parts = md.split(/^## (.+)$/m)
      const sections = []
      for (let i = 1; i < parts.length; i += 2) {
        sections.push({ name: parts[i].replace(/[（(].*$/, '').trim(), blocks: blocks(parts[i + 1] || '') })
      }
      // 文件 mtime（本地日期，不带时区）：界面展示「更新于」，一眼看出哪篇最近动过
      const mtime = statSync(join(dir, f)).mtime
      const updated = `${mtime.getFullYear()}-${String(mtime.getMonth() + 1).padStart(2, '0')}-${String(mtime.getDate()).padStart(2, '0')}`
      return { file: f, title, ai: !f.startsWith('_'), updated, intro: blocks(parts[0] || ''), sections }
    })
    .filter(Boolean)
}

/**
 * 能力全景：读 config/capabilities.json 登记表，校验实体是否存在。
 * skill 项 → .agents/skills/<ref>/SKILL.md；script 项 → package.json scripts；ui 项不校验。
 * 未登记的本地 skill 落到 unregistered，提醒补登记。
 */
function parseCapabilities() {
  let reg
  try {
    reg = JSON.parse(readFileSync(join(ROOT, 'config/capabilities.json'), 'utf8'))
  } catch {
    console.warn('[gen:data] config/capabilities.json 缺失或不是合法 JSON，跳过能力面板')
    return null
  }
  const npmScripts = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).scripts || {}
  const registered = new Set()
  const stages = (reg.stages || []).map((s) => ({
    stage: s.stage,
    hint: s.hint || '',
    items: (s.items || []).map((it) => {
      let ok = false
      if (it.kind === 'skill') {
        registered.add(it.ref)
        ok = existsSync(join(ROOT, '.agents/skills', it.ref, 'SKILL.md'))
      } else if (it.kind === 'script') {
        ok = !!npmScripts[it.ref]
      } else if (it.kind === 'ui') {
        ok = true
      }
      return { ...it, status: ok ? 'ok' : 'missing' }
    }),
  }))
  const skillsDir = join(ROOT, '.agents/skills')
  const unregistered = existsSync(skillsDir)
    ? readdirSync(skillsDir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !registered.has(e.name) && existsSync(join(skillsDir, e.name, 'SKILL.md')))
        .map((e) => e.name)
    : []
  return {
    platforms: reg.platforms || [],
    stages,
    iron: reg.iron || '',
    external: reg.external || [],
    unregistered,
  }
}

/** 账号登记：config/accounts.json，账号页/发布泳道/数据复盘都用这一份。
 *  id = 账号身份（发布排期目录名、md 里「草稿已推-x」的后缀、登录态缓存的键），没写 id 的老登记按平台名补齐。
 *  hasScript = 本机是否真有这个号的一键推草稿脚本（创作台的「能不能推」用它） */
function parseAccounts() {
  try {
    const list = JSON.parse(readFileSync(join(ROOT, 'config/accounts.json'), 'utf8'))
    return (Array.isArray(list) ? list : []).map((a) => ({
      ...a,
      id: a.id || a.platform,
      hasScript: !!(a.script && existsSync(join(ROOT, a.script))),
    }))
  } catch {
    console.warn('[gen:data] config/accounts.json 缺失或不是合法 JSON，跳过账号页签')
    return []
  }
}

/** 品牌档案：config/products.json，多品牌推广的分格清单（日历筛选胶囊与选题「归属品牌」都读它）。
 *  数组顺序即筛选顺序；缺文件 = 还没开始多产品推广，返回空数组，界面不出现筛选行。
 *  两种写法都吃：字符串 = 只登记名字（老写法），对象 = 带入口/口径/截图的完整档案。 */
function parseProductProfiles() {
  try {
    const j = JSON.parse(readFileSync(join(ROOT, 'config/products.json'), 'utf8'))
    return (Array.isArray(j.products) ? j.products : [])
      .map((p) => (typeof p === 'string' ? { name: p } : p))
      .filter((p) => p && p.name)
  } catch {
    return []
  }
}
const productProfiles = parseProductProfiles()
const productNames = productProfiles.map((p) => p.name)

/** 类型注册表的界面那一半：品牌页的页签、素材槽、「那一行怎么问」、状态词全读它。
 *  界面不许自己再抄一张类型表——抄了就会和这里对不上。 */
const targetTypes = targetUi()

/** 方案库：config/playbooks.json，从爆款里拆出来的推广结构（页序 + 槽位 + 素材槽位）。
 *  「我们的同款」那一半给的是已经渲染出来的图卡产物：只带真存在的页，缺图就少带一页，
 *  不留一张点不开的破图在界面上。
 *  sample.texts 按 pages 的顺序把样张每页的文字槽位抽成字符串：一键同款的向导拿它预填，
 *  人改的是已经跑通过的话，不是从零编（只有同款产品才预填，别的产品的事实不能照抄）。 */
const SLOT_TEXT = {
  title: (p) => (p.title || []).map((t) => (Array.isArray(t) ? t[0] : t)).join('\n'),
  echo: (p) => p.echo || '',
  items: (p) => (p.items || []).map((x) => x.zh).join('\n'),
  cells: (p) =>
    (p.cells || [])
      .map((c) => [c.emoji, c.name].filter(Boolean).join(' ') + (c.meta ? ` · ${c.meta}` : ''))
      .join('\n'),
  names: (p) => p.names || '',
  caption: (p) => p.caption || '',
}
function parsePlaybooks() {
  try {
    const j = JSON.parse(readFileSync(join(ROOT, 'config/playbooks.json'), 'utf8'))
    return (Array.isArray(j.playbooks) ? j.playbooks : []).map((p) => {
      const slug = p?.sample?.slug || ''
      const pageNos = p?.sample?.pages || []
      const urls = slug
        ? pageNos
            .filter((n) => existsSync(join(ROOT, 'public/cards', slug, `${String(n).padStart(2, '0')}.png`)))
            .map((n) => `cards/${slug}/${String(n).padStart(2, '0')}.png`)
        : []
      let card = null
      try {
        card = JSON.parse(readFileSync(join(ROOT, 'content/Projects/卡片', `${slug}.json`), 'utf8'))
      } catch {
        card = null
      }
      const texts = pageNos.map((n) => {
        const page = card?.pages?.[n - 1]
        if (!page) return {}
        const out = {}
        for (const [k, pick] of Object.entries(SLOT_TEXT)) {
          const v = pick(page)
          if (v) out[k] = v
        }
        return out
      })
      return { ...p, sample: { slug, urls, product: card?.product || '', texts } }
    })
  } catch {
    return []
  }
}

/** 图文主题层（config/card-themes.json + config/card-layouts.json）：创作台选主题、
 *  以及「这个版式能不能换皮」的判定都读它。下划线开头的键是给人看的说明，不进 generated.json。
 *  渲染器独立读同一份文件，两边不各存一份色板。 */
function parseCardThemes() {
  const strip = (o) => Object.fromEntries(Object.entries(o || {}).filter(([k]) => !k.startsWith('_')))
  const read = (rel) => {
    try {
      return JSON.parse(readFileSync(join(ROOT, rel), 'utf8'))
    } catch {
      console.warn(`[gen:data] ${rel} 缺失或不是合法 JSON，主题选择器拿不到数据`)
      return null
    }
  }
  const t = strip(read('config/card-themes.json'))
  const l = strip(read('config/card-layouts.json'))
  return {
    themes: Array.isArray(t?.themes) ? t.themes : [],
    default: t?.default || '',
    fontStack: t?.fontStack || '',
    layouts: Array.isArray(l?.layouts) ? l.layouts : [],
  }
}

/** 图文模板目录（config/card-templates.json）：创作台「模板」选择器要列的那几钮。
 *  一条模板 = 一层皮肤 + 三个页面角色各用哪个版式；界面选中它之后，写回卡片 json 的是
 *  theme.id 和逐页 layout，模板本身不参与渲染（老卡片因此一个字段都不用加）。
 *  小样是预渲的——本机一页 10–15 秒，不可能一开选择器就现渲十几张。这里只报「图在不在、过没过期」，
 *  判据跟渲图脚本用同一个指纹函数：两边各写一遍就会漂移，漂移等于拿旧图冒充新皮。 */
async function parseCardTemplates() {
  const strip = (o) => Object.fromEntries(Object.entries(o || {}).filter(([k]) => !k.startsWith('_')))
  const read = (rel, quiet = false) => {
    try {
      return JSON.parse(readFileSync(join(ROOT, rel), 'utf8'))
    } catch {
      if (!quiet) console.warn(`[gen:data] ${rel} 缺失或不是合法 JSON，模板选择器拿不到数据`)
      return null
    }
  }
  const j = strip(read('config/card-templates.json'))
  const themes = read('config/card-themes.json', true)
  const demo = read('templates/cards/_demo.json', true)
  const manifest = read('public/cards/_templates/manifest.json', true)
  const items = manifest?.items || {}
  const templatesDir = join(ROOT, 'templates/cards')
  const templates = []
  for (const t of Array.isArray(j?.templates) ? j.templates : []) {
    const png = join(ROOT, 'public/cards/_templates', `${t.key}.png`)
    // 封面小样：只有 cover 与 body 不是同一个版式、且 _demo.json 备了那份示例时才要求存在
    const wantCover = !!(t.layouts?.cover && t.layouts.cover !== t.layouts.body && demo?.[t.layouts.cover])
    const coverPng = join(ROOT, 'public/cards/_templates', `${t.key}-cover.png`)
    let status = 'missing'
    try {
      const fp = await templateFingerprint({ template: t, themes, demo, templatesDir })
      const bytes = existsSync(png) ? statSync(png).size : 0
      const coverBytes = wantCover && existsSync(coverPng) ? statSync(coverPng).size : 0
      const fresh = items[t.key]?.fingerprint === fp && bytes >= 10_000 && (!wantCover || coverBytes >= 10_000)
      if (fresh) status = 'ready'
      // 图根本没渲过 = missing；渲过但指纹对不上（改了皮/版式/示例）或图小得可疑 = stale
      else status = bytes > 0 ? 'stale' : 'missing'
    } catch {
      status = 'missing'
    }
    templates.push({
      ...t,
      thumb: { url: `/cards/_templates/${t.key}.png`, status },
      coverThumb: wantCover ? `/cards/_templates/${t.key}-cover.png` : '',
    })
  }
  return { default: j?.default || '', templates }
}

/** 视频模板目录（config/video-templates.json）：素材库「视频模板」分区读这份。
 *  图文模板的小样是预渲 PNG，视频模板的小样是从成片上截的一帧 poster + 6 秒静音预览，
 *  两个文件都在仓里，所以这里只报「在不在」——不在就是这条登记写飘了（改了 key 没重截）。
 *  没成片的条目（needs-render）不给小样，界面据此显示「还没渲过」而不是裂图。 */
function parseVideoTemplates() {
  const strip = (o) => Object.fromEntries(Object.entries(o || {}).filter(([k]) => !k.startsWith('_')))
  let j = null
  try {
    j = strip(JSON.parse(readFileSync(join(ROOT, 'config/video-templates.json'), 'utf8')))
  } catch {
    console.warn('[gen:data] config/video-templates.json 缺失或不是合法 JSON，素材库视频分区拿不到数据')
    return { default: '', templates: [] }
  }
  const exists = (rel) => {
    if (!rel) return false
    // 以 / 开头的是界面 URL，落点在 public/ 下；其余按仓库根算（out/ 里的成片不进 public）
    const p = join(ROOT, rel.startsWith('/') ? `public${rel}` : rel)
    try {
      return statSync(p).size > 0
    } catch {
      return false
    }
  }
  const templates = (Array.isArray(j?.templates) ? j.templates : []).map((t) => ({
    ...t,
    posterReady: exists(t.poster),
    previewReady: exists(t.preview),
    filmReady: exists(t.film),
    projectReady: exists(`${t.project}/src/Root.tsx`),
  }))
  return { default: j?.default || '', templates }
}

/** 爆款采集口径（config/viral.json）：自动线在采什么——关键词、平台、门槛。
 *  改口径只动 config/viral.json（脚本不硬编码），这里原样透传给界面：
 *  锁在配置文件里等于黑盒，采集页必须一眼看得见「在采什么、什么算爆款」。 */
function parseViralConfig() {
  try {
    const j = JSON.parse(readFileSync(join(ROOT, 'config/viral.json'), 'utf8'))
    return {
      keywords: Array.isArray(j.keywords) ? j.keywords : [],
      platforms: Array.isArray(j.platforms) ? j.platforms : [],
      minLikes: j.minLikes ?? 0,
      minComments: j.minComments ?? 0,
      withinDays: j.withinDays ?? 0,
      dailyLimitPerPlatform: j.dailyLimitPerPlatform ?? 0,
      scrollRounds: j.scrollRounds ?? 0,
    }
  } catch {
    console.warn('[gen:data] config/viral.json 缺失或不是合法 JSON，采集口径不展示')
    return null
  }
}

/** 目标层三读数（播放/涨粉/变现）：config/goals.json，「今日」页目标卡消费；换指标或改目标值只改这个文件。
 *  target 为 null = 观察值（只记录不判达成）；manual 字段 = 从 metrics/revenue.json 手工取数 */
function parseGoals() {
  try {
    const j = JSON.parse(readFileSync(join(ROOT, 'config/goals.json'), 'utf8'))
    return Array.isArray(j.goals) ? j.goals : []
  } catch {
    console.warn('[gen:data] config/goals.json 缺失或不是合法 JSON，跳过今日目标')
    return []
  }
}

/** 变现月记录：metrics/revenue.json，每月人工回填一次（飞轮「目标→变现」无平台 API，只能手记） */
function parseRevenue() {
  try {
    const j = JSON.parse(readFileSync(join(ROOT, 'metrics/revenue.json'), 'utf8'))
    return j.months && typeof j.months === 'object' ? j.months : {}
  } catch {
    return {}
  }
}

/** 登录态缓存：metrics/login-state.json，由 publish-check 顺带落盘（本机本地，没体检过就没有） */
function parseLoginState() {
  try {
    const j = JSON.parse(readFileSync(join(ROOT, 'metrics/login-state.json'), 'utf8'))
    return j.platforms && typeof j.platforms === 'object' ? j : null
  } catch {
    return null
  }
}

/** 选题池：一张卡一个选题，bullet kv 解析（模板见 选题池/README.md）；归档/ 子目录是淘汰留痕，不进工作台 */
function parseTopics() {
  const dir = join(CONTENT, 'Projects/选题池')
  return walk(dir, (p) => basename(p) !== 'README.md' && !p.includes('归档')).map((p) => {
    const md = readIfThere(p)
    if (md === null) return null
    const h1 = md.match(/^#\s+(.+)$/m)
    const kv = kvList(md.replace(/^#.*$/m, ''))
    // 来源文件回链：选题详情/创作台展示的是采集卡上的拆解（analysis 块）与脚本（## 脚本段），
    // 两者只写回采集卡一处，这里只做解析。行尾常被追加括号备注（如「（已补齐脚本）」），
    // 只取到 .md 为止——取整行会让文件找不到，拆解与脚本一起消失，选题详情就只剩一个标题。
    // 卡底的赞·藏·评同理：展示的是来源爆款笔记的数据（立项依据），不是我们自己那条稿的。
    const sourceFile = (String(kv['来源文件'] || '').match(/[^\s（(]+\.md/) || [''])[0]
    let analysis = null
    let analyzedAt = null
    let sourceTitle = ''
    let sourceUrl = ''
    let likes = ''
    let collects = ''
    let comments = ''
    let format = ''
    // 完整脚本（视频＝全程口播逐字稿，图文＝逐页图内文字）与拆解一样只存采集卡一处，这里带出来给选题详情看。
    // 脚本是拆与写的唯一原料：选题详情要看得到它，才能判断这条值不值得立项。
    let script = ''
    // 采集卡也会在这一轮里被搬走（归档/改名）：读不到就按「这条没有拆解」办，不炸整轮重建
    const srcMd = sourceFile ? readIfThere(join(ROOT, sourceFile)) : null
    if (srcMd !== null) {
      const { attrs, body } = parseFrontmatter(srcMd)
      script = cardScript(body)
      if (attrs.analysis && typeof attrs.analysis === 'object') {
        const got = Object.fromEntries(ANALYSIS_KEYS.filter((k) => attrs.analysis[k]).map((k) => [k, attrs.analysis[k]]))
        analysis = Object.keys(got).length ? got : null
      }
      analyzedAt = analysis && attrs.analyzedAt ? String(attrs.analyzedAt) : null
      sourceTitle = typeof attrs.title === 'string' ? attrs.title : ''
      sourceUrl = String(attrs.url || '')
      const noteData = attrs.noteData && typeof attrs.noteData === 'object' ? attrs.noteData : {}
      likes = String(noteData.likes || attrs.likes || '')
      collects = String(noteData.collects || attrs.collects || '')
      comments = String(noteData.comments || attrs.comments || '')
      format = inferFormat(attrs, srcMd)
    }
    return {
      id: basename(p, '.md'),
      title: h1 ? h1[1].trim() : basename(p, '.md'),
      status: kv['状态'] || '待创作',
      source: kv['来源信号'] || '',
      judge: kv['判据自评'] || '',
      basis: kv['依据经验'] || '',
      sourceFile,
      sourceTitle,
      sourceUrl,
      analysis,
      analyzedAt,
      script,
      likes,
      collects,
      comments,
      format,
      // 产出形态（选题卡「产出形态」）：图文 or 视频，一条选题只走一条线。空 = 卡上还没写，界面按已产出的素材倒推
      form: kv['产出形态'] === '视频' ? 'video' : kv['产出形态'] === '图文' ? 'image' : '',
      // 选题不绑平台：立项时写入全部目标平台，各平台的稿在 发布排期/<平台>/待发布/ 下同名并存
      platforms: String(kv['立项平台'] || '').split(/\s+/).filter(Boolean),
      // 归属品牌：多品牌推广的分格字段，立项时随骨架写进各版稿；空 = 人格内容
      product: normalizeProduct(kv['归属品牌']),
      file: relative(CONTENT, p).replaceAll('\\', '/'),
    }
  }).filter(Boolean).sort((a, b) => a.title.localeCompare(b.title))
}

const snapshots = parseSnapshots()
const accounts = parseAccounts()
const goals = parseGoals()
const revenue = parseRevenue()

const articles = walk(join(CONTENT, 'Projects/发布排期'), (p) => basename(p) !== 'README.md')
  .map(parseArticle)
  .filter(Boolean)
  .sort((a, b) => (a.date || '9999').localeCompare(b.date || '9999'))
for (const a of articles) {
  if (!accounts.some((x) => x.id === a.account)) {
    throw new Error(`R4 违规：${a.file} 的账号目录「${a.account}」未在 config/accounts.json 登记`)
  }
}

// 每条内容带上自己的落地链接。campaign 优先用文章里手填的「活动标识」——
// 中文标题当 campaign 会被编码成长串，想要短链接就在 md 里手填一个 ASCII 标识。
for (const a of articles) a.landing = landingFor(a.campaign || a.id)

/* ==================== 发布状态自动检测 ====================
 * publish-check / collect 从各平台后台采「已发布内容列表」（platforms[key].publishedList；
 * 小红书另有逐篇 notes 可复用）。这里按标题与所属账号的列表匹配：归一化后精确或前缀包含
 * （平台会截断长标题），且发布时间不早于排期日 7 天前（容许提前发）→ 判该平台已发布，
 * 免去人工标记。md 里手填的「发布链接-平台」仍是最高优先（存量兼容）。
 * 匹配键见 titleAliases：跨平台改写让各平台标题与母题不同，光比母题会整平台漏判。 */
const normTitle = (s) => String(s).toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')

/** 一篇稿在某平台的候选标题：母题标题 + 这一版真正发出去的文案首行。
 *  跨平台改写后各平台标题不同（快手整篇只用文案首行做标题），只拿母题标题匹配会漏判。 */
function titleAliases(a) {
  const out = []
  const push = (s) => {
    const nt = normTitle(s)
    // 归一化后太短的行（纯 emoji、单个词）当别名会误命中别的稿
    if (nt.length >= 6 && !out.includes(nt)) out.push(nt)
  }
  push(a.title)
  const first = String(a.copy || '').split('\n').find((l) => l.trim())
  if (first) push(first)
  return out
}

function detectPublished() {
  // 账号名 → 全部快照合并后的已发布列表（归一化标题 → 条目），新快照覆盖旧值
  const lists = new Map()
  for (const acct of accounts) {
    const byNorm = new Map()
    for (const snap of snapshots) {
      const p = snap.platforms[acct.key]
      if (!p) continue
      const entries = [
        ...(p.notes || []).map((n) => ({ title: n.title, publishedAt: n.published, url: '' })),
        ...(p.publishedList || []),
      ]
      for (const n of entries) {
        const nt = normTitle(n.title)
        if (!nt) continue
        const prev = byNorm.get(nt)
        // 后到的不覆盖先到的读数：链接/时间任一有值就保留（notes 无链接、publishedList 有）
        byNorm.set(nt, {
          nt,
          title: n.title,
          publishedAt: prev?.publishedAt || n.publishedAt || null,
          url: prev?.url || n.url || '',
        })
      }
    }
    lists.set(acct.id, [...byNorm.values()])
  }

  const today = localDay()
  for (const a of articles) {
    const list = lists.get(a.account)
    const aliases = titleAliases(a)
    if (!list?.length || !aliases.length) continue
    // 精确优先，其次前缀包含（列表标题可能是被截断的稿标题）
    const hit =
      list.find((n) => aliases.includes(n.nt)) ||
      list.find((n) => aliases.some((nt) => n.nt.startsWith(nt) || nt.startsWith(n.nt)))
    if (!hit) continue
    const pubDay = String(hit.publishedAt || '').slice(0, 10)
    if (pubDay) {
      if (a.date && pubDay < shiftDay(a.date, -7)) continue
    } else if (a.date && a.date > today) {
      continue // 无发布时间读数时，至少要求排期日已到
    }
    a.detected[a.account] = { publishedAt: hit.publishedAt || null, url: hit.url || '' }
    if (a.status !== 'published') a.status = 'published'
  }
}
detectPublished()

/* ==================== 逐篇读数自动回填 ====================
 * 小红书后台给逐篇数据（platforms[key].notes）。匹配到就把数写进这篇稿的 metrics，
 * 省掉「发布后数据」段手抄一遍——手抄那份永远滞后，界面上的「已复盘」也就成了假读数。
 * 手填的值优先（人可能补了后台没有的项，如完播率）。 */
function backfillMetrics() {
  const byAccount = new Map()
  for (const acct of accounts) {
    const byNorm = new Map()
    for (const snap of snapshots) {
      for (const n of snap.platforms[acct.key]?.notes || []) {
        const nt = normTitle(n.title)
        if (nt) byNorm.set(nt, n) // 后采的覆盖先采的：平台会回补终值
      }
    }
    byAccount.set(acct.id, byNorm)
  }
  const numKeys = ['views', 'likes', 'collects', 'comments', 'shares', 'follows']
  for (const a of articles) {
    if (a.status !== 'published') continue
    const note = byAccount.get(a.account)?.get(normTitle(a.title))
    // 数据状态三态：机器采到了数 / 平台给了这篇但没数 / 还没采到（后台没这篇或没采）
    // 日历徽标据此说话，不把「机器还没采到」说成「人的活」
    if (note) {
      for (const k of numKeys) if (a.metrics[k] == null && note[k] != null) a.metrics[k] = note[k]
      if (!a.metrics.completeRate && note.avgWatch) a.metrics.completeRate = note.avgWatch
      const got = numKeys.some((k) => a.metrics[k] != null) || !!a.metrics.completeRate
      a.metricsFilled = got
      a.dataState = got ? 'filled' : 'platform_gap'
    } else {
      a.metricsFilled = numKeys.some((k) => a.metrics[k] != null) || !!a.metrics.completeRate
      a.dataState = a.metricsFilled ? 'filled' : 'not_collected'
    }
  }
}
backfillMetrics()

const quotes = parseQuotes()
const readings = parseReadings()
const viral = parseViral()
const benchmarks = parseBenchmarks()
const capabilities = parseCapabilities()
const knowledge = parseKnowledge()
const topics = parseTopics()

// 立项标记以选题卡为准（值 = 选题 id，界面据此跳转创作台）：
// frontmatter 的 convertedToTopic 只写了日期，手工建的选题卡又不走工作台入池流程、
// 采集卡上连标记都没有——两条路都收敛到「来源文件」回链，认不到选题卡的孤儿标记清掉，
// 采集卡回到工作集（选题卡被删时不再挂着「已立项」却找不到家）。
{
  const bySource = new Map(topics.filter((t) => t.sourceFile).map((t) => [t.sourceFile, t.id]))
  for (const c of [...readings, ...viral]) {
    c.convertedTopic = bySource.get(`content/${c.file}`) || ''
    if (!c.convertedTopic) c.converted = ''
  }
  // 同一条笔记在灵感库和爆款采集各存一份时，选题卡只回链其中一份；
  // 按笔记身份把「已选题」传给所有副本，两个工作列表都不会漏出用过的内容。
  propagateUsedTopics([...readings, ...viral])
}

/* ==================== 复盘学习环：结论索引 + 待复盘清单 ====================
 * 判据只住在 lesson-core 一处：界面和选题预审都读这一份产物，
 * 各算各的「该复盘哪些」会让页面上的数字和弹窗里的清单对不上。 */
const lessons = lessonIndex(articles)
const reviewDueList = reviewTopics(articles).map(({ title, date, days, files, primary }) => ({
  title,
  date,
  days,
  // 同题各平台的稿一起写回：结论是对这个题说的，不是对其中一版说的
  files,
  primary: primary.file,
}))
mkdirSync(dirname(join(ROOT, LEDGER_REL)), { recursive: true })
// 变了才写：metrics/ 在 watchDataDirs 的监听里，每轮都重摊一份等于 gen:data 自己唤醒自己，刷新永不停
const ledgerAbs = join(ROOT, LEDGER_REL)
const ledgerText = renderLedger(lessons)
if (!existsSync(ledgerAbs) || readFileSync(ledgerAbs, 'utf8') !== ledgerText) writeFileSync(ledgerAbs, ledgerText)

/* 图卡收进一张表：一个选题一张卡，五个平台稿共用，以前每张稿内嵌一份同样的东西
 * （110 篇稿内嵌 610KB，去重只有 26 张，475KB 是纯重复）。产物里改成 cards 表 + 稿上留 cardSlug，
 *  读的一方按引用补回 card（界面在 store.ts，演示与游客那份在 card-core 的 hydrateCards）。
 *  同名但内容不同的极少数情况不并表，那一版把卡留在自己稿上。 */
const cardTable = {}
for (const a of articles) {
  const c = a.card
  if (!c) continue
  const slug = c.slug || c.jsonRel
  if (!slug) continue
  const held = cardTable[slug]
  if (held && JSON.stringify(held) !== JSON.stringify(c)) continue
  cardTable[slug] = c
  a.cardSlug = slug
  delete a.card
}

const data = {
  generatedAt: new Date().toISOString(),  // 当前推广对象（来自 config/active-target.mjs）。界面上的「配置」面板读这里，
  // 所以前端不写死任何品牌信息——换产品只改 config，界面自动跟着变。
  target: {
    type: activeTarget.type,
    brandName: activeTarget.brandName,
    productPerspective: activeTarget.productPerspective,
    signature: activeTarget.signature,
    brandTag: activeTarget.brandTag,
    // 定位单一事实源（R2）：Knowledge/00-定位.md 全文透传，前端只读不抄
    positioning: (() => {
      const p = join(CONTENT, 'Knowledge/00-定位.md')
      return existsSync(p) ? readFileSync(p, 'utf8') : ''
    })(),
    // 站点级落地链接（无 campaign）；每条内容的版本见 article.landing
    landing: landingFor(''),
  },
  // 「数据」面板用：数据在哪、生成了多少、AI 走哪个模型
  site: {
    contentRoot: ROOT,
    contentDir: CONTENT,
    fileCount: {
      articles: articles.length,
      topics: topics.length,
      readings: readings.length,
      viral: viral.length,
      quotes: quotes.length,
      snapshots: snapshots.length,
      benchmarks: benchmarks.length,
      knowledge: knowledge.length,
    },
    llm: {
      baseUrl: LLM_BASE_URL,
      model: LLM_MODEL,
      keyPath: LLM_KEY_PATH,
      keyConfigured: keyConfigured(),
    },
  },
  articles,
  // 图卡表（短码 → 那一张卡）：各平台稿按 cardSlug 引用，见上面的收表
  cards: cardTable,
  topics,
  // 复盘学习环：已写结论的索引（数据复盘页与选题预审都读它），全文台账另落 metrics/lessons.md 给本机 Agent 读
  lessons,
  // 到 T+3 且还没写结论的稿（复盘页「待复盘」chip 的清单，逾期天数按发布日算）
  reviewDue: reviewDueList,
  quotes,
  readings,
  viral,
  snapshots,
  // 「今日」页目标卡用：目标层三读数（播放/涨粉/变现），口径见 config/goals.json
  goals,
  // 变现月记录（metrics/revenue.json），manual 目标取当前值
  revenue,
  benchmarks,
  // 「配置→能力」页签用：流水线各环节的能力登记 + 存在性校验结果
  capabilities,
  // 「知识库」页用：content/Knowledge/ 全部 md → 结构化块（R1 唯一知识源，前端只读）
  knowledge,
  // 账号登记（config/accounts.json）：一个号一条。id 是号的身份（目录名/登录态键），platform 决定版式。
  accounts,
  // 品牌登记（config/products.json）：多品牌推广的分格清单。界面上的品牌筛选与选题归属都读它
  products: productNames,
  // 品牌档案（同上文件的完整字段）：品牌页与一键同款读这里——入口、口径、真截图只此一处
  productProfiles,
  // 类型描述符（config/promotion-target.mjs 的 targetUi()）：品牌页与新建弹层的栏位问法、素材槽、状态词唯一来源
  targetTypes,
  // 方案库（config/playbooks.json）：推广结构 + 拆自哪条爆款 + 我们的同款产物
  playbooks: parsePlaybooks(),
  // 图文主题层（config/card-themes.json + card-layouts.json）：主题选择器的色板与「版式能不能换皮」
  cardThemes: parseCardThemes(),
  // 图文模板目录（config/card-templates.json）：选择器列的钮 + 每条的小样在不在/过没过期
  cardTemplates: await parseCardTemplates(),
  // 视频模板目录（config/video-templates.json）：素材库视频分区列的那几条，含小样/成片在不在
  videoTemplates: parseVideoTemplates(),
  // 爆款采集口径（config/viral.json）：采集页「当前采集口径」条读它——关键词/平台/门槛必须看得见
  viralConfig: parseViralConfig(),
  // 推草稿前的「能不能推」读数：各平台登录态与体检时间（publish-check 顺带落的 metrics/login-state.json）
  loginState: parseLoginState(),
  // 页头运行条用：每次采集任务的落盘留痕（metrics/collect-runs.json，逐平台结果从产物反推）
  collectRuns: readRuns(ROOT).slice(-40),
}

mkdirSync(join(ROOT, 'src/data'), { recursive: true })
// 原子落盘：同时开着多个 dev server 时，一次改动会并发跑多个 gen:data 重写同一个文件，
// 直接 writeFileSync 会让前端 fetch 到半截 JSON（store.ts 顶层 await 抛错 → 整页白屏）。
// tmp 名带 pid 避免互相覆盖，rename 同目录内原子，读方只会拿到完整的新版或旧版。
const tmpOut = `${OUT}.${process.pid}.tmp`
// 不带缩进：这份产物没人读它做 diff（已在 .gitignore），缩进白吃 0.56MB 的传输量
writeFileSync(tmpOut, JSON.stringify(data))
renameSync(tmpOut, OUT)
console.log(
  `[gen:data] ${articles.length} 篇排期文章 · ${topics.length} 个选题 · ${data.quotes.length} 条金句 · ${data.readings.length} 篇灵感库 · ${data.viral.length} 条爆款采集 · ${snapshots.length} 个平台快照 · ${data.benchmarks.length} 个对标账号 · ${knowledge.length} 篇知识 · ${lessons.length} 条复盘结论（待复盘 ${reviewDueList.length} 题）→ src/data/generated.json`,
)
