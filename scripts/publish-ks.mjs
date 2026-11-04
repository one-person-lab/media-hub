/**
 * 快手图文「填单待人工发布」ego-browser 脚本（stdin 运行）
 *
 * 输入：/tmp/media-hub-publish.json → { title, lines[], tags[], imagesAbs[], coverAbs, accountKey, platform, spaceName? }
 * 流程：打开发布页 → 切「上传图文」→ 一次传全部图卡（等 N/31 计数就位）→ 填文案 + #话题 → 交接给人工
 * 实测（2026-09-22）：
 *  - 图文没有独立标题框，只有一个 contenteditable 的描述区（div[class*="_description"]），标题写进文案首行；
 *  - 传图 input 是隐藏的 accept*="image" 那个（multiple）；直接 setInputFiles 会静默失效，
 *    必须先点可见的「上传图片」把 input 挂上，传完用「N/31」计数确认（上限 31 张）；
 *  - **快手创作者平台没有图文草稿箱**：「取消」只给「继续编辑 / 放弃」，导航里也没有草稿入口。
 *    所以这个脚本的终点是「填完单、停在发布页、交给人」，绝不点「发布」——铁律在这里的实现方式。
 * 风控/验证码：识别到就等人工（240s），超时只报告并 handOff，绝不自动破解。
 */

const fs = await import('node:fs')
const payload = JSON.parse(fs.readFileSync('/tmp/media-hub-publish.json', 'utf8'))
// 根目录优先取宿主注入的 MEDIA_HUB_ROOT（run-ego / 服务端 spawn 都会写）：ego 内嵌 Node 不保证
// 跑在项目根，只认 process.cwd() 在装机版（数据目录带空格与中文）上会让动态 import 解析成坏 URL，
// 整版直接炸成 ERR_INVALID_FILE_URL_HOST（2026-10-23 实测）。cwd 只作兜底。
const ROOT = process.env.MEDIA_HUB_ROOT || process.cwd()
const { openSpace, guardJar } = await import(`${ROOT}/scripts/ego-space.mjs`)

const task = await openSpace(payload.spaceName || 'ks-publish')
const tabs = await task.tabs()
const reused = tabs.find((t) => t.label === 'p1') || tabs.find((t) => !t.label && /cp\.kuaishou\.com/.test(t.url))
const page = reused ? (reused.label ? reused.page : await task.adopt(reused.page, { as: 'p1' })) : await task.newPage()
// 同平台挂了几个号：开工前把浏览器罐子换成这个号的登录态，交还空间时自动换回（只有一个号则不动）
await guardJar(task, page, { accountKey: payload.accountKey, platform: payload.platform })
const log = (...a) => console.log('[ks-publish]', ...a)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 等条件成立再往下走：命中立刻返回，最多等 budget 毫秒（cond 抛错当作「还没好」） */
async function waitReady(cond, budget, step = 1000) {
  const deadline = Date.now() + budget
  for (;;) {
    // cond 同步抛错（页面正在跳转）也算「还没好」
    let hit = false
    try { hit = await cond() } catch { hit = false }
    if (hit) return true
    if (Date.now() >= deadline) return false
    await sleep(step)
  }
}

/** 第二参必须透传：配乐段要往页内函数里传 { wantT, wantA }，丢了参数就是解构 undefined，
 *  抛错被外层 catch 吞成一句「选曲抛错」，配乐整段跳过。显式传 undefined 会被 ego 入参校验拒绝，所以判一下。 */
async function safeEval(fn, arg) {
  const call = () => (arg === undefined ? page.evaluate(fn) : page.evaluate(fn, arg))
  try { return await call() } catch { await sleep(800); return await call() }
}

/** 风控/验证码是否挡路（须人工完成，脚本不破解） */
async function detectBlocker() {
  return safeEval(() => {
    if (!/验证码|安全验证|滑动完成|访问验证|异常行为/.test(document.body.innerText || '')) return false
    return !![...document.querySelectorAll('div')].find((d) => {
      const s = getComputedStyle(d)
      const r = d.getBoundingClientRect()
      return (s.position === 'fixed' || s.position === 'absolute') && +s.zIndex > 100 &&
        r.width > innerWidth * 0.3 && r.height > innerHeight * 0.25
    })
  }).catch(() => false)
}

async function waitCaptcha(label) {
  if (!(await detectBlocker())) return false
  log(`${label}：检测到验证/风控——请在 Ego Lite 里人工完成，最多等 240 秒…`)
  const deadline = Date.now() + 240000
  while (Date.now() < deadline) {
    await sleep(5000)
    if (!(await detectBlocker())) break
  }
  if (await detectBlocker()) {
    console.log(JSON.stringify({ ok: false, error: '等待验证超时。发布页已在 Ego Lite 打开，请人工完成后重试。', captchaWaited: true }))
    await task.handOff()
    process.exit(1)
  }
  log('验证已解除，继续')
  return true
}

