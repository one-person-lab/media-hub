/**
 * 本机授权：打开平台创作者后台登录页，把二维码抠出来写给工作台界面直接摆（/tmp/media-hub-login-qr.png），
 * 人在工作台弹层里扫码，脚本盯到登录完成自己收工。只有取不到二维码的平台才退化成把登录页拉前台。
 * media-hub 要的是「登录成功后那套登录态」= cookie + 后台那一格的 localStorage，两样一起按号存进本机
 * metrics/account-cookies/（0600、不入库、不进日志），同平台的第二个号靠它换罐，不再要人去 Ego Lite 建 profile。
 * 账号密码不碰，验证码不破解。只收 cookie 的库会让第二个号顶着主号的设备键（2026-10-23 的「扫了二号打开主号后台」）。
 * 扫之前先把这个平台的登录态从浏览器里清出去（clearJar）：罐里还住着主号时，登录页摆的是主号那一屏，
 * 人拿二号手机扫上去，收进这个号库的还是主号；收工把罐子还回去。
 * 只有一个号的平台不清罐也不还罐：没什么可混，扫完这套新登录态就留在浏览器里（旧的那套还回去也是死的）。
 * 登录成功后由界面接着跑 publish-check 回认（后台读数为凭），所以这里判两件事：
 * 页面进到了后台（登录态在不在）+ 后台自报的是不是这一行要绑的那个号（见 account-identity-core）。
 *
 * 用法：node scripts/run-ego.mjs scripts/open-login.mjs --args --platform <平台 key> [--open]
 * 带 `--open` 时不等扫码：界面判这个号已登录，只把它的登录态换进浏览器、打开后台，几秒收工。
 * 平台 key 与后台地址取自 config/accounts.json 的 backend 字段。
 *
 * 带 `--new` 时 `--platform` 给的是**平台中文名**（config/platforms.json 的模板），走蚁小二那一套交互：
 * 人不必先填昵称——扫进去之后问平台后台「这是谁的号」，拿那个名字当场登记一行、收下这套登录态，
 * 回话里带 `bound:{id,key,nickname}`。这个平台已经有同名号时判 `already-authorized`，不建重复行。
 *
 * 等的过程中界面可以递信号进来（信号文件）：重新弹出登录窗口、取消等待、
 * 以及视频号那一屏的两个按钮——「用这个微信号登录」(quick) 和「改用其他微信扫码」(swap)，
 * 由人在界面上点，脚本替他点登录页里那一下。
 */
const fs = await import('node:fs')
const cp = await import('node:child_process')

const ROOT = process.env.MEDIA_HUB_ROOT || process.cwd()
/** 开关只能走参数：ego 内嵌 Node 不透传宿主环境变量 */
const at = process.argv.indexOf('--platform')
const argPlatform = at < 0 ? '' : String(process.argv[at + 1] || '')
if (!argPlatform) {
  console.error('用法: node scripts/run-ego.mjs scripts/open-login.mjs --args --platform <平台 key> [--new]')
  process.exit(1)
}
/** `--new`：--platform 给平台中文名，扫进去的号自己报名字（先扫码、后登记） */
const isNew = process.argv.includes('--new')

/** 空间已存在时先 claim 再 takeover（都在 ego-space 里） */
const { openSpace } = await import(`${ROOT}/scripts/ego-space.mjs`)
const vault = await import(`${ROOT}/scripts/cookie-vault.mjs`)
const ident = await import(`${ROOT}/scripts/account-identity-core.mjs`)
const acc = await import(`${ROOT}/scripts/accounts-core.mjs`)
const sync = await import(`${ROOT}/scripts/sync-step.mjs`)

/** 走到哪一步，实时写进进度文件给界面弹层摆（脚本 stdout 要到进程退出才吐，运行中没人看得见）。
 *  只写状态与计数——cookie 与 localStorage 的值一个字符都不写。 */
const say = (phase, note, done) => sync.progress('', phase, done, undefined, note)

/** 扫哪个后台、算哪个号：老路子取登记表上这一行；`--new` 取平台模板——登记表上还没有它 */
function resolveAccount() {
  if (!isNew) return JSON.parse(fs.readFileSync(`${ROOT}/config/accounts.json`, 'utf8')).find((a) => a.key === argPlatform)
  let tpl
  try {
    tpl = acc.platformTemplates(ROOT).find((t) => t.platform === argPlatform)
  } catch {
    return null // 模板表读不到：下面统一报错，别在这里抛栈盖掉那句人话
  }
  return tpl && { platform: tpl.platform, key: '', nickname: '', backend: tpl.backend, quickLogin: tpl.quickLogin || '' }
}
const acct = resolveAccount()
if (!acct?.backend) {
  console.error(`[open-login] ${isNew ? `config/platforms.json 里没有平台「${argPlatform}」` : `config/accounts.json 里没有 key=${argPlatform} 或它没登记 backend 地址`}`)
  process.exit(1)
}

