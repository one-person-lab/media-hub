/**
 * 复盘学习环的纯逻辑：待复盘判定、结论索引、结论台账、预答证据。
 *
 * 存在的理由（评分体系.md §四）：⑤ 的结论必须能改变 ② 的决定，否则闭环没跑起来。
 * 结论原本只长在稿 md 里，选题预审和创作环节读不到——这里把它摊成一份可注入的索引，
 * 判据与写法都改成引真实结论，而不是让模型按定位现编一句「依据经验」。
 *
 * 只吃已解析好的 article 对象（build-data 的产物 / generated.json），不自己解析 md：
 * 段落口径已经住在 build-data 里，第二份解析器迟早和它分家。
 */
import { localDay } from './day-core.mjs'

/** T+3 才复盘：数据要跑够一个推荐周期，第一天看到的数字不作数 */
export const T_PLUS_DAYS = 3

/** 台账落点：派生物，稿 md 才是结论的真身（改了稿，下次 gen:data 重写这一份） */
export const LEDGER_REL = 'metrics/lessons.md'

/** 注入 prompt 的预算：结论越攒越多，不能无限撑大每一次调用的上下文 */
export const LEDGER_INJECT_LIMIT = 40
export const LEDGER_INJECT_CHARS = 6000

const norm = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')

const dayMs = 86400000

/** 'YYYY-MM-DD' → 当天零点毫秒；拿不到日期的按「不可判」返回 null */
function toDay(s) {
  const m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (!m) return null
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
}

/** 台账与复盘判定用的「今天」：本机日历日，跟快照桶名同一把尺 */
export function todayISO(d = new Date()) {
  return localDay(d)
}

const hasLesson = (a) => String(a?.lesson || '').trim().length > 10

/**
 * 这一篇到没到该复盘的时候。
 * 返回 reason 而不是布尔：界面上「太早」和「已复盘」是两件不同的事，
 * 把还没到 T+3 的算进待办，等于天天催一件此刻答不了的题。
 */
export function reviewDue(a, { today = todayISO(), tPlus = T_PLUS_DAYS } = {}) {
  if (a?.status !== 'published') return { due: false, reason: 'not_published', days: null }
  const day = toDay(a.date)
  const now = toDay(today)
  if (day == null || now == null) return { due: false, reason: 'no_date', days: null }
  const days = Math.floor((now - day) / dayMs)
  if (hasLesson(a)) return { due: false, reason: 'already', days }
  // 发布日当天算第 0 天：T+3 = 隔三天再回头看
  if (days < tPlus) return { due: false, reason: 'too_soon', days }
  return { due: true, reason: 'due', days }
}

/** 待复盘清单：越久没复盘的排越前（逾期天数是唯一的排序依据，不按数据好坏——数据好坏不影响该不该补） */
export function reviewQueue(articles, opts = {}) {
  return articles
    .map((a) => ({ article: a, ...reviewDue(a, opts) }))
    .filter((x) => x.due)
    .sort((x, y) => y.days - x.days || String(x.article.date).localeCompare(String(y.article.date)))
}

/**
 * 这条选题在各平台稿之间的聚合键 = 去掉日期前缀的文件名。
 * 创作提示词里写死了「只改 H1，文件名不要动——文件名是这条选题各平台版本的聚合键」，
 * 而各版标题本来就各起一条，所以按标题归并会把一题散成五题，键才是对的。
 */
export function topicKeyOf(a) {
  const base = String(a?.file || '').split('/').pop() || ''
  const key = base.replace(/^\d{4}-\d{2}-\d{2}-/, '').replace(/\.md$/, '').trim()
  return key || norm(a?.title)
}

/** 同一选题在各平台的那几版稿：已发布且还没结论的才算——写回会把段整个替换，
 *  把哪一版已经答过的结论默默覆盖掉，比漏掉一版更糟。 */
export function topicSiblings(articles, article) {
  const key = topicKeyOf(article)
  if (!key) return []
  return (articles || []).filter((a) => a !== article && a?.status === 'published' && !hasLesson(a) && topicKeyOf(a) === key)
}

/**
 * 待复盘按选题归并：一个题五平台的稿各写一遍结论是假工作量，
 * 复盘回答的是「这个题这么做成不成」，答案对五版同时成立。
 * primary 取有读数的那一版（没读数就当证据摆不出），供预答与写回当主稿。
 */
export function reviewTopics(articles, opts = {}) {
  const seen = new Set()
  const out = []
  for (const item of reviewQueue(articles, opts)) {
    const a = item.article
    const key = topicKeyOf(a)
    if (seen.has(key)) continue
    const group = [a, ...topicSiblings(articles, a)]
    group.forEach((x) => seen.add(topicKeyOf(x)))
    const hasData = (x) => ['views', 'likes', 'collects'].some((k) => x.metrics?.[k] != null)
    out.push({
      title: a.title,
      date: a.date,
      days: item.days,
      primary: group.find((x) => x.account === '小红书' && hasData(x)) || group.find(hasData) || group[0],
      files: group.map((x) => x.file),
      group,
    })
  }
  return out
}

const numFmt = (v) => {
  // null / undefined / '' 一律当没读到：Number(null) 是 0，不挡就会把缺项印成「赞 0」冒充读数
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  if (!Number.isFinite(n)) return null
  return n >= 10000 ? `${(n / 10000).toFixed(n >= 100000 ? 0 : 1)}万` : String(n)
}

