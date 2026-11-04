/** 一个号一套登录态（本机 metrics/account-cookies/，0600、不入库）
 *
 * 为什么要它：一个浏览器 profile 只有一个存储罐子，同平台的第二个号一扫码就把第一个顶掉。
 * Ego Lite 不给脚本建 profile（实测：profiles() 只列、手加目录不热识别、import 只搬 Chrome 已注册的 profile），
 * 所以隔离改由 media-hub 自己做——**要哪个号，就把那个号那套登录态换进罐子；用完换回去**。
 * 换的粒度只有平台域名，且动手之前必先快照现状，所以每一步可逆。
 *
 * 一套登录态 = cookie + 后台域名那一格的 localStorage，两样必须一起换。
 * 依据是蚁小二 4.0 的本机授权实现（扒开客户端包看的）：它按号开 `persist:auth-<accountId>` 独立 session，
 * 收登录态时连 localStorage 一起收（小红书明确要 `b1`），发布抖音时缺 `security-sdk/s_sdk_crypt_sdk`
 * 就直接报「账号信息缺失，请重新授权此账号再试」。只换 cookie 等于第二个号顶着主号的设备键，
 * 平台认出来还是主号——2026-10-23 那两个假库、以及「扫了二号打开的还是主号后台」都是这么来的。
 *
 * 三个入口：
 *   adoptLogin()  刚扫完码时调用：把罐里这套认作该号的登录态收下
 *   useAccount()  要替某个号干活时调用：换进该号的登录态，返回换回原状的 restore()（只有一个号的平台改用 save()：落库不还罐）
 *   stashLive()   浏览器现有会话读通了：把它落回该号的库，库不会一直发旧（体检用这条，别动不动就换罐）
 *   clearJar()    扫同平台的第二个号之前调用：把罐里那位清出去，登录页才会摆一张干净的码
 *
 * cookie 与 localStorage 的值只在内存与本机文件之间走，绝不进日志、绝不进界面。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const ROOT = process.env.MEDIA_HUB_ROOT || process.cwd()

/** 各平台登录态所在域名（后缀匹配）。只列登录真用的域，别把 CDN 卷进来。
 *  键用 config/accounts.json 里的「platform」中文名——它是账号表与 payload 里唯一稳定的平台标识；
 *  账号 key（douyin / douyin-2）会被同平台的第二个号带后缀，认不出平台。 */
export const COOKIE_DOMAINS = {
  抖音: ['douyin.com', 'iesdouyin.com'],
  小红书: ['xiaohongshu.com'],
  公众号: ['mp.weixin.qq.com', 'weixin.qq.com'],
  快手: ['kuaishou.com', 'gifshow.com'],
  视频号: ['channels.weixin.qq.com', 'weixin.qq.com'],
}

/** 换罐时只动这个平台自己那一栏（收/存仍按上面整张表，那是一份完整快照）。
 *  公众号与视频号的 cookie 全落在 weixin.qq.com 底下，按整张表清会把兄弟平台那半套一起扫掉——
 *  扫掉之后视频号不再发 post_list、公众号拿不到 token，两个号同时判掉线（2026-11-04 实测）。
 *  没列在这里的平台照旧按整张表换：抖音的会话值挂在 .douyin.com 根域上，必须一起换。 */
export const SWAP_DOMAINS = {
  公众号: ['mp.weixin.qq.com'],
  视频号: ['channels.weixin.qq.com'],
}

export const vaultPath = (key, root = ROOT) => join(root, 'metrics', 'account-cookies', `${key}.json`)

/** 库里那一套登录态的原文：`{ savedAt, cookies, storage }`，storage 按后台域名存 localStorage。
 *  老库里没 storage 这一栏也照样读得回（只换 cookie，等下次授权时补上）。 */
export function readVaultFull(key, root = ROOT) {
  const p = vaultPath(key, root)
  if (!existsSync(p)) return null
  try {
    const v = JSON.parse(readFileSync(p, 'utf8'))
    return Array.isArray(v?.cookies) ? { cookies: v.cookies, storage: v.storage && typeof v.storage === 'object' ? v.storage : {} } : null
  } catch {
    return null // 半截文件按没存过处理，别拿坏数据去换罐
  }
}

