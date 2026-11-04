#!/usr/bin/env node
/**
 * 对话/命令行发链接 → 采集卡落 content/Inbox/采集笔记/。
 * 只抓用户给的那一个 URL，不爬取、不调 LLM。
 * 用法：node scripts/capture-link.mjs <url> ["为什么值得参考"]
 */
import { writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { downloadImage } from './collect-note-core.mjs'
import { localDay } from './day-core.mjs'

const ROOT = process.env.MEDIA_HUB_ROOT || resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DIR = join(ROOT, 'content/Inbox/采集笔记')

export function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;|&#\d+;/gi, ' ')
    .replace(/\s+/g, ' ').trim()
}

export function meta(html, name) {
  const m = html.match(new RegExp(`<meta[^>]+(?:name|property)=["']${name}["'][^>]+content=["']([^"']*)["']`, 'i'))
    || html.match(new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:name|property)=["']${name}["']`, 'i'))
  return m ? m[1].trim() : ''
}

export function buildCard({ url, title, desc, cover, why }) {
  const lines = [
    '---', `source: link`, `url: "${url}"`, `platform: unknown`,
    `capturedAt: "${new Date().toISOString()}"`, `coverImage: ${cover}`, '---', '', `# ${title}`, '',
  ]
  if (desc) lines.push(`> 摘要：${desc.slice(0, 200)}`, '')
  lines.push(`为什么值得参考：${why || '（待补）'}`, '', '<!-- 采集卡：AI 拆解结论写 analysis frontmatter，见 viral-teardown -->')
  return lines.join('\n')
}

export function safeName(s) {
  return (s || 'untitled').replace(/[\\/:*?"<>|#%&{}$!'@+`=：！？、，。；「」（）《》％^]/g, ' ').replace(/\s+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'untitled'
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [url, why] = process.argv.slice(2)
  if (!/^https?:\/\//.test(url || '')) { console.error('用法：npm run capture -- <http(s)链接> ["为什么值得参考"]'); process.exit(1) }
  const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' }, redirect: 'follow', signal: AbortSignal.timeout(15000) })
  const html = await res.text()
  const title = meta(html, 'og:title') || (html.match(/<title[^>]*>([^<]*)<\/title>/i) || [, ''])[1].trim() || res.url
  // 封面必须落到 public/：无封面的条目进不了「灵感库」，外链图还会因防盗链显示不出来
  const noteId = (res.url.match(/\/explore\/([0-9a-f]+)/) || [])[1] || `link-${safeName(title)}`
  const cover = await downloadImage(meta(html, 'og:image'), noteId)
  const card = buildCard({ url: res.url, title, desc: meta(html, 'og:description') || meta(html, 'description'), cover, why })
  if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true })
  const file = join(DIR, `${localDay()}-${safeName(title)}.md`)
  if (existsSync(file)) { console.error('已采集过：' + file); process.exit(1) }
  writeFileSync(file, card)
  console.log(JSON.stringify({
    ok: true,
    file: `content/Inbox/采集笔记/${file.split('/').pop()}`,
    cover,
    ...(cover ? {} : { warning: '没抓到封面图（og:image 缺失或被防盗链挡住）——这条不会出现在灵感库里' }),
  }))
}
