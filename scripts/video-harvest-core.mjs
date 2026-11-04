/**
 * 视频爆款结构收编：把采集回来的抖音口播爆款，从带时间码的逐字稿里量出结构，存成候选视频模板。
 *
 * 图文那条线搬的是皮（色值）和排法，视频这条线搬不动画面，能搬的只有节奏结构：
 * 多长、多少拍、语速多快、开场几秒说完钩子、几处停顿分段。这些全是从逐字稿的时间码上量出来的读数，
 * 不是「爆款感」「强节奏」这种没法验证的形容词。
 *
 * 收编来的条目一律 status=candidate，且没有 composition/project/render——平台不渲别人的片子，
 * 它是一份照着拍的规格（口径见 content/Knowledge/视频创作.md）。人在界面上点头转正，它才进可选列表。
 */
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..')
export const VIDEO_TPLS_REL = 'config/video-templates.json'

const readJson = (root, rel) => JSON.parse(readFileSync(join(root, rel), 'utf8'))

/** 原子写：tmp + 同目录 rename。收编一次写整份目录，写一半崩了会把 config 变成非法 JSON */
function writeJson(root, rel, obj) {
  const tmp = join(root, `${rel}.${process.pid}.tmp`)
  writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n')
  renameSync(tmp, join(root, rel))
}

/** 逐字稿 → 带时间码的拍：只认「[Ns] 文本」这种采集线/转写写回来的格式 */
export function parseBeats(script) {
  const out = []
  const seen = new Set()
  for (const line of String(script || '').split('\n')) {
    const m = line.match(/^\s*\[(\d+(?:\.\d+)?)s\]\s*(.*)$/)
    if (!m) continue
    const text = m[2].trim()
    if (!text) continue
    // 同一句写两遍的是转写与画面字幕撞在一起（同一时间码两份文本），数一遍就够
    if (seen.has(text)) continue
    seen.add(text)
    out.push({ at: Number(m[1]), text })
  }
  return out.sort((a, b) => a.at - b.at)
}

/** 一条能当模板用的短片结构：15 秒到 5 分钟之间。
 *  比这长的多半是直播切片或课程录屏，抄不动；比这短的连钩子都立不住。 */
export const MIN_DUR = 15
export const MAX_DUR = 300
/** 语速上限：正常中文口播 4-6 字/秒，超过 8 只可能是稿子里混进了画面字，这个数不可信 */
export const MAX_CPS = 8

/** 逐字稿末拍时间就是这条片子的长度；采集时没量到视频时长的老卡靠它补上（build-data 也用它） */
export function scriptDurationSec(script) {
  const beats = parseBeats(script)
  return beats.length ? Math.round(beats[beats.length - 1].at) : 0
}

/**
 * 从拍里量结构。读数各自回答一件事：
 *  - durationSec：这条片子多长（末拍时间）
 *  - charsPerSec：语速，字/秒——口播爆款普遍比正常人快，这是能抄的第一件事
 *  - beatSec：平均一拍几秒，即切镜/换句的节奏；maxGap：最长一次停顿（留白在哪一拍之后）
 *  停顿的绝对秒数没法当分段用：转写行的间隔本来就 2 秒上下，多长算「一次换气」各条片子不一样，
 *  所以这里只报平均拍长和最长间隔，不硬判「几段」。
 * 开场钩子按前 8 秒算：这几秒说了多少字、哪几拍，决定观众走不走。
 * 量完过不了上面两道闸的返回 null 并带上原因：宁可不收，也不给库里挂一个说不圆的数字。
 */
export function structureFromScript(script) {
  const beats = parseBeats(script)
  if (beats.length < 3) return null
  const durationSec = scriptDurationSec(script)
  const chars = beats.reduce((n, b) => n + [...b.text.replace(/\s/g, '')].length, 0)
  const hook = beats.filter((b) => b.at <= 8)
  const hookChars = hook.reduce((n, b) => n + [...b.text.replace(/\s/g, '')].length, 0)
  let maxGap = 0
  for (let i = 1; i < beats.length; i++) maxGap = Math.max(maxGap, beats[i].at - beats[i - 1].at)
  const charsPerSec = durationSec > 0 ? Math.round((chars / durationSec) * 10) / 10 : 0
  if (durationSec < MIN_DUR) return null
  if (durationSec > MAX_DUR) return null
  if (charsPerSec > MAX_CPS) return null
  return {
    durationSec,
    beats: beats.length,
    chars,
    charsPerSec,
    beatSec: beats.length > 1 ? Math.round(((durationSec - beats[0].at) / (beats.length - 1)) * 10) / 10 : durationSec,
    maxGap: Math.round(maxGap),
    hookSec: hook.length ? Math.round(hook[hook.length - 1].at) : 0,
    hookChars,
    hookLines: hook.length,
    hookText: hook.map((b) => b.text).join(' '),
  }
}

const heatNum = (v) => Number(v && typeof v === 'object' ? v.heat : v) || 0

/**
 * 一条爆款 → 一条候选模板。名字直接由读数说话（「62 秒口播 · 4.9 字/秒 · 每拍 2 秒」），
 * 库里两条同类的靠数字区分，不靠「紧凑」「有力」这种谁都能写的词。
 */
