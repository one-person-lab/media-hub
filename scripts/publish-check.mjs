/**
 * 发布状态检测：逐平台创作者后台采「已发布内容列表」（标题 + 发布时间 + 链接），
 * 合并写入 metrics/raw/<date>.json 的 platforms[key].publishedList；
 * 顺手读到的粉丝数写同一份的 platforms[key].followers（账号页卡片用）。
 * gen:data 拿每条稿的标题与所属账号的列表匹配 → 发布日历自动判「已发布」，无需人工标记。
 *
 * 运行：npm run publish-check（经 run-ego.mjs 喂给 ego-browser，用 Ego Lite 已登录会话）
 *      单平台回认：--args --only xiaohongshu（账号页授权后只测刚登录的那个号，不等五平台跑完）
 *
 * 各平台数据源（2026-09-24 实测）：
 *  - 小红书  note-manager 页接口 /api/galaxy/v2/creator/note/user/posted（display_title + time + id）
 *  - 抖音    内容管理页同源接口 /janus/douyin/creator/pc/work_list?status=0（item_title/desc + create_time + share_url）
 *  - 快手    /profile 首页自带 /rest/cp/works/v2/video/pc/home/photo/list（title 首行 + publishTime + workId）；
 *            该接口带 __NS_sig3 签名，不能直连，只能捕获页面自身请求的响应
 *  - 公众号  appmsgpublish?sub=list（appmsg_info[].title + content_url + sent_info.time），token 从首页取
 *  - 视频号  /micro/content/cgi-bin/mmfinderassistant-bin/post/post_list（2026-10-01 实测）；
 *            后台是 wujie 微前端，这条请求由子应用帧发出、顶层帧 hook 收不到，
 *            改用 CDP Network 层抓页面自身的响应（见 CHECKS.视频号）
 *
 * 铁律：只读浏览列表，不碰任何发布/编辑控件；登录态失效只报告，不破解不自动登录。
 */
const fs = await import('node:fs/promises')

const ROOT = process.env.MEDIA_HUB_ROOT || process.cwd()
// 结构化进度与停止信号：一行 JSON 走 stdout 给服务端，停止只在平台之间自取（掐半路会留脏任务空间）
const { step, progress, plan, stopRequested } = await import(`file://${ROOT}/scripts/sync-step.mjs`)
const { classify, nextOf, labelOf } = await import(`file://${ROOT}/scripts/error-catalog.mjs`)
const { localDay } = await import(`file://${ROOT}/scripts/day-core.mjs`)
// 与 collect 同一把尺（本机日历日）：读取侧的落盘判据和界面读数都按它对齐
const DATE = localDay()

/** 各账号后台地址与所属平台：唯一事实源是 config/accounts.json
 *  （账号页「去后台」与这里同一份）。id = 这个号在本仓的身份，key = 快照桶，platform = 用哪套采集器。 */
const ACCTS = JSON.parse(await fs.readFile(`${ROOT}/config/accounts.json`, 'utf8'))
  .map((a) => ({ ...a, id: a.id || a.platform }))
const BACKEND = Object.fromEntries(ACCTS.map((a) => [a.key, a.backend]))

/** unix 秒/毫秒 → 本地 'YYYY-MM-DD HH:mm'（toISOString 是 UTC，会早 8 小时） */
function fmt(ms) {
  if (!ms) return null
  const d = new Date(ms > 1e12 ? ms : ms * 1000)
  return Number.isNaN(d.getTime()) ? null : d.toLocaleString('sv-SE', { hour12: false }).slice(0, 16)
}

