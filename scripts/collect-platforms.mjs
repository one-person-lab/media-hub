/**
 * 采集小红书 / 抖音创作者后台数据 → metrics/raw/<date>.json
 *
 * 运行：npm run collect
 *      （实际经 scripts/run-ego.mjs 喂给 ego-browser，包装器注入 process.chdir 定位项目根）
 *
 * 前提：需先在 ego lite 浏览器里登录两个平台的创作者后台，登录态会持久化。
 *
 * 提取策略：
 *   - 汇总/账号信息：文本「标签 + 数值」正则 + 表格二维化，不依赖任何 CSS 类名。
 *     原因：抖音的类名带构建 hash（如 metric-name-text-HADaeN），改版即失效；
 *     而页面上的中文标签文案相对稳定，坏了也容易一眼看出来。
 *   - 日维度序列（daily）：DOM 里拿不到，用 CDP 在文档创建前注入 fetch/XHR 钩子，
 *     捕获页面自身发起的数据接口响应（这类接口有签名校验，直接调会 406）：
 *       小红书 /api/galaxy/v2/creator/datacenter/account/base （thirty 组逐日数组）
 *       抖音   /janus/douyin/creator/data/overview/dashboard（含 fans 子接口，trends 逐日数组）
 */
const fs = await import('node:fs/promises')

// 本脚本经 stdin 喂给 ego-browser，无相对路径上下文，故根目录取环境变量或 cwd
const ROOT = process.env.MEDIA_HUB_ROOT || process.cwd()
// 结构化进度与停止信号（同一个仓库里的兄弟模块，file:// 绝对导入）
const { step, progress, plan, stopRequested, skipUnlessWanted } = await import(`file://${ROOT}/scripts/sync-step.mjs`)
const { mergeSnapshot } = await import(`file://${ROOT}/scripts/raw-snapshot-core.mjs`)
const { localDay } = await import(`file://${ROOT}/scripts/day-core.mjs`)
// 快照桶用本机日历日（2026-10-28 前是 UTC 日，凌晨 00:00–07:59 那几趟会写进前一天的桶）。
// 这把尺和读取侧同一份：collect-runs 的落盘判据、build-data、界面 TODAY 都换成同一日才成立。
const DATE = localDay()

/** "1,598" / "2.78万" / "-2" / "11.6%" / "6.3s" → number */
function num(s) {
  if (s == null) return null
  const t = String(s).replace(/,/g, '')
  const m = t.match(/-?\d+(?:\.\d+)?/)
  if (!m) return null
  const v = Number(m[0])
  return /万/.test(t) ? Math.round(v * 10000) : v
}

/** 在一段文本里按「标签 数值」成对抓取 */
function pick(txt, keys) {
  const out = {}
  for (const k of keys) {
    const m = txt.match(new RegExp(k + '\\s*([-+]?[\\d,]+(?:\\.\\d+)?%?)'))
    if (m) out[k] = m[1]
  }
  return out
}

/* ==================== 日维度捕获 ==================== */

// 在文档创建前注入，goto 重新导航后依然生效；记录 JSON 响应的 URL + body
const HOOK = `(() => {
  window.__apiLog = []
  const push = (u, resp) => {
    try {
      if (typeof resp !== 'string' || resp.charCodeAt(0) !== 123) return
      window.__apiLog.push({ url: String(u).slice(0, 400), body: resp.slice(0, 400000) })
    } catch (e) {}
  }
  const oF = window.fetch
  window.fetch = async function (input, init) {
    const u = typeof input === 'string' ? input : input && input.url
    const res = await oF.apply(this, arguments)
    try { const c = res.clone(); c.text().then((t) => push(u, t)) } catch (e) {}
    return res
  }
  const oX = XMLHttpRequest.prototype.open
  const oS = XMLHttpRequest.prototype.send
  XMLHttpRequest.prototype.open = function (m, u) { this.__u = u; return oX.apply(this, arguments) }
  XMLHttpRequest.prototype.send = function () {
    this.addEventListener('load', () => { try { push(this.__u, this.responseText) } catch (e) {} })
    return oS.apply(this, arguments)
  }
})()`

const DAILY_KEYS = ['views', 'exposure', 'likes', 'collects', 'comments', 'shares', 'new_followers']

/** 找捕获响应并解析；找不到返回 null（daily 缺席，UI 走空态） */
async function grabDaily(page, urlPattern, parse) {
  const body = await page.evaluate(
    (pat) => (window.__apiLog || []).filter((c) => new RegExp(pat).test(c.url)).pop()?.body ?? null,
    urlPattern,
  )
  if (!body) return null
  try {
    return parse(JSON.parse(body))
  } catch {
    return null
  }
}