export function videoCandidate(item) {
  const st = structureFromScript(item.script)
  if (!st) return null
  const id = String(item.id || '')
  const label = `${st.durationSec} 秒口播 · ${st.charsPerSec} 字/秒 · 每拍 ${st.beatSec} 秒`
  return {
    key: `viral-${item.platform || 'dy'}-${id.slice(0, 8)}`,
    label,
    kind: '爆款结构',
    status: 'candidate',
    composition: '',
    project: '',
    fps: 0,
    size: '',
    durationSec: st.durationSec,
    order: 900 + Number(item.heat || 0),
    source: {
      platform: item.platform || '',
      noteId: id,
      title: item.title || '',
      url: item.url || '',
      likes: item.likes || '',
      collects: item.collects || '',
      comments: item.comments || '',
      heat: heatNum(item),
    },
    structure: st,
    pick:
      `逐字稿量出来的：${st.durationSec} 秒 ${st.chars} 字（${st.charsPerSec} 字/秒），` +
      `${st.beats} 拍、平均一拍 ${st.beatSec} 秒，最长一次停顿 ${st.maxGap} 秒；` +
      `前 ${st.hookSec} 秒把钩子说完（${st.hookChars} 字）。抄的是这个节奏，不是它的稿子。`,
  }
}

/** 量不出结构时说得清是哪一种量不出来：界面拿这句当跳过原因，不能只会说「没有逐字稿」 */
export function structureRejectReason(script) {
  const beats = parseBeats(script)
  if (beats.length < 3) return '这条没有带时间码的逐字稿，量不出节奏'
  const durationSec = Math.round(beats[beats.length - 1].at)
  if (durationSec < MIN_DUR) return `这条只有 ${durationSec} 秒，太短立不住钩子`
  if (durationSec > MAX_DUR) return `这条 ${Math.round(durationSec / 60)} 分钟，不是照着拍得动的短片结构`
  const chars = beats.reduce((n, b) => n + [...b.text.replace(/\s/g, '')].length, 0)
  const cps = durationSec > 0 ? chars / durationSec : 0
  if (cps > MAX_CPS) return `逐字稿里混了画面字（算出来 ${Math.round(cps * 10) / 10} 字/秒），语速不可信`
  return ''
}

/** 收一批：没带时间码逐字稿的、库里已有同一条笔记的都跳过并说清为什么，剩下的落盘 */
export function saveVideoCandidates(items, opt = {}) {
  const root = opt.root || ROOT
  const j = readJson(root, VIDEO_TPLS_REL)
  if (!Array.isArray(j.templates)) throw new Error(`${VIDEO_TPLS_REL} 里没有 templates 数组`)
  const saved = []
  const skipped = []
  for (const it of Array.isArray(items) ? items : []) {
    const id = String(it?.id || '')
    if (!id) {
      skipped.push({ id: '', why: '没给笔记号' })
      continue
    }
    if (j.templates.some((t) => t.source?.noteId === id)) {
      skipped.push({ id, why: '库里已经收过这条' })
      continue
    }
    const entry = videoCandidate(it)
    if (!entry) {
      skipped.push({ id, why: structureRejectReason(it.script) || '这条量不出能抄的结构' })
      continue
    }
    if (j.templates.some((t) => t.key === entry.key)) {
      skipped.push({ id, why: `已经有同一条笔记的模板（${entry.key}）` })
      continue
    }
    j.templates.push(entry)
    saved.push({ key: entry.key, label: entry.label })
  }
  if (saved.length) writeJson(root, VIDEO_TPLS_REL, j)
  return { saved, skipped }
}

/** 转正：候选 → 在架。它仍然没有 composition 和成片——转正只是让人能在创作时选它照着拍。 */
export function promoteVideoCandidate(input, opt = {}) {
  const root = opt.root || ROOT
  const j = readJson(root, VIDEO_TPLS_REL)
  const t = j.templates.find((x) => x.key === String(input.template || ''))
  if (!t) throw new Error(`视频模板目录里没有「${input.template}」`)
  if (t.status !== 'candidate') throw new Error(`「${t.label}」不是候选，不用转正`)
  t.status = 'active'
  t.order = Math.max(...j.templates.map((x) => Number(x.order) || 0)) + 1
  writeJson(root, VIDEO_TPLS_REL, j)
  return { templateKey: t.key, label: t.label }
}

/** 删掉候选：收编来的东西反悔要能一键清干净，否则库里堆满没人看的节奏读数 */
export function dropVideoCandidate(input, opt = {}) {
  const root = opt.root || ROOT
  const j = readJson(root, VIDEO_TPLS_REL)
  const at = j.templates.findIndex((x) => x.key === String(input.template || ''))
  if (at < 0) throw new Error(`视频模板目录里没有「${input.template}」`)
  const t = j.templates[at]
  if (t.status !== 'candidate') throw new Error(`「${t.label}」已经转正，不在候选里，别在这里删`)
  j.templates.splice(at, 1)
  writeJson(root, VIDEO_TPLS_REL, j)
  return { templateKey: t.key, label: t.label }
}
