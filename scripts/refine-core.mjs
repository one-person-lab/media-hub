#!/usr/bin/env node
/**
 * 局部优化：一句意见 → 模型把命中的整段重写一遍（连带把被牵动的上下文捋顺）→ 界面按段看差异 → 采纳才落盘。
 * 叫「局部」是指动手的范围，不是指眼光：换掉一个例子会让承接句、配文、首评、图卡那一行一起失焦，
 * 所以一次请求里把所有版的可改单元和来源脚本全给出去，要求它把牵连到的段落一并改顺，不许只改一半。
 * 模型只交「这一段的新文字」，原文由我们从盘上读，落盘是整段替换——它抄错一个字都污染不了文件。
 */
import { readFileSync, existsSync } from 'node:fs'
import { resolve, sep } from 'node:path'

/** 稿里可改的段：创作信息与转化数据是机器读数，标题走创作环节，都不给模型碰 */
const REFINE_SECTIONS = /^(正文|发布配文|话题标签|首评引导|.*文案|贴图描述)$/

/** 图卡 json 里的文字字段（与 src/lib/cardFields.ts 同一份名单）：版式参数不在内 */
const CARD_TEXT_KEYS = new Set([
  'zh', 'en', 'src', 'srcEn', 'echo', 'quote', 'hl', 'quoteEn', 'who', 'role', 'kicker', 'cta',
  'title', 'head', 'items', 'lines',
])

/** 按 `## 段名` 切段：只回可改段。frontmatter、H1、卡片数据声明行天然落在名单外 */
export function editableSections(md) {
  const lines = md.split('\n')
  const out = []
  let cur = null
  for (const l of lines) {
    const m = /^## (.+?)\s*$/.exec(l)
    if (m) {
      const name = m[1].trim()
      cur = REFINE_SECTIONS.test(name) ? { name, body: [] } : null
      if (cur) out.push(cur)
      continue
    }
    if (cur) cur.body.push(l)
  }
  return out.map((s) => ({ name: s.name, text: s.body.join('\n').trim() }))
}

/** 整段替换：段名对不上就回错，别的段落一个字不动 */
export function swapSection(md, name, after) {
  const lines = md.split('\n')
  const start = lines.findIndex((l) => l.trim() === `## ${name}`)
  if (start < 0) return { ok: false, error: `稿里没有「${name}」段` }
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) if (/^## /.test(lines[i])) { end = i; break }
  // 段间固定一个空行（下一段存在时），末段不留空行：同样内容再存一次字节不变
  const body = ['', after.trim(), ...(end < lines.length ? [''] : [])]
  const next = [...lines.slice(0, start + 1), ...body, ...lines.slice(end)].join('\n')
  return { ok: true, md: next.endsWith('\n') ? next : next + '\n' }
}

/** 遍历图卡全部文字叶子（名单同 cardFields）：数组套数组只取首项，那是 [文字, 色块类名] 的色块位 */
function eachCardText(data, cb) {
  const walk = (node, path) => {
    if (!node || typeof node !== 'object') return
    for (const [k, v] of Object.entries(node)) {
      if (!CARD_TEXT_KEYS.has(k)) continue
      const at = [...path, k]
      if (typeof v === 'string') cb(at, v)
      else if (Array.isArray(v)) v.forEach((row, i) => {
        if (typeof row === 'string') cb([...at, i], row)
        else if (Array.isArray(row)) { if (typeof row[0] === 'string') cb([...at, i, 0], row[0]) }
        else walk(row, [...at, i])
      })
    }
  }
  ;(data?.pages || []).forEach((p, i) => walk(p, ['pages', i]))
}

/** 图卡的一行 = 一个可改单元（带取值路径，落盘按路径写，不做文字匹配） */
function cardUnits(data, rel) {
  const units = []
  eachCardText(data, (path, value) => {
    if (value.trim().length < 2) return
    const page = Number(path[1]) + 1
    units.push({
      kind: 'card', rel, path, text: value,
      where: `第${page}页 ${path.slice(2).join('.')}`,
    })
  })
  return units
}

/**
 * 摊出这条选题的全部可改单元：各版稿的每个可改段 + 图卡的每一行。
 * 读不到文件 / 没有可改段的条目直接跳过——缺哪版是常态（骨架还没建），不该因此开不了口。
 */
export function refineTargets(root, targets) {
  const out = []
  for (const t of targets) {
    const rel = String(t.rel || '')
    if (!rel || rel.includes('..')) continue
    const abs = resolve(root, rel)
    if (!abs.startsWith(resolve(root) + sep) || !existsSync(abs)) continue
    if (t.kind === 'card') {
      let data
      try { data = JSON.parse(readFileSync(abs, 'utf8')) } catch { continue }
      out.push(...cardUnits(data, rel).map((u) => ({ ...u, label: t.label })))
      continue
    }
    for (const s of editableSections(readFileSync(abs, 'utf8'))) {
      if (s.text) out.push({ kind: 'md', rel, label: t.label, section: s.name, where: `${s.name}段`, text: s.text })
    }
  }
  return out.map((u, i) => ({ ...u, index: i + 1 }))
}