// ---- 1. 打开发布页并确认登录（页面里有「退出登录」，不能用 /登录/ 判未登录） ----
await page.goto('https://cp.kuaishou.com/article/publish/video?publishType=video')
// 渲染完（创作台或登录墙）再判登录态，否则空页面会判成「未登录」白报
const rendered = await waitReady(() => safeEval(() =>
  /上传图文|发布作品|扫码登录|手机号登录|立即登录/.test(document.body?.innerText || '')), 25000, 800)
log('页面到位:', rendered)
const loggedIn = await safeEval(() => {
  const txt = document.body.innerText || ''
  return /上传图文|发布作品/.test(txt) && !/扫码登录|手机号登录|立即登录/.test(txt)
})
if (!loggedIn) {
  console.log(JSON.stringify({ ok: false, error: '快手创作者服务平台未登录，请先在 Ego Lite 登录 cp.kuaishou.com' }))
  await task.finish({ keep: ['p1'] })
  process.exit(1)
}

// ---- 2. 切「上传图文」tab，等图片 file input 就位 ----
/* 「发布作品」这个侧栏按钮比选项卡先渲染，所以 `rendered` 到位时选项卡常常还没长出来——
 * 点一次就判失败会偶发「没能切到上传图文」（实测 2026-10-21）。改成边点边等。 */
const clickImageTab = () => safeEval(() => {
  const els = [...document.querySelectorAll('div,span,li,button,a')].filter((e) => {
    const t = (e.innerText || '').trim()
    return t === '上传图文' && e.getBoundingClientRect().width > 0
  })
  if (!els.length) return false
  els[els.length - 1].click()
  return true
})
let hasImageInput = false
for (let i = 0; i < 8 && !hasImageInput; i++) {
  const tabClicked = await clickImageTab()
  if (i === 0) log('切「上传图文」:', tabClicked)
  await sleep(2500)
  hasImageInput = await safeEval(() =>
    [...document.querySelectorAll('input[type="file"]')].some((x) => /image|png|jpg|webp/i.test(x.accept) && x.multiple))
}
if (!hasImageInput) {
  console.log(JSON.stringify({ ok: false, error: '没能切到「上传图文」（页面可能改版）' }))
  await task.finish({ keep: ['p1'] })
  process.exit(1)
}

// ---- 3. 传图：多页图卡一次全传；上限 31 张，按「N/31」计数确认 ----
const images = (payload.imagesAbs?.length ? payload.imagesAbs : [payload.coverAbs]).filter((p) => p && fs.existsSync(p))
if (!images.length) {
  console.log(JSON.stringify({ ok: false, error: '缺少配图（imagesAbs/coverAbs），快手图文必须有图' }))
  await task.finish({ keep: ['p1'] })
  process.exit(1)
}
let captchaWaited = await waitCaptcha('传图前')
const readCounter = () => safeEval(() => +((document.body.innerText || '').match(/(\d+)\s*\/\s*31/) || [])[1] || 0)
/** 实测：只 setInputFiles 常静默失效（0/7），要先点可见的「上传图片」把 input 挂上；两次都没成就报失败 */
async function tryUpload() {
  await safeEval(() => {
    const vis = (e) => e.getBoundingClientRect().width > 0
    const b = [...document.querySelectorAll('button,div,span,a')].filter((e) => (e.innerText || '').trim() === '上传图片' && vis(e) && e.childElementCount === 0)
    ;(b[b.length - 1] || b[0])?.click()
  })
  await sleep(2500)
  await page.setInputFiles('input[type="file"][accept*="image"]', images)
  for (let i = 0; i < 8; i++) {
    await sleep(4000)
    const n = await readCounter()
    if (n >= images.length) return n
  }
  return readCounter()
}
let uploaded = await tryUpload()
if (uploaded < images.length) {
  log(`第 1 次只传进 ${uploaded}/${images.length}，重点「上传图片」再试一次`)
  uploaded = await tryUpload()
}
log(`图片上传: ${uploaded}/${images.length}`)
if (uploaded < images.length) {
  console.log(JSON.stringify({ ok: false, error: `图没传齐（${uploaded}/${images.length}），不填文案也不交接`, captchaWaited }))
  await task.finish({ keep: ['p1'] })
  process.exit(1)
}
captchaWaited = (await waitCaptcha('传图后')) || captchaWaited

