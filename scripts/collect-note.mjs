#!/usr/bin/env node
/**
 * 采集单条小红书笔记（ego-browser 命令行版）→ content/参考资料/<标题>.md
 *
 * 用法（ego-browser 需已登录小红书）：
 *   echo '<笔记链接>' > /tmp/note-url.txt && npm run collect:note
 *
 * 落盘逻辑在 scripts/collect-note-core.mjs（与浏览器扩展的 /__collect 端点共用）。
 *
 * 注意：只采自己浏览、用于个人学习参考的单条笔记；不改评、不批量、不碰他人后台。
 */

const { readFileSync } = await import('node:fs')
let URL_RAW = process.env.NOTE_URL || ''
if (!URL_RAW) {
  try {
    URL_RAW = readFileSync('/tmp/note-url.txt', 'utf8').trim()
  } catch {}
}
if (!URL_RAW) {
  console.error("[collect:note] 缺少笔记链接。用法：echo '<链接>' > /tmp/note-url.txt && npm run collect:note")
  process.exit(1)
}

const task = await taskSpace('collect-xhs-note')
const page = task.page('p1')
await page.goto(URL_RAW)
await page.waitForTimeout(8000)

const data = await page.evaluate(() => {
  const pick = (sel) => document.querySelector(sel)?.innerText?.trim() ?? null
  const counters = [
    ...document.querySelectorAll("[class*='count-wrapper'] span, .interact-container .count"),
  ].map((e) => e.innerText.trim())

  const container = document.querySelector('.note-detail, #noteContainer, .note-container')
  const img = container
    ? [...container.querySelectorAll('img')].find((i) => /sns-webpic/.test(i.src))
    : null

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
    tags,
  }
})

if (!data.title && !data.desc) {
  console.error('[collect:note] 没抓到内容——页面可能没加载完或不是笔记页。URL:', await page.url())
  process.exit(1)
}

// 落盘逻辑与扩展端点共用（本脚本经 stdin 喂给 ego-browser，没有相对路径上下文，
// 故用 file:// 绝对导入；根目录由 MEDIA_HUB_ROOT 或 cwd 决定，不写死个人路径）
const { pathToFileURL } = await import('node:url')
const { join } = await import('node:path')
const ROOT = process.env.MEDIA_HUB_ROOT || process.cwd()
const core = await import(pathToFileURL(join(ROOT, 'scripts/collect-note-core.mjs')).href)

const noteId = (URL_RAW.match(/\/explore\/([0-9a-f]+)/) || [])[1] || `note-${Date.now()}`
const imagePath = await core.downloadImage(data.image, noteId)
if (imagePath) console.log(`[collect:note] 首图已存 public${imagePath}`)
const { rel } = core.writeNoteMd(data, URL_RAW, imagePath)
console.log(`[collect:note] 已落盘 ${rel}`)
console.log(`[collect:note] 下一步：跑 npm run gen:data 后灵感库可见；让 AI 补 analysis 拆解`)
