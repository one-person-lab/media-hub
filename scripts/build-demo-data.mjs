#!/usr/bin/env node
/**
 * 演示站那一份：真产物里只留「自己已经公开发出去的」那部分，其余各站摆 demo-seed.mjs 造的示例数据。
 *
 * 走白名单，不走黑名单：没点名的字段一律不进产物。以后 articles 加了新字段，
 * 默认是漏不出去的那一侧。挑数据、造数据与自查都在 demo-data-core.mjs / demo-seed.mjs（那边有测试）。
 *
 * 用法：node scripts/build-demo-data.mjs [--dist dist] [--out dist-demo]
 *      WORKBENCH_DOWNLOAD_URL 覆盖「下载客户端」的去处。
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { demoProduct } from './demo-data-core.mjs'

const ROOT = join(import.meta.dirname, '..')
const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`)
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt
}
const DIST = join(ROOT, arg('dist', 'dist'))
const OUT = join(ROOT, arg('out', 'dist-demo'))

const raw = JSON.parse(readFileSync(join(ROOT, 'src', 'data', 'generated.json'), 'utf8'))
const { demo, body, referenced, leaks } = demoProduct(raw, {
  downloadUrl: process.env.WORKBENCH_DOWNLOAD_URL || 'https://github.com/one-person-lab/media-hub',
})

rmSync(OUT, { recursive: true, force: true })
mkdirSync(OUT, { recursive: true })
for (const name of ['index.html', 'favicon.svg', 'icons.svg']) {
  if (existsSync(join(DIST, name))) cpSync(join(DIST, name), join(OUT, name))
}
if (existsSync(join(DIST, 'assets'))) cpSync(join(DIST, 'assets'), join(OUT, 'assets'), { recursive: true })
let copied = 0
for (const p of referenced) {
  const from = join(DIST, p.replace(/^\//, ''))
  if (!existsSync(from)) continue
  const to = join(OUT, p.replace(/^\//, ''))
  mkdirSync(dirname(to), { recursive: true })
  cpSync(from, to)
  copied++
}
writeFileSync(join(OUT, 'generated.json'), JSON.stringify(demo))

const publishedCount = (raw.articles || []).filter((a) => a.status === 'published').length
console.log(`[demo] 真已发布稿 ${publishedCount} 篇 + 示例稿 ${demo.articles.length - publishedCount} 版，账号 ${demo.accounts.length} 个（昵称已换示例号）`)
console.log(`[demo] 示例数据：采集 ${demo.readings.length} · 爆款 ${demo.viral.length} · 对标 ${demo.benchmarks.length} · 选题 ${demo.topics.length} · 方案 ${demo.playbooks.length} · 知识 ${demo.knowledge.length}`)
console.log(`[demo] 搬进演示站的资源 ${copied} 个（引用 ${referenced.size} 个）→ ${relative(ROOT, OUT)}`)
if (leaks.length) {
  console.error(`[demo] 这些字段不该出现在演示产物里：${leaks.join('、')}`)
  for (const n of leaks) {
    const i = body.indexOf(n)
    console.error(`  ${n} → …${body.slice(Math.max(0, i - 150), i + 90)}…`)
  }
  process.exit(1)
}
