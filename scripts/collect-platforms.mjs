/**
 * 采集小红书 / 抖音创作者后台数据 → metrics/raw/<date>.json
 *
 * 运行：npm run collect
 *      （实际执行 ego-browser nodejs < scripts/collect-platforms.mjs）
 *
 * 前提：需先在 ego lite 浏览器里登录两个平台的创作者后台，登录态会持久化。
 *
 * 提取策略：**文本「标签 + 数值」正则** + 表格二维化，不依赖任何 CSS 类名。
 * 原因：抖音的类名带构建 hash（如 metric-name-text-HADaeN），改版即失效；
 * 而页面上的中文标签文案相对稳定，坏了也容易一眼看出来。
 */
const fs = await import('node:fs/promises')

// 本脚本经 stdin 喂给 ego-browser，无相对路径上下文，故根目录取环境变量或 cwd
const ROOT = process.env.MEDIA_HUB_ROOT || process.cwd()
const DATE = new Date().toISOString().slice(0, 10)

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

async function text(page, url, waitMs) {
  await page.goto(url)
  await page.waitForTimeout(waitMs)
  return page.evaluate(() => (document.body.innerText || '').replace(/\s+/g, ' '))
}

const task = await taskSpace(2)
const page = task.page('p1')
const result = { collectedAt: new Date().toISOString(), date: DATE, platforms: {} }

// ===================== 小红书 =====================
const XHS_HOME = await text(page, 'https://creator.xiaohongshu.com/new/home', 9000)
const xhsAcc = XHS_HOME.match(/(\S+)\s+([\d,]+)\s+关注数\s+([\d,]+)\s+粉丝数\s+([\d,]+)\s+获赞与收藏/)

result.platforms.xiaohongshu = {
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
  notes: [],
}

// 逐篇明细（数据看板 → 内容分析）
await page.goto('https://creator.xiaohongshu.com/statistics/data-analysis')
await page.waitForTimeout(9000)
const grid = await page.evaluate(() => {
  const trs = [...document.querySelectorAll('table tr')]
  return trs.map((tr) =>
    [...tr.querySelectorAll('td,th')].map((c) => (c.innerText || '').replace(/\s+/g, ' ').trim()),
  )
})
const head = grid[0] || []
if (head.length) {
  result.platforms.xiaohongshu.notes = grid
    .slice(1)
    .map((row) => {
      const o = {}
      head.forEach((h, i) => { o[h] = row[i] ?? null })
      return o
    })
    .filter((o) => o[head[0]])
}

// ===================== 抖音 =====================
const DY_HOME = await text(page, 'https://creator.douyin.com/creator-micro/home', 9000)
const dyAcc = DY_HOME.match(/(\S+)\s+抖音号：\s*(\d+)/)
const dyCnt = DY_HOME.match(/关注\s+([\d,.万]+)\s+粉丝\s+([\d,.万]+)\s+获赞\s+([\d,.万]+)/)

result.platforms.douyin = {
  nickname: dyAcc ? dyAcc[1] : null,
  douyinId: dyAcc ? dyAcc[2] : null,
  following: dyCnt ? num(dyCnt[1]) : null,
  followers: dyCnt ? num(dyCnt[2]) : null,
  likes: dyCnt ? num(dyCnt[3]) : null,
  period: null,
  metrics: {},
}

const DY_DATA = await text(page, 'https://creator.douyin.com/creator-micro/data-center/operation', 10000)
result.platforms.douyin.period = ((DY_DATA.match(/统计周期：([\d.\-\s至]+)/) || [])[1] || '').trim() || null
result.platforms.douyin.metrics = pick(DY_DATA, [
  '播放量', '互动率', '完播率', '作品数', '粉丝净增',
  '投稿量', '总播放量', '总点赞量', '总分享量', '总评论量',
  '5秒完播率', '2秒跳出率', '封面点击率', '平均播放时长',
  '总粉丝量', '吸粉量', '脱粉量', '回访粉丝量',
])

// ===================== 落盘 =====================
await fs.mkdir(`${ROOT}/metrics/raw`, { recursive: true })
const outPath = `${ROOT}/metrics/raw/${DATE}.json`
await fs.writeFile(outPath, JSON.stringify(result, null, 2) + '\n')

const x = result.platforms.xiaohongshu
const d = result.platforms.douyin
console.log(JSON.stringify({
  date: DATE,
  file: `metrics/raw/${DATE}.json`,
  xiaohongshu: { 账号: x.nickname, 粉丝: x.followers, 赞藏: x.likesCollects, 逐篇: x.notes.length, 指标: Object.keys(x.metrics).length },
  douyin: { 账号: d.nickname, 粉丝: d.followers, 获赞: d.likes, 指标: Object.keys(d.metrics).length },
}, null, 1))