export function readVault(key, root = ROOT) {
  return readVaultFull(key, root)?.cookies ?? null
}

/** 这个号的库里存没存过 localStorage（界面/日志只报状态，绝不报内容） */
export function hasStorage(key, root = ROOT) {
  return Object.keys(readVaultFull(key, root)?.storage || {}).length > 0
}

/** storage 传 undefined = 保留库里原有那一份（会话刷新只换 cookie 时用它），
 *  传对象 = 整栏换成这一份（收登录态、换罐、还罐三条路都显式给）。 */
export function writeVault(key, cookies, root = ROOT, storage = undefined) {
  const p = vaultPath(key, root)
  mkdirSync(dirname(p), { recursive: true })
  const body = JSON.stringify(
    { savedAt: new Date().toISOString(), cookies, storage: storage ?? readVaultFull(key, root)?.storage ?? {} },
    null, 1,
  )
  writeFileSync(`${p}.tmp`, body, { mode: 0o600 })
  renameSync(`${p}.tmp`, p) // 原子换，并发跑也不会读到半截
  return cookies.length
}

const inDomains = (c, list) => {
  const d = String(c?.domain || '').replace(/^\./, '').toLowerCase()
  return !!d && list.some((x) => d === x || d.endsWith(`.${x}`))
}

/** CDP 读回来的 cookie 不能原样写回去：sourceScheme/sourcePort/priority 是只读字段，
 *  sameSite 两边取值也不同（读回 NoSameSite，写入只认 Strict/Lax/None）。 */
export function forSetCookie(c) {
  const o = { name: c.name, value: c.value, domain: c.domain, path: c.path || '/' }
  if (c.secure) o.secure = true
  if (c.httpOnly) o.httpOnly = true
  const same = { Strict: 'Strict', Lax: 'Lax', None: 'None' }[c.sameSite]
  if (same) o.sameSite = same
  if (typeof c.expires === 'number' && c.expires > 0) o.expires = c.expires
  return o
}

/** 两套 cookie 是不是同一位：域+路径+名+值全比。值会随请求刷新，所以刷新要顺手落回库（见 useAccount 的 refreshed） */
export const sameCookies = (a, b) => {
  const set = (l) => new Map((l || []).map((c) => [`${c.domain}|${c.path || '/'}|${c.name}`, String(c.value)]))
  const x = set(a)
  const y = set(b)
  return x.size === y.size && [...x].every(([k, v]) => y.get(k) === v)
}

/** 库里每一条在罐子里都还在（值不一样不算丢，平台本来就常刷新）：罐里住的还是他。
 *  少了几条就是被别的平台换罐时一起扫掉了——公众号与视频号同属 weixin.qq.com，域名表互相盖得住，
 *  主人栏认得他、罐里却没他那几条，这时候必须照旧换罐（2026-11-04 改「单号平台也换气」时踩到的坑）。 */
export const jarHas = (live, want) => {
  const at = new Set((live || []).map((c) => `${c.domain}|${c.path || '/'}|${c.name}`))
  return (want || []).every((c) => at.has(`${c.domain}|${c.path || '/'}|${c.name}`))
}

const liveCookies = async (page, domains) => {
  // 新开的一张页面上第一次 getAllCookies 会回空（Network 域还没挂上这个 target）：
  // 授权动手前那次快照就是这么拍成空的，收工时无从还起，把主号的登录态留在地上（2026-10-23 实测）。
  await page.cdp('Network.enable').catch(() => {})
  const { cookies = [] } = await page.cdp('Network.getAllCookies')
  return cookies.filter((c) => inDomains(c, domains))
}
const drop = async (page, cookies) => {
  for (const c of cookies) {
    await page.cdp('Network.deleteCookies', { name: c.name, domain: c.domain, path: c.path || '/' }).catch(() => {})
  }
}
const put = async (page, cookies) => {
  for (const c of cookies) await page.cdp('Network.setCookie', forSetCookie(c))
}