/** 匹配的所有响应逐一解析、按日期合并（后到的覆盖非空字段），供一次导航多发接口的平台用 */
async function grabAllDaily(page, urlPattern, parse) {
  const bodies = await page.evaluate(
    (pat) => (window.__apiLog || []).filter((c) => new RegExp(pat).test(c.url)).map((c) => c.body),
    urlPattern,
  )
  const merged = {}
  for (const b of bodies) {
    let daily = null
    try { daily = parse(JSON.parse(b)) } catch {}
    for (const d of daily ?? []) {
      const cur = (merged[d.date] ??= { date: d.date })
      for (const k of DAILY_KEYS) if (d[k] != null) cur[k] = d[k]
    }
  }
  const arr = Object.values(merged).sort((a, b) => a.date.localeCompare(b.date))
  return arr.length ? arr : null
}

/** 页面自身的数据接口比文本标记更晚到：轮询捕获结果直到非空或超时 */
async function grabDailyWait(page, urlPattern, parse, ms = 12000) {
  const dl = Date.now() + ms
  for (;;) {
    const r = await grabDaily(page, urlPattern, parse)
    if (r || Date.now() > dl) return r
    await page.waitForTimeout(2000)
  }
}
async function grabAllDailyWait(page, urlPattern, parse, ms = 12000) {
  const dl = Date.now() + ms
  for (;;) {
    const r = await grabAllDaily(page, urlPattern, parse)
    if (r || Date.now() > dl) return r
    await page.waitForTimeout(2000)
  }
}

const dayStr = (v) => {
  if (v && typeof v === 'object' && v.year) return `${v.year}-${String(v.month).padStart(2, '0')}-${String(v.day).padStart(2, '0')}`
  // 平台给的毫秒时间戳按中国日截（后台的日序列就是中国的日历日），跟上面那个快照桶名是两回事
  if (typeof v === 'number') return new Date(v + 8 * 3600e3).toISOString().slice(0, 10)
  const m = String(v ?? '').match(/(\d{4})\D?(\d{2})\D?(\d{2})/)
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null
}

const toDaily = (byDate) =>
  Object.entries(byDate)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, v]) => ({ date, ...Object.fromEntries(DAILY_KEYS.map((k) => [k, v[k] ?? null])) }))

// 小红书 account/base：优先 thirty 组的逐日数组
function parseXhsDaily(j) {
  const win = j?.data?.thirty ?? j?.data?.seven
  if (!win) return null
  const lists = {
    views: 'view_list', exposure: 'impl_count_list', likes: 'like_list', collects: 'collect_list',
    comments: 'comment_list', shares: 'share_list', new_followers: 'net_rise_fans_count_list',
  }
  const byDate = {}
  for (const [key, field] of Object.entries(lists)) {
    for (const e of Array.isArray(win[field]) ? win[field] : []) {
      const d = dayStr(e?.date)
      if (!d) continue
      const v = typeof e.count === 'number' ? e.count : num(String(e.count ?? ''))
      if (v != null) (byDate[d] ??= {})[key] = v
    }
  }
  return Object.keys(byDate).length ? toDaily(byDate) : null
}

// 抖音数据中心 overview/dashboard（含 fans 子接口）：metrics[] 每项带 trends 逐日数组
// 注意：首页的 overview/all 只有汇总值，日数组只在数据中心页发出
const DY_ENG = {
  play_cnt: 'views', digg_cnt: 'likes', comment_cnt: 'comments',
  share_cnt: 'shares', collect_cnt: 'collects', net_fans_cnt: 'new_followers',
}
function parseDouyinDaily(j) {
  const arr = j?.metrics
  if (!Array.isArray(arr)) return null
  const byDate = {}
  for (const m of arr) {
    const key = DY_ENG[m?.english_metric_name]
    if (!key) continue
    for (const t of Array.isArray(m.trends) ? m.trends : []) {
      const d = dayStr(t?.date_time)
      if (!d) continue
      const v = typeof t.value === 'number' ? t.value : num(String(t.value ?? ''))
      if (v != null) (byDate[d] ??= {})[key] = v
    }
  }
  return Object.keys(byDate).length ? toDaily(byDate) : null
}

