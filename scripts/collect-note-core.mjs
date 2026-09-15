/**
 * 采集落盘核心：命令行（collect-note.mjs / ego）与 dev server 端点（vite.config /__collect）共用。
 * 输入一份笔记数据，输出「参考资料 md + 首图」，analysis 一律留待 AI 补（不编造）。
 */
import { writeFileSync, mkdirSync, readFileSync, existsSync, unlinkSync, renameSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { activeTarget } from '../config/active-target.mjs'

// 仓库根目录：优先环境变量，否则由本文件位置推导（不要把个人绝对路径写死进仓库）
export const MEDIA_HUB_ROOT =
  process.env.MEDIA_HUB_ROOT || resolve(dirname(fileURLToPath(import.meta.url)), '..')

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

/** 生成参考资料 md 并落盘。目标文件已存在时，自动保留旧的 analysis 拆解（重采不冲掉人工成果） */
export function writeNoteMd(data, url, imagePath, root = MEDIA_HUB_ROOT) {
  const today = new Date().toISOString().slice(0, 10)
  const safeName = (data.title || '未命名笔记')
    .replace(/[/\\:*?"<>|\n\r\t]/g, '')
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]/gu, '')
    .trim()
    .slice(0, 40)

  const file = join(root, 'content/参考资料', `${safeName}.md`)

  // 重采保护：旧文件里有 analysis 就提取出来重新注入
  let keepAnalysis = ''
  try {
    const old = readFileSync(file, 'utf8')
    const m = old.match(/\n(analysis:\n(?:  .*\n)+analyzedAt: [^\n]+\n)/)
    if (m) keepAnalysis = m[1]
  } catch {}

  const md = `---
source: ${data.source || `小红书 @${data.author || '未知'}`}
url: ${url}
collected: ${today}
platform: 小红书
noteData:
  likes: ${data.likes || ''}
  collects: ${data.collects || ''}
  comments: ${data.comments || ''}
  postedAt: ${data.postedAt || ''}
tags: ${Array.isArray(data.tags) ? data.tags.join(' ') : data.tags || ''}
coverImage: ${imagePath}
${keepAnalysis}---

# ${data.title || safeName}

> ${data.author || ''} · ${data.postedAt || ''} · 赞 ${data.likes || '-'} / 藏 ${data.collects || '-'} / 评 ${data.comments || '-'}
> 原文：${url}

${data.desc}
${keepAnalysis ? '' : `\n---\n\n## AI 拆解\n\n**待拆解**：让 AI 按《参考资料 README》规范补 frontmatter 的 analysis 块，补完删掉本节。\n`}`

  writeFileSync(file, md)
  return { file, rel: `content/参考资料/${safeName}.md`, keptAnalysis: !!keepAnalysis }
}

/** 端点总入口：校验 → 下载图 → 写 md。返回给前端的 JSON */
export async function handleCollect(payload) {
  const { url, ...data } = payload || {}
  if (!url || (!data.title && !data.desc)) {
    throw new Error('payload 需要至少包含 url + (title|desc)')
  }
  const noteId = (url.match(/\/explore\/([0-9a-f]+)/) || [])[1] || `note-${Date.now()}`
  const imagePath = await downloadImage(data.image, noteId)
  const { rel, keptAnalysis } = writeNoteMd(data, url, imagePath)
  return { ok: true, file: rel, image: imagePath, keptAnalysis }
}

/* ==================== 自动拆解 / 创作（LLM） ==================== */

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

const ANALYZE_PROMPT = `你是自媒体运营拆解助手。阅读以下小红书笔记原文，输出拆解。

输出必须是严格的 YAML（不带 markdown 围栏、不带任何解释文字），格式：
analysis:
  titleStructure: 标题句式/结构与点开率原因（一句话）
  hook: 开头前三句靠什么钩住人（一句话）
  structure: 全文行文骨架（一句话）
  steal: 可直接偷的句式/技巧（一句话，引号内举一个原句）
  topics: 适用选题方向（1-3 个，顿号分隔）

账号定位：「${activeTarget.brandName}」——${activeTarget.accountPositioning}；${activeTarget.tone}；主题：${activeTarget.topics.join('、')}。

笔记标题：
`

/** 调百炼对单篇笔记做拆解，写回 frontmatter。返回 { ok, analyzed, error? } */
export async function autoAnalyze(rel, root = MEDIA_HUB_ROOT) {
  const key = readApiKey()
  if (!key) return { ok: false, error: '未配置 API key（~/.config/media-hub/dashscope.key）' }

  const file = join(root, rel)
  let md
  try {
    md = readFileSync(file, 'utf8')
  } catch {
    return { ok: false, error: '文件不存在' }
  }
  if (/analysis:/.test(md.split('---')[1] || '')) return { ok: true, analyzed: false, skip: '已有拆解' }

  const titleMatch = md.match(/^# (.+)$/m)
  const body = md.split(/^---$/m).pop() || ''
  const content = (titleMatch ? `标题：${titleMatch[1]}\n\n` : '') + body.trim().slice(0, 3000)

  let text = ''
  try {
    // Token Plan（阿里云百炼包月套餐）专属端点
    const resp = await fetch(`${LLM_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: LLM_MODEL,
        messages: [
          { role: 'system', content: ANALYZE_PROMPT },
          { role: 'user', content: content },
        ],
        temperature: 0.4,
        max_tokens: 1500,
        enable_thinking: false,
      }),
    })
    const out = await resp.json()
    if (!resp.ok) throw new Error(out.error?.message || `HTTP ${resp.status}`)
    text = out.choices?.[0]?.message?.content?.trim() || ''
  } catch (e) {
    return { ok: false, error: String(e?.message || e) }
  }

  // 校验输出确实是 analysis YAML
  if (!/^analysis:\n {2}titleStructure:/m.test(text)) {
    return { ok: false, error: '模型输出不符合预期格式：' + text.slice(0, 120) }
  }

  const today = new Date().toISOString().slice(0, 10)
  let updated = md
  if (/^coverImage:/m.test(updated)) {
    updated = updated.replace(/^(coverImage:[^\n]*\n)/m, `$1${text}\nanalyzedAt: ${today}\n`)
  } else {
    updated = updated.replace(/^(---\n)/, `$1${text}\nanalyzedAt: ${today}\n`)
  }
  // 删除「待拆解」节
  updated = updated.replace(/\n---\n\n## AI 拆解\n\n\*\*待拆解\*\*[\s\S]*$/m, '\n')

  writeFileSync(file, updated)
  return { ok: true, analyzed: true }
}

/** 组装小红书图文发布 payload：解析 md → { title, lines, tags, coverAbs }，写 /tmp 供 ego 脚本读 */
export function prepareXhsPublish(rel, root = MEDIA_HUB_ROOT) {
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
  const bodyText = section('备忘录正文')
  if (!bodyText) throw new Error('正文（备忘录正文段）为空——先完成创作再发布')
  const tags = section('话题标签').split(/\s+/).filter((s) => s.startsWith('#'))
  const cover = (md.match(/^coverImage:\s*(\S+)$/m) || [])[1]
  const coverAbs = cover ? join(root, 'public', cover) : ''

  const payload = {
    title,
    lines: bodyText.split(/\n/).map((s) => s.trim()),
    tags,
    coverAbs,
  }
  writeFileSync('/tmp/media-hub-publish.json', JSON.stringify(payload))
  return { title, lines: payload.lines.length, tags: tags.length, coverAbs }
}

/** 标记已发布：此时才创建「发布后数据」段（发布环节的产出物；复盘数据后续由人/采集回填） */
export function publishNote(rel, link, platform = '', root = MEDIA_HUB_ROOT) {
  const file = join(root, rel)
  let md
  try {
    md = readFileSync(file, 'utf8')
  } catch {
    return { ok: false, error: '文件不存在' }
  }
  const today = new Date().toISOString().slice(0, 10)
  const section = [
    '## 发布后数据',
    '',
    '- 内容状态：已发布',
    `- 实际发布日期：${today}`,
    platform ? `- 发布平台：${platform}` : null,
    `- 发布链接：${link || ''}`,
  ].filter((l) => l !== null).join('\n') + '\n'

  let updated
  if (/^## 发布后数据$/m.test(md)) {
    updated = replaceSection(md, '发布后数据', section.replace(/^## 发布后数据\n/, '').trim())
  } else {
    updated = md.replace(/\s*$/, '') + '\n\n' + section
  }
  writeFileSync(file, updated)
  return { ok: true }
}

/* ==================== AI 创作日更（草稿 → 成稿） ==================== */

const HANDBOOK = join(MEDIA_HUB_ROOT, activeTarget.handbookPath)

function replaceSection(md, name, content) {
  const re = new RegExp('(## ' + name + '\\n)[\\s\\S]*?(?=\\n## |\\n---|$)')
  if (!re.test(md)) return md
  return md.replace(re, '$1' + content + '\n\n')
}

/**
 * 风格借鉴上下文：只取参考资料的「AI 拆解」结论（排版结构/表达风格），
 * **绝不读取原文正文** —— 内容必须从「当前推广对象」的产品视角原创，避免洗稿。
 */
function styleContext(fromLine = '', root = MEDIA_HUB_ROOT) {
  const name = (fromLine.match(/^(.+?)（/) || [])[1]?.trim()
  if (!name) return ''
  const ref = join(root, 'content/参考资料', name + '.md')
  try {
    const t2 = readFileSync(ref, 'utf8')
    const m = t2.match(/analysis:\n((?:  [^\n]*\n)+)/)
    if (!m) return ''
    const fields = {}
    for (const line of m[1].split('\n')) {
      const kv = line.match(/^  ([A-Za-z]+):\s*(.+)$/)
      if (kv) fields[kv[1]] = kv[2].trim()
    }
    const parts = []
    if (fields.titleStructure) parts.push('- 标题句式（可模仿结构，不抄字面）：' + fields.titleStructure)
    if (fields.hook) parts.push('- 开头钩子的手法：' + fields.hook)
    if (fields.structure) parts.push('- 行文/排版结构：' + fields.structure)
    if (fields.steal) parts.push('- 值得偷的表达技巧：' + fields.steal)
    if (fields.topics) parts.push('- 这类内容的选题方向：' + fields.topics)
    if (!parts.length) return ''
    return '【参考笔记「' + name + '」的可借鉴手法（只学结构与语气，内容必须原创）】\n' + parts.join('\n')
  } catch {}
  return ''
}

export async function writeDailyNote(rel, root = MEDIA_HUB_ROOT) {
  const key = readApiKey()
  if (!key) return { ok: false, error: '未配置 API key' }

  const file = join(root, rel)
  let md
  try {
    md = readFileSync(file, 'utf8')
  } catch {
    return { ok: false, error: '草稿文件不存在' }
  }

  const title = (md.match(/^# (.+)$/m) || [])[1] || ''
  const source = (md.match(/^- 灵感来源：(.+)$/m) || [])[1] || ''
  const style = styleContext(source, root)
  let handbook = ''
  try {
    handbook = readFileSync(HANDBOOK, 'utf8').slice(0, 9000)
  } catch {}

  let text = ''
  try {
    const resp = await fetch(`${LLM_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
      body: JSON.stringify({
        model: LLM_MODEL,
        temperature: 0.7,
        max_tokens: 3000,
        enable_thinking: false,
        messages: [
          { role: 'system', content: `你是「${activeTarget.brandName}」账号的资深写手。严格遵守以下运营手册规范写一篇小红书日更。\n\n【原创铁律（最高优先级）】参考笔记只提供排版结构与表达风格的借鉴——严禁复述、改写或缝合参考笔记的具体观点、案例、比喻和句子；必须结合「${activeTarget.brandName}」的产品视角（${activeTarget.productPerspective.join(' / ')}）与用户自己的真实生活场景，写出完全原创的内容。\n\n` + handbook + `\n\n【任务】基于选题标题与「可借鉴手法」，输出严格的 JSON（不带围栏、不带解释），字段：{"identity":"身份主题","intent":"创作意图（一句话）","openingType":"开头类型","body":"备忘录正文——严格遵守手册的行数限制与格式规则，段落间单个换行，不要任何 markdown 语法","caption":"发布配文（1-2 句）","tags":"#话题 #标签（3-6 个）","firstComment":"首评引导（一句话）"}` },
          { role: 'user', content: '【选题标题】' + title + '\n\n' + (style || '（无可借鉴手法，按标题与运营手册自由发挥）') },
        ],
      }),
    })
    const out = await resp.json()
    if (!resp.ok) throw new Error(out.error?.message || 'HTTP ' + resp.status)
    text = out.choices?.[0]?.message?.content?.trim() || ''
  } catch (e) {
    return { ok: false, error: String(e?.message || e) }
  }

  const raw = text.replace(/^```(json)?\n?/m, '').replace(/```\s*$/m, '').trim()
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end < 0) return { ok: false, error: '模型输出不含 JSON：' + text.slice(0, 100) }
  let parsed
  try {
    parsed = JSON.parse(raw.slice(start, end + 1))
  } catch {
    return { ok: false, error: 'JSON 解析失败：' + raw.slice(0, 150) }
  }

  let updated = md
  if (parsed.identity) updated = updated.replace(/^- 身份主题：.*$/m, '- 身份主题：' + parsed.identity)
  if (parsed.intent) updated = updated.replace(/^- 创作意图：.*$/m, '- 创作意图：' + parsed.intent)
  if (parsed.openingType) updated = updated.replace(/^- 开头类型：.*$/m, '- 开头类型：' + parsed.openingType)
  updated = replaceSection(updated, '备忘录正文', parsed.body || '')
  updated = replaceSection(updated, '发布配文', parsed.caption || '')
  updated = replaceSection(updated, '话题标签', parsed.tags || '')
  updated = replaceSection(updated, '首评引导', parsed.firstComment || '')
  writeFileSync(file, updated)
  return { ok: true }
}

const PENDING_DIR = 'content/自媒体运营/发布排期/待发布'
const SCHEDULED_DIR = 'content/自媒体运营/发布排期/已排期'

/** 排期：待发布/标题.md → 已排期/YYYY-MM/YYYY-MM-DD-标题.md（状态自动 ready → 到期 published） */
export function scheduleNote(rel, date, root = MEDIA_HUB_ROOT) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('日期格式应为 YYYY-MM-DD')
  const src = join(root, rel)
  if (!src.startsWith(join(root, PENDING_DIR))) throw new Error('只能排期 待发布/ 目录下的文件')
  if (!existsSync(src)) throw new Error('文件不存在')

  const base = rel.split('/').pop() || ''
  const name = base.replace(/^\d{4}-\d{2}-\d{2}-/, '').replace(/\.md$/, '')
  const month = date.slice(0, 7)
  const destDir = join(root, SCHEDULED_DIR, month)
  mkdirSync(destDir, { recursive: true })
  const dest = join(destDir, `${date}-${name}.md`)
  if (existsSync(dest)) throw new Error('目标文件已存在：' + dest)
  renameSync(src, dest)
  return { ok: true, rel: `${SCHEDULED_DIR}/${month}/${date}-${name}.md` }
}