// ---- 4. 填文案 + 话题（只有一个描述区，没有标题框） ----
const descSel = 'div[class*="_description"][contenteditable="true"]'
const focused = await safeEval(() => {
  const ed = document.querySelector('div[class*="_description"][contenteditable="true"]')
  if (!ed) return false
  ed.scrollIntoView({ block: 'center' })
  ed.focus()
  const sel = window.getSelection()
  const r = document.createRange()
  r.selectNodeContents(ed)
  r.collapse(false)
  sel?.removeAllRanges()
  sel?.addRange(r)
  return document.activeElement === ed || ed.contains(document.activeElement)
})
log('描述区聚焦:', focused)
if (!focused) {
  console.log(JSON.stringify({ ok: false, error: `找不到图文描述区（${descSel}），页面可能改版`, captchaWaited }))
  await task.finish({ keep: ['p1'] })
  process.exit(1)
}
const descText = () => safeEval(() => document.querySelector('div[class*="_description"][contenteditable="true"]')?.innerText || '')
/** 传完 7 张图后主线程容易卡，CDP Input.* 会 30s 超时；超时不等于没写进去，先核现状再剪贴板兜底 */
async function insertOrPaste(text) {
  if (!text) return
  try {
    await page.keyboard.insertText(text)
  } catch (e) {
    log(`insertText 超时（${String(e.message).split('\n')[0]}），核对描述区`)
  }
  await sleep(500)
  if ((await descText()).includes(text.slice(-14))) return
  log('内容未落进描述区，改用剪贴板粘贴')
  await page.keyboard.paste(text)
  await sleep(800)
}
async function pressEnter() {
  try { await page.keyboard.press('Enter') } catch { await page.keyboard.paste('\n').catch(() => {}) }
}
for (let i = 0; i < payload.lines.length; i++) {
  await insertOrPaste(payload.lines[i])
  if (i < payload.lines.length - 1) await pressEnter()
}
if (payload.tags?.length) {
  await pressEnter()
  await insertOrPaste(payload.tags.join(' '))
}
await sleep(600)
await page.keyboard.press('Escape').catch(() => {})  // 关话题联想，别盖住后面的操作

// ---- 5. 核验：图齐 + 文案齐，才交给人工 ----
const final = await safeEval(() => ({
  counter: +((document.body.innerText || '').match(/(\d+)\s*\/\s*31/) || [])[1] || 0,
  descLen: (document.querySelector('div[class*="_description"][contenteditable="true"]')?.innerText || '').length,
}))
const filled = final.counter >= images.length && final.descLen > 0
if (!filled) {
  console.log(JSON.stringify({ ok: false, error: '填单未完成（图片或文案没就位），不交接', final, captchaWaited }))
  await task.finish({ keep: ['p1'] })
  process.exit(1)
}

// ---- 5.5 配乐：默认曲见 config/publish-music.json（payload.music）。曲库里认不出那首就跳过，绝不退而选别的 ----
/* 实测（2026-10-21 探测，传完 16 张图之后才有这一行）：
 *  - 入口是「添加音乐」行右侧那个 pointer 叶子；字段标题本身也叫「添加音乐」，`text="添加音乐"` 会点错，
 *    所以按 cursor:pointer + 最靠右来认按钮；
 *  - 抽屉在页面右侧，搜索框 placeholder 正好是「搜索音乐」；
 *  - 结果行是 [class*="_item_"]，曲名叶子是 [class*="_info-title"]，行文本形如「III(Find Yourself) 06:10 Athletics」；
 *    列表里有 4 条同名近似曲（III 06:10 Athletics、III (超燃bgm)、III(speed up)…），必须歌名+歌手一起认；
 *  - 行内「添加」按钮只在鼠标悬停到该行时才浮出，所以先 move 过去再点，且只在行矩形内找，别点到场外的「添加」。 */
