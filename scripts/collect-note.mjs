/**
 * 采集单条小红书笔记（ego-browser 命令行版）→ content/Inbox/采集笔记/<标题>.md
 *
 * 用法（ego-browser 需已登录小红书）：
 *   node scripts/run-ego.mjs scripts/collect-note.mjs --args --url '<笔记链接>'
 *   （命令行老路数仍可用：echo '<笔记链接>' > /tmp/note-url.txt && npm run collect:note）
 *
 * 落盘逻辑在 scripts/collect-note-core.mjs（与浏览器扩展的 /__collect 端点共用）。
 *
 * 注意：只采自己浏览、用于个人学习参考的单条笔记；不改评、不批量、不碰他人后台。
 */

const { readFileSync } = await import('node:fs')
// 工作台起步向导经 run-ego.mjs 把链接注入 process.argv；命令行仍可继续用文件或环境变量
const argUrl = process.argv.slice(2).map((a) => a.replace(/^--url=/, '')).find((a) => /^https?:\/\//.test(a))
let URL_RAW = argUrl || process.env.NOTE_URL || ''
if (!URL_RAW) {
  try {
    URL_RAW = readFileSync('/tmp/note-url.txt', 'utf8').trim()
  } catch {}
}
if (!URL_RAW) {
  console.error("[collect:note] 缺少笔记链接。用法：node scripts/run-ego.mjs scripts/collect-note.mjs --args --url '<链接>'")
  process.exit(1)
}

// 本脚本经 stdin 喂给 ego-browser，没有相对路径上下文，故用 file:// 绝对导入；
// 根目录由 MEDIA_HUB_ROOT 或 cwd 决定，不写死个人路径。
const { pathToFileURL } = await import('node:url')
const { join } = await import('node:path')
const ROOT = process.env.MEDIA_HUB_ROOT || process.cwd()
const sync = await import(pathToFileURL(join(ROOT, 'scripts/sync-step.mjs')).href)
/** 人在界面上按了停止：一进浏览器就收工，退 3 让服务端记成「人工停止」。
 *  掐在半路的是本脚本，不是 ego 那条页——任务空间照常留着，不弄脏。 */
const stopped = () => {
  if (!sync.stopRequested()) return
  console.log('[collect:note] 人在界面上按了停止，这条不采了')
  process.exit(3)
}
stopped()

const task = await taskSpace('collect-xhs-note')
const page = task.page('p1')
await page.goto(URL_RAW)
await page.waitForTimeout(8000)
stopped() // 页面加载这 8 秒里人可能已经走了
const data = await page.evaluate(() => {
  const pick = (sel) => document.querySelector(sel)?.innerText?.trim() ?? null
  const counters = [
    ...document.querySelectorAll("[class*='count-wrapper'] span, .interact-container .count"),
  ].map((e) => e.innerText.trim())

  const container = document.querySelector('.note-detail, #noteContainer, .note-container')
  const webpics = container
    ? [...container.querySelectorAll('img')].filter((i) => /sns-webpic/.test(i.src)).map((i) => i.src)
    : []
  const img = webpics[0] || ''

  // 轮播全量图：优先走笔记数据里的 imageList（顺序=滑动顺序，且含封面），拿不到再退回 DOM
  let images = []
  try {
    const state = window.__INITIAL_STATE__
    const map = state?.note?.noteDetailMap || state?._rawValue?.note?.noteDetailMap
    const noteKey = map && Object.keys(map)[0]
    const list = noteKey ? (map[noteKey]?.note?.imageList || map[noteKey]?._rawValue?.note?.imageList) : null
    images = (list || [])
      .map((it) => it?.urlDefault || it?.url || (Array.isArray(it?.urlList) ? it.urlList[0] : ''))
      .filter(Boolean)
  } catch {}
  if (!images.length) images = [...new Set(webpics)]

  const tags = [...document.querySelectorAll('.tag, #detail-desc .tag')]
    .map((e) => e.innerText.trim())
    .filter((t) => t.startsWith('#'))
    .slice(0, 10)

  return {
    title: pick('#detail-title') || '',
    desc: pick('#detail-desc') || '',
    author: pick('.username') || '',
    postedAt: pick('.date') || '',
    likes: counters[0] ?? '',
    collects: counters[1] ?? '',
    comments: counters[2] ?? '',
    image: img ? img.src : '',
    images,
    tags,
  }
})

if (!data.title && !data.desc) {
  console.error('[collect:note] 没抓到内容——页面可能没加载完或不是笔记页。URL:', await page.url())
  process.exit(1)
}

// 落盘逻辑与扩展端点共用（会把正文、封面、逐页原图写进 content/ 与 public/）
const core = await import(pathToFileURL(join(ROOT, 'scripts/collect-note-core.mjs')).href)

stopped()
const result = await core.handleCollect({ ...data, url: URL_RAW })
console.log(`[collect:note] 已落盘 ${result.file}`)
console.log(`[collect:note] 封面 public${result.image} · 源图 ${result.sourceImages.count} 页 → public/inspiration/${result.sourceImages.dir}/`)
console.log('[collect:note] 下一步：跑 npm run gen:data 后在「灵感库」可见；让 AI 补 analysis 拆解')