/** 选题草稿（文件驱动，替代浏览器便签） */
export function safeTitleName(title) {
  return (title || '未命名选题')
    .replace(/[/\\:*?"<>|\n\r\t]/g, '')
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]/gu, '')
    .trim()
    .slice(0, 40)
}

/** 生成选题 → 落一份骨架 md 到 待发布/。正文留空 = 「草稿」状态；AI 写完正文自动变「待排期」 */
export function writeDraftMd({ title, fromKind, from }, root = MEDIA_HUB_ROOT) {
  const name = safeTitleName(title)
  if (!name) throw new Error('标题为空')
  const fromLine =
    fromKind === 'quote' ? `${from}（金句）`
    : fromKind === 'reading' ? `${from}（参考资料）`
    : fromKind === 'benchmark' ? `${from}（对标账号）`
    : from || '原创'

  const file = join(root, PENDING_DIR, `${name}.md`)
  if (existsSync(file)) throw new Error(`草稿已存在：${name}.md`)

  const md = `# ${name}

## 创作信息

- 身份主题：
- 创作意图：
- 灵感来源：${fromLine}
- 开头类型：
- 活动标识：（转化归因用，建议填短 ASCII，如 xxs-0901；留空则用文件名）

## 备忘录正文

## 发布配文

## 话题标签

## 首评引导

## 转化数据

（发布后回填：落地链接访问 / 下载 / Stars 等，一行一个「指标：数值」。
  内容数据说明传播，转化数据才说明值不值。）
`
  writeFileSync(file, md)
  return { file, rel: `${PENDING_DIR}/${name}.md` }
}

/** 删除草稿 md（仅允许 待发布/ 目录内，防路径穿越） */
export function deleteDraftMd(rel, root = MEDIA_HUB_ROOT) {
  const dir = join(root, PENDING_DIR)
  const file = join(root, rel)
  if (!file.startsWith(dir)) throw new Error('只能删除 待发布/ 目录下的文件')
  if (!existsSync(file)) throw new Error('文件不存在')
  unlinkSync(file)
  return { ok: true }
}