// 捕获页面自身发出的 JSON 响应（带签名校验的接口只能这么拿，同 collect-platforms 的策略）
const HOOK = `(() => {
  window.__apiLog = []
  const push = (u, resp) => {
    try {
      if (typeof resp !== 'string' || resp.charCodeAt(0) !== 123) return
      window.__apiLog.push({ url: String(u).slice(0, 400), body: resp.slice(0, 600000) })
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

/** 空间已存在时先 claim 再 takeover（都在 ego-space 里） */
const { openSpace } = await import(`${ROOT}/scripts/ego-space.mjs`)
const vault = await import(`${ROOT}/scripts/cookie-vault.mjs`)
const ident = await import(`${ROOT}/scripts/account-identity-core.mjs`)
const { saveAvatar } = await import(`${ROOT}/scripts/account-avatar.mjs`)

let task = await openSpace('publish-check')
let page = (await task.pages()).find((p) => p.label === 'p1') || (await task.newPage())
await page.cdp('Page.addScriptToEvaluateOnNewDocument', { source: HOOK })

/** 换气分两条路，先后不能颠倒（2026-11-04 实测：一开头就换罐会把好的会话弄死——
 *  公众号那套落库时把视频号的 channels.* 一起扫掉，视频号接着跳回 login.html，两个号同时红）。
 *  1) 浏览器现在这套先直接读：它常常比库里新（授权之后平台一直在刷会话值），读到了就把这套落回库；
 *  2) 读不出来才从本机的登录态库换气重读——「明明早就授权了却一直报已失效」靠这一步救回来。
 *  一个平台挂了多个号时必须一开头就换气，否则两个号读到同一位。
 *  这个平台一套库都还没有（第一次分号）时，罐里那位就是最早登记的主号，先把他认下来收进库。 */
let swapBack = null
const keysOf = (platform) => ACCTS.filter((x) => x.platform === platform).map((x) => x.key)

/** 上一轮那一罐的收尾（还罐或落库）先做掉，别把别人的登录态留在罐子里 */
let swapStash = false
async function flushSwap() {
  if (!swapBack) return
  const done = swapBack
  swapBack = null
  await done()
}

/** 多号平台：一开头就按号换气 */
async function useAccount(a) {
  await flushSwap()
  const rivals = keysOf(a.platform)
  if (rivals.length < 2) return
  const hit = await vault.useAccount(page, { key: a.key, platform: a.platform, backend: a.backend, root: ROOT })
  if (hit.applied === 'unstored') {
    if (a.key === rivals[0] && await vault.claimJarForFirstAccount(page, { key: a.key, platform: a.platform, keys: rivals, backend: a.backend, root: ROOT })) return
    // 这条报错会直接摆到授权页的读数上，报「抖音-晓丸子君」那种内部 id 人认不出是哪一行
    throw new Error(`「${a.nickname ? `${a.platform}·${a.nickname}` : a.id}」还没收过登录态：在授权页给它扫一次码`)
  }
  // 还罐时落不落库，看这一轮读通没读通——读不通那套是残值，别写进库里那唯一一套好会话
  if (hit.applied === 'swapped') { swapStash = false; swapBack = () => hit.restore({ stashJar: swapStash }) }
}

/** 单号平台的兜底：浏览器这套读不出来，换进库里那一套重读一次。
 *  读通了就让他登着（save 落库）；读不通把浏览器原样还回去，库里那套一个字都不改——
 *  弹回登录页之后的罐子只剩残值，顺手落库就是把唯一一套好会话洗掉，下次连兜底都没得兜。
 *  库里根本没这套（这个号一次没扫过码）就不重读：留给界面的是第一次那句实话，不是凭空造一个库。 */
async function retryFromJar(a) {
  if (!vault.readVault(a.key, ROOT)) return false
  const hit = await vault.useAccount(page, { key: a.key, platform: a.platform, backend: a.backend, root: ROOT, force: true })
  if (hit.applied !== 'swapped') return false
  try {
    await CHECKS[a.platform]()
    await assertIdentity()
    swapBack = hit.save
    return true
  } catch (e2) {
    swapBack = () => hit.restore({ stashJar: false })
    throw e2
  }
}

const result = { date: DATE, collectedAt: new Date().toISOString(), platforms: {}, errors: {} }
/** 顺手从后台页面上读到的账号读数（粉丝数等），账号页卡片要用 */
const stats = {}
const fail = (p, e) => { result.errors[p] = String(e?.message ?? e).slice(0, 200) }
/** 鉴权读数成功（哪怕返回 0 条）即登录态可用——0 条是「没内容」，不能报成掉线 */
const authed = new Set()

async function gotoTolerant(url) {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded' })
  } catch {
    const here = String(await page.url().catch(() => ''))
    if (!here.startsWith(new URL(url).origin)) {
      try { await page.goto(url) } catch { /* committed 后照读 */ }
    }
  }
}

/** 轮询等页面自身请求出现在 __apiLog（签名接口不能直连，只能等页面发出来）。
 *  每轮顺手看一眼是不是已经跳到登录那一屏：是就别再等满 25 秒（旧写法等到底才回头看，慢且误判掉线）。 */
async function waitApi(urlPat, waitMs = 25000) {
  const deadline = Date.now() + waitMs
  for (;;) {
    const hit = await page.evaluate(
      (pat) => (window.__apiLog || []).filter((c) => new RegExp(pat).test(c.url)).pop()?.body ?? null,
      urlPat,
    ).catch(() => null)
    if (hit) return JSON.parse(hit)
    if (Date.now() > deadline) return null
    const wall = await loginWall()
    if (wall) {
      logout.add(KEY)
      return { bounced: wall }
    }
    await page.waitForTimeout(2000)
  }
}

/** CDP 网络层等某个请求的响应体（按页面 target 收，跨 iframe——wujie 子应用的请求顶层 hook 看不到）。
 *  调用方须先 page.cdp('Network.enable') 再导航，否则请求早于 enable 就发完了。
 *  onTick 每轮先问一次：它回一句原因（比如页面已经被人弹回登录页）就立刻收手回 `{ bounced }`——
 *  登录页那一屏不会再发这条请求，等满 30 秒只是把「慢」和「误判掉线」一起留着（2026-11-04）。 */
async function sniffResponse(urlPat, waitMs = 30000, onTick) {
  const re = new RegExp(urlPat)
  const seen = new Map() // requestId -> url：responseReceived 和 loadingFinished 可能落在不同批事件里
  const deadline = Date.now() + waitMs
  for (;;) {
    for (const e of await page.events()) {
      if (e.method === 'Network.responseReceived' && re.test(e.params.response.url)) {
        seen.set(e.params.requestId, e.params.response.url)
      }
      if (e.method === 'Network.loadingFinished' && seen.has(e.params.requestId)) {
        const url = seen.get(e.params.requestId)
        seen.delete(e.params.requestId)
        try {
          const b = await page.cdp('Network.getResponseBody', { requestId: e.params.requestId })
          return { url, body: b.base64Encoded ? Buffer.from(b.body, 'base64').toString('utf8') : b.body }
        } catch { /* 响应体已被回收，等下一条匹配 */ }
      }
    }
    if (Date.now() > deadline) return null
    if (onTick) {
      const bounced = await onTick()
      if (bounced) return { bounced }
    }
    await page.waitForTimeout(500)
  }
}

const clearLog = () => page.evaluate(() => { window.__apiLog = [] })
const sleep = (ms) => page.waitForTimeout(ms)

/** 轮询到 fn 交出东西为止，到点回 null。
 *  固定 sleep 赌不了页面快慢：秒开的页面白等 6 秒，慢半拍的页面等完 6 秒照样读空（2026-11-04 体检又慢又误报的成因）。 */
async function poll(waitMs, everyMs, fn) {
  const deadline = Date.now() + waitMs
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > deadline) return null
    await sleep(Math.min(everyMs, Math.max(50, deadline - Date.now())))
  }
}

/* ==================== 账号读数（粉丝数） ====================
 * 后台的粉丝数只写在页面上，鉴权接口里不一定带，所以从正文里按各平台的原文样式抠。
 * 2026-09-30 实测原文：
 *   公众号 首页「总用户数 30 +2」
 *   快手    /profile「60粉丝0关注423获赞」
 *   视频号  未登录跳 login.html，读数原文还没实测过——不猜，等登录后再补 pattern
 */
const num = (s) => {
  const m = String(s ?? '').replace(/,/g, '').match(/^([\d.]+)\s*([万wW])?/)
  if (!m) return null
  const v = Number(m[1]) * (m[2] ? 10000 : 1)
  return Number.isFinite(v) ? Math.round(v) : null
}

/** 正文压成一行后按 pattern 取第一个捕获组；轮询到水合为止，读不到返回 null（宁缺不假）。
 *  快手的账号头在 shadow DOM 里，body.innerText 看不到，所以要连影子树一起收。 */
async function readNum(re, waitMs = 10000) {
  const deadline = Date.now() + waitMs
  for (;;) {
    try {
      const txt = await page.evaluate(() => {
        const chunks = [document.body ? `${document.body.innerText} ${document.body.textContent}` : '']
        const walk = (root) => {
          for (const el of root.querySelectorAll('*')) {
            if (el.shadowRoot) { chunks.push(el.shadowRoot.textContent || ''); walk(el.shadowRoot) }
          }
        }
        walk(document)
        return chunks.join(' ').replace(/\s+/g, ' ')
      })
      const m = String(txt).match(re)
      if (m) return num(m[1])
    } catch { /* 页面还在导航，下一轮再读 */ }
    if (Date.now() > deadline) return null
    await sleep(2000)
  }
}

/* ==================== 逐平台读数 ====================
 * 采集器按**平台**分（版式与接口只跟平台有关），跑的时候按**账号**循环：
 * 同一个平台的两个号各换各的登录态、各写各的快照桶（result.platforms[KEY]）。
 * 每个 check 自己写 result.platforms[KEY]，并在「鉴权读数成功」那一刻 authed.add(KEY)。
 * 0 条算不算登录证据各平台不同（小红书/公众号/视频号 0 条 = 真没发过——视频号 2026-10-01 实测
 * errCode:0 空列表；抖音 0 条 = 没读到，可能是改版），
 * 所以抛错的位置保持各平台原样，不要统一。 */
let KEY = null
let ACCT = null
/** 这一轮后台自报的「这是谁的号」，登录态缓存要摆出来：同平台两个号都报 ok 时，光看条数分不出真假 */
const readAs = {}
/** 这一轮认下本人的账号头像（站内路径）：只有昵称对得上这一行才落，读到别人的号时那张脸也不能顶在这一行上 */
const avatars = {}

/** 身份核对：接口返回了数据只证明「有个号登着」，不证明「是登记表上这一行的那个号」。
 *  2026-10-23 实测：换罐失败时同平台两个号会读到一模一样的 42 条，两份读数都敢报「已登录」。
 *  判得出是别人必须停手；判不出（这个平台没有身份读数、改版、接口没返回）照旧放行——别把没证据当证据。
 *  每个 check 都已经把页面导航进那个平台的后台，所以这里走同域 GET 就够，不必再导航一次。 */
async function assertIdentity() {
  if (!ident.hasIdentityReader(ACCT.platform)) return
  let who = null
  try {
    who = ident.readIdentity(ACCT.platform, JSON.parse((await page.fetch(ident.IDENTITY_URL[ACCT.platform])).body))
  } catch { /* 读数拿不到就判不了，交给下面 unknown 放行 */ }
  if (who) readAs[KEY] = ident.identityLabel(who)
  if (ident.identityVerdict(ACCT, who) === 'mismatch') {
    // 别人的作品列表不能留在这个号的快照桶里：发布日历拿它判「已发布」，会把主号的稿认成这个号的
    delete result.platforms[KEY]
    // 读数成功那一刻记的「登着」也要撤回来：登着的是别人，这一行就没资格报 ok
    authed.delete(KEY)
    const rivals = ACCTS.filter((x) => x.platform === ACCT.platform && x.key !== ACCT.key)
    throw new Error(ident.identityMismatchError(ACCT, who, rivals))
  }
  // 头像只在认下「就是这一行的号」时落盘：同平台两个号共用一个浏览器，认错的头像比没头像更误导人
  if (who?.avatar && ident.identityVerdict(ACCT, who) === 'match') {
    const hit = await saveAvatar(who.avatar, ACCT.key, ROOT)
    if (hit) avatars[ACCT.key] = hit
  }
}

/* ==================== 「已失效」只认一个凭据 ====================
 * 页面真被弹回登录页、或后台摆着扫码墙，才叫这个号的登录态掉了。
 * 接口没出现、返回 0 条、嗅探落空只说明这一次没测出来——可能是改版、可能是慢。
 * 旧写法拿一句正则扫报错文案（/未登录|登录态|token|cookie/），
 * 而「接口未出现（登录态失效或改版）」这种话人人都写，于是每一次超时都记成掉线（2026-11-04 的红点）。 */
const LOGIN_PAGE_URL = /login|passport|signin|qrcode|qrconnect|sso/i
const LOGIN_WALL_TEXT = /扫码登录|请使用微信扫码|手机号登录|APP扫码|请登录|立即登录|微信扫一扫|登录后管理/
/** 这一轮真见过登录页的号；只有它们配报「已失效」 */
const logout = new Set()

/** 页面此刻是不是登录那一屏。是就回一句「凭什么说他没登录」，不是回空串。
 *  开头一律写「未登录」：error-catalog 认这一类就靠这几个字，标签才会是「登录过期」而不是「页面改版了」。 */
async function loginWall() {
  const url = String(await page.url().catch(() => ''))
  if (LOGIN_PAGE_URL.test(url)) return `未登录：后台把人弹回了登录页（${url.slice(0, 90)}）`
  const txt = String(await page.evaluate(() => document.body?.innerText || '').catch(() => '')).slice(0, 3000)
  const m = txt.match(LOGIN_WALL_TEXT)
  return m ? `未登录：后台摆着扫码墙（${m[0]}）` : ''
}

/** 读数落空时的两句实话：有登录页证据就报掉线，没有就报这一次没测出来。
 *  「未出现」三个字留着给 error-catalog 认类（页面改版了）。 */
async function notRead(what) {
  const wall = await loginWall()
  if (wall) {
    logout.add(KEY)
    return wall
  }
  return `${what}未出现（这一次没测出来，不代表登录掉了）`
}

const CHECKS = {
  /* 小红书 */
  小红书: async () => {
    await gotoTolerant(BACKEND[KEY])
    const j = await waitApi('creator/note/user/posted')
    if (j?.bounced) throw new Error(j.bounced)
    if (!j) throw new Error(await notRead('笔记列表接口'))
    const notes = j?.data?.notes || []
    result.platforms[KEY] = notes
      .filter((n) => n.display_title)
      .map((n) => ({
        title: n.display_title,
        publishedAt: n.time || fmt(n.visible_time),
        url: n.id ? `https://www.xiaohongshu.com/explore/${n.id}` : '',
        private: n.permission_code !== 0 || !!n.permission_msg,
      }))
    authed.add(KEY)
    if (!result.platforms[KEY].length) throw new Error('列表接口返回 0 条')
  },

  /* 抖音 */
  抖音: async () => {
    await gotoTolerant(BACKEND[KEY])
    await sleep(6000)
    const res = await page.fetch('https://creator.douyin.com/janus/douyin/creator/pc/work_list?status=0&count=50&max_cursor=0&scene=star_atlas&device_platform=android&aid=1128')
    const list = JSON.parse(res.body)?.aweme_list || []
    result.platforms[KEY] = list.flatMap((it) => {
      const t = fmt(it.create_time)
      const url = it.share_url || (it.aweme_id ? `https://www.douyin.com/video/${it.aweme_id}` : '')
      // 图文的标题在 item_title，视频在 desc/caption——三个候选都登记，匹配层各认各的
      return [it.item_title, it.desc, it.caption]
        .map((s) => String(s || '').trim())
        .filter(Boolean)
        .map((title) => ({ title, publishedAt: t, url }))
    })
    if (!list.length) throw new Error(await notRead('作品列表读数'))
    authed.add(KEY)
  },

  /* 公众号 */
  公众号: async () => {
    await gotoTolerant(BACKEND[KEY])
    // 同一个 mp.weixin.qq.com 域名既挂公众号后台也挂小程序后台（/wxamp）：登着小程序时 token 照样拿得到，
    // 但发表记录接口只回空列表，上一轮就报成「发表记录返回 0 条」，看着像改版（2026-10-28 实测）。
    // token 要等根域重定向跑完才挂到地址上，所以轮询到「拿到 token / 进了小程序后台 / 见到登录页」为止（同 publish-mp 那把尺）。
    let wallSeen = 0
    const here = await poll(20000, 700, async () => {
      const v = await page
        .evaluate(() => ({ token: (location.href.match(/token=(\d+)/) || [])[1] || '', path: location.pathname }))
        .catch(() => ({ token: '', path: '' }))
      if (v.token || /^\/wxamp/.test(v.path)) return v
      const wall = await loginWall()
      if (!wall) {
        wallSeen = 0
        return null
      }
      // 重定向半路也可能一闪而过登录页：连见两次才算真没登录
      wallSeen++
      return wallSeen >= 2 ? { token: '', path: '', wall } : null
    })
    if (!here) throw new Error(await notRead('后台首页的 token'))
    if (/^\/wxamp/.test(here.path)) throw new Error(`后台现在登的是小程序，不是公众号「${ACCT?.nickname || KEY}」：在 Ego Lite 里把身份切回公众号再扫一次码`)
    if (here.wall) {
      logout.add(KEY)
      throw new Error(`公众号${here.wall}`)
    }
    const token = here.token
    const res = await page.fetch(`https://mp.weixin.qq.com/cgi-bin/appmsgpublish?sub=list&begin=0&count=20&token=${token}&lang=zh_CN&f=json&ajax=1`)
    const pageData = JSON.parse(JSON.parse(res.body).publish_page || '{}')
    result.platforms[KEY] = (pageData.publish_list || []).flatMap((p) => {
      const info = JSON.parse(p.publish_info || '{}')
      const t = fmt(info.sent_info?.time)
      return (info.appmsg_info || [])
        .filter((m) => m.title && !m.is_deleted)
        .map((m) => ({ title: m.title, publishedAt: t, url: m.content_url || '' }))
    })
    authed.add(KEY)
    const fans = await readNum(/总用户数\s*([\d.,]+\s*[万w]?)/)
    if (fans != null) stats[KEY] = { followers: fans }
    if (!result.platforms[KEY].length) throw new Error('发表记录返回 0 条')
  },

  /* 快手 */
  快手: async () => {
    await clearLog()
    await gotoTolerant(BACKEND[KEY])
    const j = await waitApi('works/v2/video/pc/home/photo/list')
    if (j?.bounced) throw new Error(j.bounced)
    if (!j) throw new Error(await notRead('首页作品列表接口'))
    const list = j?.data?.list || []
    result.platforms[KEY] = list
      .filter((w) => w.title && w.publishStatus === 4) // 4 = 已发布（实测读数）
      .map((w) => ({
        title: String(w.title).split('\n')[0].trim(),
        publishedAt: fmt(w.uploadTime),
        url: w.workId ? `https://www.kuaishou.com/short-video/${w.workId}` : '',
      }))
    authed.add(KEY)
    const fans = await readNum(/([\d.,]+\s*[万w]?)\s*粉丝\s*[\d.,]+\s*关注/)
    if (fans != null) stats[KEY] = { followers: fans }
    if (!result.platforms[KEY].length) throw new Error('已发布图文 0 条')
  },

  /* 视频号：后台是 wujie 微前端，post_list 由子应用帧发出，顶层帧的 __apiLog 收不到
   * （2026-10-01 实测：顶层 hook 抓到 32 条 JSON，里面没有 post_list）。
   * 所以走 CDP Network 层——它按页面 target 收，天然跨帧。
   * 判据换成「post_list 返回 errCode:0 即登录证据」，0 条如实记 0 条（本号确实没发过动态）。 */
  视频号: async () => {
    await page.cdp('Network.enable')
    await gotoTolerant(BACKEND[KEY])
    // 未登录时这一屏直接跳去 login.html，之后再也不会发 post_list：边嗅边看地址，落到登录页立刻收手。
    // 旧写法等满 30 秒才回头读一次 URL——慢一半，而且那句「接口未出现」还被正则判成掉线（2026-11-04 的红点）。
    const hit = await sniffResponse('mmfinderassistant-bin/post/post_list', 30000, async () => {
      const url = String(await page.url().catch(() => ''))
      return LOGIN_PAGE_URL.test(url) ? `未登录：视频号助手把人弹回了登录页（${url.slice(0, 90)}）` : ''
    })
    if (hit?.bounced) {
      logout.add(KEY)
      throw new Error(`视频号${hit.bounced}`)
    }
    if (!hit) throw new Error(await notRead('动态列表接口'))
    let j
    try { j = JSON.parse(hit.body) } catch { throw new Error('动态列表接口返回非 JSON（改版）') }
    if (j.errCode !== 0) throw new Error(`动态列表接口 errCode=${j.errCode}：${j.errMsg || '未知错误'}`)
    const list = j.data?.list || []
    // 视频号接口是驼峰命名（noteId/createTime），旧嗅探猜的下划线字段一条都匹配不上
    if (list.length) console.log('视频号 post_list 首条字段：', Object.keys(list[0]).join(','))
    result.platforms[KEY] = list.map((it) => ({
      title: String(it.title || it.description || '').trim().split('\n')[0],
      publishedAt: fmt(Number(it.createTime || it.publishTime || 0)),
      url: '', // 动态详情页链接形态未实测，不猜
    })).filter((x) => x.title)
    authed.add(KEY)
  },
}

