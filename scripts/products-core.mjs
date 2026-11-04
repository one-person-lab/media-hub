#!/usr/bin/env node
/**
 * 品牌档案的读写：config/products.json 是唯一事实源。
 * 品牌页的「新建/编辑」走这里落盘（界面不碰 JSON 也不碰路径），build-data 只读它——
 * 入口、对外口径、可放图卡的真截图，一个品牌只在这一处登记一次。
 *
 * 校验只挡两类东西：
 *  - 名字空或重复（「归属品牌」按名字取档案，两个同名档案会让一稿一品牌形同虚设）
 *  - 截图路径不在 public/ 下或文件不存在（一键同款靠这些图，路径写错等于放行一张不存在的图）
 * 入口和口径留空是允许的：还没登记的品牌就该在向导里被拦住，而不是被界面编出来。
 */
import { existsSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { TARGET_TYPES } from '../config/promotion-target.mjs'

const ROOT = process.env.MEDIA_HUB_ROOT || process.cwd()
export const PRODUCTS_REL = 'config/products.json'

/** 界面上能改的字段；_说明 / _字段 这类注释键原样保留，人手写的规矩不被保存冲掉 */
const EDITABLE = ['name', 'type', 'kind', 'status', 'oneLiner', 'entry', 'facts', 'screens', 'target']

function readJson(p) {
  try {
    return JSON.parse(readFileSync(p, 'utf8'))
  } catch {
    return null
  }
}

/** 读整份档案（老写法里的纯字符串也补成 { name }，界面拿到的形状只有一种） */
export function readProducts(root = ROOT) {
  const j = readJson(join(root, PRODUCTS_REL))
  const list = Array.isArray(j?.products) ? j.products : []
  return { file: j, products: list.map((p) => (typeof p === 'string' ? { name: p } : p)).filter((p) => p?.name) }
}

const text = (v) => String(v ?? '').trim()

/** 「归属品牌」的空值写法：空行 = 人格内容（不挂品牌）。
 *  人手写稿与生成稿常把「无」填进这一行——它和留空是同一件事，
 *  不能被当成一个没登记的品牌名（那会把推送整串拦死，而且界面上没有改的地方）。
 *  只认这几种明确表否定的写法；像是打错的品牌名照旧交给闸门拦住。 */
const NO_PRODUCT = new Set(['无', '没有', '无产品', '不挂产品', '不挂品牌', '人格内容', 'none', 'null', 'n/a', '-', '—', '——'])
/** 以项目符号开头的值是排版残迹：这一行没填完，下一行的「- 立项平台：」被吃了进来。
 *  留着它等于在界面上凭空多出一个假品牌筛选项，谁也对不上档案。 */
export function normalizeProduct(raw) {
  const t = text(raw)
  if (/^[-•]/.test(t)) return ''
  return NO_PRODUCT.has(t.toLowerCase()) ? '' : t
}

/** 类型：留空按 app（type 是后加的字段，比它早的在册档案都没写过这一行，当时全是应用），写了不认识的当场说破——
 *  静默兜住等于让一张门店档案长成应用的样子，页签和素材槽会一起错。
 *  只认注册表自有的键：constructor / __proto__ 这类原型链上的键在 TARGET_TYPES 上取到真值，
 *  却不是一个类型（/__product 收任意 POST 体，放行等于让脏值静默落盘）。 */
function cleanType(raw) {
  const t = text(raw)
  if (!t) return 'app'
  if (!Object.hasOwn(TARGET_TYPES, t)) throw new Error(`没有这种类型：${t}（可选：${Object.keys(TARGET_TYPES).join(' / ')}）`)
  return t
}

function cleanFacts(raw) {
  const out = []
  for (const f of Array.isArray(raw) ? raw : []) {
    const t = text(f)
    if (t && !out.includes(t)) out.push(t)
  }
  return out
}

/** 截图：只收 public/ 下真实存在的文件。路径统一存成仓库相对路径（渲染脚本按这个拼绝对路径） */
function cleanScreens(raw, root = ROOT) {
  const out = []
  for (const s of Array.isArray(raw) ? raw : []) {
    const path = text(s?.path).replaceAll('\\', '/')
    if (!path) continue
    if (!path.startsWith('public/')) throw new Error(`截图路径要在 public/ 下：${path}`)
    if (!existsSync(join(root, path))) throw new Error(`截图文件不存在：${path}`)
    const label = text(s?.label)
    out.push(label ? { path, label } : { path })
  }
  return out
}

/** 校验并规范化一份档案（不落盘，测试与预览都用它）。originalName 用于改名时找回旧条目 */
export function planProduct(patch, { originalName, root = ROOT } = {}) {
  const { products } = readProducts(root)
  const name = text(patch.name)
  if (!name) throw new Error('品牌名不能空：「归属品牌」就是按这个名字取档案的')
  const from = originalName ? text(originalName) : name
  const idx = products.findIndex((p) => p.name === from)
  const dup = products.findIndex((p) => p.name === name)
  if (name !== from && dup >= 0) throw new Error(`已经有叫「${name}」的品牌了，改个名或去那张卡上编辑`)
  const next = { ...(idx >= 0 ? products[idx] : {}) }
  for (const k of EDITABLE) if (patch[k] !== undefined) next[k] = patch[k]
  next.name = name
  next.type = cleanType(next.type)
  next.kind = text(next.kind)
  next.status = text(next.status)
  next.oneLiner = text(next.oneLiner)
  next.entry = text(next.entry)
  next.facts = cleanFacts(next.facts)
  next.screens = cleanScreens(next.screens, root)
  next.target = text(next.target)
  return { product: next, index: idx }
}

function writeProductsFile(root, file, products) {
  const abs = join(root, PRODUCTS_REL)
  // tmp + rename：半截 JSON 会让 gen:data 与采集线一起读崩
  writeFileSync(`${abs}.tmp`, `${JSON.stringify({ ...(file || {}), products }, null, 2)}\n`)
  renameSync(`${abs}.tmp`, abs)
}

/** 新增或按原名替换一条档案，返回档案本身（界面保存后要立刻在卡上看见它） */
export function writeProduct(patch, { originalName, root = ROOT } = {}) {
  const { file, products } = readProducts(root)
  const { product, index } = planProduct(patch, { originalName, root })
  const next = [...products]
  if (index >= 0) next[index] = product
  else next.push(product)
  writeProductsFile(root, file, next)
  return product
}

/** 可选截图清单：public/shots/ 下的图片（真界面截图的登记处），给界面勾选。
 *  只扫这一个目录：public/ 下还有渲染产物、头像、采集图，全列出来等于让人在垃圾堆里挑图。
 *  界面能勾的选项就是本机真有的文件，不给人留打错路径的机会。 */
export function listShotImages(root = ROOT) {
  const base = join(root, 'public/shots')
  const out = []
  const walk = (dir, rel) => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      if (ent.name.startsWith('.')) continue
      const abs = join(dir, ent.name)
      const r = `${rel}/${ent.name}`
      if (ent.isDirectory()) walk(abs, r)
      else if (/\.(png|jpe?g|webp)$/i.test(ent.name) && statSync(abs).size > 0) out.push(r)
    }
  }
  if (existsSync(base)) walk(base, 'public/shots')
  return out.sort()
}
