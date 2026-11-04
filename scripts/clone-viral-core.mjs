#!/usr/bin/env node
/**
 * 一键克隆爆款：采到的一条爆款 → 拆出结构 → 映射到我的号和我的产品 → 出这一号的图文/竖屏视频脚本 → 落创作台。
 *
 * 三条硬规矩（与一键同款同一口径）：
 *  1. 学结构不抄表达：中间产物只留「这一步在干什么」，原文句子不作为产出的模板被复用。
 *  2. 事实只从产品档案来（config/products.json）：正文与口播里的效果断言带数字的，档案里没有就拦住。
 *  3. planClone 一个字不写（界面预览与测试都拿它跑），writeClone 才落盘。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { chatCompletion, extractScript } from './llm-core.mjs'
import {
  loadAiContext, listAccounts, markTopicConverted, pendingDirFor, platformOf, replaceSection, safeTitleName, topicTitleName,
  writeDraftMd, writeTopicMd,
} from './collect-note-core.mjs'
import { readProducts } from './products-core.mjs'
import { targetByFile } from './target-registry.mjs'

const ROOT = process.env.MEDIA_HUB_ROOT || process.cwd()
const TOPIC_DIR_REL = 'content/Projects/选题池'

/** 生成形式 / 商业目标 / 结构复用程度：界面与内核共用这一张表，别在两处各写一份 */
export const FORMS = { image: '图文内容', video: '竖屏视频脚本', both: '图文 + 视频脚本' }
export const GOALS = { lead: '获取咨询', sale: '卖课程或服务', trust: '建立专业影响力' }
export const FIDELITY = {
  align: '结构对齐：沿用它的步骤顺序，案例与表达全部重写',
  loose: '只借机制：学它为什么有效，段落自己重排',
}

/** 效果断言的词根：句子同时命中它和数字，就要在产品档案里找得到出处 */
const CLAIM_WORDS = /(涨粉|变现|收入|营收|成交额?|回本|利润|付费|转化|留存|复购|用户|学员|客户|粉丝|播放|阅读|曝光|涨|掉粉|掉)/

/** 模型常把 JSON 包在围栏或前后带话里，剥到第一个 { 到最后一个 } */
function parseModelJson(text) {
  const raw = String(text || '').replace(/^```(json)?\n?/m, '').replace(/```\s*$/m, '').trim()
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end < 0) return null
  try { return JSON.parse(raw.slice(start, end + 1)) } catch { return null }
}
const str = (v) => String(v ?? '').trim()
const toLines = (v) => (Array.isArray(v) ? v : String(v ?? '').split('\n')).map(str).filter(Boolean)

/**
 * 未经证实的说法：把「数字 + 效果词」的句子挑出来，数字在档案事实里找不到出处就报。
 * 只拦带数字的效果断言——「很有效」这种空话拦不住也不该拦。
 */
export function findUnverifiedClaims(text, factsText) {
  const facts = String(factsText || '')
  const hits = []
  for (const s of toLines(String(text || '').replace(/([。！？])/g, '$1\n')).flatMap(toLines)) {
    if (!/\d/.test(s) || !CLAIM_WORDS.test(s)) continue
    // 档案里出现过的数字算有出处；档案没有的数字要人自己确认过才放行
    const sourced = (s.match(/\d[\d.,]*/g) || []).every((n) => facts.includes(n.replace(/[.,]$/, '')))
    if (!sourced) hits.push(s)
  }
  return [...new Set(hits)]
}

/* ==================== 第一段：把爆款拆成可复用的步骤 ==================== */
export async function extractStructure({ title, script, analysis }, { chat = chatCompletion, log = () => {} } = {}) {
  log(`第一步：拆结构（脚本 ${script.length} 字）…`)
  const text = await chat({
    system: [
      '你在把一个爆款拆成「结构骨架」，供另一个账号照着骨架重做自己的内容。',
      '只输出一个 JSON（不带围栏、不带解释）：',
      '{"hook":"开头靠什么把人留住","audience":"它说给谁","pain":"戳的是哪个痛点","beats":[{"role":"这一步的名字","move":"这一步在干什么","why":"为什么有效"}],"turn":"情绪在哪一步转折","evidence":"它拿什么当证据（数据/亲历/对比/清单/权威）","cta":"它怎么收口引导动作"}',
      '硬约束：',
      '- beats 按原文出现顺序给 3–7 步，每步只写「在干什么」和「为什么有效」，不要摘抄原句、不要复述案例细节；',
      '- 结论只能从脚本内容推出，原文没写就不猜；',
      '- 一句话能说清就别写两句，空话（"内容不错""引发共鸣"）直接算错。',
    ].join('\n'),
    user: `【爆款标题】${title}\n\n【已有五层拆解】\n${analysis || '（还没拆过）'}\n\n【完整脚本】\n${script.slice(0, 6000)}`,
  })
  const j = parseModelJson(text)
  if (!j) return { ok: false, error: '模型没给出结构 JSON：' + str(text).slice(0, 120) }
  const beats = (Array.isArray(j.beats) ? j.beats : [])
    .map((b) => ({ role: str(b?.role), move: str(b?.move), why: str(b?.why) }))
    .filter((b) => b.role && b.move)
  if (!beats.length) return { ok: false, error: '模型没给出分步结构（beats 为空）' }
  return {
    ok: true,
    structure: { hook: str(j.hook), audience: str(j.audience), pain: str(j.pain), turn: str(j.turn), evidence: str(j.evidence), cta: str(j.cta), beats },
  }
}