/** --only <key 或 账号 id>[,<…>]：账号页授权后只回认这一个号，不必等全部号跑一遍 */
const onlyAt = process.argv.indexOf('--only')
const only = onlyAt < 0 ? [] : String(process.argv[onlyAt + 1] || '').split(',').map((s) => s.trim()).filter(Boolean)
const targets = ACCTS.filter((a) => !only.length || only.includes(a.key) || only.includes(a.id))
plan(targets.map((a) => a.key))
for (const [ti, a] of targets.entries()) {
  if (!CHECKS[a.platform]) {
    fail(a.key, `accounts.json 里「${a.id}」的平台「${a.platform}」没有对应采集器（现有：${Object.keys(CHECKS).join('、')}）`)
    continue
  }
  KEY = a.key
  ACCT = a
  progress(a.key, '检测', ti + 1, targets.length, a.id)
  try {
    if (stopRequested()) throw new Error('人工停止，该平台本轮没跑')
    await useAccount(a)
    const single = keysOf(a.platform).length < 2
    try {
      await CHECKS[a.platform]()
      // 列表读到了不等于读对了人：核对过身份，这一行的登录态才算成立
      await assertIdentity()
      swapStash = true // 读通了，还罐时才把他这一轮的会话落回库
      // 单号平台读通了：把浏览器这套最新会话落回他的库，库里那份只有靠这一刻才不会一直发旧
      if (single) await vault.stashLive(page, { key: a.key, platform: a.platform, backend: a.backend, root: ROOT })
    } catch (e) {
      // 多号平台换过罐了，报错照实报；单号平台还有一步兜底
      if (!single || stopRequested()) throw e
      if (!await retryFromJar(a)) throw e
    }
  } catch (e) {
    fail(a.key, e)
  }
  step(a.key, result.errors[a.key] ? 'error' : 'ok', {
    note: result.errors[a.key] || '', count: (result.platforms[a.key] || []).length,
  })
}
// 最后一个换过罐的号也要把浏览器还回他原来那位
if (swapBack) await swapBack().catch(() => {})

