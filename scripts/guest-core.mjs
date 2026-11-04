/**
 * 游客那一屏：未登录时对外可见的全部数据，与号主盘上的真东西完全分离。
 *
 * 为什么不拿真产物裁一刀给游客看：generated.json 是一整坨全量数据——没发布的稿子、平台账号身份与
 * 登录态、逐日读数、变现数、这台机器的绝对路径和 LLM 配置全在里面。砍掉哪几刀都不叫隔离，
 * 漏的是判断而不是字段。
 * 也不照搬演示站那份：演示站是号主自己决定公开的快照，里面的「已发布」是他真发出去的那几篇；
 * 游客这一屏没有这个前提，所以稿子走 seededArticles 全现造，读数表（收益、目标、逐日快照）一律抹掉。
 *
 * 静态资源是同一条链上的另一半：真图卡落在 public/cards、截图落在 public/shots，
 * 而静态服务只查路径、不在端点路由表里，登录墙管不到它——不改这里的话，未登录直接 GET
 * /cards/<没发布那篇的短码>/01.png 就拿到号主的真图了。所以游客能拿哪几个文件，
 * 由这份数据集引用到哪几个决定，内容目录里的其余一律要登录。
 */
import { demoProduct, assetRefs, CONTENT_ASSET_DIRS } from './demo-data-core.mjs'

/** 演示产物里仍然按号主真实经营数摆着的几张表：游客那份一律不给看 */
const PRIVATE_KEYS = ['snapshots', 'goals', 'revenue', 'capabilities']

/**
 * 真产物 → 游客产物。`leaks` 非空说明白名单哪天漏了字段，调用方必须当作「这一屏不能发」处理。
 * `referenced` 是这一屏引用到的内容文件，静态层按它放行。
 * 稿子走 seededArticles：连「已发布」都是现造的示例稿，号主的真稿子与真配图一篇都不在这一屏里。
 */
export function guestData(raw, opts = {}) {
  const { demo, leaks } = demoProduct(raw, { ...opts, seededArticles: true })
  const guest = { ...demo, viewer: 'guest' }
  for (const key of PRIVATE_KEYS) delete guest[key]
  // 引用清单跟着游客产物重算：删掉的那几张表万一提到过文件，不该继续给游客开着
  return { guest, body: JSON.stringify(guest), referenced: assetRefs(guest), leaks }
}

/** 这个静态路径游客能不能拿：内容目录之外的（界面壳、js/css、图标）照常，
 *  内容目录之内的只认这份游客产物引用过的那几个。
 *  引用清单的键带前导斜杠，与产物 JSON 里写的地址一个写法（照 demo-data-core 的口径）。 */
export function guestStaticOk(pathname, referenced) {
  const p = String(pathname || '')
  const rel = p.startsWith('/') ? p : `/${p}`
  const dir = rel.split('/')[1]
  if (!CONTENT_ASSET_DIRS.includes(dir)) return true
  return !!referenced && referenced.has(rel)
}