let task
try {
  say('开浏览器', '正在开浏览器窗口')
  task = await openSpace('media-hub 账号授权')
} catch (e) {
  // 浏览器都开不出来，后面什么都不会发生。原因写在最后一行：
  // ego 抛完还会追一段栈，界面只留尾巴几行，那句报错会被栈挤掉（2026-10-23 实测误判成「太慢」）
  console.log(JSON.stringify({ ok: false, error: `开不出浏览器：${String(e?.message || e)}` }))
  process.exit(1)
}
/** ego 的硬停原文是一大段带示例代码的说明（空间被人接管时脚本一条浏览器命令都不许发），
 *  原样摆到界面只会盖掉真正的原因，所以翻成一句人话，原文另存 `why` 供留痕查。 */
const egoPaused = (e) => {
  const s = String(e?.message || e)
  return /Control of this task space is with the user/i.test(s)
    ? '浏览器把这个标签空间交到人手里了，脚本一动就停：在 Ego Lite 里把这个空间交还给脚本，再点一次「去授权」'
    : s.split('\n')[0]
}
let reused
try {
  reused = (await task.pages()).find((p) => p.label === 'p1')
} catch (e) {
  // 空间刚接手就发不出命令 = 控制权还在人手里，后面什么都不会发生，别让人对着「正在搬二维码」干等
  console.log(JSON.stringify({
    ok: false, platform: acct.platform, account: acct.key, error: egoPaused(e),
    why: String(e?.message || e).split('\n')[0], space: task.spaceId, ownership: String(task.ownership || ''),
  }))
  process.exit(1)
}
const page = reused || (await task.newPage())
say('开页面', reused ? '接着用上次那张标签页' : '新开一张标签页')

/** 页面自己弹出的 JS 提示框会挡住一切 evaluate：CDP 直接抛 PageDialogOpenedError，
 *  旧版 cropFrame 没接这个错，整趟授权当场崩退（exit=1）——而且崩在循环半路，罐子还是清空状态，
 *  等于顺手把这台浏览器上的主号弄丢（2026-10-23 小红书风控「浏览器异常，请尝试关闭/卸载风险插件或重启试试」实测）。
 *  替人把这个框收掉不碰验证码，也不判它代表什么：风控真把登录页挡死了，下一轮照样抠不到码，
 *  由界面那句人话收尾。框里的原文只留最近一句，用来给界面报「平台弹了个提示」。 */
let dialogNote = ''
/** 这一轮有没有碰上框：只有当下这一轮算数。dialogNote 会一直留着（报给人看），
 *  拿它当「还在被挡」的依据会把一次关掉的框误判成三轮连挡，好端端等着扫码也被掐停。 */