/* ==================== 后台域名那一格的 localStorage ====================
 * 只有落在那个域名上才摸得到它，所以三条路都得先「站到那一格里去」：页面已经在那儿就直接读，
 * 不在就顺路 goto 一次（授权、干活、还罐这几趟本来都要进那个后台，多数时候这一步是空转）。
 * 读不到就照实说读不到（skipped），绝不静默当成「这个号没有本地存储」——静默就是回到只换 cookie 的老错。 */

export const originOf = (url) => {
  try {
    return new URL(String(url || '')).origin
  } catch {
    return ''
  }
}

/** 把页面弄到那个 origin 上；弄不动返回 false（页面 API 缺、导航失败、被弹到别的域） */
async function onOrigin(page, origin) {
  if (!origin || typeof page?.evaluate !== 'function') return false
  const here = async () => {
    try {
      return originOf(await (typeof page.url === 'function' ? page.url() : page.url))
    } catch {
      return ''
    }
  }
  if ((await here()) === origin) return true
  try {
    await page.goto(`${origin}/`, { waitUntil: 'domcontentloaded', timeout: 12000 })
  } catch {
    /* 重 SPA 首屏超时属常态，页面已提交就照读 */
  }
  return (await here()) === origin
}

async function readLocal(page, origin) {
  if (!await onOrigin(page, origin)) return null
  try {
    return await page.evaluate(() => {
      const out = {}
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i)
        out[k] = localStorage.getItem(k)
      }
      return out
    })
  } catch {
    return null // 隐私模式/页面在导航，读不到就按没读到办
  }
}

/** 整格换掉：先清再写，写不进去返回 false（调用方报 skipped，别谎报换好了） */
async function writeLocal(page, origin, kv) {
  if (!kv || !await onOrigin(page, origin)) return false
  try {
    await page.evaluate((items) => {
      localStorage.clear()
      for (const [k, v] of items) localStorage.setItem(k, v == null ? '' : String(v))
    }, Object.entries(kv))
    return true
  } catch {
    return false
  }
}

async function clearLocal(page, origin) {
  if (!await onOrigin(page, origin)) return false
  try {
    await page.evaluate(() => localStorage.clear())
    return true
  } catch {
    return false
  }
}

/** 收这一格的现状进 storage 对象（读不到就什么也不写，别拿一个空格覆盖库里那份） */
async function snapLocal(page, backend) {
  const origin = originOf(backend)
  const kv = origin ? await readLocal(page, origin) : null
  return { origin, storage: kv ? { [origin]: kv } : null }
}

/** 罐子里现在住的是谁。靠记，不靠猜：值比对只能判"像不像"，判不出"是哪个号"。 */
export const currentPath = (platform, root = ROOT) => join(root, 'metrics', 'account-cookies', `_current-${platform}.json`)
export function readCurrent(platform, root = ROOT) {
  try {
    return String(JSON.parse(readFileSync(currentPath(platform, root), 'utf8')).key || '') || null
  } catch {
    return null
  }
}
function writeCurrent(platform, key, root = ROOT) {
  const p = currentPath(platform, root)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(`${p}.tmp`, JSON.stringify({ key, at: new Date().toISOString() }), { mode: 0o600 })
  renameSync(`${p}.tmp`, p)
}
/** 罐里这位认不出来就别留名字：写个空主人，比顶着个错名字强——下轮 seedCurrent 会重新认 */
function clearCurrent(platform, root = ROOT) {
  try {
    writeFileSync(`${currentPath(platform, root)}.tmp`, JSON.stringify({ key: '', at: new Date().toISOString() }), { mode: 0o600 })
    renameSync(`${currentPath(platform, root)}.tmp`, currentPath(platform, root))
  } catch { /* 写不进去就当没记过 */ }
}

/** 罐里这套 cookie 是哪一位：拿库里几套逐套比，值全等的那套就是他。
 *  只当快路用——会话值会随请求刷新，比不中不代表不是他，所以比不出还要走「只有一个号没库」那条认法。 */
export function ownerOfCookies(platform, cookies, keys, root = ROOT) {
  const hits = (keys || []).filter((k) => sameCookies(readVault(k, root), cookies))
  return hits.length === 1 ? hits[0] : null
}