// 快手创作者平台（cp.kuaishou.com/profile 一次发出两个读数接口）：
//   home/userInfo → 这是谁的号与粉丝存量；analysis/.../author/overview → 近 7 天六项指标逐日数组
// 两个接口都带 __NS_sig3 签名，只能捕页面自己发的那一份，直接调会拒（与抖音同一套理由）
const KS_ENG = {
  PLAY: 'views', LIKE: 'likes', COMMENT: 'comments',
  SHARE: 'shares', PURE_INCREASE_FAN: 'new_followers',
}
function parseKuaishouDaily(j) {
  const arr = j?.data?.basicData
  if (!Array.isArray(arr)) return null
  const byDate = {}
  for (const m of arr) {
    const key = KS_ENG[m?.tab]
    if (!key) continue // 完播率这类比率没有日维度字段，留在 metrics 里
    for (const t of Array.isArray(m.trendData) ? m.trendData : []) {
      const d = dayStr(t?.date) // 快手给的是 "20261027"
      if (!d) continue
      const v = typeof t.count === 'number' ? t.count : num(String(t.count ?? ''))
      if (v != null) (byDate[d] ??= {})[key] = v
    }
  }
  return Object.keys(byDate).length ? toDaily(byDate) : null
}

/** 接口里那对 [前一日, 当日] 的读数取当日：视频号 fans_trend 的 add/reduce/netAdd/total 都是这个形状 */
const lastOf = (a) => (Array.isArray(a) && a.length ? num(String(a[a.length - 1])) : null)

async function gotoTolerant(page, url) {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded' })
  } catch (e) {
    // 导航超时但页面已提交时继续读；若压根没跳过去（如不支持 waitUntil 选项）再裸 goto 一次
    const here = String(page.url?.() ?? '')
    if (!here.startsWith(new URL(url).origin)) {
      try { await page.goto(url) } catch { /* 同上：committed 后照读 */ }
    }
  }
}

/** 导航后轮询页面文本：probe 命中即返回，否则最多等 waitMs（重 SPA 定长等待不够稳） */
async function text(page, url, waitMs, probe) {
  await gotoTolerant(page, url)
  const deadline = Date.now() + waitMs
  let txt = ''
  for (;;) {
    await page.waitForTimeout(1500)
    txt = await page.evaluate(() => (document.body.innerText || '').replace(/\s+/g, ' '))
    if (!probe || probe(txt) || Date.now() > deadline) return txt
  }
}

const task = await taskSpace('collect-platforms')
const page = task.page('p1')
await page.cdp('Page.addScriptToEvaluateOnNewDocument', { source: HOOK })
const result = { collectedAt: new Date().toISOString(), date: DATE, platforms: {}, errors: {} }
const fail = (p, e) => { result.errors[p] = String(e?.message ?? e).slice(0, 200) }
/** 一个人工停止就把整轮收工；检查点只放在平台之间——掐在半路会把浏览器任务空间留成脏 */
const stopNow = () => { if (stopRequested()) throw new Error('人工停止，该平台本轮没跑') }
const skipped = new Set()
// 本轮计划采这四个平台；真要跑的那个一进来就报一声，界面才知道现在卡在谁身上
// 公众号不在列：这台浏览器 mp.weixin.qq.com 登的是小程序后台，公众号身份没扫码（2026-10-28 实测）
plan(['xiaohongshu', 'douyin', 'kuaishou', 'sph'])
const skipNow = (p) => {
  if (skipUnlessWanted(p)) {
    skipped.add(p)
    return true
  }
  progress(p, '采集中')
  return false
}
const reportStep = (p) => {
  if (skipped.has(p)) return
  step(p, result.errors[p] ? 'error' : 'ok', { note: result.errors[p] || '' })
}