/* ==================== 第二段：把骨架对到我的号和我的产品 ==================== */
export async function mapToBusiness({ structure, sourceTitle, account, product, target, goal, fidelity, context }, { chat = chatCompletion, log = () => {} } = {}) {
  log('第二步：对到我的号和我的产品…')
  const text = await chat({
    system: [
      '你手上有一份别人的爆款结构骨架。现在要把它落到「我这个号、我这个产品」上，做出每一步的自有内容计划。',
      '只输出一个 JSON（不带围栏、不带解释）：',
      '{"angle":"这一版我的切入角度","beats":[{"role":"对应骨架那一步的名字","mine":"我这一步写什么（具体到能下笔）","need":"需要我提供但材料里没有的事实，没有就空字符串"}],"avoid":"这次绝对不能碰的（对方的原句、独有案例、素材）"}',
      '硬约束：',
      '- 只能使用【我的材料】里给到的事实。材料里没有的客户数、收入、效果、时间，一律不许编；缺就写进 need，让人去补；',
      '- 视角、人群、口径以【账号定位】为准，挂不上产品的就别硬挂；',
      `- 商业目标：${GOALS[goal] || str(goal)}；${FIDELITY[fidelity] || str(fidelity)}；`,
      '- beats 与输入的骨架逐步对应，数量一致，不许合并或漏步。',
      `【账号定位】\n${context}`,
    ].join('\n'),
    user: [
      `【来源爆款】${sourceTitle}`,
      `【我的号】${account.id}（${account.platform}${account.nickname ? ' · ' + account.nickname : ''}）`,
      `【我的产品】${product.name}｜${product.kind}｜${product.oneLiner || ''}\n事实清单：\n- ${(product.facts || []).join('\n- ') || '（档案没写事实）'}`,
      target?.landing ? `【落地与口径】\n${JSON.stringify({ productPerspective: target.productPerspective, conversionGoal: target.conversionGoalLabel || target.conversionGoal, landing: target.landing }, null, 1)}` : '【落地与口径】这个产品没登记推广对象',
      `【结构骨架】\n${JSON.stringify(structure, null, 1)}`,
    ].join('\n\n'),
  })
  const j = parseModelJson(text)
  if (!j) return { ok: false, error: '模型没给出映射 JSON：' + str(text).slice(0, 120) }
  const beats = (Array.isArray(j.beats) ? j.beats : []).map((b) => ({ role: str(b?.role), mine: str(b?.mine), need: str(b?.need) })).filter((b) => b.mine)
  if (beats.length !== structure.beats.length) {
    return { ok: false, error: `映射的步骤数和骨架对不上（骨架 ${structure.beats.length} 步，映射 ${beats.length} 步）` }
  }
  return { ok: true, mapping: { angle: str(j.angle), beats, need: beats.map((b) => b.need).filter(Boolean), avoid: str(j.avoid) } }
}