/** 授权开始前先把罐里现在这位认下来：他要是没进过库，等下二号一扫码就被平台原地顶掉，再也找不回来了。
 *  认法两条：先跟库里几套比（值全等就是这位）；比不出再看「罐里没记主人、且这个平台恰好只有一个别的号没库」——那这位就是他。认不出就不动。
 *  keys 传**不含本次要授权的那个号**的同平台账号——那个号本来就没库，把它算进来就永远认不出主人。 */
export async function seedCurrent(page, { platform, keys, backend, root = ROOT }) {
  const domains = COOKIE_DOMAINS[platform]
  if (!domains) return { seeded: null }
  const live = await liveCookies(page, domains)
  if (!live.length) return { seeded: null }
  const cur = readCurrent(platform, root)
  // 落一份新库时连那一格的 localStorage 一起落；读不到就沿用库里原有那份，别写空
  const snap = await snapLocal(page, backend)
  const stash = (key, cookies) => writeVault(key, cookies, root, snap.storage || readVaultFull(key, root)?.storage || {})
  if (cur && !readVault(cur, root)) {
    stash(cur, live)
    return { seeded: cur, why: '罐里主人没库，先落一份' }
  }
  const byValue = ownerOfCookies(platform, live, keys, root)
  if (byValue && byValue !== cur) {
    writeCurrent(platform, byValue, root)
    return { seeded: byValue, why: '罐里这套和库里那位对上了' }
  }
  const missing = keys.filter((k) => !readVault(k, root))
  if (!cur && missing.length === 1) {
    stash(missing[0], live)
    writeCurrent(platform, missing[0], root)
    return { seeded: missing[0], why: '这个平台只有一个号没库，罐里这位就是他' }
  }
  return {
    seeded: null,
    why: cur ? '罐里有主人且有库' : (keys.length ? `有 ${missing.length} 个号没库，认不出罐里是谁` : '这个平台没别的号，罐里不用认别人'),
  }
}

/** 平台第一次分号：库里一套都还没有，说明换罐从没跑过，罐里这位就是这只浏览器一直登着的那号——
 *  也就是登记表上最早登记的那个。先把他认下来收进库，之后才谈得上换罐；罐子是空的就认不了，照实报。 */
export async function claimJarForFirstAccount(page, { key, platform, keys, backend, root = ROOT }) {
  if (!COOKIE_DOMAINS[platform]) return false
  if (readCurrent(platform, root)) return false
  if ((keys || []).some((k) => readVault(k, root))) return false
  try {
    await adoptLogin(page, { key, platform, backend, root })
    return true
  } catch {
    return false // 罐里没这个平台的 cookie：他本来就没登录，别替他编一套
  }
}

/** 扫完码收下这套：罐里现在就是这个人。cookie 与后台那一格的 localStorage 一起收。 */
export async function adoptLogin(page, { key, platform, backend, root = ROOT }) {
  const domains = COOKIE_DOMAINS[platform]
  if (!domains) throw new Error(`平台 ${platform} 没有 cookie 域名表，收不了登录态`)
  const live = await liveCookies(page, domains)
  if (!live.length) throw new Error('这个平台上没读到任何 cookie，登录态没收下')
  const same = sameCookies(readVault(key, root), live)
  const snap = await snapLocal(page, backend)
  const count = writeVault(key, live, root, snap.storage || readVaultFull(key, root)?.storage || {})
  writeCurrent(platform, key, root)
  return { changed: !same, count, storage: snap.storage ? 'stored' : 'skipped' }
}

/** 开工前把罐子换成这个号（cookie + 那一格的 localStorage）；返回的 restore() 把罐子换回动手之前的样子，
 *  换过罐时才带上 save()——只把这一轮的会话落回他的库、浏览器照旧登着他，用于一个平台只有一个号的场合。
 *  没存过登录态的号不去动罐子——它该先去授权页扫一次码，别拿别人的会话冒充。
 *  `force`：主人栏说他本人但读数就是拿不到时也要真换一遍——库里那套的值可能比罐里的新。 */