/** 一行读数读数，缺的项不写「0」冒充 */
export function metricsLine(m = {}) {
  const label = [['views', '播放'], ['likes', '赞'], ['collects', '藏'], ['comments', '评'], ['shares', '享'], ['follows', '粉']]
  const parts = label
    .map(([k, cn]) => (numFmt(m[k]) != null ? `${cn} ${numFmt(m[k])}` : null))
    .filter(Boolean)
  if (m.completeRate) parts.push(`完读 ${m.completeRate}`)
  return parts.length ? parts.join(' · ') : '无读数'
}

/** 已写结论的已发布稿 → 索引（发布日倒序）；rel 用 content/ 前缀，回链直接能点开 */
export function lessonIndex(articles) {
  return articles
    .filter((a) => a?.status === 'published' && hasLesson(a))
    .map((a) => ({
      rel: `content/${a.file}`,
      title: a.title,
      account: a.account,
      date: a.date || '',
      lesson: String(a.lesson).trim(),
      metrics: a.metrics || {},
      metricsText: metricsLine(a.metrics || {}),
    }))
    .sort((x, y) => String(y.date).localeCompare(String(x.date)))
}

/**
 * 台账正文：一条结论一段，带出处与当时的读数。
 * 这份是给本机 Agent 读的（创作 prompt 让它读文件），所以不摆表格、不写解释，
 * 只保留「结论 + 证据 + 回链」——评分体系 §四 要求的三件套。
 */
export function renderLedger(lessons, { generatedAt = todayISO() } = {}) {
  const head = [
    '# 复盘结论台账（机器生成，勿手改）',
    '',
    `> 来源：各篇稿件的「## 这篇教会了我们什么」段，共 ${lessons.length} 条，截至 ${generatedAt}。`,
    '> 单次发现留在这一份里；同向证据累计 ≥2 篇才升进 Knowledge 的规范页（口径见 Knowledge/评分体系.md §四）。',
    '',
  ]
  if (!lessons.length) return [...head, '（还没有结论。发布满 3 天的稿在「数据复盘」页的待复盘清单里。）\n'].join('\n')
  const body = lessons.map((l) => [
    `## ${l.date || '未标日期'}｜${l.title}`,
    `- 出处：${l.rel}（${l.account}）`,
    `- 当时的读数：${l.metricsText}`,
    `- 结论：${l.lesson.replace(/\n+/g, ' ').trim()}`,
  ].join('\n')).join('\n\n')
  return `${head.join('\n')}\n${body}\n`
}

/** 台账的可注入切片：只给最近的、最多 N 条、总字数封顶，超了从尾部截 */
export function ledgerDigest(lessons, { limit = LEDGER_INJECT_LIMIT, maxChars = LEDGER_INJECT_CHARS } = {}) {
  const text = renderLedger(lessons.slice(0, limit))
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n…（台账过长，全文见 metrics/lessons.md）` : text
}

/**
 * 选题卡回找：稿的 H1 各版各起，先拿文件名聚合键去对选题卡的标题（立项时两边同名），
 * 再退回稿标题；归一化后相等或前缀包含都算，都对不上返回 null——宁可说没依据，不硬攀一张卡。
 */
export function findTopic(topics, articleOrTitle) {
  const keys = [
    typeof articleOrTitle === 'string' ? norm(articleOrTitle) : norm(topicKeyOf(articleOrTitle)),
    typeof articleOrTitle === 'string' ? '' : norm(articleOrTitle?.title),
  ].filter(Boolean)
  const list = topics || []
  for (const k of keys) {
    const hit = list.find((t) => norm(t.title) === k)
      || list.find((t) => { const x = norm(t.title); return x && (x.startsWith(k) || k.startsWith(x)) })
    if (hit) return hit
  }
  return null
}

/**
 * 复盘预答的证据装配（不含模型调用，可单测）。
 * 摆四样：本篇读数、账号基线、当初立项时写的判据与依据经验、已有的同类结论。
 * 判据摆进来是这条闭环的关键——「当初预测收藏型、实际收藏率垫底」才是全场最有价值的发现
 * （评分体系 §二 写回要求），不摆进来就只能就着数字重新感想一遍。
 */
export function reviewEvidence({ article, topic, baseline, lessons, siblings } = {}) {
  if (!article) return ''
  const lines = [
    `【稿件】${article.title}`,
    `- 账号：${article.account || '—'}｜发布日：${article.date || '—'}`,
    `- 本篇读数：${metricsLine(article.metrics || {})}`,
  ]
  if (siblings?.length) {
    lines.push('【同选题其他平台的稿（结论要同时对这几版成立）】')
    for (const s of siblings) lines.push(`- ${s.account || '—'}（${s.date || '—'}）：${metricsLine(s.metrics || {})}`)
  }
  const conv = article.conversion && Object.keys(article.conversion).length
    ? Object.entries(article.conversion).map(([k, v]) => `${k} ${v}`).join(' · ')
    : ''
  if (conv) lines.push(`- 转化数据（手填）：${conv}`)
  lines.push(`- 账号基线（近 10 篇中位数）：${baseline?.text || '基线未成型，只就本篇说话'}`)
  if (topic?.judge) lines.push(`【当初立项时写的判据】\n${topic.judge}`)
  if (topic?.basis) lines.push(`【当初写的依据经验】${topic.basis}`)
  if (article.source) lines.push(`【灵感来源（当初记的出处或爆款标题）】${article.source}`)
  const sameTopic = (lessons || []).filter((l) => l.rel !== `content/${article.file}`).slice(0, 8)
  if (sameTopic.length) {
    lines.push('【已有复盘结论（同账号或题面相近的优先参考）】')
    for (const l of sameTopic) lines.push(`- ${l.date}｜${l.title}：${l.lesson.replace(/\n+/g, ' ').trim()}`)
  }
  return lines.join('\n')
}