/* ==================== 第三段：出这一号能直接编辑的成品 ==================== */
export async function generateVersions({ structure, mapping, form, platform, product, target, sourceTitle }, { chat = chatCompletion, log = () => {} } = {}) {
  log('第三步：生成我的版本…')
  const wantImage = form === 'image' || form === 'both'
  const wantVideo = form === 'video' || form === 'both'
  const text = await chat({
    system: [
      '按给定的结构计划和账号事实，写出这个号自己的成品。',
      '只输出一个 JSON（不带围栏、不带解释）：',
      '{"title":"标题（≤20 字，平台通用）","coverText":"封面大字，最多两行用 \\n 分隔","shortCopy":"一句话摘要","body":["正文段落，3–6 段"],"tags":["#话题"],"firstComment":"发出去后自己第一条评论写什么","cta":"结尾引导","video":{"shots":[{"sec":3,"visual":"画面","voice":"口播","subtitle":"屏幕字幕"}],"voiceover":"整段口播连读稿","outro":"结尾一句"}}',
      '硬约束：',
      '- 标题、正文、口播都是我自己账号的话，不复用来源爆款的句子和案例；',
      `- 数字与效果只能来自【产品事实】，档案里没有的不写；宁可写「我还在试」也不要编一个数；`,
      '- 段落要能直接发：不要写"（此处补充案例）"这类占位，不要写小标题式提纲；',
      `- 平台是${platform}：${wantVideo ? 'video.shots 给 5–9 个镜头，每镜 sec 合计约 25–45 秒，voice 连起来就是 voiceover；' : '没有视频需求就整个 video 字段给 null；'}${wantImage ? '' : ' 只要视频：body 给 []，title 仍要给。'}`,
      target?.landing?.primary ? `【结尾引导挂这个链接】${target.landing.primary}` : '',
    ].join('\n'),
    user: [
      `【来源爆款（只作结构参照）】${sourceTitle}`,
      `【我的切入】${mapping.angle}`,
      `【逐步计划】\n${mapping.beats.map((b, i) => `${i + 1}. ${b.role}：${b.mine}`).join('\n')}`,
      mapping.avoid ? `【这次不碰】${mapping.avoid}` : '',
      `【产品事实】${product.name}：\n- ${(product.facts || []).join('\n- ')}`,
    ].filter(Boolean).join('\n\n'),
  })
  const j = parseModelJson(text)
  if (!j) return { ok: false, error: '模型没给出成品 JSON：' + str(text).slice(0, 120) }
  const title = str(j.title)
  if (!title) return { ok: false, error: '模型没给标题' }
  const image = wantImage ? {
    title, coverText: str(j.coverText), shortCopy: str(j.shortCopy),
    body: toLines(j.body), tags: toLines(j.tags), firstComment: str(j.firstComment), cta: str(j.cta),
  } : null
  if (wantImage && !image.body.length) return { ok: false, error: '模型没给正文段落' }
  const video = wantVideo ? {
    title,
    shots: (Array.isArray(j.video?.shots) ? j.video.shots : [])
      .map((s) => ({ sec: Number(s?.sec) || 0, visual: str(s?.visual), voice: str(s?.voice), subtitle: str(s?.subtitle) }))
      .filter((s) => s.voice || s.visual),
    voiceover: str(j.video?.voiceover), outro: str(j.video?.outro),
  } : null
  if (wantVideo && !video.shots.length) return { ok: false, error: '模型没给分镜（video.shots 为空）' }
  return { ok: true, versions: { image, video } }
}