let dialogHit = false
const dialogOf = (e) => (String(e?.message || e).match(/JavaScript \w+ dialog \("([^"]*)"\)/) || [])[1] || ''
const isDialogErr = (e) =>
  /Dialog/i.test(String(e?.name || '')) || /while a JavaScript|dialog (?:.* )?is open/i.test(String(e?.message || e))

/** 有没有框挡着，只能试着收一次——收掉了才算原来有（ego 没给「当前有没有对话框」这个查询口） */
async function closeDialog() {
  for (const m of ['dismissDialog', 'acceptDialog']) {
    try {
      await page[m]()
      return true
    } catch { /* 这个办法不存在，或当下根本没框 */ }
  }
  return false
}

/** 在页面里跑一段脚本；碰上「提示框挡路」先替人把框收掉再跑一次，跑不通才照旧抛。
 *  参数用 rest 传：没参数时一个字都不给（ego 的 evaluate 收到 undefined 会判「参数必须可 JSON 序列化」而整轮失败）。 */
async function evalPage(fn, ...args) {
  try {
    return await page.evaluate(fn, ...args)
  } catch (e) {
    if (!isDialogErr(e)) throw e
    dialogHit = true
    const said = dialogOf(e)
    if (said) dialogNote = said
    if (!(await closeDialog())) throw e
    return page.evaluate(fn, ...args)
  }
}

/** 提示框挡住 evaluate 时地址还读得到：Page.getNavigationHistory 走 Page 域，不碰 Runtime.evaluate。
 *  读不到就回空串，调用方自己退回文案判据。 */
async function cdpUrl() {
  try {
    const h = await page.cdp('Page.getNavigationHistory')
    const e = h?.entries?.[h?.currentIndex ?? -1]
    if (e?.url) return String(e.url)
  } catch { /* 页面在崩的边缘就没这条 */ }
  try {
    const t = await page.cdp('Target.getTargetInfo', { targetId: page.targetId })
    return String(t?.targetInfo?.url || '')
  } catch {
    return ''
  }
}

/** 同平台的其它号（不含本次授权的这个）：授权前要把罐里现在这位认下来，否则新号一扫码，
 *  平台原地顶掉旧登录态，旧的那个号就再也找不回来了。 */
const samePlatformAccts = JSON.parse(fs.readFileSync(`${ROOT}/config/accounts.json`, 'utf8'))
  .filter((a) => a.platform === acct.platform && a.key !== acct.key)
const samePlatformKeys = samePlatformAccts.map((a) => a.key)
const seed = await vault.seedCurrent(page, { platform: acct.platform, keys: samePlatformKeys, backend: acct.backend, root: ROOT })
const jarBefore = await vault.snapshotJar(page, { platform: acct.platform, backend: acct.backend, root: ROOT })

/** 后台自报「这台浏览器现在登的是谁」。page.fetch 走浏览器 CORS，所以人得先在那个平台的域里。
 *  判不出就返回 null（这个平台没有身份读数、改版、页面没起来）——授权照旧只判登录态在不在，
 *  宁可判不出，不许拿一句猜当闸把真扫进来的号拒之门外。 */
async function readWho() {
  if (!ident.hasIdentityReader(acct.platform)) return null
  const here = String(await page.url().catch(() => ''))
  if (!here.startsWith(new URL(acct.backend).origin)) {
    try {
      await page.goto(acct.backend, { waitUntil: 'domcontentloaded', timeout: 15000 })
    } catch { /* 重 SPA 首屏超时属常态，页面已提交就照读 */ }
  }
  try {
    const res = await page.fetch(ident.IDENTITY_URL[acct.platform])
    return ident.readIdentity(acct.platform, JSON.parse(res.body))
  } catch {
    return null
  }
}

/** 已有登录态时只开后台不绑码：`--open`。几秒完事，不进等扫码的循环。 */
const openOnly = process.argv.includes('--open')

/** 把动手前拍的那张快照还回罐子（无论这次扫成没扫成、从哪条路收工）。
 *  认主人：先按记录，记录没有就按值去库里对——对不上就清空主人栏，不冒名。 */
async function putBack() {
  try {
    // 还罐子路上也挂着提示框的话，本地存储那一格会静默写不进去（vault 里那几条 evaluate 只吞错）：
    // 先把框收掉再还，宁可多试一次
    await closeDialog().catch(() => {})
    const back = await vault.restoreJar(page, {
      platform: acct.platform,
      cookies: jarBefore.cookies,
      storage: jarBefore.storage,
      key: jarBefore.was || seed.seeded || vault.ownerOfCookies(acct.platform, jarBefore.cookies, samePlatformKeys, ROOT),
      backend: acct.backend,
      root: ROOT,
    })
    /** 快照是空的（动手前那一读没拍到东西）时不能就这么罢手：罐子刚被自己清过，
     *  留成空的等于把这台浏览器上这个平台的号全弄丢。退一步照本机库里那位主号还一套回去。 */
    if (!back.restored && !jarBefore.cookies.length) {
      for (const row of samePlatformAccts) {
        const lib = vault.readVaultFull(row.key, ROOT)
        if (!lib?.cookies?.length) continue
        const got = await vault.restoreJar(page, { platform: acct.platform, cookies: lib.cookies, storage: lib.storage, key: row.key, backend: acct.backend, root: ROOT })
        if (got.restored) return { ...got, from: '本机库', via: row.key }
      }
    }
    return back
  } catch (e) {
    return { restored: false, error: String(e?.message || e) }
  }
}

if (!openOnly) {
  /** 扫同平台的第二个号前，先把这个平台的登录态从罐子里清出去：罐里还住着主号时，登录页摆的是主号
   *  那一屏（甚至直接跳进主号后台），人拿二号手机扫上去，收进这个号库的还是主号——2026-10-23 那两个
   *  假库就是这么来的。一个平台只有一个号时不清：没什么可混，别动他正常的会话。 */
  say('清登录态', `要先清掉这台浏览器上的${acct.platform}登录态`)
  const cleared = samePlatformKeys.length > 0
    ? await vault.clearJar(page, { platform: acct.platform, backend: acct.backend, root: ROOT })
    : { dropped: 0, storage: 'none' }
  const cleaned = cleared.dropped > 0
  say('清登录态', cleaned ? `清了 ${cleared.dropped} 条 cookie，本地存储${cleared.storage === 'cleared' ? '也倒了' : '没动'}` : `罐里本来就没有${acct.platform}的 cookie`)
  try {
    await page.goto(acct.backend, { waitUntil: 'domcontentloaded' })
  } catch {
    // 后台是重 SPA，load 超时属常态；页面已提交就照留
  }
  /** 清了 cookie 后台还报得出人 = 那半条会话藏在本地存储里，把那个域名的本地存储也倒掉再进一次。
   *  两遍都还不干净就照实停手，别摆着一张主号的「一键登录」让人扫——扫完还是错的号。 */
  if (cleaned && await readWho()) {
    say('清登录态', '后台还报得出人，把本地存储也倒掉再进一次')
    await vault.clearSiteData(page, new URL(acct.backend).origin)
    try {
      await page.goto(acct.backend, { waitUntil: 'domcontentloaded' })
    } catch { /* 同上 */ }
    if (await readWho()) {
      const reason = `${acct.platform}这台浏览器清不掉登录态（后台还报得出人），先别扫：手动退出这个平台再试一次`
      say('停手', reason)
      await putBack()
      try {
        await task.finish({ keep: [page.label] })
      } catch {
        try { await task.finish({ keep: [] }) } catch { /* 页面已经没了 */ }
      }
      console.log(JSON.stringify({ ok: false, platform: acct.platform, account: acct.key, error: reason }))
      process.exit(1)
    }
  }
}

/** 还在登录页 = 地址落在 login/passport 上，或页面仍挂着扫码引导（抖音未登录是在原 URL 上浮二维码）。
 *  「微信扫一扫」是公众号点完页签后的弹层文案（2026-10-01 实测：那时「扫码登录」字样会消失），少一条就误判已登录。
 *  「扫描成功 / 请在…确认 / 确认登录」同样是堵漏项：手机扫完码后页面换成这张待确认浮层，
 *  旧词表一条都不命中，脚本会在人点确认前判已登录并把页关掉，登录链当场断（2026-10-01 实测踩中）。 */
const LOGIN_URL = /login|passport|signin|qrcode|qrconnect|sso/i
const LOGIN_TEXT = /扫码登录|手机号登录|APP扫码|请登录|立即登录|使用微信里扫一扫|微信扫一扫|登录后管理|绑定手机号|扫描成功|请在[^。]{0,8}确认|确认登录/

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 界面 → 脚本的唯一通道：本地服务把 raise/cancel 写进这个文件，脚本每轮取走一次 */
const SIGNAL = '/tmp/media-hub-login-signal'
/** 脚本 → 界面的通道：二维码 PNG 落这里，工作台弹层用 /__login-qr 轮询取（tmp+rename 防读到半张图） */
const QR_FILE = '/tmp/media-hub-login-qr.png'
const dropQr = () => { try { fs.unlinkSync(QR_FILE) } catch { /* 没有就删个空 */ } }
function writeQr(dataUrl) {
  try {
    fs.writeFileSync(`${QR_FILE}.tmp`, Buffer.from(String(dataUrl).replace(/^data:image\/\w+;base64,/, ''), 'base64'))
    fs.renameSync(`${QR_FILE}.tmp`, QR_FILE)
  } catch { /* 写不进去界面自会显示「没取到码」 */ }
}
dropQr() // 上一轮留下的码别被这次的弹层误显示

/** 从登录页里抠二维码：canvas 直接导 → data: 图直接用 → 同域图片 URL 页内 fetch 转 base64。
 *  尺寸限 90–400px 的方形图，避开 logo 和大图；跨域图会污染 canvas，取不到就交给 cropFrame。
 *  公众号实测（2026-10-01）：首页不摆码，要先点「扫码登录」页签，码才以同域 img（scanloginqrcode）出现；
 *  找不到码时顺手点一次这个页签，下一轮再取。 */
async function grabQr() {
  const top = await grabTopDocQr()
  if (top) return top
  // 码在跨域 iframe 里的平台（视频号 = open.weixin.qq.com/connect/qrconnect）顶层一个字都读不到，
  // 只能整块截。截出来的是登录控件当前那一屏：可能是二维码，也可能是「头像 + 微信快捷登录」，
  // 摆到弹层里人自己看得清。换哪一屏由界面上的按钮发信号，脚本不自己抢。
  return await cropFrame()
}

/** 取不到码时给界面一句「页面上到底有什么」：地址＋元素计数，一个 cookie 值都不带。
 *  没有这一句，弹层只能干摆「正在搬二维码」，人看不出是页面根本没到登录页，还是码抠不出来。 */
async function pageDiag() {
  const raw = String(await page.url().catch(() => ''))
  let at = raw
  try {
    const u = new URL(raw)
    at = `${u.host}${u.pathname}`.split('/').slice(0, 3).join('/').slice(0, 26)
  } catch { /* about:blank 之类，原样报 */ }
  const n = await evalPage(() => {
    const sq = (el) => {
      const r = el.getBoundingClientRect()
      return r.width >= 90 && r.width <= 400 && r.height >= 90 && r.height <= 400
    }
    return {
      canvas: [...document.querySelectorAll('canvas')].filter(sq).length,
      img: [...document.querySelectorAll('img')].filter(sq).length,
      frame: document.querySelectorAll('iframe').length,
      chars: (document.body?.innerText || '').trim().length,
    }
  }).catch(() => null)
  return n ? `${at}｜画布${n.canvas} 方图${n.img} 内嵌${n.frame} 正文${n.chars}字` : `${at}｜页面读不到`
}

/** 把页面上那块「接近方形」的 iframe 整块截下来当码用。
 *  跨域只挡住读它的内容，挡不住量它的位置——iframe 元素本身在顶层文档里。
 *  只认接近方形的，免得把页面里的广告 iframe 当成码摆进弹层；scale 2 才扫得清。 */
async function cropFrame() {
  const box = await evalPage(() => {
    let best = null
    for (const f of document.querySelectorAll('iframe')) {
      const r = f.getBoundingClientRect()
      if (r.width < 90 || r.height < 90) continue
      if (Math.abs(r.width - r.height) > r.width * 0.35) continue
      if (best && r.width * r.height <= best.area) continue
      best = { el: f, area: r.width * r.height }
    }
    if (!best) return null
    best.el.scrollIntoView({ block: 'center' })
    const q = best.el.getBoundingClientRect()
    return { x: Math.round(q.x), y: Math.round(q.y), width: Math.round(q.width), height: Math.round(q.height) }
  })
  if (!box) return null
  try {
    const shot = await page.cdp('Page.captureScreenshot', { format: 'png', clip: { ...box, scale: 2 } }, { timeout: 5000 })
    return shot?.data ? `data:image/png;base64,${shot.data}` : null
  } catch {
    return null // 页面在导航，下一轮再截
  }
}

async function grabTopDocQr() {
  try {
    return await evalPage(async () => {
      const square = (el) => {
        const r = el.getBoundingClientRect()
        return r.width >= 90 && r.width <= 400 && r.height >= 90 && r.height <= 400
      }
      const scan = async () => {
        for (const c of document.querySelectorAll('canvas')) {
          if (!square(c) || c.width < 90) continue
          try { const d = c.toDataURL('image/png'); if (d.length > 2000) return d } catch { /* 污染了，换下一个 */ }
        }
        const imgs = [...document.querySelectorAll('img')].filter(square)
        for (const im of imgs) if (im.src.startsWith('data:image')) return im.src
        for (const im of imgs) {
          if (!/^https?:/.test(im.src) || !/qr|code|scan/i.test(im.src)) continue
          try {
            const blob = await (await fetch(im.src, { credentials: 'include' })).blob()
            if (!/^image\//.test(blob.type)) continue
            const d = await new Promise((res, rej) => {
              const r = new FileReader()
              r.onload = () => res(r.result)
              r.onerror = rej
              r.readAsDataURL(blob)
            })
            if (String(d).length > 2000) return d
          } catch { /* 跨域取不了 */ }
        }
        return null
      }
      const hit = await scan()
      if (hit) return hit
      const tab = [...document.querySelectorAll('a,button,span,div')].reverse()
        .find((e) => (e.textContent || '').trim() === '扫码登录' && e.getBoundingClientRect().width > 0)
      if (tab) tab.click()
      else if (!/扫一扫|扫码登录/.test(document.body?.innerText || '')) {
        // 小红书创作平台的登录卡默认是「短信登录」那一屏，码藏在卡右上角一个没有文字的角标后面
        // （实测 64x64 图、cursor:pointer，点完标题变「APP扫一扫登录」并长出 160x160 的码）。
        // 只认文字「扫码登录」的旧逻辑永远点不到它，于是界面一直卡在「正在搬二维码」（2026-10-23 装机版授权全废的真因）。
        // 只在还停在短信那一屏时点一次，切成扫码后条件不成立，不会来回 toggle。
        const badge = [...document.querySelectorAll('img,svg,i,use')]
          .find((e) => {
            const b = e.getBoundingClientRect()
            return b.width >= 24 && b.width <= 90 && b.height >= 24 && b.height <= 90 && getComputedStyle(e).cursor === 'pointer'
          })
        if (badge) { badge.click(); badge.parentElement?.click?.() }
      }
      return await scan()
    })
  } catch {
    return null // 页面在导航，下一轮再取
  }
}
function takeSignal() {
  try {
    const v = fs.readFileSync(SIGNAL, 'utf8').trim()
    fs.unlinkSync(SIGNAL)
    return v
  } catch {
    return ''
  }
}
/** 人在界面上按了「停止」：服务端把本轮任务 key 写进停止信号文件，这里每一轮自取一次。
 *  跟弹层里那颗「取消」走同一条路（都不点任何东西、照常还罐子），区别只在界面报哪句话。 */
const stopPressed = () => sync.stopRequested()

function raise() {
  try {
    cp.execFileSync('/usr/bin/open', ['-a', 'ego lite'])
    return true
  } catch {
    return false /* 非 macOS 或找不到 App */
  }
}
/** 只看地址栏不够：抖音的二维码是浮在原 URL 上的模态，得连页面文案一起判。判断放进页面里，只回一个布尔。
 *  正文没渲染（空白/极短）也算「还在登录页」——2026-10-01 实测后台标签渲染慢，
 *  空 body 上正则不命中会被误判成已登录，脚本 2.5 秒就假收工。 */
async function stillAtLogin() {
  if (LOGIN_URL.test(String(await page.url().catch(() => '')))) return true
  try {
    return await evalPage(
      (src) => {
        const t = (document.body?.innerText || '').trim()
        if (t.length < 50) return true
        return new RegExp(src).test(t)
      },
      LOGIN_TEXT.source,
    )
  } catch {
    return true // 页面还在导航，下一轮再读
  }
}
/** 「打开后台」那一趟要分清三种屏：还在登录页 / 确实进了后台 / 首屏还没渲染出来。
 *  stillAtLogin 把「空白」和「登录页」并成一类（扫码那一趟宁可多等），这里得各走各的判法。 */
async function loginPageState() {
  if (LOGIN_URL.test(String(await page.url().catch(() => '')))) return 'login'
  try {
    return await evalPage(
      (src) => {
        const t = (document.body?.innerText || '').trim()
        if (t.length < 50) return 'blank'
        return new RegExp(src).test(t) ? 'login' : 'ok'
      },
      LOGIN_TEXT.source,
    )
  } catch {
    return 'blank' // 页面还在导航
  }
}

/** 人把标签页关了以后 evaluate 会一直抛错，不能当成「还没登录」空等到超时。
 *  只认 targetId：标签名会落到别的标签上，按名判等于永远判不出关页（实测关掉后 tabs() 里查不到这个 id）。 */
const TARGET = page.targetId
let unreadable = 0
async function pageAlive() {
  try {
    const ok = (await task.tabs()).some((t) => t.targetId === TARGET)
    unreadable = 0
    return ok
  } catch {
    // 整个任务空间被关掉时 tabs() 会一直抛；连抛三轮按关页收工，别空等到超时
    return ++unreadable < 3
  }
}

/** 已登录的号点「打开后台」走这一趟：把这个号的登录态换进浏览器 → 打开后台 → 认出不是登录页就收工。
 *  不进等扫码的循环、不抠二维码（那一趟起步 20 秒，看一眼后台不该等它）。 */
if (openOnly) {
  const t0 = Date.now()
  /** 'open' 后台确实打开着 / 'need-scan' 停在登录页，得扫码 / 'slow' 首屏没渲染完，页面照样留着 */
  let outcome = 'open'
  const swap = await vault.useAccount(page, { key: acct.key, platform: acct.platform, backend: acct.backend, root: ROOT })
  // 同平台还有别的号，可这个号本机没存过登录态：罐子里此刻是谁完全说不准，不能当他已登录
  if (swap.applied === 'unstored' && samePlatformKeys.length) outcome = 'need-scan'
  if (outcome === 'open') {
    try {
      await page.goto(acct.backend, { waitUntil: 'domcontentloaded', timeout: 15000 })
    } catch { /* 重 SPA 首屏超时属常态，页面已提交就照留 */ }
    outcome = 'slow'
    for (let i = 0; i < 5 && outcome === 'slow'; i++) {
      await sleep(2000)
      const s = await loginPageState()
      if (s === 'login') outcome = 'need-scan'
      else if (s === 'ok') outcome = 'open'
    }
  }
  // 换进去的那套 cookie 到底是谁的，问一句平台后台：2026-10-23 那趟授权把主号的会话存成了
  // 第二个号的库，于是「晓丸子君」这一行点开的是醒醒老己的后台，界面还写着已登录。
  let reason = ''
  if (outcome === 'open') {
    const who = await readWho()
    if (ident.identityVerdict(acct, who) === 'mismatch') {
      outcome = 'wrong-account'
      reason = ident.identityMismatchError(acct, who, samePlatformAccts)
    }
  }
  // 页面留着、罐子也留着：他点这一行就是要看这个号的后台，把登录态换回去等于把这一页顶成别人的号。
  // 下一趟采集/推草稿各自按号换气，不怕浏览器停在哪一位。
  try {
    await task.finish({ keep: [page.label] })
  } catch {
    try { await task.finish({ keep: [] }) } catch { /* 页面已经没了，交不回收尾不影响后台是否打开 */ }
  }
  console.log(JSON.stringify({
    ok: true, mode: 'open', platform: acct.platform, account: acct.key, url: acct.backend,
    outcome, jar: swap.applied, ...(reason ? { reason } : {}), seconds: Math.round((Date.now() - t0) / 1000),
  }))
  process.exit(0)
}

takeSignal() // 上一轮没取走的信号别带到这一次
// 二维码摆在工作台弹层里，默认不抢前台。登录页在后台标签里定时器会被 Chrome 掐慢
// （扫码成功后靠页面自己轮询换登录态），用 focus 仿真让它以为一直在前台。
try { await page.cdp('Emulation.setFocusEmulationEnabled', { enabled: true }) } catch { /* 不支持就认了 */ }

/** 替人点登录控件里的一个按钮（视频号那屏在跨域 iframe 里，locator 会自动搜进帧）。
 *  只在这两种时候发生：人在弹层里点了「用这个微信号登录」，或点了「改用其他微信扫码」。 */
async function clickLoginButton(text) {
  try {
    await page.click(`text=${text}`, { timeout: 2000, label: `点「${text}」` })
    return true
  } catch {
    return false /* 这一屏没有这个按钮 */
  }
}

// 拉前台只发生在两种时刻：开头连几轮取不到二维码（跨域 iframe 之类，退化成老路子），
// 以及人自己点「重新弹出」时；工作台本身就是 Ego Lite 里的一个标签页，反复拉等于抢他的前台。
// 等待上限 135 秒：连开页面一起必须落在服务端任务超时之内，否则脚本会被从外面掐死（没输出、退出码 1）
const DEADLINE = Date.now() + 135_000
let outcome = 'timeout'
let raised = false
let qrMissed = 0
/** 这张跑里到底有没有把码搬进弹层过：一次都没有就说明人根本没机会扫，
 *  此时「页面不像登录页」多半是抖音那种未登录也带读数的后台首页，不能当登录成功（见下面的身份复核）。 */
let qrShown = false
/** 平台弹出的提示框连着挡住 evaluate 的轮数：到三轮就收手报人话，别空等到超时 */
let dialogRounds = 0
// 判「登录完成」要连中两轮（约 5 秒）：文案判据单轮命中多半是改版/措辞漂移，不是真登进去了
let loggedRounds = 0
say('搬二维码', '进了登录页，正在抠二维码')
/** 循环里的意外（风控弹窗收不掉、页面自己崩、ego 抽风）一律接住：
 *  旧版让它冒到进程外，罐子留在清空状态、界面只能报「脚本没回话」——两样都是最坏结果。
 *  接住后照常走还罐子那段，界面上报的是那句具体原因。 */
let loopErr = ''
try {
  for (;;) {
    await sleep(2500)
    const sig = takeSignal()
    if (sig === 'cancel' || stopPressed()) { outcome = 'cancelled'; break }
    if (sig === 'raise') {
      raised = true
      raise()
      try { await page.cdp('Page.bringToFront') } catch { /* 拉不到前台继续等 */ }
    }
    // 「微信快捷登录」是视频号那一屏的按钮名，登完直接跳后台；换成「使用其他…」就出二维码。
    // 两个按钮名各自只在一屏上出现，所以点错屏只会静默失败。
    if (sig === 'quick') await clickLoginButton(acct.quickLogin || '微信快捷登录')
    if (sig === 'swap') await clickLoginButton('使用其他头像、昵称或账号')
    dialogHit = false
    const qr = await grabQr()
    if (qr) { writeQr(qr); qrShown = true } // 页面约 70 秒自己换一次码，每轮都搬最新的
    else {
      ++qrMissed
      // 平台弹了提示框（小红书风控那句「浏览器异常…」）已经替他关掉了，界面得报这一句：
      // 这多半是登录页被挡死，不关一句「没抠到码」的事，人要的是知道现在卡在哪
      const why = dialogHit ? `平台弹了提示框「${dialogNote}」，已替他关掉` : `第 ${qrMissed} 轮没抠到码 · ${await pageDiag()}`
      say('搬二维码', why, qrMissed)
      if (qrMissed === 4 && !raised) {
        raised = true
        say('搬二维码', dialogHit ? `${dialogNote} · 把浏览器拉到前台，这一屏要你自己看一眼` : '连着四轮抠不到码，把浏览器拉到前台')
        raise()
        try { await page.cdp('Page.bringToFront') } catch { /* 拉不到前台继续等 */ }
      }
    }
    if (!dialogHit) dialogRounds = 0
    else if (++dialogRounds === 6) {
      // 连着六轮（约 15 秒）页面都被提示框挡着、码也搬不出来：这不是慢，是登录页被平台锁了。
      // 在此之前一直等：人可能正拿手机扫那张已经摆出来的码，扫码成功了脚本还能从地址那一跳认出来。
      outcome = 'blocked-by-dialog'
      break
    }
    if (!(await pageAlive())) { outcome = 'closed'; break }
    /** 判登录没成看页面像不像登录页。提示框挡着 evaluate 时这条路是瞎的，
     *  但地址还在：人扫完码页面自己跳进后台，这一跳 CDP 的 target 信息读得到（它不走 Runtime.evaluate）。
     *  只认地址时少了文案判据（抖音那种在原 URL 上浮码的会误判），所以只在被挡住的那几轮退这一步。 */
    const blockedHref = dialogHit ? ((await cdpUrl()) || String(await page.url().catch(() => ''))) : ''
    const atLogin = dialogHit && blockedHref ? LOGIN_URL.test(blockedHref) : await stillAtLogin()
    if (atLogin) loggedRounds = 0
    else if (++loggedRounds >= 2) {
      // 没扫上号的抖音后台首页照样挂着「画布N 正文N字」这种读数，文案判据会把它当成「已经登进去了」，
      // 于是脚本提前收工、人那边只看到弹层一直在搬二维码。码从没摆出来过就不信这一句，改问后台自报的是谁。
      // 没有身份读数的平台（公众号/快手/视频号）照旧：只认页面形态，别把这段等成死等。
      if (qrShown || !ident.hasIdentityReader(acct.platform)) { outcome = 'logged'; break }
      const who = await readWho().catch(() => null)
      if (who) {
        say('看页面', `后台自报是 ${who.nickname}，按已登录收尾`)
        outcome = 'logged'
        break
      }
      loggedRounds = 0
      say('看页面', '页面不像登录页，但这台浏览器还没登着任何号 · 继续等扫码')
    } else if (loggedRounds === 1) say('看页面', '页面不像登录页，再确认一轮')
    if (Date.now() > DEADLINE) break
  }
} catch (e) {
  loopErr = egoPaused(e)
  outcome = 'crashed'
}

/** 登录页被平台的提示框锁住以后，脚本就不再动它了（每关一次它又弹一次，越动越糟），
 *  但那张已经摆进弹层的码照样能用：人扫完、手机点确认，页面自己跳进后台，这一跳从地址读得到
 *  （Page.getNavigationHistory 不碰 Runtime.evaluate，所以提示框挡不住它）。
 *  这时候撤走二维码等于把已经到手的登录机会掐了，所以这段静默等待里 dropQr 还没执行。
 *  150 秒：小红书那张码约 70 秒自己过期，再等下去只是让他盯一张失效的图。 */
if (outcome === 'blocked-by-dialog') {
  const until = Date.now() + 150_000
  say('等你扫码', `${dialogNote ? `平台弹了提示框「${dialogNote}」，脚本不再动这一屏 · ` : ''}直接在浏览器窗口里用手机扫那张码，登进去自动收工`)
  raise()
  try { await page.cdp('Page.bringToFront') } catch { /* 拉不到前台继续等 */ }
  while (Date.now() < until) {
    await sleep(3000)
    const sig = takeSignal()
    if (sig === 'cancel' || stopPressed()) { outcome = 'cancelled'; break }
    if (sig === 'raise' || sig === 'quick' || sig === 'swap') {
      raise()
      try { await page.cdp('Page.bringToFront') } catch { /* 拉不到前台继续等 */ }
    }
    if (!(await pageAlive())) { outcome = 'closed'; break }
    const href = (await cdpUrl()) || String(await page.url().catch(() => ''))
    if (!href || LOGIN_URL.test(href)) { loggedRounds = 0; continue }
    if (++loggedRounds >= 2) { outcome = 'logged'; break }
    say('等你扫码', '页面还没跳进后台，继续等', loggedRounds)
  }
}
dropQr() // 收工后别让下一张弹层误显示这张过期的码

let logged = outcome === 'logged'
let reason = ''
// 登录页被平台的提示框锁死：那句原因得人来看那一屏（循环里还不能赋值——reason 在这之后才声明）
if (outcome === 'blocked-by-dialog') {
  reason = `${acct.platform}的登录页反复弹「${dialogNote || '一个提示框'}」，脚本插不进去。请在 Ego Lite 那个窗口里手动点掉这个提示，或换个网络再点一次「去授权」`
}
/** 扫进来的是谁，一律问平台后台。两条路各自判法不同：
 *  · 给登记表上已有的一行绑码——读到的是别人（mismatch）或读不出是谁（这个平台有读数却空）都不入库，
 *    宁可让人重扫一次，也不能把主号的会话存成第二个号的库（2026-10-23 就是这么错的）。
 *  · `--new`（扫完才登记）——名字本来就出自后台，没有"对不上"这回事，只有两种拒绝：
 *    这个平台已经有同名号（不建重复行）、读不出是谁（不建无名行）。
 *  两种拒绝都不入库，但罐子照样还：他平时用这只浏览器看主号，收工不把人家门口换回来就是替他弄丢一个号。 */
let bound = null
if (logged) {
  await sleep(3000) // 登录换 cookie 的重定向链还在跑，早一拍收的是半套
  const who = await readWho()
  if (isNew) {
    if (!who) {
      logged = false
      outcome = 'identity-unknown'
      reason = `${acct.platform}的后台读不出这是哪个号（接口改版或这个平台还没有身份读数），先别扫：这一行要在界面上填名字登记`
    } else {
      const dup = ident.alreadyAuthorized(samePlatformAccts, who, acct.platform)
      if (dup) {
        logged = false
        outcome = 'already-authorized'
        reason = `这个号已经授权过了：${dup.platform}·${dup.nickname} 本机存着它的登录态，不用再扫一遍`
      } else {
        try {
          bound = acc.addAccount({ platform: acct.platform, nickname: who.nickname }, ROOT)
        } catch (e) {
          logged = false
          outcome = 'register-failed'
          reason = `号扫上了，但这一行没登记上：${String(e?.message || e)}`
        }
      }
    }
  } else {
    const verdict = ident.identityVerdict(acct, who)
    if (verdict === 'mismatch') {
      logged = false
      outcome = 'wrong-account'
      reason = ident.identityMismatchError(acct, who, samePlatformAccts)
    } else if (verdict === 'unknown' && ident.hasIdentityReader(acct.platform) && samePlatformAccts.length) {
      logged = false
      outcome = 'identity-unknown'
      reason = `后台没读出这是哪个号（改版或接口没返回），${acct.platform}本机还登记着别的号，这套登录态先不收——重扫一次，扫的是「${acct.nickname}」自己的码`
    }
  }
}
/** 扫成了就把这套登录态认下来存进本机的号库（`--new` 存进刚登记那一行的库）。
 *  扫错号、判不出、取消、关页、超时都不入库。 */
let stored = null
if (logged) {
  try {
    const got = await vault.adoptLogin(page, { key: bound ? bound.key : acct.key, platform: acct.platform, backend: acct.backend, root: ROOT })
    stored = { count: got.count, local: got.storage, seeded: seed.seeded || undefined }
  } catch (e) {
    stored = { error: String(e?.message || e) }
  }
}
/** 扫成功 + 这个平台只登记了这一个号：新登录态就留在浏览器里，不还旧罐（库里那份已经存好了）。
 *  还回去的是动手前那一套旧会话——微信那一类每个请求都在刷会话值，还回去的当场失效，
 *  下一轮体检读的就是这条死会话，于是「明明早就授权了」报成已失效（2026-11-04 公众号/视频号红点）。
 *  同平台还挂着别的号才还罐：那位的主人不是这个号，不能拿这套登录态顶他的名字。 */
const keepLive = logged && !samePlatformKeys.length
const back = keepLive ? { restored: false, storage: 'kept' } : await putBack()
stored = {
  adopted: logged, ...(keepLive ? { keptLive: true } : {}),
  restored: back.restored ?? false, backLocal: back.storage, snap: jarBefore.cookies.length,
  ...(back.via ? { backVia: back.via } : {}), ...(stored || {}),
}
// 取消和关页是他主动退出的，别在浏览器里留尾巴；其余（到点、判到已登录）都把页面留着——
// 判据万一早了半拍，登录换 cookie 的重定向链还在页面里跑，关掉标签就是掐断它（2026-10-01 实测）。
// keep 用 page.label 不用写死的 'p1'：复用旧页时它是 p1，新建的可能是 p2。
const keep = outcome === 'cancelled' || outcome === 'closed' ? [] : [page.label]
try {
  await task.finish({ keep })
} catch {
  try { await task.finish({ keep: [] }) } catch { /* 页面已经没了，交不回收尾也不影响结果 */ }
}

console.log(JSON.stringify({
  ok: true, platform: acct.platform, url: acct.backend, logged, outcome, stored,
  ...(bound ? { bound: { id: bound.id, key: bound.key, nickname: bound.nickname } } : {}),
  ...(reason ? { reason } : {}),
  ...(loopErr ? { error: loopErr } : {}),
}))