export async function useAccount(page, { key, platform, backend, root = ROOT, force = false }) {
  const domains = COOKIE_DOMAINS[platform]
  if (!domains) return { restore: async () => {}, save: async () => {}, applied: 'noop' } // 没域名表就一条命令都不发：宁可不做，不许清错罐
  const vault = readVaultFull(key, root)
  if (!vault) return { restore: async () => {}, save: async () => {}, applied: 'unstored' }
  const origin = originOf(backend)
  // 换罐只动这个平台自己那一栏（公众号与视频号同属 weixin.qq.com，整张表一起清会扫掉兄弟平台的会话）
  const own = SWAP_DOMAINS[platform] || domains
  const inOwn = (list) => (list || []).filter((c) => inDomains(c, own))
  const before = await liveCookies(page, domains)
  const ownLive = inOwn(before)
  const ownVault = inOwn(vault.cookies)
  const beforeLocal = origin ? await readLocal(page, origin) : null
  const cur = readCurrent(platform, root)
  // 把此刻罐里的样子落到某人的库上：读得到本地存储就连它一起落，读不到只换 cookie、那栏原样保留
  const stash = (k, cookies, kv) => writeVault(k, cookies, root, kv && origin ? { ...readVaultFull(k, root)?.storage, [origin]: kv } : undefined)

  if (!force && cur === key && jarHas(ownLive, ownVault)) {
    // 罐里就是他本人：值不一样只说明平台刷新过会话，顺手把新的落回库，不换罐
    if (!sameCookies(vault.cookies, before) && before.length) stash(key, before, beforeLocal)
    return { restore: async () => {}, save: async () => {}, applied: 'already', count: vault.cookies.length }
  }

  // 换罐前先把上一位此刻的状态存住：会话值会随请求刷新，罐里这份比他库里的旧数据新
  if (cur && cur !== key && before.length) stash(cur, before, beforeLocal)
  await drop(page, ownLive)
  await put(page, ownVault)
  const mine = vault.storage?.[origin]
  // 库里没存过那一格（只换 cookie 的年代收的库），或是那一格换不进去：两种都得清干净。
  // 留着上一个号的设备键，平台认出来的还是上一个号（2026-10-23「扫了二号打开的是主号后台」）——
  // 宁可让平台给这个号重新长一套键，也不能拿别人的键认他。
  const wrote = mine ? await writeLocal(page, origin, mine) : false
  if (origin && !wrote) await clearLocal(page, origin)
  writeCurrent(platform, key, root)
  return {
    applied: 'swapped',
    count: vault.cookies.length,
    // missing = 这一格要重新授权才补得回来；界面上催一次扫码，补完就永久带上了
    storage: !origin ? 'none' : !mine ? 'missing' : wrote ? 'swapped' : 'skipped',
    /** 这个号此刻的会话落回他的库，浏览器保持登着他——不还罐。
     *  一个平台只有一个号时用这条：还回去的是动手前那套旧会话（常常已经失效），
     *  既白跑一趟换罐，又让人点开后台看到登录页（2026-11-04 公众号/视频号红点的另一半成因）。
     *  主人栏已由上面 writeCurrent 认下，下一轮走 already，连换罐都省了。 */
    save: async () => {
      try {
        const now = await liveCookies(page, domains)
        if (now.length) stash(key, now, origin ? await readLocal(page, origin) : null)
      } catch { /* 页面没了就只留库里那一套，不比没有强 */ }
    },
    restore: async ({ stashJar = true } = {}) => {
      const now = await liveCookies(page, domains)
      const nowLocal = origin ? await readLocal(page, origin) : null
      // 干完活这位的登录态可能又被平台刷过，先落回他的库再清罐，别把活会话扔了留一套旧的。
      // stashJar=false 是读不通那一轮：此刻罐里是被平台弹回登录页之后的残值，
      // 写进去就把库里唯一一套好会话覆盖了，下次连兜底都没得兜（2026-11-05 实测把 mp 库洗成死值）。
      if (stashJar && now.length) stash(key, now, nowLocal)
      await drop(page, inOwn(now))
      await put(page, inOwn(before))
      if (beforeLocal && origin) await writeLocal(page, origin, beforeLocal)
      if (cur) writeCurrent(platform, cur, root)
      else clearCurrent(platform, root) // 动手前罐里主人就认不出，换回去后也别说是谁的
    },
  }
}