// ===================== 小红书 =====================
const x = result.platforms.xiaohongshu = {
  nickname: null, following: null, followers: null, likesCollects: null,
  period: null, metrics: {}, daily: null, notes: [],
}
if (!skipNow('xiaohongshu')) try {
  stopNow()
  // 骨架屏阶段读数全是 0：探针要等到关注数/赞藏真实水合
  const XHS_HOME = await text(page, 'https://creator.xiaohongshu.com/new/home', 20000, (t) => {
    const m = t.match(/关注数\s+([\d,]+)\s+粉丝数\s+([\d,]+)\s+获赞与收藏\s+([\d,]+)/)
    return m && m[1] !== '0' && m[3] !== '0'
  })
  // 首页加载时账号数据中心接口已发出，先于下一次导航取走日数组
  x.daily = await grabDailyWait(page, 'datacenter/account/base', parseXhsDaily)
  const xhsAcc = XHS_HOME.match(/(\S+)\s+([\d,]+)\s+关注数\s+([\d,]+)\s+粉丝数\s+([\d,]+)\s+获赞与收藏/)
  Object.assign(x, {
    nickname: xhsAcc ? xhsAcc[1] : null,
    following: xhsAcc ? num(xhsAcc[2]) : null,
    followers: xhsAcc ? num(xhsAcc[3]) : null,
    likesCollects: xhsAcc ? num(xhsAcc[4]) : null,
    period: (XHS_HOME.match(/统计周期\s*([\d-]+\s*至\s*[\d-]+)/) || [])[1] || null,
    metrics: pick(XHS_HOME, [
      '曝光数', '观看数', '封面点击率', '视频完播率',
      '点赞数', '评论数', '收藏数', '分享数',
      '净涨粉', '新增关注', '取消关注', '主页访客',
    ]),
  })

  // 逐篇明细（数据看板 → 内容分析）：表格是 SPA 渲染的，轮询到出行或超时
  await gotoTolerant(page, 'https://creator.xiaohongshu.com/statistics/data-analysis')
  const gridDeadline = Date.now() + 20000
  let grid = []
  for (;;) {
    grid = await page.evaluate(() => {
      const trs = [...document.querySelectorAll('table tr')]
      return trs.map((tr) =>
        [...tr.querySelectorAll('td,th')].map((c) => (c.innerText || '').replace(/\s+/g, ' ').trim()),
      )
    })
    if (grid.length > 1 || Date.now() > gridDeadline) break
    await page.waitForTimeout(2000)
  }
  const head = grid[0] || []
  if (head.length) {
    x.notes = grid
      .slice(1)
      .map((row) => {
        const o = {}
        head.forEach((h, i) => { o[h] = row[i] ?? null })
        return o
      })
      .filter((o) => o[head[0]])
  }
} catch (e) { fail('xiaohongshu', e) }
reportStep('xiaohongshu')

// ===================== 抖音 =====================
const d = result.platforms.douyin = {
  nickname: null, douyinId: null, following: null, followers: null, likes: null,
  period: null, metrics: {}, daily: null,
}
if (!skipNow('douyin')) try {
  stopNow()
  const DY_HOME = await text(page, 'https://creator.douyin.com/creator-micro/home', 20000, (t) => /获赞\s+[\d,.万]+/.test(t))
  const dyAcc = DY_HOME.match(/(\S+)\s+抖音号：\s*(\d+)/)
  const dyCnt = DY_HOME.match(/关注\s+([\d,.万]+)\s+粉丝(?:指数)?\s+([\d,.万]+)\s+获赞\s+([\d,.万]+)/)
  Object.assign(d, {
    nickname: dyAcc ? dyAcc[1] : null,
    douyinId: dyAcc ? dyAcc[2] : null,
    following: dyCnt ? num(dyCnt[1]) : null,
    followers: dyCnt ? num(dyCnt[2]) : null,
    likes: dyCnt ? num(dyCnt[3]) : null,
  })

  const DY_DATA = await text(page, 'https://creator.douyin.com/creator-micro/data-center/operation', 20000, (t) => {
    const m = t.match(/播放量\s+([\d,.万]+)/)
    return /统计周期：/.test(t) && m && m[1] !== '0'
  })
  // 数据中心页发出 overview/dashboard（及 fans 子接口），逐条解析后按日期合并
  d.daily = await grabAllDailyWait(page, 'douyin/creator/data/overview/dashboard', parseDouyinDaily)
  d.period = ((DY_DATA.match(/统计周期：([\d.\-\s至]+)/) || [])[1] || '').trim() || null
  d.metrics = pick(DY_DATA, [
    '播放量', '互动率', '完播率', '作品数', '粉丝净增',
    '投稿量', '总播放量', '总点赞量', '总分享量', '总评论量',
    '5秒完播率', '2秒跳出率', '封面点击率', '平均播放时长',
    '总粉丝量', '吸粉量', '脱粉量', '回访粉丝量',
  ])
} catch (e) { fail('douyin', e) }
reportStep('douyin')

