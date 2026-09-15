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
import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from 'node:fs'
import { join, dirname, relative, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { activeTarget } from '../config/active-target.mjs'
import { withUtm } from '../config/promotion-target.mjs'
import { LLM_BASE_URL, LLM_MODEL, LLM_KEY_PATH } from './collect-note-core.mjs'

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

function parseArticle(path) {
  const rel = relative(CONTENT, path).replaceAll('\\', '/')
  const md = readFileSync(path, 'utf8')
  const sec = sections(md)
  const info = kvList(sec['创作信息'])
  const metricsRaw = kvList(sec['发布后数据'])
  const h1 = md.match(/^#\s+(.+)$/m)
  const fname = basename(path, '.md')
  const dateM = rel.match(/(\d{4}-\d{2}-\d{2})/)
  const date = dateM ? dateM[1] : null
  const stage = rel.includes('待发布') ? 'pending' : 'scheduled'
  const filled = Object.values(metricsRaw).some((v) => v !== '')
  const unfence = (s) => (s || '').replace(/^```[a-z]*\n?/gm, '').replace(/```\s*$/gm, '').trim()
  const body = unfence(sec['备忘录正文'])

  let status
  // 【铁律】只有真的填了「发布链接」才算已发布 —— 排期日期到了 ≠ 发过了。
  // 旧逻辑把「已排期且日期≤今天」直接判为 published，导致内容一到日期就从
  // 待发队列里消失，发布中心的 dueList（ready && date<=today）永远为空。
  if (metricsRaw['发布链接']) status = 'published'
  else if (stage === 'pending') status = body ? 'creating' : 'not_start'
  else status = 'ready'

  return {
    id: fname,
    title: sec['标题'] || (h1 ? h1[1].trim() : fname.replace(/^\d{4}-\d{2}-\d{2}-/, '')),
    file: rel,
    date,
    stage,
    status,
    identity: info['身份主题'] || '',
    intent: info['创作意图'] || '',
    source: info['灵感来源'] || '',
    openingType: info['开头类型'] || '',
    /** 手填的转化活动标识（UTM campaign）。留空则用文章 id */
    campaign: info['活动标识'] || '',
    body,
    caption: unfence(sec['发布配文']),
    tags: sec['话题标签'] || '',
    firstComment: unfence(sec['首评引导']),
    metrics: {
      link: metricsRaw['发布链接'] || '',
      views: toNumber(metricsRaw['播放量']),
      likes: toNumber(metricsRaw['点赞']),
      collects: toNumber(metricsRaw['收藏']),
      comments: toNumber(metricsRaw['评论数']),
      follows: toNumber(metricsRaw['关注转化']),
      bounce: metricsRaw['划走率'] || '',
    },
    metricsFilled: filled,
    // 「## 转化数据」段（手填）：这条内容到底带来了什么转化。
    // 内容数据（点赞/曝光）只能说明传播，转化数据才能说明「值不值」。
    conversion: kvList(sec['转化数据']),
  }
}

/** 金句摘录：按分类 section 解析引用块 */
function parseQuotes() {
  const path = join(CONTENT, '自媒体运营/创作素材/金句摘录.md')
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
  return { attrs, body: md.slice(m[0].length) }
}

/** 参考资料：每篇 md → 阅读条目（frontmatter 里可有 analysis 拆解块） */
const ANALYSIS_KEYS = ['titleStructure', 'hook', 'structure', 'steal', 'topics']

function parseReadings() {
  const dir = join(CONTENT, '参考资料')
  // 归档子目录（归档/）不进灵感库
  return walk(dir, (p) => basename(p) !== 'README.md' && !p.includes('归档')).map((p) => {
    const md = readFileSync(p, 'utf8')
    const { attrs, body } = parseFrontmatter(md)
    const analysis = attrs.analysis && typeof attrs.analysis === 'object'
      ? Object.fromEntries(ANALYSIS_KEYS.filter((k) => attrs.analysis[k]).map((k) => [k, attrs.analysis[k]]))
      : null
    const analyzedAt = analysis && attrs.analyzedAt ? attrs.analyzedAt : null
    const h1 = body.match(/^#\s+(.+)$/m)
    const text = body.replace(/^---$/gm, '').replace(/^#.*$/m, '').replace(/^>.*$/gm, '').trim()
    const firstPara = text.split(/\n\s*\n/).find((s) => s.trim().length > 20) || ''
    return {
      id: basename(p, '.md'),
      title: h1 ? h1[1].trim() : basename(p, '.md'),
      file: relative(CONTENT, p).replaceAll('\\', '/'),
      chars: text.length,
      excerpt: firstPara.replace(/[*#>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 120),
      analysis,
      analyzedAt,
      tags: typeof attrs.tags === 'string' ? attrs.tags : '',
      source: typeof attrs.source === 'string' ? attrs.source : '',
      url: typeof attrs.url === 'string' ? attrs.url : '',
      coverImage: typeof attrs.coverImage === 'string' ? attrs.coverImage : '',
      likes: attrs.noteData?.likes ?? null,
      collects: attrs.noteData?.collects ?? null,
      comments: attrs.noteData?.comments ?? null,
      postedAt: attrs.noteData?.postedAt ?? null,
      body: text,
    }
  })
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

  const METRIC_KEYS = {
    xiaohongshu: ['曝光数', '观看数', '封面点击率', '视频完播率', '点赞数', '评论数', '收藏数', '分享数', '净涨粉', '新增关注', '取消关注', '主页访客'],
    douyin: ['播放量', '互动率', '完播率', '作品数', '粉丝净增', '总播放量', '总点赞量', '总分享量', '总评论量', '5秒完播率', '2秒跳出率', '封面点击率', '平均播放时长', '总粉丝量', '吸粉量', '脱粉量', '回访粉丝量'],
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
      for (const [name, keys] of Object.entries(METRIC_KEYS)) {
        const p = raw.platforms[name]
        if (!p) continue
        const metrics = {}
        for (const k of keys) {
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
          notes: mapNotes(p.notes),
        }
      }
      return { date: raw.date, collectedAt: raw.collectedAt || null, platforms }
    })
    .sort((a, b) => a.date.localeCompare(b.date))
}

/** 对标账号：每篇 md → benchmark 条目（frontmatter 元数据 + 数据快照 + 模式） */
function parseBenchmarks() {
  const dir = join(CONTENT, '自媒体运营/对标账号')
  // 归档子目录（归档/）不进灵感库
  return walk(dir, (p) => basename(p) !== 'README.md' && !p.includes('归档')).map((p) => {
    const md = readFileSync(p, 'utf8')
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
    return {
      id: basename(p, '.md'),
      nickname: attrs.nickname || basename(p, '.md'),
      platform: attrs.platform || '',
      url: attrs.url || '',
      position: attrs.position || '',
      why: attrs.why || '',
      snapshots,
      patterns,
    }
  })
}

/** 封面参考：每篇 md → cover 条目（frontmatter 元数据，图片放 public/covers/） */
function parseCovers() {
  const dir = join(CONTENT, '自媒体运营/封面参考')
  return walk(dir, (p) => basename(p) !== 'README.md').map((p) => {
    const { attrs } = parseFrontmatter(readFileSync(p, 'utf8'))
    const h1 = readFileSync(p, 'utf8').match(/^#\s+(.+)$/m)
    return {
      id: basename(p, '.md'),
      title: attrs.title || (h1 ? h1[1].trim() : basename(p, '.md')),
      source: attrs.source || '',
      style: attrs.style || '',
      scene: attrs.scene || '',
      why: attrs.why || '',
      image: attrs.image || '',
    }
  })
}

const articles = walk(join(CONTENT, '自媒体运营/发布排期'), (p) => basename(p) !== 'README.md')
  .map(parseArticle)
  .sort((a, b) => (a.date || '9999').localeCompare(b.date || '9999'))

// 每条内容带上自己的落地链接。campaign 优先用文章里手填的「活动标识」——
// 中文标题当 campaign 会被编码成长串，想要短链接就在 md 里手填一个 ASCII 标识。
for (const a of articles) a.landing = landingFor(a.campaign || a.id)

const snapshots = parseSnapshots()
const quotes = parseQuotes()
const readings = parseReadings()
const benchmarks = parseBenchmarks()
const covers = parseCovers()

const data = {
  generatedAt: new Date().toISOString(),
  // 当前推广对象（来自 config/active-target.mjs）。界面上的「配置」面板读这里，
  // 所以前端不写死任何品牌信息——换产品只改 config，界面自动跟着变。
  target: {
    type: activeTarget.type,
    brandName: activeTarget.brandName,
    accountPositioning: activeTarget.accountPositioning,
    productPerspective: activeTarget.productPerspective,
    tone: activeTarget.tone,
    topics: activeTarget.topics,
    signature: activeTarget.signature,
    brandTag: activeTarget.brandTag,
    handbookPath: activeTarget.handbookPath,
    // 站点级落地链接（无 campaign）；每条内容的版本见 article.landing
    landing: landingFor(''),
  },
  // 「数据」面板用：数据在哪、生成了多少、AI 走哪个模型
  site: {
    contentRoot: ROOT,
    contentDir: CONTENT,
    fileCount: {
      articles: articles.length,
      readings: readings.length,
      quotes: quotes.length,
      snapshots: snapshots.length,
      benchmarks: benchmarks.length,
      covers: covers.length,
    },
    llm: {
      baseUrl: LLM_BASE_URL,
      model: LLM_MODEL,
      keyPath: LLM_KEY_PATH,
      keyConfigured: keyConfigured(),
    },
  },
  articles,
  quotes,
  readings,
  snapshots,
  benchmarks,
  covers,
}

mkdirSync(join(ROOT, 'src/data'), { recursive: true })
writeFileSync(OUT, JSON.stringify(data, null, 1))
console.log(
  `[gen:data] ${articles.length} 篇排期文章 · ${data.quotes.length} 条金句 · ${data.readings.length} 篇参考资料 · ${snapshots.length} 个平台快照 · ${data.benchmarks.length} 个对标账号 · ${data.covers.length} 条封面参考 → src/data/generated.json`,
)