/** 读成功那一刻把罐里这套活会话落回该号的库，浏览器一条命令都不发。
 *  库里那份过去只在授权时收一次，可平台每个请求都在刷会话值——体检于是拿一套过期的去换一个好用的（2026-11-04）。
 *  这条是「浏览器那套读通了」之后的顺手动作：让库跟着活会话一起新。 */
export async function stashLive(page, { key, platform, backend, root = ROOT }) {
  const domains = COOKIE_DOMAINS[platform]
  if (!domains) return 0
  const live = await liveCookies(page, domains)
  if (!live.length) return 0 // 罐里读不到东西就不写：拿空表覆盖库里那一套，下次换气就没得换
  const origin = originOf(backend)
  const kv = origin ? await readLocal(page, origin) : null
  return writeVault(key, live, root, kv && origin ? { ...readVaultFull(key, root)?.storage, [origin]: kv } : undefined)
}

/** 授权开始前拍一张现状：等下他扫的是新号，罐子会被平台原地顶掉，这位就找不回来了 */
export async function snapshotJar(page, { platform, backend, root = ROOT }) {
  const domains = COOKIE_DOMAINS[platform]
  if (!domains) return { cookies: [], storage: null, was: null }
  const snap = await snapLocal(page, backend)
  return { cookies: await liveCookies(page, domains), storage: snap.storage, was: readCurrent(platform, root) }
}

/** 授权收完工把罐子还回去：他平时用浏览器看的是主号，别扫完二号就把人家门口换了锁。
 *  key 是"这套登录态是谁的"；认不出主人就把主人栏清空——留着上一位的新名字是谎，
 *  下轮授权时 seedCurrent 会照值重新认。 */
export async function restoreJar(page, { platform, cookies, storage, key, backend, root = ROOT }) {
  const domains = COOKIE_DOMAINS[platform]
  if (!domains || !cookies?.length) return { restored: false }
  await drop(page, await liveCookies(page, domains))
  await put(page, cookies)
  const origin = originOf(backend)
  const kv = storage?.[origin]
  const wrote = await writeLocal(page, origin, kv)
  if (key) writeCurrent(platform, key, root)
  else clearCurrent(platform, root)
  return { restored: true, count: cookies.length, storage: !origin ? 'none' : !kv ? 'missing' : wrote ? 'restored' : 'skipped' }
}

/** 把这个平台的登录态从罐子里清出去——扫第二个号之前那一步。
 *  罐里还住着主号时，登录页摆的是主号那一屏（甚至直接跳进后台），人拿二号手机扫上去，
 *  落进这个号库的还是主号那套（2026-10-23 两个假库的成因）。清掉的那份由调用方先拍快照，收工还回。
 *  只清这一个平台的域名与那一个后台域名的本地存储，别的平台不动。 */
export async function clearJar(page, { platform, backend, root = ROOT }) {
  const domains = COOKIE_DOMAINS[platform]
  if (!domains) return { dropped: 0 }
  const live = await liveCookies(page, domains)
  await drop(page, live)
  const origin = originOf(backend)
  const cleared = origin ? await clearLocal(page, origin) : false
  clearCurrent(platform, root)
  return { dropped: live.length, storage: !origin ? 'none' : cleared ? 'cleared' : 'skipped' }
}

/** 清了 cookie 后台还认得出人 = 会话还藏在本地存储里，把那个域名的本地存储也倒掉。
 *  只动这一个 origin 的 local_storage + indexeddb，不碰整只浏览器的存储。 */
export async function clearSiteData(page, origin) {
  if (!origin) return false
  try {
    await page.cdp('Storage.clearDataForOrigin', { origin, storageTypes: 'local_storage,indexeddb' })
    return true
  } catch {
    return false // 这个 ego 版本不给清存储：调用方自己判还没清干净，别硬来
  }
}