// ===================== 快手 =====================
const k = result.platforms.kuaishou = {
  nickname: null, followers: null, period: null, metrics: {}, daily: null,
}
if (!skipNow('kuaishou')) try {
  stopNow()
  await gotoTolerant(page, 'https://cp.kuaishou.com/profile')
  const acc = await grabDailyWait(page, 'creator/pc/home/userInfo', (j) => j?.data?.coreUserInfo ?? null)
  k.nickname = acc?.userName ? String(acc.userName).trim() : null
  k.followers = acc?.fansNum != null ? num(String(acc.fansNum)) : null

  const ov = await grabDailyWait(page, 'creator/analysis/pc/home/author/overview', (j) => j?.data ?? null)
  if (ov) {
    k.metrics = Object.fromEntries(
      (ov.basicData || []).filter((m) => m?.name && m.sumCount != null).map((m) => [m.name, m.sumCount]),
    )
    k.daily = await grabDaily(page, 'creator/analysis/pc/home/author/overview', parseKuaishouDaily)
    // 快手的窗口是后台自己定的「近 7 天」，界面要摆统计周期就从捕到的日数组首尾报
    const days = (k.daily || []).map((p) => p.date).sort()
    k.period = days.length ? `${days[0]} 至 ${days[days.length - 1]}` : null
  }
} catch (e) { fail('kuaishou', e) }
reportStep('kuaishou')

// ===================== 视频号 =====================
// 只拿存量与净增：数据中心那几张图的接口在 wujie 微前端沙箱里发，顶层文档注入的钩子捕不到，
// 逐日序列要换到网络层才捕得着（本轮不做，宁可行上写「只到存量」也不摆假数）
const s = result.platforms.sph = {
  nickname: null, followers: null, period: null, metrics: {}, daily: null,
}
if (!skipNow('sph')) try {
  stopNow()
  await gotoTolerant(page, 'https://channels.weixin.qq.com/platform')
  const fans = await grabDailyWait(page, 'statistic/fans_trend', (j) => j?.data ?? null)
  if (fans) {
    s.followers = lastOf(fans.total)
    const net = lastOf(fans.netAdd)
    if (net != null) s.metrics = { 净增粉丝量: net }
  }
} catch (e) { fail('sph', e) }
reportStep('sph')

// 产物断言：账号读到了但指标接口一条没捕到，算采空，不许静默 exit 0
if (x.nickname && !Object.keys(x.metrics).length) fail('xiaohongshu', '首页指标一条都没采到（可能未水合）')
if (d.nickname && !Object.keys(d.metrics).length) fail('douyin', '数据中心指标接口未捕获')
if (k.nickname && !Array.isArray(k.daily)) fail('kuaishou', '数据中心逐日接口未捕获（可能未水合或改版）')
if (s.followers == null && !result.errors.sph) fail('sph', '粉丝趋势接口未捕获（可能未水合或改版）')

// ===================== 落盘 =====================
await fs.mkdir(`${ROOT}/metrics/raw`, { recursive: true })
const outPath = `${ROOT}/metrics/raw/${DATE}.json`
/* 当天可能已有 publish-check 写的 publishedList / 粉丝数：逐平台合并，整表覆盖会把它们冲掉 */
let prev = null
try {
  prev = JSON.parse(await fs.readFile(outPath, 'utf8'))
} catch { /* 当天还没有快照，直接写 */ }
const doc = mergeSnapshot(prev, result)
await fs.writeFile(outPath, JSON.stringify(doc, null, 2) + '\n')

// 有 errors 或两平台读数全空 = 本轮没采到，必须上报（自报成功不等于落盘正确）
// 读数从刚落盘的 doc 里取，不取内存里的 result：界面和记账都只认文件里有什么
const landedX = doc.platforms.xiaohongshu || {}
const landedD = doc.platforms.douyin || {}
const landedK = doc.platforms.kuaishou || {}
const landedS = doc.platforms.sph || {}
console.log(JSON.stringify({
  date: DATE,
  file: `metrics/raw/${DATE}.json`,
  xiaohongshu: { 账号: landedX.nickname ?? null, 粉丝: landedX.followers ?? null, 赞藏: landedX.likesCollects ?? null, 逐篇: (landedX.notes || []).length, 指标: Object.keys(landedX.metrics || {}).length, 日序列: (landedX.daily || []).length },
  douyin: { 账号: landedD.nickname ?? null, 粉丝: landedD.followers ?? null, 获赞: landedD.likes ?? null, 指标: Object.keys(landedD.metrics || {}).length, 日序列: (landedD.daily || []).length },
  kuaishou: { 账号: landedK.nickname ?? null, 粉丝: landedK.followers ?? null, 指标: Object.keys(landedK.metrics || {}).length, 日序列: (landedK.daily || []).length },
  sph: { 粉丝: landedS.followers ?? null, 日序列: (landedS.daily || []).length },
  ...(Object.keys(result.errors).length ? { errors: result.errors } : {}),
}, null, 1))
if (Object.keys(result.errors).length) process.exitCode = 2
// 人按的停止优先于「部分成功」：界面要能分清这是你停的，不是平台挂了
if (stopRequested()) process.exitCode = 3