let music = { want: payload.music?.title || '', applied: false, note: '' }
if (payload.music) {
  const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9一-龥]/g, '')
  const wantT = norm(payload.music.title)
  const wantA = norm(payload.music.author)
  /** 认目标曲目行；scroll=true 时先滚到视野中央（列表能滚，视口外的行悬停不到） */
  const findRow = (scroll) => safeEval(({ wantT, wantA, scroll }) => {
    const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9一-龥]/g, '')
    const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 }
    for (const e of document.querySelectorAll('[class*="_info-title"]')) {
      if (!vis(e) || !norm(e.innerText || '').includes(wantT)) continue
      const item = e.closest('[class*="_item_"]')
      if (!item || (wantA && !norm(item.innerText || '').includes(wantA))) continue
      if (scroll) item.scrollIntoView({ block: 'center' })
      const r = item.getBoundingClientRect()
      return { rowText: (item.innerText || '').replace(/\s+/g, ' ').slice(0, 60), x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }
    }
    return null
  }, { wantT, wantA, scroll })
  try {
    const readEntry = (scroll) => safeEval(({ scroll }) => {
      const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 }
      const b = [...document.querySelectorAll('*')].filter((e) => e.childElementCount === 0 && vis(e)
        && (e.innerText || '').trim() === '添加音乐' && getComputedStyle(e).cursor === 'pointer')
      if (!b.length) return null
      // 字段标题在左、按钮在右；填完文案时这一行往往还在视口外，mouse.click 用的是视口坐标，必须先滚进来
      const el = b.map((e) => ({ e, r: e.getBoundingClientRect() })).sort((p, q) => q.r.x - p.r.x)[0]
      if (scroll) el.e.scrollIntoView({ block: 'center' })
      const r = el.e.getBoundingClientRect()
      return { cx: Math.round(r.x + r.width / 2), cy: Math.round(r.y + r.height / 2) }
    }, { scroll })
    let entry = await readEntry(true)
    if (entry) { await sleep(900); entry = await readEntry(false) }   // 滚动落定后再取一次坐标
    if (!entry) {
      music.note = '页面上没有可点的「添加音乐」按钮（图没传上就没有这一行）'
    } else {
      await page.mouse.click(entry.cx, entry.cy, { label: '打开选曲抽屉' })
      await sleep(4000)
      const search = await safeEval(() => {
        const i = [...document.querySelectorAll('input')].find((x) => /^搜索音乐/.test(x.placeholder || '') && x.getBoundingClientRect().width > 0)
        return i ? Math.round(i.getBoundingClientRect().x) : 0
      })
      if (!search) {
        music.note = '没打开选曲抽屉（找不到「搜索音乐」输入框）'
      } else {
        await page.fill('input[placeholder="搜索音乐"]', payload.music.query)
        await sleep(800)
        await page.keyboard.press('Enter')
        await sleep(5000)
        let row = await findRow(true)
        if (row) { await sleep(900); row = await findRow(false) }   // 滚动落定后再取一次坐标
        if (!row) {
          music.note = `曲库搜索结果里没有「${payload.music.title}」`
        } else {
          await page.mouse.move(row.x + Math.round(row.w / 2), row.y + Math.round(row.h / 2))
          await sleep(1200)
          const add = await safeEval(({ x, y, w, h }) => {
            const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 }
            const b = [...document.querySelectorAll('button,div,span,a')].find((e) => e.childElementCount === 0 && vis(e) && (e.innerText || '').trim() === '添加'
              && (() => { const r = e.getBoundingClientRect(); return r.x >= x && r.x <= x + w && r.y >= y && r.y <= y + h })())
            if (!b) return null
            const r = b.getBoundingClientRect()
            return { cx: Math.round(r.x + r.width / 2), cy: Math.round(r.y + r.height / 2) }
          }, row)
          if (!add) {
            music.note = `悬停到「${row.rowText}」这一行，没浮出行内「添加」按钮`
          } else {
            await page.mouse.click(add.cx, add.cy, { label: '点行内「添加」配乐' })
            await sleep(4000)
            // 配上乐之后：左侧表单的「添加音乐」行变成曲目名 + 播放条 + 「更换音乐/删除」。
            // 抽屉里那些同名行在右侧，所以只认 x 小于抽屉左沿的叶子；「更换音乐」是只有真配上才有的一句话。
            const landed = await safeEval(({ wantT, drawerX }) => {
              const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9一-龥]/g, '')
              const vis = (e) => e.getBoundingClientRect().width > 0
              const leaf = [...document.querySelectorAll('*')].find((e) => e.childElementCount === 0 && vis(e)
                && norm(e.innerText || '').includes(wantT) && e.getBoundingClientRect().x < drawerX)
              return { applied: !!leaf && /更换音乐/.test(document.body.innerText || ''), row: leaf ? (leaf.innerText || '').trim().slice(0, 40) : '' }
            }, { wantT, drawerX: search })
            music.applied = landed.applied
            music.note = landed.applied ? landed.row : `点完「添加」配乐栏没换成目标曲：${landed.row}`
          }
        }
      }
    }
  } catch (e) {
    music.note = `选曲抛错：${String(e.message || e).slice(0, 80)}`
  }
  log('配乐:', JSON.stringify(music))
  // 实测点「添加」后抽屉自己关；万一没关，Escape 兜一下别让它盖住后面的操作
  await page.keyboard.press('Escape').catch(() => {})
  await sleep(600)
}

console.log(JSON.stringify({
  ok: filled,
  filled,
  images: { want: images.length, got: final.counter },
  descLen: final.descLen,
  captchaWaited,
  music,
  next: '快手图文没有网页草稿箱：内容已全部填在发布页上，页面已交给你。请人工核对后点「发布」——脚本按铁律不会替你点。',
}, null, 2))
log('截图:', await page.screenshot({ path: '/tmp/ks-autopublish-draft.png' }).catch(() => '截图超时'))
await task.handOff()