/** 一句意见 → 模型给出逐段新文字。edits 里的 before 由我们按 target 回填，模型不需要抄原文 */
export async function runRefinePlan({ instruction, targets, basis, knowledge, chat }) {
  if (!instruction?.trim()) return { ok: false, error: '先说一句怎么改' }
  if (!targets.length) return { ok: false, error: '这一条还没有可改的正文（先完成创作）' }

  const text = await chat({
    system: [
      `你是这个自媒体仓库的改稿助手。用户对已写好的稿提了一句意见，你要把它落到稿面上。`,
      `只输出一个 JSON（不带围栏、不带解释）：`,
      `{"edits":[{"target":编号,"after":"这一整段的新文字","why":"一句话说明改了什么、为什么"}],"note":"一句话向用户交代这次优化动了什么；没动就说明原因"}`,
      `硬约束：`,
      `- target 是下面【可改单元】的编号；after 是这一整段重写后的全部文字，不是要替换的片段——段里没被意见涉及的内容、事实、数字、出处一律原样保住；`,
      `- 一次改动会牵动上下文：换了例子，承接句、指代、小标题、结尾提问都要跟着捋顺，不能留下「按上面那个例子」却指不到东西的话；`,
      `- 同一选题的各版共用一套说法：正文改了，发布配文、首评、各平台短文案、图卡那几行里引用它的地方必须一并给出新文字，不许只改一版——漏掉的版会留着旧说法跟新版说岔话；`,
      `- 各单元保持自己的形态与长度量级：短文案段别写成长正文，图卡单行别超原来那一行的长度，话题标签还是标签；`,
      `- 案例口径以【知识库】的 创作规范 为准：原作者的个人经历不许搬，换成用户自己的或虚拟案例，不写可被核对的硬数字；`,
      `- 标题、创作信息、转化数据、发布状态行不在名单里，不要输出；拿不准就少改，在 note 里说明。`,
      basis ? `【来源脚本（复刻的事实与观点以它为准，改的时候别把口径改丢）】\n${basis}` : ``,
      `【知识库】\n${knowledge}`,
    ].filter(Boolean).join('\n'),
    user: [
      `【我的意见】`,
      instruction.trim(),
      ``,
      `【可改单元】（编号即 target）`,
      ...targets.map((t) => `编号 ${t.index}｜${t.label}｜${t.where}\n${t.text}`),
    ].join('\n\n'),
    temperature: 0.6,
  })

  const raw = text.replace(/^```(json)?\n?/m, '').replace(/```\s*$/m, '').trim()
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end < 0) return { ok: false, error: '模型输出不含 JSON：' + text.slice(0, 120) }
  let parsed
  try { parsed = JSON.parse(raw.slice(start, end + 1)) } catch { return { ok: false, error: 'JSON 解析失败：' + raw.slice(0, 120) } }
  const byIndex = new Map(targets.map((t) => [t.index, t]))
  const seen = new Set()
  const edits = []
  for (const e of Array.isArray(parsed.edits) ? parsed.edits : []) {
    // 模型会把编号照抄成 "#1"、"1." 这类带符号的写法，只认里面的数字
    const num = Number(String(e?.target ?? '').replace(/\D/g, ''))
    const t = byIndex.get(num)
    const after = String(e?.after ?? '').trim()
    if (!t || !after || seen.has(t.index)) continue
    seen.add(t.index)
    if (after === t.text) continue
    edits.push({ target: t.index, kind: t.kind, rel: t.rel, label: t.label, where: t.where, section: t.section, path: t.path, before: t.text, after, why: String(e.why || '').trim() })
  }
  // 模型说改了却一条没落上：多半是编号写飞了，如实报错让它重来，别拿一句 note 糊过去
  if (!edits.length && Array.isArray(parsed.edits) && parsed.edits.length) {
    return { ok: false, error: '模型给的单元编号对不上（可能是凭空编号），重新出一次方案试试' }
  }
  return { ok: true, edits, note: String(parsed.note || '').trim() }
}

/**
 * 落盘：md 整段替换、图卡按路径写回那一行。
 * 这里只算出新内容并交回结果，写文件与重渲由端点做（它才有渲染队列的锁）。
 */
export function applyRefineEdits(root, edits) {
  const slots = new Map()
  const slotOf = (e) => {
    if (!slots.has(e.rel)) {
      const abs = resolve(root, e.rel)
      slots.set(e.rel, { abs, raw: readFileSync(abs, 'utf8') })
    }
    return slots.get(e.rel)
  }

  const results = []
  for (const e of edits) {
    const slot = slotOf(e)
    if (e.kind === 'card') {
      slot.data = slot.data ?? JSON.parse(slot.raw)
      let node = slot.data
      for (const p of (e.path || []).slice(0, -1)) node = node?.[p]
      const key = e.path?.[e.path.length - 1]
      const hit = node && key !== undefined && typeof node[key] === 'string'
      if (hit) node[key] = e.after
      results.push({ ...e, ok: hit, error: hit ? '' : '图卡里那一行已经不在了（可能被改过），请重新出方案' })
      continue
    }
    const r = swapSection(slot.md ?? slot.raw, e.section, e.after)
    if (r.ok) slot.md = r.md
    results.push({ ...e, ok: r.ok, error: r.ok ? '' : r.error })
  }

  const writes = [...slots]
    .filter(([, s]) => (s.md != null && s.md !== s.raw) || s.data != null)
    .map(([rel, s]) => ({
      kind: s.data != null ? 'card' : 'md',
      rel,
      abs: s.abs,
      md: s.md,
      data: s.data,
    }))
  return { results, writes }
}
