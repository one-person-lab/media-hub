/**
 * 采集落盘核心：命令行（collect-note.mjs / ego）与 dev server 端点（vite.config /__collect）共用。
 * 输入一份笔记数据，输出「参考资料 md + 首图」；脚本与拆解由服务端收尾当场自动补（不编造）。
 */
import { writeFileSync, mkdirSync, readFileSync, existsSync, unlinkSync, renameSync, readdirSync } from 'node:fs'
import { join, dirname, basename, resolve, sep, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { activeTarget } from '../config/active-target.mjs'
import { targetForDraft } from './target-registry.mjs'
import { normalizeProduct } from './products-core.mjs'
import { swapSection } from './refine-core.mjs'
import { localDay } from './day-core.mjs'

// 仓库根目录：优先环境变量，否则由本文件位置推导（不要把个人绝对路径写死进仓库）
export const MEDIA_HUB_ROOT =
  process.env.MEDIA_HUB_ROOT || resolve(dirname(fileURLToPath(import.meta.url)), '..')

const DEFAULT_SYSTEM_DIRS = ['/opt/homebrew/bin', '/usr/local/bin']

/** 包内二进制目录：开发态在仓库 bin/，打包态在 Electron 的 resources/bin。
 *  第五期 electron-builder 把 bin/ 原样当 extraResources 搬进 resources/，这里不用改。 */
export function vendorBinDir({ root = MEDIA_HUB_ROOT, arch = process.arch, resourcesPath = process.resourcesPath } = {}) {
  const base = resourcesPath ? join(resourcesPath, 'bin') : join(root, 'bin')
  return join(base, `darwin-${arch}`)
}

/** ego 内嵌 Node 与 Electron 的 PATH 常常不含 Homebrew，直接 spawn 'ffmpeg' 会静默失败。
 *  查找顺序：包内（取料脚本下载的）→ Homebrew → /usr/local → 裸名交给系统 PATH。 */
export function toolBin(name, { root = MEDIA_HUB_ROOT, arch = process.arch, systemDirs = DEFAULT_SYSTEM_DIRS } = {}) {
  const inPackage = join(vendorBinDir({ root, arch }), name)
  if (existsSync(inPackage)) return inPackage
  for (const dir of systemDirs) {
    const p = join(dir, name)
    if (existsSync(p)) return p
  }
  return name
}

/** 源片里到底有没有音轨：抖音的 DASH 常只拉到画面轨，哑片能 OCR 硬字幕但不能语音转写 */
export async function hasAudioStream(file) {
  try {
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const { stdout } = await promisify(execFile)(
      toolBin('ffprobe'),
      ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', file],
    )
    return stdout.trim().length > 0
  } catch {
    return false
  }
}

/**
 * 小红书笔记 ID 前 8 位是 16 进制的发布时间戳，不打开笔记就能拿到它哪天发的。
 * 爆款采集据此筛掉旧内容：多看一眼页面都要撞风控，而 ID 已经在手上了。
 * 解不出（ID 规则变了 / 本来就不是笔记 ID）返回空串，丢不丢由调用方定。
 */
export function notePublishedAt(noteId) {
  const hex = String(noteId || '').slice(0, 8)
  if (!/^[0-9a-f]{8}$/.test(hex)) return ''
  const ts = parseInt(hex, 16)
  // 2000 年之前或明天之后都算不合理，宁可判成「不知道」也不误判成「很新」
  const now = Math.floor(Date.now() / 1000)
  if (ts < 946684800 || ts > now + 86400) return ''
  const d = new Date(ts * 1000)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/**
 * 抖音作品 ID 是雪花号，高 32 位是秒级时间戳——不用点进视频就知道它哪天发的。
 * 注意不能拿 notePublishedAt 凑：抖音 ID 前 8 位恰好也是数字，会被误当成十六进制解出个假日期。
 */
export function douyinPublishedAt(awemeId) {
  const s = String(awemeId || '')
  if (!/^\d{15,20}$/.test(s)) return ''
  const ts = Number(BigInt(s) >> 32n)
  const now = Math.floor(Date.now() / 1000)
  if (ts < 946684800 || ts > now + 86400) return ''
  const d = new Date(ts * 1000)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** 笔记标题 → 安全文件名（源图目录与 md 同名，两边对得上） */
export function safeNoteName(title) {
  return (title || '未命名笔记')
    .replace(/[/\\:*?"<>|\n\r\t]/g, '')
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]/gu, '')
    .trim()
    .slice(0, 40)
}

/** 比对用的归一化：剥掉标点、空白与 emoji，只留文字与数字 */
const normTitle = (s) => String(s || '').replace(/[^\p{L}\p{N}]/gu, '')

/** 标题防错（它同时是采集卡/选题卡/待发布稿的文件名）：抖音页面的 h1 有时根本不是作品标题，
 *  而是账号名（「某某的抖音」）或我们自己的统一署名——09-28 就把「醒醒老己」采成了卡名。
 *  命中这两种情况或撞上自家署名，就改用正文首句，别让文件名跟内容对不上。 */
export function sanitizeTitle(data) {
  const t = String(data.title || '').trim()
  const author = String(data.author || '').trim()
  const own = [activeTarget.signature, activeTarget.brandName, ...(activeTarget.accountNames || [])]
    .map(normTitle)
    .filter(Boolean)
  const bad =
    !t ||
    (!!author && normTitle(t) === normTitle(author)) ||
    /(的)?(抖音|小红书|快手|视频号|微博)$/.test(t) ||
    own.includes(normTitle(t))
  if (!bad) return t
  const head = String(data.desc || '')
    .replace(/#[^\s#]+/g, '')
    .trim()
  return (head.match(/^[^。！？!?]{2,}?[。！？!?]/) || [head.slice(0, 30)])[0].trim() || t
}

/** 下载数据里的首图 → public/inspiration/<id>.jpg，返回站点内路径（失败返回空串） */
export async function downloadImage(imageUrl, noteId, root = MEDIA_HUB_ROOT) {
  if (!imageUrl) return ''
  try {
    const res = await fetch(imageUrl)
    if (!res.ok) return ''
    const buf = Buffer.from(await res.arrayBuffer())
    mkdirSync(join(root, 'public/inspiration'), { recursive: true })
    const file = join(root, 'public/inspiration', `${noteId}.jpg`)
    writeFileSync(file, buf)
    return `/inspiration/${noteId}.jpg`
  } catch {
    return ''
  }
}

/** 下载轮播全部源图 → public/inspiration/<noteId>/page-NN.<ext>，按滑动顺序编号。
 *  只存首图等于把原版排版丢了——「复刻爆款」必须先看到每一页长什么样。
 *  放 public/ 是因为 content/ 下的文件浏览器拿不到，工作台要看原笔记每一页。 */
export async function downloadSourceImages(imageUrls, noteId, root = MEDIA_HUB_ROOT) {
  const urls = (imageUrls || []).filter(Boolean)
  if (!urls.length) return { dir: '', count: 0 }
  mkdirSync(join(root, 'public/inspiration', noteId), { recursive: true })
  let count = 0
  for (let i = 0; i < urls.length; i++) {
    try {
      const res = await fetch(urls[i])
      if (!res.ok) continue
      const type = res.headers.get('content-type') || ''
      const ext = type.includes('jpeg') || type.includes('jpg') ? 'jpg' : type.includes('png') ? 'png' : 'webp'
      const file = `page-${String(i + 1).padStart(2, '0')}.${ext}`
      writeFileSync(join(root, 'public/inspiration', noteId, file), Buffer.from(await res.arrayBuffer()))
      count++
    } catch { /* 单页失败不影响其余页 */ }
  }
  return { dir: count ? noteId : '', count }
}

/** 视频卡把源片也搬回家 → public/inspiration/<noteId>/source.mp4，返回 public 下相对路径（拿不到返回空串）。
 *  直链是签名地址，几小时就 403：不趁刚采到时落盘，工作台只能看一张封面帧，「补扒脚本」也得回原页重采。
 *  60s 硬超时——扩展弹窗在等这个响应，宁可少一个源片也不能把入库卡死。 */
export async function downloadSourceVideo(videoSrc, noteId, referer = '', root = MEDIA_HUB_ROOT, expectDur = 0) {
  if (!videoSrc) return ''
  const rel = `inspiration/${noteId}/source.mp4`
  if (existsSync(join(root, 'public', rel))) return rel
  try {
    const res = await fetch(videoSrc, {
      headers: { 'User-Agent': 'Mozilla/5.0', Referer: referer },
      redirect: 'follow',
      signal: AbortSignal.timeout(60_000),
    })
    if (!res.ok) return ''
    const buf = Buffer.from(await res.arrayBuffer())
    // 签名过期时 CDN 回的是几百字节的错误页，存下来只会得到一个播不了的假文件
    if (buf.length < 100_000) return ''
    // 时长对不上 = 下回来的不是这条作品（直链常是信息流里别条的）。宁可没源片，也不留一条错片：
    // 09-28 那条「做成大事」就是这么存进同页前一条的片子，脚本整段成了别人的话
    if (expectDur) {
      const got = await probeDuration(join(root, 'public', rel), buf)
      if (got && Math.abs(got - expectDur) > 2) return ''
    }
    mkdirSync(join(root, 'public/inspiration', noteId), { recursive: true })
    writeFileSync(join(root, 'public', rel), buf)
    return rel
  } catch {
    return ''
  }
}

/** 读一段 mp4 的时长（先写临时文件再 ffprobe）；读不出返回 0，不参与判断 */
async function probeDuration(target, buf) {
  const tmp = `${target}.probe-${Date.now()}.mp4`
  try {
    mkdirSync(dirname(tmp), { recursive: true })
    writeFileSync(tmp, buf)
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const { stdout } = await promisify(execFile)(
      toolBin('ffprobe'),
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', tmp],
    )
    return Number(stdout.trim()) || 0
  } catch {
    return 0
  } finally {
    try { unlinkSync(tmp) } catch {}
  }
}

/** 生成参考资料 md 并落盘。目标文件已存在时，自动保留旧的 analysis 拆解与 convertedToTopic 标记（重采不冲掉人工成果） */
export function writeNoteMd(data, url, imagePath, root = MEDIA_HUB_ROOT) {
  const today = localDay()
  const safeName = safeNoteName(data.title)
  const file = join(root, 'content/Inbox/采集笔记', `${safeName}.md`)
  const platform = data.platform || '小红书'

  // 重采保护：旧文件里有 analysis 就提取出来重新注入
  let keepAnalysis = ''
  let keepConverted = ''
  let keepVideoFile = ''
  try {
    const old = readFileSync(file, 'utf8')
    const m = old.match(/\n(analysis:\n(?:  .*\n)+analyzedAt: [^\n]+\n)/)
    if (m) keepAnalysis = m[1]
    const c = old.match(/^convertedToTopic: .*$\n/m)
    if (c) keepConverted = c[0]
    const vf = old.match(/^videoFile: .*$\n/m)
    if (vf) keepVideoFile = vf[0]
  } catch {}

  const videoFile = data.videoFile || keepVideoFile.replace(/^videoFile:\s*/, '').trim()
  const videoFileLine = videoFile ? `videoFile: ${videoFile}\n` : ''

  const md = `---
source: ${data.source || `${platform} @${data.author || '未知'}`}
url: ${url}
collected: ${today}
platform: ${platform}
${data.videoSrc ? `videoSrc: ${data.videoSrc}\n` : ''}${data.format === 'video' ? 'format: video\n' : ''}noteData:
  likes: ${data.likes || ''}
  collects: ${data.collects || ''}
  comments: ${data.comments || ''}
  postedAt: ${data.postedAt || ''}
tags: ${Array.isArray(data.tags) ? data.tags.join(' ') : data.tags || ''}
coverImage: ${imagePath}
sourceImages: ${data.sourceImages?.dir || ''}
${videoFileLine}${keepConverted}${keepAnalysis}---

# ${data.title || safeName}

> ${data.author || ''} · ${data.postedAt || ''} · 赞 ${data.likes || '-'} / 藏 ${data.collects || '-'} / 评 ${data.comments || '-'}
> 原文：${url}
${data.sourceImages?.count ? `> 源图：\`public/inspiration/${data.sourceImages.dir}/\`（${data.sourceImages.count} 页，按滑动顺序）——复刻前先翻原版排版，别凭印象排版；工作台详情页逐页可看\n` : ''}${videoFile ? `> 源片：\`public/${videoFile}\`——工作台详情弹层就地播，复刻时对着原版看节奏\n` : ''}

${data.desc}`

  writeFileSync(file, md)
  return { file, rel: `content/Inbox/采集笔记/${safeName}.md`, videoFile, keptAnalysis: !!keepAnalysis, converted: keepConverted.match(/:\s*(.+)$/)?.[1]?.trim() || '' }
}

/** 扩展截的视频帧（dataURL）直接落盘当封面——详情页 poster 常是黑帧，截帧才是真画面 */
export function saveDataImage(dataUrl, noteId, root = MEDIA_HUB_ROOT) {
  const m = String(dataUrl || '').match(/^data:image\/(jpeg|jpg|png|webp);base64,([A-Za-z0-9+/=]+)/)
  if (!m) return ''
  try {
    mkdirSync(join(root, 'public/inspiration'), { recursive: true })
    const file = join(root, 'public/inspiration', `${noteId}.jpg`)
    writeFileSync(file, Buffer.from(m[2], 'base64'))
    return `/inspiration/${noteId}.jpg`
  } catch {
    return ''
  }
}

/** 端点总入口：校验 → 下载图 → 写 md。返回给前端的 JSON */
export async function handleCollect(payload) {
  let { url, imageData, ...data } = payload || {}
  if (!url || (!data.title && !data.desc)) {
    throw new Error('payload 需要至少包含 url + (title|desc)')
  }
  data.title = sanitizeTitle(data)
  // 平台从链接认，不信任 payload：抖音作品 ID 是纯数字，小红书笔记 ID 是十六进制
  // 沉浸弹窗形态（搜索/精选页 ?modal_id=<id>）也认，md 里统一换成规范作品链接——带参数的搜索页 URL 会过期
  let dy = url.match(/douyin\.com\/(video|note)\/(\d{15,20})/)
  if (!dy && /douyin\.com/.test(url)) {
    const mid = url.match(/[?&]modal_id=(\d{15,20})/)
    if (mid) dy = [mid[0], data.format === 'image' ? 'note' : 'video', mid[1]]
  }
  if (dy) {
    url = `https://www.douyin.com/${dy[1]}/${dy[2]}`
    data.platform = '抖音'
    if (!data.postedAt) data.postedAt = douyinPublishedAt(dy[2])
  }
  const noteId = dy ? dy[2] : (url.match(/\/explore\/([0-9a-f]+)/) || [])[1] || `note-${Date.now()}`
  // 视频帖没有「逐页源图」可言：别把封面当第一页存进图集，详情弹层会误标「原笔记 1 页」
  const imageUrls = data.format === 'video' ? [] : data.images?.length ? data.images : data.image ? [data.image] : []
  data.sourceImages = await downloadSourceImages(imageUrls, noteId)
  const imagePath = saveDataImage(imageData, noteId) || await downloadImage(data.image || imageUrls[0], noteId)
  if (!imagePath) throw new Error('采集失败：一张图都没拿到——无封面的笔记不进灵感库')
  // 视频卡的源片当场落盘：签名直链几小时就 403，只留链接等于过两天既播不了、也补不了脚本
  data.videoFile = data.format === 'video' && data.videoSrc
    ? await downloadSourceVideo(data.videoSrc, noteId, url, MEDIA_HUB_ROOT, Number(data.videoDuration) || 0)
    : ''
  const { rel, keptAnalysis, videoFile } = writeNoteMd(data, url, imagePath)
  return { ok: true, file: rel, image: imagePath, sourceImages: data.sourceImages, videoFile, keptAnalysis, converted: topicOfSourceCard(rel) }
}

/* ==================== AI 创作（LLM） ====================
 * 采集卡入库后由服务端收尾自动出脚本、自动拆解（见 server-core 的 collect）：
 * 拆解框架与写回格式见 content/Knowledge/爆款拆解.md，模型没配好或没脚本时卡上留「待拆解」。
 * 旧的百炼自动拆解 autoAnalyze 已停用，原文留档在 content/Archive/拆解归档-七层口径-20260924/。
 */

// 任何兼容 OpenAI Chat Completions 协议的服务都能接。默认指向阿里云百炼，
// 用自己的模型时设 LLM_BASE_URL / LLM_MODEL 即可。（导出供 build-data 展示当前配置）
export const LLM_BASE_URL =
  process.env.LLM_BASE_URL || 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1'
export const LLM_MODEL = process.env.LLM_MODEL || 'qwen3.7-plus'
export const LLM_KEY_PATH = '~/.config/media-hub/dashscope.key'

const LLM_KEY_FILE = join(process.env.HOME || '', '.config/media-hub/dashscope.key')

function readApiKey() {
  if (process.env.DASHSCOPE_API_KEY) return process.env.DASHSCOPE_API_KEY
  try {
    return readFileSync(LLM_KEY_FILE, 'utf8').trim()
  } catch {
    return ''
  }
}
export { readApiKey }

/** 图为主的形态（抖音/快手/视频号图文、公众号贴图）：文案不取长正文，只取自己那一段。
 *  缺段时回退正文首行当钩子（见 prepareXhsPublish）。
 *  build-data 按同一份表算「界面显示哪一段」——发布与展示同源，不会两边各说各话。 */
export const SHORT_COPY_SECTION = {
  抖音: '抖音文案',
  快手: '快手文案',
  公众号: '贴图描述',
  视频号: '视频号文案',
}

/** 这一版真正发出去的文字：短文案形态取自己那段（缺段回退正文首行），长文案形态取正文。
 *  推草稿与工作台展示都走它——界面看到的和草稿箱里的必须是同一段。 */
export function publishTextFor(platform, bodyText, shortText) {
  if (!SHORT_COPY_SECTION[platform]) return bodyText || ''
  return (shortText || '').trim()
    || (bodyText || '').split('\n').map((s) => s.trim()).filter(Boolean)[0] || ''
}

/** 推送草稿的默认配乐（config/publish-music.json，唯一事实源）。
 *  只交「搜什么、认哪首」，不交时长——同一首在抖音是 01:00 片段、在快手是 06:10 全长。
 *  没这个文件、或 enabled=false，就返回 null，脚本段整个跳过。 */
export function publishMusic(root = MEDIA_HUB_ROOT) {
  const p = join(root, 'config/publish-music.json')
  if (!existsSync(p)) return null
  let cfg
  try {
    cfg = JSON.parse(readFileSync(p, 'utf8'))
  } catch {
    return null
  }
  if (!cfg.enabled || !cfg.query || !cfg.title) return null
  return { query: cfg.query, title: cfg.title, author: cfg.author || '' }
}

/** 各平台发布页标题框的硬上限，推草稿脚本按此截断（publish-xhs/douyin/mp 20 字、publish-sph 22 字符）。
 *  快手图文没有标题框，标题根本不进草稿，所以不在表里。 */
export const PUBLISH_TITLE_LIMIT = { 小红书: 20, 抖音: 20, 公众号: 20, 视频号: 22 }

/** 话题最终进不进草稿：公众号编辑器的正文里不写话题，payload.tags 那条脚本不读。 */
export const PUBLISH_TAGS_PUSHED = { 小红书: true, 抖音: true, 快手: true, 视频号: true, 公众号: false }

/** 哪些平台的推草稿脚本会去曲库选配乐（xhs/sph 发布页没有配乐入口）。 */
/** 哪些平台会吃到 config/publish-music.json 那首默认曲。
 *  公众号贴图 2026-10-31 起不配乐：贴图是看图读字的形态，音乐条会插在描述最上面抢走第一行，
 *  且关不掉（读者点开才响）。要配乐的只有短视频形态。 */
export const PUBLISH_MUSIC = { 抖音: true, 快手: true, 公众号: false }

/** 组装图文发布 payload：解析 md → { title, lines, tags, coverAbs, imagesAbs }。
 *  推草稿与「发布预览」共用这一份，预览看到的就是脚本要填进去的；
 *  只有 prepareXhsPublish 会把它写到 /tmp 供 ego 脚本读。
 *  入参是**账号 id**（同平台两个号各推各的），版式仍按它所属平台取短文案段。
 *  短文案形态（见 SHORT_COPY_SECTION）只取对应段，不灌小红书/公众号长正文。
 *  imagesAbs = 卡片渲染出的多页图（按页序），coverAbs = 第一页；单图旧稿两者退化成同一张。
 *  payload 里的 platform / accountKey 供脚本换登录态用：同平台挂了几个号才换，一个号不动罐子。 */
export function buildPublishPayload(rel, root = MEDIA_HUB_ROOT, account = '小红书') {
  guardNotArchive(rel)
  const acct = accountFromRel(rel)
  if (acct && account && acct !== account) throw new Error(`账号不匹配：稿在 ${acct}/ 目录，不能推给「${account}」`)
  const registry = listAccounts(root)
  const entry = registry.find((a) => a.id === account)
  const platform = entry?.platform ?? account
  const file = join(root, rel)
  let md
  try {
    md = readFileSync(file, 'utf8')
  } catch {
    throw new Error('文件不存在')
  }

  const section = (name) => {
    const m = md.match(new RegExp('## ' + name + '\\n([\\s\\S]*?)(?=\\n## |\\n---|$)'))
    return (m ? m[1] : '').trim()
  }
  const title = (md.match(/^# (.+)$/m) || [])[1] || ''
  // 日更文体是「备忘录正文/话题标签」，逆向图文是「正文/话题」，两套 section 名都认
  const bodyText = section('备忘录正文') || section('正文')
  const shortSection = SHORT_COPY_SECTION[platform]
  // 短文案版可以没有正文段（发出去的就是自己那段文案）；长文案版没正文就等于没东西可发
  if (!bodyText && !shortSection) throw new Error('正文（备忘录正文/正文段）为空——先完成创作再发布')
  const tags = (section('话题标签') || section('话题')).split(/\s+/).filter((s) => s.startsWith('#'))
  const cover = (md.match(/^coverImage:\s*(\S+)$/m) || [])[1]
  let coverAbs = cover ? join(root, 'public', cover) : ''
  let imagesAbs = []
  if (coverAbs) {
    imagesAbs = [coverAbs]
  } else {
    // 图文稿的图登记在卡片 json：render-cards 把页产在 public/cards/<slug>/，manifest 是清单
    imagesAbs = readCardSidecar(rel, root)?.images || []
    coverAbs = imagesAbs[0] || ''
  }

  const shortText = shortSection ? section(shortSection).replace(/<!--[\s\S]*?-->/g, '').trim() : ''
  const warnings = []
  if (shortSection && !shortText) {
    warnings.push(`缺「## ${shortSection}」段，取正文首行当钩子`)
  }
  // 稿里的 `**…**` 只是稿面排版，没有任何平台渲染 Markdown——推送前去掉星号
  let text = publishTextFor(platform, bodyText, shortText).replace(/\*\*(.+?)\*\*/g, '$1')
  if (!text) throw new Error(`要发出去的文字为空——${shortSection ? `补「## ${shortSection}」段` : '先完成创作'}`)
  // 小红书正文硬上限 1000 字：超了报错拦下，回创作台精简。这里不静默截断——截断会推出半句话
  if (platform === '小红书') {
    const n = [...text].length
    if (n > 1000) throw new Error(`小红书正文 ${n} 字 > 1000 字上限——回创作台精简「## 正文」，发布环节不截断`)
  }

  // 转化落点：贴图的挂链位是编辑器的「链接」栏（链接→小程序 弹窗），口令单独传字段，不塞描述。
  // 按稿上的「归属品牌」取那个品牌自己的推广对象——全局 active-target 只管稿子没写品牌时兜底，
  // 否则就会出现「推醒醒的稿挂上 BuildHub 链接」这种事（2026-10-26 收口）。
  const { target, product: draftProduct } = targetForDraft(md, { root })
  const weapp = platform === '公众号' ? target?.landing?.byPlatform?.['公众号']?.url || '' : ''
  const music = publishMusic(root)

  const payload = {
    title,
    lines: text.split(/\n/).map((s) => s.trim()),
    tags,
    coverAbs,
    imagesAbs,
    rel,
    account,
    // 脚本据此把浏览器罐子换成这个号的登录态（同平台挂了几个号才换，见 ego-space 的 guardJar）
    platform,
    accountKey: entry?.key || '',
    author: (md.match(/^作者：(.+)$/m) || [])[1]?.trim() || '',
    digest: section('摘要'),
    // 这一稿推的是哪个产品（稿上没写就是空串，此时 weapp 走全局 active-target 兜底）
    product: draftProduct,
    weapp,
    // 小红书图文发布页无配乐入口、视频号未实测，两家的脚本会忽略这个字段
    ...(music ? { music } : {}),
  }
  return { payload, warnings }
}

/** 推草稿入口：拿 buildPublishPayload 的同一份 payload 写 /tmp，再调脚本。 */
export function prepareXhsPublish(rel, root = MEDIA_HUB_ROOT, account = '小红书') {
  const { payload, warnings } = buildPublishPayload(rel, root, account)
  for (const w of warnings) console.warn(`[publish] ${rel} ${w}`)
  writeFileSync('/tmp/media-hub-publish.json', JSON.stringify(payload))
  return {
    title: payload.title,
    lines: payload.lines.length,
    tags: payload.tags.length,
    coverAbs: payload.coverAbs,
    images: payload.imagesAbs.length,
    music: payload.music?.title || '',
    product: payload.product,
    weapp: payload.weapp,
  }
}

/** 发布预览：把同一份 payload 翻成界面能画的样子（只读，不写 /tmp，不碰浏览器）。
 *  标题按脚本的 slice 规则先截——预览里看到的就是草稿箱里会出现的；
 *  图片换成本机能访问的 /public 路径，缺文件的单独标出来（脚本会拦下或静默少传，两种都不能假装没事）。 */
export function buildPublishPreview(rel, root = MEDIA_HUB_ROOT, account = '小红书') {
  const { payload, warnings } = buildPublishPayload(rel, root, account)
  const { platform } = payload
  const titleChars = [...payload.title]
  const limit = PUBLISH_TITLE_LIMIT[platform] || 0
  const publicDir = join(root, 'public')
  const images = payload.imagesAbs.map((abs) => {
    const relPath = relative(publicDir, abs)
    return {
      url: relPath.startsWith('..') ? '' : '/' + relPath.split(sep).join('/'),
      exists: existsSync(abs),
    }
  })
  return {
    platform,
    account,
    title: limit ? titleChars.slice(0, limit).join('') : payload.title,
    titleChars: titleChars.length,
    titleLimit: limit,
    titlePushed: limit > 0,
    body: payload.lines.join('\n'),
    bodyChars: [...payload.lines.join('\n')].length,
    tags: payload.tags,
    tagsPushed: PUBLISH_TAGS_PUSHED[platform] !== false,
    images,
    music: PUBLISH_MUSIC[platform] && payload.music ? payload.music : null,
    weapp: payload.weapp || '',
    warnings,
  }
}

/** 推草稿成功标记：Buffer 式队列的中间态（草稿已推 → 待人工点发布 → 已发布）。
 *  键是账号 id —— 同平台两个号各写各的「草稿已推-<账号>」，不会互相顶掉。 */
export function markDraftPushed(rel, account, root = MEDIA_HUB_ROOT) {
  guardNotArchive(rel)
  const file = join(root, rel)
  let md
  try {
    md = readFileSync(file, 'utf8')
  } catch {
    return { ok: false, error: '文件不存在' }
  }
  // 本地时间：toISOString 是 UTC，台账会比实际早 8 小时（sv-SE 格式 = "YYYY-MM-DD HH:mm"）
  md = upsertPublishMetric(md, `草稿已推-${account}`, new Date().toLocaleString('sv-SE', { hour12: false }).slice(0, 16))
  writeFileSync(file, md)
  return { ok: true }
}

/** 在「## 发布后数据」段内 upsert 一行 `- key：value`；段不存在则创建 */
function upsertPublishMetric(md, key, value) {
  const line = `- ${key}：${value}`
  if (!/^## 发布后数据$/m.test(md)) {
    return md.replace(/\s*$/, '') + `\n\n## 发布后数据\n\n${line}\n`
  }
  const re = new RegExp('(- ' + key + '：).*$', 'm')
  // 回调用函数形式：value 里出现 $& / $1 等替换模式时不被 String.replace 展开
  if (re.test(md)) return md.replace(re, (_m, p1) => p1 + value)
  return md.replace(/(## 发布后数据\n)/, (_m, p1) => p1 + '\n' + line)
}

/** R1：AI 唯一知识源 = Knowledge/ 全量；00- 前缀（定位页）永远排最前。`_` 前缀是只给人看的页（如「我的版图」），绝不进 prompt。 */
export function loadAiContext(root = MEDIA_HUB_ROOT) {
  const dir = join(root, 'content/Knowledge')
  if (!existsSync(dir)) return ''
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.md') && f !== 'README.md' && !f.startsWith('_'))
    .sort((a, b) => Number(b.startsWith('00-')) - Number(a.startsWith('00-')))
  // 蒸馏来源等 HTML 注释含退役词汇，绝不进 prompt（R1 附注：注入前剥离注释块）
  return files
    .map((f) => `【Knowledge/${f}】\n` + readFileSync(join(dir, f), 'utf8').replace(/<!--[\s\S]*?-->/g, '').trim())
    .join('\n\n')
}

/** R3：Archive/ 只进不出，管线读写命中即报错 */
export function guardNotArchive(rel) {
  if (String(rel).replaceAll('\\', '/').includes('content/Archive/')) {
    throw new Error('R3 违规：content/Archive/ 禁止脚本读写 → ' + rel)
  }
}

/** 路径收束：resolve 后必须落在 root 内，越界（如 ../）直接抛错 */
function insideRoot(rel, root = MEDIA_HUB_ROOT) {
  const abs = resolve(root, rel)
  const base = resolve(root)
  if (abs !== base && !abs.startsWith(base + sep)) {
    throw new Error('路径越界（必须位于仓库根目录内）→ ' + rel)
  }
  return abs
}

/* ==================== Markdown 分节写入 ==================== */

export function replaceSection(md, name, content) {
  const re = new RegExp('(## ' + name + '\\n)[\\s\\S]*?(?=\\n## |\\n---|$)')
  if (!re.test(md)) return md
  return md.replace(re, '$1' + content + '\n\n')
}

const ACCOUNT_RE = /^content\/Projects\/发布排期\/([^/]+)\/(待发布|已排期)(\/|$)/
const ACCOUNT_RE_SHORT = /^Projects\/发布排期\/([^/]+)\/(待发布|已排期)(\/|$)/

/** 账号注册表（accounts.json 是唯一事实源）。
 *  一条 = 一个号：`id` 是这个号在本仓的身份（发布排期目录名、md 里「草稿已推-x」的后缀、登录态缓存的键），
 *  `platform` 是它属于哪个平台（短文案段、图文/贴图形态、logo 都只认平台）。
 *  没写 id 的老登记按平台名补齐 —— 一平台一号时 id 就等于平台名，历史数据零迁移。
 *  快照键 key 与 id 都必须是唯一的：两个号共用 key 会把后台读数叠在一起。 */
export function listAccounts(root = MEDIA_HUB_ROOT) {
  const p = join(root, 'config/accounts.json')
  if (!existsSync(p)) throw new Error('缺少 config/accounts.json（账号注册表）')
  const list = JSON.parse(readFileSync(p, 'utf8')).map((a) => ({ ...a, id: a.id || a.platform }))
  for (const a of list) {
    if (!a.platform || !a.key) throw new Error(`accounts.json 条目缺 platform/key：${JSON.stringify(a)}`)
    const dupKey = list.filter((x) => x.key === a.key).length > 1
    const dupId = list.filter((x) => x.id === a.id).length > 1
    if (dupKey) throw new Error(`accounts.json 快照键重复：${a.key}（同平台多号要各写一个 key/id）`)
    if (dupId) throw new Error(`accounts.json 账号 id 重复：${a.id}`)
  }
  return list
}

/** 账号身份 → 平台名：拿不准传进来的是 id 还是平台名时用它兜一层（老调用方传的仍是平台名） */
export const platformOf = (accounts, id) => accounts.find((a) => a.id === id)?.platform ?? id

export function accountFromRel(rel) {
  const m = rel.match(ACCOUNT_RE) || rel.match(ACCOUNT_RE_SHORT) || rel.match(/(?:^|\/)发布排期\/([^/]+)\/(待发布|已排期)(?:\/|$)/)
  return m ? m[1] : null
}

export const pendingDirFor = (account) => `content/Projects/发布排期/${account}/待发布`
export const scheduledDirFor = (account, month) => `content/Projects/发布排期/${account}/已排期/${month}`

/** 手改一版稿：标题写 H1，正文写这一版真正发出去的那一段（段名与 buildPublishPayload 同源，
 *  短文案形态各写各的段）。frontmatter、机器读数、其它段落一个字不碰。 */
export function writeArticleText(rel, { title = null, copy = null } = {}, root = MEDIA_HUB_ROOT) {
  guardNotArchive(rel)
  const clean = String(rel).startsWith('content/') ? rel : `content/${rel}`
  const file = insideRoot(clean, root)
  let md
  try {
    md = readFileSync(file, 'utf8')
  } catch {
    throw new Error('文件不存在')
  }
  const acct = accountFromRel(clean)
  const platform = acct ? platformOf(listAccounts(root), acct) : ''
  const changed = []
  let next = md
  const curTitle = (next.match(/^# (.+)$/m) || [])[1] || ''
  if (typeof title === 'string' && title.trim() && title.trim() !== curTitle) {
    next = next.replace(/^# .+$/m, () => `# ${title.trim()}`)
    changed.push('标题')
  }
  if (typeof copy === 'string' && copy.trim()) {
    const name = SHORT_COPY_SECTION[platform] || (/^## 备忘录正文\s*$/m.test(next) ? '备忘录正文' : '正文')
    const sw = swapSection(next, name, copy)
    // 段还不存在（短文案版没建过自己那段）：补在稿尾，不悄悄写进母本正文
    const cand = sw.ok ? sw.md : `${next.replace(/\s+$/, '')}\n\n## ${name}\n\n${copy.trim()}\n`
    if (cand !== next) {
      next = cand
      changed.push(name)
    }
  }
  if (changed.length) writeFileSync(file, next.endsWith('\n') ? next : next + '\n')
  return { rel: clean, changed }
}

/** 排期：<账号>/待发布/标题.md → <账号>/已排期/YYYY-MM/YYYY-MM-DD-标题.md */
export function scheduleNote(rel, date, root = MEDIA_HUB_ROOT) {
  guardNotArchive(rel)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('日期格式应为 YYYY-MM-DD')
  const m = (rel.match(ACCOUNT_RE) || rel.match(/(?:^|\/)发布排期\/([^/]+)\/(待发布|已排期)(\/|$)/))
  if (!m) throw new Error('只能排期 发布排期/<账号>/待发布/ 下的文件')
  if (m[2] !== '待发布') throw new Error('只能排期 待发布/ 下的文件')
  const account = m[1]
  if (!listAccounts(root).some((a) => a.id === account)) throw new Error(`未知账号「${account}」，不在 config/accounts.json 注册表内`)
  const src = join(root, rel.startsWith('content/') ? rel : `content/${rel}`)
  if (!existsSync(src)) throw new Error('文件不存在')
  const base = rel.split('/').pop() || ''
  const name = base.replace(/^\d{4}-\d{2}-\d{2}-/, '').replace(/\.md$/, '')
  const month = date.slice(0, 7)
  const destRel = `${scheduledDirFor(account, month)}/${date}-${name}.md`
  const dest = join(root, destRel)
  if (existsSync(dest)) throw new Error('目标文件已存在：' + dest)
  mkdirSync(join(root, scheduledDirFor(account, month)), { recursive: true })
  renameSync(src, dest)
  return { ok: true, rel: destRel }
}

/** 稿里声明的卡片 json 名。稿名常含空格与「#」（话题标签切出来的），所以按整行取到 .json 为止，
 *  不能用 \S+ ——它会在第一个空格处断掉，只剩「#认.json」，于是找不着文件、创作台整块预览消失。 */
function declaredCardName(md) {
  return (md.match(/卡片数据：[^\n]*?([^\n]*?\.json)/) || [])[1] || ''
}

/** 稿里声明的视频素材（相对仓库根的 mp4）。纯视频稿没有图卡 json，成片路径就写在稿的这一行上——
 *  与「卡片数据：」同款写法：工作台与发布脚本读同一处，稿旁不放复制件。 */
function declaredVideo(md) {
  return (md.match(/视频素材：[^\n]*?([^\n]*?\.mp4)/) || [])[1] || ''
}

/** 选题草稿（文件驱动，替代浏览器便签） */
export function safeTitleName(title) {
  return (title || '未命名选题')
    .replace(/[/\\:*?"<>|\n\r\t]/g, '')
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]/gu, '')
    .trim()
    .slice(0, 40)
}

/** 选题卡标题：来源是短视频/笔记标题，先去 #话题 尾巴再落安全名，长句裁到 24 字 */
export function topicTitleName(title) {
  const cleaned = String(title || '')
    .replace(/#[^\s#]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  const short = cleaned.length > 24 ? `${cleaned.slice(0, 24).trim()}…` : cleaned
  return safeTitleName(short)
}

/** 卡片数据的唯一事实源：content/Projects/卡片/<slug>.json。
 *  一份图卡服务同一选题的各平台稿，改一处即全平台生效——稿旁不放复制件，复制件必然跑偏。 */
export const CARD_DIR_REL = 'content/Projects/卡片'

/** 在卡片目录里找 json：显式声明名优先，其次与稿同名的猜测 */
function findCardJson(names, root) {
  for (const n of names.filter(Boolean)) {
    const p = join(root, CARD_DIR_REL, n)
    if (existsSync(p)) return p
  }
  return ''
}

/** 视频素材 → 成果描述（与图卡同一个形状，创作台/发布脚本读同一份）。
 *  落在 public/ 下才给浏览器可播地址；否则留空，界面直说成片在哪、让发布脚本按这个路径上传。 */
function videoAsset(videoRel, slug) {
  return {
    slug,
    title: '',
    jsonRel: '',
    data: null,
    pageCount: 0,
    video: videoRel,
    videoUrl: videoRel.startsWith('public/') ? `/${videoRel.replace(/^public\//, '')}` : '',
    images: [],
    urls: [],
  }
}

/** 稿的成果素材（图卡 / 视频 / 两者都有）：
 *  - 图卡：md 里「卡片数据：xxx.json」显式声明，或卡片目录下与稿同名的 json → public/cards/<slug>/ 的页清单，
 *    图由 render-cards.mjs 渲染，工作台与发布脚本共用同一份 manifest；
 *  - 视频：md 里「视频素材：xxx.mp4」显式声明（纯视频稿的唯一成果形态），图卡 json 里也能挂 video 字段。
 *  两样都没有（纯文字稿）返回 null。 */
export function readCardSidecar(mdRel, root = MEDIA_HUB_ROOT) {
  const norm = mdRel.startsWith('content/') ? mdRel : `content/${mdRel}`
  const slugFromMd = basename(norm, '.md').replace(/^\d{4}-\d{2}-\d{2}-/, '')
  let md = ''
  let cardPath = ''
  try {
    md = readFileSync(join(root, norm), 'utf8')
    const named = declaredCardName(md)
    cardPath = findCardJson([named && basename(named), `${slugFromMd}.json`], root)
  } catch {
    return null
  }
  const videoRel = declaredVideo(md)
  if (!cardPath || !existsSync(cardPath)) return videoRel ? videoAsset(videoRel, slugFromMd) : null
  let card
  try {
    card = JSON.parse(readFileSync(cardPath, 'utf8'))
  } catch {
    // json 坏了但稿上写了视频：至少让视频这条成果还能被看到，别让整块成果凭空消失
    return videoRel ? videoAsset(videoRel, slugFromMd) : null
  }
  const outDir = join(root, 'public/cards', String(card.slug || ''))
  const manifest = join(outDir, 'manifest.json')
  let images = []
  if (existsSync(manifest)) {
    try {
      images = JSON.parse(readFileSync(manifest, 'utf8')).images || []
    } catch {
      images = []
    }
  } else if (existsSync(join(outDir, `${card.slug}.png`))) {
    images = [join(outDir, `${card.slug}.png`)]
  }
  /** 视频素材路径（相对仓库根）：卡片 json 的 video 字段优先，其次稿上的「视频素材：」行；空 = 本版没有视频 */
  const video = String(card.video || videoRel || '')
  return {
    slug: String(card.slug || ''),
    title: String(card.title || ''),
    /** 卡片 json 相对仓库根：工作台据此保存改动并触发渲染 */
    jsonRel: relative(root, cardPath),
    /** 卡片数据本体（逐页文字与版式参数）：创作台「编辑文字」的表单源 */
    data: card,
    /** json 声明的页数：图还没渲染时用它说「该有几页、现在没图」 */
    pageCount: (card.pages || []).length || images.length,
    video,
    /** 落在 public/ 下才给浏览器可播地址；否则留空，界面直说素材在哪 */
    videoUrl: video.startsWith('public/') ? `/${video.replace(/^public\//, '')}` : '',
    images,
    urls: images.map((p) => `/cards/${card.slug}/${basename(String(p))}`),
  }
}

/** 写回卡片 json（创作台「编辑文字」的唯一落盘口）。
 *  slug 不许改：图产物按 slug 落在 public/cards/<slug>/，改名等于把已渲染的图全丢了。
 *  返回 changedPages（0 基页号）供调用方只重渲改动页；页数变了就全量重渲。 */
export function writeCardJson(jsonRel, data, root = MEDIA_HUB_ROOT) {
  const norm = jsonRel.startsWith('content/') || jsonRel.startsWith('public/')
    ? jsonRel
    : `content/${jsonRel}`
  const abs = resolve(root, norm)
  if (!norm.endsWith('.json') || norm.includes('..') || !abs.startsWith(join(root, 'content') + sep)) {
    throw new Error('只能写 content/ 下的卡片 json')
  }
  if (!existsSync(abs)) throw new Error(`卡片 json 不存在：${norm}`)
  const old = JSON.parse(readFileSync(abs, 'utf8'))
  const pages = Array.isArray(data?.pages) ? data.pages : null
  if (!pages?.length) throw new Error('卡片数据缺少 pages[]')
  for (const [i, p] of pages.entries()) {
    if (typeof p?.layout !== 'string' || !/^[a-z][a-z0-9-]*$/.test(p.layout)) {
      throw new Error(`第 ${i + 1} 页缺少合法 layout`)
    }
  }
  const next = { ...old, ...data, slug: old.slug, pages }
  const body = JSON.stringify(next, null, 2) + '\n'
  if (body === readFileSync(abs, 'utf8')) return { ok: true, rel: norm, changedPages: [] }
  // 原子写：先落同名 .tmp 再 rename，避免读到半截 json
  writeFileSync(`${abs}.tmp`, body)
  renameSync(`${abs}.tmp`, abs)
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
  const changed = old.pages?.length === pages.length
    ? pages.map((p, i) => (same(p, old.pages[i]) ? -1 : i)).filter((i) => i >= 0)
    : pages.map((_, i) => i)
  return { ok: true, rel: norm, changedPages: changed }
}

/** 生成选题 → 落一份骨架 md 到 待发布/。正文留空 = 「草稿」状态；AI 写完正文自动变「待排期」 */
export function writeDraftMd({ title, fromKind, from, account, product = '' }, root = MEDIA_HUB_ROOT) {
  if (!account) throw new Error('缺少 account（发布账号，见 config/accounts.json）')
  const known = listAccounts(root).map((a) => a.id)
  if (!known.includes(account)) throw new Error(`未知账号「${account}」，已登记：${known.join('、')}`)
  const name = safeTitleName(title)
  if (!name) throw new Error('标题为空')
  const fromLine =
    fromKind === 'quote' ? `${from}（金句）`
    : fromKind === 'reading' ? `${from}（参考资料）`
    : fromKind === 'benchmark' ? `${from}（对标账号）`
    : from || '原创'

  const dirRel = pendingDirFor(account)
  const file = join(root, dirRel, `${name}.md`)
  if (existsSync(file)) throw new Error(`草稿已存在：${name}.md`)

  const md = `# ${name}

## 创作信息

- 身份主题：
- 创作意图：
- 灵感来源：${fromLine}
- 开头类型：
- 活动标识：（转化归因用，建议填短 ASCII，如 xxs-0901；留空则用文件名）
- 归属品牌：${normalizeProduct(product)}

## 备忘录正文

## 发布配文

## 话题标签

## 首评引导

## 转化数据

（发布后回填：落地链接访问 / 下载 / Stars 等，一行一个「指标：数值」。
  内容数据说明传播，转化数据才说明值不值。）
`
  mkdirSync(join(root, dirRel), { recursive: true })
  writeFileSync(file, md)
  return { file, rel: `${dirRel}/${name}.md` }
}

/** 删除草稿 md（仅允许 待发布/ 目录内，防路径穿越） */
export function deleteDraftMd(rel, root = MEDIA_HUB_ROOT) {
  guardNotArchive(rel)
  const m = (rel.match(ACCOUNT_RE) || rel.match(ACCOUNT_RE_SHORT) || rel.match(/(?:^|\/)发布排期\/([^/]+)\/(待发布|已排期)(?:\/|$)/))
  if (!m || m[2] !== '待发布') throw new Error('只能删除 发布排期/<账号>/待发布/ 下的文件')
  const acct = m[1]
  if (!listAccounts(root).some((a) => a.id === acct)) throw new Error(`未知账号「${acct}」，不在 config/accounts.json 注册表内`)
  const dir = join(root, pendingDirFor(acct))
  const file = insideRoot(join(root, rel), root)
  if (!file.startsWith(dir + '/')) throw new Error('路径越界')
  if (!existsSync(file)) throw new Error('文件不存在')
  unlinkSync(file)
  return { ok: true }
}

/* ==================== 选题池（立项闸门） ==================== */

const TOPIC_DIR = 'content/Projects/选题池'
// 与 ACCOUNT_RE 同款双前缀风格：接受 "content/Projects/选题池/…" 全 rel 与 "Projects/…" 短 rel
const TOPIC_RE = /^(?:content\/)?Projects\/选题池\/[^/]+\.md$/

/** 反查采集卡是否已有选题卡回链（老卡没打 convertedToTopic 时靠「来源文件」这一行认）。
 *  重采时插件用它告知去向，免得用户以为没进灵感库。 */
export function topicOfSourceCard(rel, root = MEDIA_HUB_ROOT) {
  const norm = (rel.startsWith('content/') ? rel : `content/${rel}`).replaceAll('\\', '/')
  const dir = join(root, TOPIC_DIR)
  let files = []
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.md'))
  } catch {
    return ''
  }
  for (const f of files) {
    let md = ''
    try {
      md = readFileSync(join(dir, f), 'utf8')
    } catch {
      continue
    }
    const src = (md.match(/^- 来源文件：(.+\.md)/m) || [])[1]
    const normSrc = src ? src.trim().replace(/^\.?\//, '').replace(/^content\//, 'content/') : ''
    if (normSrc && normSrc === norm) {
      return (md.match(/^# (.+)$/m) || [, f.replace(/\.md$/, '')])[1].trim()
    }
  }
  return ''
}

/** 采集卡转化标记：加入选题池时在 frontmatter 写 convertedToTopic，工作台据此默认隐藏该采集卡。
 *  文件与源图保留——复盘要能回溯「哪条采集真产出了内容」。 */
export function markTopicConverted(rel, root = MEDIA_HUB_ROOT) {
  const norm = rel.startsWith('content/') ? rel : `content/${rel}`
  // 采集卡可能在平台子目录下（爆款采集/<平台>/<id>.md）——少这一层，所有爆款来源的入池都打不上标记
  if (!/^content\/Inbox\/(采集笔记|爆款采集)\/([^/]+\/)?[^/]+\.md$/.test(norm)) {
    throw new Error('只能给 Inbox/采集笔记 或 Inbox/爆款采集 下的采集卡打转化标记')
  }
  guardNotArchive(norm)
  const file = insideRoot(join(root, norm), root)
  if (!existsSync(file)) throw new Error('文件不存在')
  const md = readFileSync(file, 'utf8')
  if (/^convertedToTopic:/m.test(md)) return { ok: true, already: true }
  if (!md.startsWith('---\n')) throw new Error('采集卡缺少 frontmatter，无法打转化标记')
  const today = localDay()
  writeFileSync(file, md.replace(/^---\n/, `---\nconvertedToTopic: ${today}\n`))
  return { ok: true }
}

/** 采集卡/金句/手动 → 选题池卡片（立项闸门）。fromKind 沿用 writeDraftMd 语义 */
export function writeTopicMd({ title, fromKind, from, sourceRel, judge = '', basis = '', product = '' }, root = MEDIA_HUB_ROOT) {
  const name = topicTitleName(title)
  if (!name) throw new Error('标题为空')
  const srcLine = from ? `${from}${fromKind === 'quote' ? '（金句）' : fromKind === 'reading' ? '（灵感库）' : fromKind === 'viral' ? '（爆款采集）' : ''}` : ''
  const file = insideRoot(join(root, TOPIC_DIR, `${name}.md`), root)
  if (existsSync(file)) throw new Error(`选题已存在：${name}.md`)
  mkdirSync(join(root, TOPIC_DIR), { recursive: true })
  // 来源文件回链：选题详情/创作台靠这一行找到采集卡，读出拆解（analysis 块）
  const srcFile = sourceRel ? (String(sourceRel).startsWith('content/') ? sourceRel : `content/${sourceRel}`) : ''
  writeFileSync(file, `# ${name}\n\n- 状态：待创作\n- 来源信号：${srcLine}\n${srcFile ? `- 来源文件：${srcFile}\n` : ''}- 判据自评：${judge}\n- 依据经验：${basis}\n- 归属品牌：${normalizeProduct(product)}\n- 立项平台：\n`)
  return { file, rel: `${TOPIC_DIR}/${name}.md` }
}

/** 送去创作（立项）：待创作→创作中，写入账号清单，并按账号各建一份稿骨架。
 *  一次立项 = 一个选题的 N 版稿同时就位（N 默认 = config/accounts.json 里已授权的全部账号）。
 *  一个选题不绑账号：各版同名落在 发布排期/<账号id>/待发布/，创作台按同名聚合。
 *  同平台两个号就是两个账号 id，各出一版——卡上「立项平台」这一行存的是账号 id（历史数据里它就是平台名）。
 *  状态改完卡片即离开选题库（选题库只列待创作）——但选题卡本身留在 选题池/ 不删，
 *  创作台的选题聚合与「复刻依据」都靠它回链拿账号清单、拆解与脚本。
 *  卡上的「归属品牌」随立项写进每一版稿骨架：品牌分格从选题一路带到发布日历。 */
export function promoteTopic(rel, platforms, root = MEDIA_HUB_ROOT) {
  guardNotArchive(rel)
  if (!TOPIC_RE.test(rel)) throw new Error('只能操作 选题池/ 下的卡片')
  const known = listAccounts(root).map((a) => a.id)
  const want = (Array.isArray(platforms) ? platforms : String(platforms || '').split(/\s+/)).filter(Boolean)
  // 「补建这一版」会把已有版本连同新平台整张清单回传，不去重就往卡上写会写出重复平台
  const list = [...new Set(want.length ? want : known)]
  const unknown = list.filter((p) => !known.includes(p))
  if (unknown.length) throw new Error(`未知账号「${unknown.join('、')}」，已登记：${known.join('、')}`)
  const file = join(root, rel)
  if (!existsSync(file)) throw new Error('文件不存在')
  const md = readFileSync(file, 'utf8')
  if (!/^- 状态：/m.test(md)) throw new Error('卡片缺少「状态」行')
  writeFileSync(
    file,
    md
      .replace(/^- 状态：.*$/m, '- 状态：创作中')
      .replace(/^- 立项平台：.*$/m, `- 立项平台：${list.join(' ')}`),
  )
  const title = (md.match(/^#\s+(.+)$/m) || [])[1]?.trim() || basename(file, '.md')
  const product = normalizeProduct((md.match(/^- 归属品牌：\s*(.*)$/m) || [, ''])[1])
  const drafts = []
  for (const p of list) {
    const name = safeTitleName(title)
    try {
      const d = writeDraftMd({ title, fromKind: 'topic', from: title, account: p, product }, root)
      drafts.push({ platform: p, rel: d.rel })
    } catch (e) {
      // 骨架已存在（重复立项或手工建过）：不推翻已有稿，只报告
      drafts.push({
        platform: p,
        rel: `${pendingDirFor(p)}/${name}.md`,
        skipped: String(e?.message || e),
      })
    }
  }
  return { ok: true, rel, platforms: list, drafts }
}

/** 定这条选题的产出形态：图文或视频，写进卡上「产出形态」行。一条选题只走一条线，
 *  创作台整页（步骤轨、创作按钮、发布前检查）都跟着这一行走。 */
export function setTopicForm(rel, form, root = MEDIA_HUB_ROOT) {
  guardNotArchive(rel)
  if (!TOPIC_RE.test(rel)) throw new Error('只能操作 选题池/ 下的卡片')
  const label = form === 'video' ? '视频' : form === 'image' ? '图文' : ''
  if (!label) throw new Error('产出形态只有图文与视频两种')
  const file = join(root, rel)
  if (!existsSync(file)) throw new Error('文件不存在')
  const md = readFileSync(file, 'utf8')
  const line = `- 产出形态：${label}`
  const next = /^- 产出形态：.*$/m.test(md)
    ? md.replace(/^- 产出形态：.*$/m, line)
    : /^- 立项平台：.*$/m.test(md)
      ? md.replace(/^- 立项平台：.*$/m, `${line}\n$&`)
      : `${md.trimEnd()}\n${line}\n`
  writeFileSync(file, next)
  return { ok: true, rel, form }
}

/** 淘汰 = 归档：移进 选题池/归档/，判据留痕供复盘（归档目录不进工作台） */
export function archiveTopicMd(rel, root = MEDIA_HUB_ROOT) {
  guardNotArchive(rel)
  if (!TOPIC_RE.test(rel)) throw new Error('只能归档 选题池/ 下的卡片')
  const file = join(root, rel)
  if (!existsSync(file)) throw new Error('文件不存在')
  mkdirSync(join(root, TOPIC_DIR, '归档'), { recursive: true })
  const dest = uniqueArchivePath(join(root, TOPIC_DIR, '归档', basename(file)))
  renameSync(file, dest)
  return { ok: true, archived: `${TOPIC_DIR}/归档/${basename(dest)}` }
}

/** 灵感库淘汰 = 归档：采集卡移进 采集笔记/归档/（收藏搬运卡在 归档/收藏/<平台>/ 下）；
 *  public/inspiration/ 下的源图不动，复盘可回溯 */
export function archiveNoteMd(rel, root = MEDIA_HUB_ROOT) {
  const norm = (rel.startsWith('content/') ? rel : `content/${rel}`).replaceAll('\\', '/')
  guardNotArchive(norm)
  const m = norm.match(/^content\/Inbox\/采集笔记\/(?:(收藏)\/([^/]+)\/)?([^/]+)\.md$/)
  if (!m || norm.endsWith('/README.md') || m[2] === '归档') {
    throw new Error('只能归档 Inbox/采集笔记/ 下的采集卡')
  }
  const file = insideRoot(join(root, norm), root)
  if (!existsSync(file)) throw new Error('文件不存在')
  const destDir = join(root, 'content/Inbox/采集笔记/归档', ...(m[1] ? [m[1], m[2]] : []))
  mkdirSync(destDir, { recursive: true })
  const dest = uniqueArchivePath(join(destDir, `${m[3]}.md`))
  renameSync(file, dest)
  return { ok: true, archived: `Inbox/采集笔记/归档/${m[1] ? `${m[1]}/${m[2]}/` : ''}${basename(dest)}` }
}

/** 爆款采集卡删除 = 归档：卡片移进 爆款采集/归档/<平台>/，public/viral/ 下的封面与源片不动。
 *  归档目录仍被采集线的去重认到，所以删掉的这条不会被明天的定时任务再采回来。 */
export function archiveViralMd(rel, root = MEDIA_HUB_ROOT) {
  const norm = (rel.startsWith('content/') ? rel : `content/${rel}`).replaceAll('\\', '/')
  guardNotArchive(norm)
  const m = norm.match(/^content\/Inbox\/爆款采集\/([^/]+)\/([^/]+)\.md$/)
  if (!m || m[1] === '归档') throw new Error('只能归档 Inbox/爆款采集/<平台>/ 下的采集卡')
  const file = insideRoot(join(root, norm), root)
  if (!existsSync(file)) throw new Error('文件不存在')
  const destDir = join(root, 'content/Inbox/爆款采集/归档', m[1])
  mkdirSync(destDir, { recursive: true })
  const dest = uniqueArchivePath(join(destDir, `${m[2]}.md`))
  renameSync(file, dest)
  return { ok: true, archived: `Inbox/爆款采集/归档/${m[1]}/${basename(dest)}` }
}

/** 归档同名不覆盖：重名时依次加 -1、-2 后缀 */
function uniqueArchivePath(dest) {
  if (!existsSync(dest)) return dest
  const base = dest.replace(/\.md$/, '')
  for (let i = 1; ; i += 1) {
    const cand = `${base}-${i}.md`
    if (!existsSync(cand)) return cand
  }
}

/* ==================== 对标账号 ==================== */

const BENCH_DIR = 'content/Resources/对标账号'

/** 主页链接 → 平台 key + 作者 id。
 *  去重键是「平台:作者id」（自动线同一个口径），所以链接是唯一不必让人手填的来源。
 *  查询串（小红书带 xsec_token）一律砍掉——档案里的 url 要能长期回访，token 过期就是死链。 */
export function parseProfileUrl(raw) {
  const s = String(raw || '').trim()
  const xhs = s.match(/xiaohongshu\.com\/user\/profile\/([0-9a-zA-Z]+)/)
  if (xhs) return { platform: 'xiaohongshu', userId: xhs[1], url: `https://www.xiaohongshu.com/user/profile/${xhs[1]}` }
  const dy = s.match(/douyin\.com\/user\/([A-Za-z0-9_-]+)/)
  if (dy) return { platform: 'douyin', userId: dy[1], url: `https://www.douyin.com/user/${dy[1]}` }
  throw new Error('链接认不出来：要粘的是主页地址——小红书 …/user/profile/… 或抖音 douyin.com/user/…')
}

/** 档案名里的非法字符换成短横线（与自动线同一套清洗） */
const benchSlug = (s) => String(s || '').replace(/[\\/:*?"<>|\s]+/g, '-').slice(0, 40)

/** frontmatter 只认单行：换行压成空格，引号统一成中文右引号（照自动线的 yaml() 口径） */
function fmLine(s) {
  const t = String(s ?? '').replace(/\s*\n\s*/g, ' ').trim()
  return `"${t.replace(/["“”]/g, '”')}"`
}

/** 已建档的 平台:作者id → 档案绝对路径（含 归档/，删掉的号不该被再建一次） */
function benchmarkIndex(root = MEDIA_HUB_ROOT) {
  const out = new Map()
  const dir = join(root, BENCH_DIR)
  if (!existsSync(dir)) return out
  const scan = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isDirectory()) { scan(p); continue }
      if (!e.name.endsWith('.md') || e.name === 'README.md') continue
      const fm = readFileSync(p, 'utf8').match(/^---\r?\n([\s\S]*?)\r?\n---/)
      const pick = (k) => (fm?.[1].match(new RegExp(`^${k}:\\s*(\\S+)\\s*$`, 'm')) || [])[1] || ''
      const uid = pick('userId')
      if (uid) out.set(`${pick('platform') || 'xiaohongshu'}:${uid}`, p)
    }
  }
  scan(dir)
  return out
}

/** 手动建档：界面「添加对标账号」的落盘。
 *  只写链接与理由，读数留空——紧跟其后的 benchmark-one 那一次采集负责补全（脚本只补空值，不覆盖已有读数）。 */
export function writeBenchmarkMd({ url, nickname = '', why = '' }, root = MEDIA_HUB_ROOT) {
  const { platform, userId, url: profileUrl } = parseProfileUrl(url)
  const dup = benchmarkIndex(root).get(`${platform}:${userId}`)
  if (dup) {
    // 归档过的号再添加一次＝重新对标：把原档案搬回平台目录（快照与人工判断都还在），不另建一份
    if (!/(^|\/)归档\//.test(dup.replaceAll('\\', '/'))) {
      throw new Error(`这个号已经在对标档案里了：${relative(root, dup).replaceAll('\\', '/')}`)
    }
    const destDir = join(root, BENCH_DIR, platform)
    mkdirSync(destDir, { recursive: true })
    const dest = uniqueArchivePath(join(destDir, basename(dup)))
    renameSync(dup, dest)
    return { ok: true, restored: true, rel: relative(root, dest).replaceAll('\\', '/'), platform, userId, url: profileUrl }
  }
  const nick = String(nickname || '').trim()
  const name = benchSlug(nick || userId)
  const file = insideRoot(join(root, BENCH_DIR, platform, `${name}.md`), root)
  if (existsSync(file)) throw new Error(`同名档案已存在：${platform}/${name}.md`)
  mkdirSync(join(root, BENCH_DIR, platform), { recursive: true })
  const nickOne = String(nick).replace(/\s*\n\s*/g, ' ').trim()
  writeFileSync(file, `---
nickname: ${nickOne || '""'}
userId: ${userId}
platform: ${platform}
url: ${profileUrl}
accountId: ""
ipLocation: ""
desc: ""
position: ""
why: ${why ? fmLine(why) : '""'}
source: manual
capturedAt: ""
followers:
likesCollects:
works:
recentSample:
recentTopLikes:
recentMedianLikes:
lastPublishDays:
matchedKeywords: ""
score:
avatar: ""
---

## 数据快照

<!-- 自动线只在新建档当天写一行；老档案的快照由人工复查时追加 -->

## 值得偷的模式

<!-- 自动线只留证据（高赞作品标题），打法与模式由人工复盘时提炼 -->
`, 'utf8')
  return { ok: true, rel: `${BENCH_DIR}/${platform}/${name}.md`, platform, userId, url: profileUrl }
}

/** 不再对标 = 归档：整文件移进 对标账号/归档/<平台>/，头像与快照留在原地可回溯（归档目录不进对标列表） */
export function archiveBenchmarkMd(rel, root = MEDIA_HUB_ROOT) {
  const norm = (rel.startsWith('content/') ? rel : `content/${rel}`).replaceAll('\\', '/')
  guardNotArchive(norm)
  const m = norm.match(/^content\/Resources\/对标账号\/([^/]+)\/([^/]+)\.md$/)
  if (!m || m[1] === '归档' || m[2] === 'README') throw new Error('只能归档 对标账号/<平台>/ 下的档案')
  const file = insideRoot(join(root, norm), root)
  if (!existsSync(file)) throw new Error('文件不存在')
  const destDir = join(root, BENCH_DIR, '归档', m[1])
  mkdirSync(destDir, { recursive: true })
  const dest = uniqueArchivePath(join(destDir, `${m[2]}.md`))
  renameSync(file, dest)
  return { ok: true, archived: `${BENCH_DIR}/归档/${m[1]}/${basename(dest)}` }
}