/* ==================== 编排：三段跑完 + 卡口，不写盘 ==================== */
export async function planClone(
  { file, account: accountId, form = 'image', goal = 'lead', fidelity = 'align', product: productName },
  { root = ROOT, chat = chatCompletion, log = () => {} } = {},
) {
  if (!file) return { ok: false, error: '缺少 file（爆款采集卡）' }
  const rel = String(file).startsWith('content/') ? String(file) : `content/${String(file)}`
  const abs = join(root, rel)
  if (!existsSync(abs)) return { ok: false, error: '采集卡文件不存在：' + rel }
  const md = readFileSync(abs, 'utf8')
  const script = extractScript(md)
  if (!script) return { ok: false, error: '这条还没有「## 脚本」段——先点「补采脚本」，克隆的输入是完整脚本' }

  const accounts = listAccounts(root)
  const account = accounts.find((a) => a.id === accountId)
  if (!account) return { ok: false, error: `未知账号「${accountId}」，已登记：${accounts.map((a) => a.id).join('、')}` }
  if (!FORMS[form]) return { ok: false, error: `未知生成形式：${form}` }

  const { products } = readProducts(root)
  const want = productName || (md.match(/^-?\s*归属品牌：\s*(.+)$/m) || [])[1]
  const product = want ? products.find((p) => p.name === String(want).trim()) : products.find((p) => (account.script || '').includes(p.name)) || products[0]
  if (!product) return { ok: false, error: `没找到产品档案「${want || ''}」——到「产品」页先登记，事实只从档案来` }
  const target = targetByFile(product.target, { root })

  const rawTitle = (md.match(/^title:\s*(.+)$/m) || [])[1] || (md.match(/^# (.+)$/m) || [])[1] || rel.split('/').pop()
  // frontmatter 里的 title 带引号，不剥掉会一路带进灵感来源那行
  const title = str(rawTitle).replace(/^["'](.*)["']$/, '$1')
  const analysis = (md.match(/^analysis:\n((?:  .*\n)+)/m) || [])[1]?.trim() || ''
  const context = loadAiContext(root)

  const s1 = await extractStructure({ title: str(title), script, analysis }, { chat, log })
  if (!s1.ok) return s1
  const s2 = await mapToBusiness(
    { structure: s1.structure, sourceTitle: str(title), account, product, target, goal, fidelity, context },
    { chat, log },
  )
  if (!s2.ok) return s2
  const s3 = await generateVersions(
    { structure: s1.structure, mapping: s2.mapping, form, platform: platformOf(accounts, account.id), product, target, sourceTitle: str(title) },
    { chat, log },
  )
  if (!s3.ok) return s3

  const factsText = (product.facts || []).join('\n')
  const allText = [s3.versions.image?.body.join('\n'), s3.versions.image?.cta, s3.versions.video?.voiceover, s3.versions.video?.outro].filter(Boolean).join('\n')
  const claims = findUnverifiedClaims(allText, factsText)
  const errors = claims.length
    ? [`有 ${claims.length} 处产品档案里没有的数字或效果说法，先去「产品」页补进事实、或改掉再克隆：\n- ${claims.join('\n- ')}`]
    : []
  if (s2.mapping.need.length) {
    log(`要补的事实 ${s2.mapping.need.length} 条（不拦，写进预览里给人看）`)
  }

  return {
    ok: errors.length === 0,
    errors,
    gates: { unverifiedClaims: claims, needFacts: s2.mapping.need },
    source: { file: rel, title: str(title), platform: platformOf(accounts, account.id), scriptChars: script.length, analysis },
    account: { id: account.id, platform: account.platform, nickname: account.nickname || '' },
    product: { name: product.name, facts: product.facts || [] },
    form, goal, fidelity,
    structure: s1.structure, mapping: s2.mapping, versions: s3.versions,
    target: target?.landing?.primary ? { landing: target.landing.primary } : null,
  }
}

/* ==================== 落盘：选题卡 + 这一号的稿，来源回链留住 ==================== */
export function writeClone(plan, { root = ROOT } = {}) {
  if (!plan?.versions) return { ok: false, error: '没有可保存的生成结果' }
  if (plan.gates?.unverifiedClaims?.length) return { ok: false, error: '还有没核实的说法，先改掉' }
  const image = plan.versions.image
  const video = plan.versions.video
  const title = image?.title || video?.title || plan.source.title
  const from = `${plan.source.title}（克隆结构）`

  // 两份都要落，先各自查重：不然选题卡建了、稿却撞名，留一张没稿的选题
  const topicName = topicTitleName(title)
  const draftName = safeTitleName(title)
  if (existsSync(join(root, TOPIC_DIR_REL, `${topicName}.md`))) return { ok: false, error: `选题已有同名卡：${topicName}.md——改个标题再存，或直接去创作台接着写` }
  if (existsSync(join(root, pendingDirFor(plan.account.id), `${draftName}.md`))) return { ok: false, error: `这一号已有同名稿：${draftName}.md——先去创作台看它一眼` }

  const topic = writeTopicMd({
    title, fromKind: 'viral', from: plan.source.title, sourceRel: plan.source.file, product: plan.product.name,
  }, root)

  const d = writeDraftMd({ title, fromKind: 'viral', from, account: plan.account.id, product: plan.product.name }, root)
  const abs = join(root, d.rel)
  let md = readFileSync(abs, 'utf8')
  const bodyParts = []
  if (image?.body?.length) bodyParts.push(image.body.join('\n\n'))
  if (video?.shots?.length) {
    bodyParts.push(
      '### 分镜\n\n' + video.shots.map((s, i) => `${i + 1}. ${s.sec || '—'}s｜${s.visual}｜${s.voice}`).join('\n'),
    )
    if (video.voiceover) bodyParts.push('### 口播全文\n\n' + video.voiceover)
  }
  if (image?.cta || video?.outro) bodyParts.push([image?.cta, video?.outro].filter(Boolean).join('\n'))
  md = replaceSection(md, '备忘录正文', bodyParts.filter(Boolean).join('\n\n'))
  if (image?.shortCopy || image?.coverText) md = replaceSection(md, '发布配文', [image.coverText?.replace(/\n/g, ' / '), image.shortCopy].filter(Boolean).join('\n'))
  if (image?.tags?.length) md = replaceSection(md, '话题标签', image.tags.join(' '))
  if (image?.firstComment) md = replaceSection(md, '首评引导', image.firstComment)
  md = md.replace(/^- 开头类型：.*$/m, `- 开头类型：${plan.structure.hook || ''}`.slice(0, 500))
  writeFileSync(abs, md)

  markTopicConverted(plan.source.file, root)
  return { ok: true, topicRel: topic.rel, draftRel: d.rel, title }
}