/* ==================== 合并落盘 ====================
 * 同一天 collect 可能已写过本文件（metrics 读数）：只更新 publishedList，不碰别的字段 */
const outPath = `${ROOT}/metrics/raw/${DATE}.json`
let doc = { collectedAt: result.collectedAt, date: DATE, platforms: {}, errors: {} }
try {
  doc = JSON.parse(await fs.readFile(outPath, 'utf8'))
  doc.platforms ||= {}
} catch { /* 当天还没有快照，新建 */ }
for (const [key, list] of Object.entries(result.platforms)) {
  doc.platforms[key] = { ...(doc.platforms[key] || {}), publishedList: list }
}
for (const [key, s] of Object.entries(stats)) {
  doc.platforms[key] = { ...(doc.platforms[key] || {}), ...s }
}
// 回认时间单独记：collectedAt 是「指标读数」的时间，只跑 publish-check 不该把它提前，
// 否则「数据复盘」会拿一次列表回认冒充成新的指标采集。
doc.publishedListAt = result.collectedAt
await fs.mkdir(`${ROOT}/metrics/raw`, { recursive: true })
await fs.writeFile(outPath, JSON.stringify(doc, null, 2) + '\n')

/* ==================== 登录态缓存（本机本地，不入库） ====================
 * 不为登录单独开浏览器：这次后台读数的成败就是凭据。
 *  - 鉴权读数成功 → ok
 *  - 页面真被弹回登录页/摆着扫码墙（logout 这一组，判据在上面）→ out，要人工重扫
 *  - 其余（改版、接口没出现、嗅探落空、这个号还没扫过码）→ error，别冒充掉线
 * --only 跑单平台时只换这几个号的时间戳，别把没测过的写成「没读到」。
 */
