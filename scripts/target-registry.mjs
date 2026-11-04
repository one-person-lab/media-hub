/** 推广对象的唯一取数口：产品名 → 它自己的 config/targets/*.mjs。
 *
 *  为什么要有这一份：发布链（collect-note-core 的 payload 组装）是同步的，
 *  而 import() 只能异步——所以在模块加载时把 config/targets/ 全预载一遍，
 *  之后按档案取数就是同步的。
 *  一稿一品牌：稿上写了「归属品牌」，落地链接与署名就按那个品牌的档案走；
 *  没写才回落到全局 active-target（旧稿）。写了却查不到 = 拦住，不替人猜一个产品挂上去。
 */
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { normalizeProduct, readProducts } from './products-core.mjs'
import { activeTarget } from '../config/active-target.mjs'

const ROOT = process.env.MEDIA_HUB_ROOT || process.cwd()
const DIR_REL = 'config/targets'

/** 绝对路径 → 那个推广对象（预载一次，之后同步命中） */
const loaded = new Map()

async function preload(root) {
  const dir = join(root, DIR_REL)
  if (!existsSync(dir)) return
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.mjs') && n !== 'example.mjs')) {
    const abs = join(dir, f)
    try {
      loaded.set(abs, (await import(pathToFileURL(abs).href)).default || null)
    } catch {
      loaded.set(abs, null)
    }
  }
}
await preload(ROOT)

/** 按档案文件名取推广对象；没登记 target 返回 null（这个产品没有可挂的落地链接） */
export function targetByFile(targetFile, { root = ROOT } = {}) {
  const file = String(targetFile || '').trim()
  if (!file) return null
  const abs = join(root, DIR_REL, file)
  if (!loaded.has(abs)) throw new Error(`产品档案指向的推广对象文件不存在：${DIR_REL}/${file}`)
  return loaded.get(abs)
}

/** 按产品名取（产品名要在 config/products.json 里登记过） */
export function targetForProduct(name, { root = ROOT } = {}) {
  const { products } = readProducts(root)
  const p = products.find((x) => x.name === String(name || '').trim())
  return p ? targetByFile(p.target, { root }) : null
}

/** 这一稿该用谁的落地链接：读稿上的「归属品牌」那一行 */
export function targetForDraft(md, { root = ROOT } = {}) {
  const line = normalizeProduct((String(md).match(/^- 归属品牌：(.+)$/m) || [])[1] || '')
  if (!line) return { target: activeTarget, product: '' }
  if (line.includes('/')) {
    throw new Error(`「归属品牌」写了两个（${line}）：一稿一品牌，改成一个再推`)
  }
  const { products } = readProducts(root)
  if (!products.some((p) => p.name === line)) {
    throw new Error(`「归属品牌」对不上品牌档案：${line} · 去「品牌」页登记或改成档案里的名字`)
  }
  return { target: targetByFile(products.find((p) => p.name === line).target, { root }), product: line }
}