const loginPath = `${ROOT}/metrics/login-state.json`
let loginDoc = { checkedAt: null, platforms: {} }
try {
  const prev = JSON.parse(await fs.readFile(loginPath, 'utf8'))
  if (prev?.platforms) loginDoc = prev
} catch { /* 还没体检过 */ }
const checkedAt = new Date().toISOString()
for (const a of targets) {
  const err = result.errors[a.key]
  const entry = authed.has(a.key)
    ? { state: 'ok', evidence: `${(result.platforms[a.key] || []).length} 条已发布` }
    : logout.has(a.key)
      ? { state: 'out', error: err }
      : { state: 'error', error: err || '没读到后台列表' }
  // 键是账号 id：同平台两个号各有各的登录态，一个掉线不能把另一个也判成掉线
  // account 是后台自报「这批数据是谁的」：判得出本人时它是凭据，判出是别人时它是那句报错的主语
  // 报错顺手带上 error-catalog 的类名与那句「该做什么」：这条读数会直接摆在授权页上，
  // 而脚本给的是英文原文（newTaskSpace: Profile not found），界面不自己翻译第二套措辞。
  // code 也留着：授权页靠它认出「这个号点去授权必挂」，直接摆建浏览器那一屏而不是空跑一趟
  const code = err ? classify(err) : ''
  const action = code ? nextOf(code) : ''
  // label 是这一类的几个字：创作台的 chip 要写「未授权」而不是笼统的「推不动」，
  // 但措辞不许在视图里再翻一套，所以由这里从 error-catalog 一起落下来
  const label = code ? labelOf(code) : ''
  // avatar 跟着 account 走：这一轮没读到头像（判不出身份/只回认了别的号）就沿用上一次的，别把它抹成空
  const prev = loginDoc.platforms[a.id]
  const seen = {}
  if (readAs[a.key]) seen.account = readAs[a.key]
  const avatar = avatars[a.key] || prev?.avatar
  if (avatar) seen.avatar = avatar
  loginDoc.platforms[a.id] = {
    ...seen, ...entry,
    ...(code ? { code } : {}), ...(label ? { label } : {}), ...(action ? { action } : {}),
    checkedAt,
  }
}
loginDoc.checkedAt = checkedAt
await fs.mkdir(`${ROOT}/metrics`, { recursive: true })
await fs.writeFile(`${loginPath}.tmp`, JSON.stringify(loginDoc, null, 2) + '\n')
await fs.rename(`${loginPath}.tmp`, loginPath)

// 成败判据 = 产物内容断言：每平台报条数，errors 非空必须上报（自报 ok 不等于采对）
console.log(JSON.stringify({
  date: DATE,
  file: `metrics/raw/${DATE}.json`,
  counts: Object.fromEntries(Object.entries(result.platforms).map(([k, v]) => [k, v.length])),
  ...(Object.keys(stats).length ? { 粉丝数: Object.fromEntries(Object.entries(stats).map(([k, v]) => [k, v.followers])) } : {}),
  ...(Object.keys(result.errors).length ? { errors: result.errors } : {}),
}, null, 1))
if (Object.keys(result.errors).length) process.exitCode = 2
// 人按的停止优先于「部分成功」：界面要能分清这是你停的，不是平台挂了
if (stopRequested()) process.exitCode = 3
await task.finish({ keep: [] })
