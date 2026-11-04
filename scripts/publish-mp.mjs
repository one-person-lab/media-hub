/**
 * 公众号「贴图（图片消息）存草稿」ego-browser 脚本（stdin 运行）
 *
 * 输入：/tmp/media-hub-publish.json → { title, lines[], imagesAbs[], coverAbs, weapp?, accountKey, platform, spaceName? }
 * 流程：mp 首页取 token → 直达贴图编辑器 → 逐张传图卡 → 填标题/描述 → 点「保存为草稿」→ 用草稿计数核对
 * 实测（2026-09-23，号「醒醒老己App」）：
 *  - 公众号发的是**贴图不是长文**：贴图 = `type=10&createType=8`，直达这个 URL 就能开编辑器，不必点「新的创作」菜单；
 *    注意别用 /cgi-bin/home 判登录——旧 token 会返回「请重新登录」，根域名 mp.weixin.qq.com 才会跳到带新 token 的首页；
 *  - 编辑器里没有 #title/#js_description 那套图文字段，只有两个 ProseMirror：
 *    `.title-editor__input .ProseMirror`（标题，上限 20 字）和 `.share-text__input .ProseMirror`（描述，上限 1000 字）；
 *  - 传图必须打 `input[type=file]` 里 accept 含 bmp 的那个（贴图专用，multiple）；另一个 accept 含 svg 的是图文正文的，
 *    喂它静默失效。要注意编辑器每次传完一张就会多挂一个这样的隐藏 input，选择器会 matching 到多个 → 逐张传、每张先打唯一 id。
 *    传成功的判据见下面第 3 步注释（2026-10-31 平台换了图床域名、缩略图条改懒渲染，两个旧判据都废了）。
 *  - 贴图没有 #话题；
 *  - 引流落点：贴图编辑器的「链接」栏（占位「支持添加内容链接、小程序、小店商品」）→ 点小字弹菜单选「小程序」
 *    → 「插入小程序」弹窗把口令 `#小程序://昵称/token` 填进「小程序链接」框（placeholder 含「粘贴到此处」；
 *    JS 直接设 value 不触发校验、「确定」会一直禁用；2026-10-31 起 keyboard.paste 也失效了，
 *    走 keyboard.insertText 逐字输入才算真输入 → 点「确定」挂卡片；
 *    口令来自 config/targets 的 landing.byPlatform.公众号，由 prepareXhsPublish 以 payload.weapp 单传；
 *  - 存证：`appmsg?action=list_card&f=json&ajax=1` 里 `draft_type_cnt` 中 `item_show_type==8` 的计数，存前存后各读一次。
 * 铁律：**绝不点击「发表/群发」** —— 只存草稿，最后一下由人完成。
 */

const fs = await import('node:fs')
// 入参可用 `--payload <路径>` 换一份参数文件。默认 /tmp/media-hub-publish.json 是**全平台共用的约定路径**，
// 工作台（另一路可能正在推别的稿）和人手动推同一秒时会互相盖掉——2026-10-31 实测过一次：
// 脚本读到的是另一篇稿的参数，于是把别人的稿存进了草稿箱。要并行就跑独立路径。
// run-ego 用 process.argv.push 注入参数，slice(2) 会把它们切掉——只在全量 argv 里找
const argv = process.argv
const pi = argv.indexOf('--payload')
const PAYLOAD_PATH = pi >= 0 && argv[pi + 1] ? argv[pi + 1] : '/tmp/media-hub-publish.json'
const payload = JSON.parse(fs.readFileSync(PAYLOAD_PATH, 'utf8'))
// 根目录优先取宿主注入的 MEDIA_HUB_ROOT（run-ego / 服务端 spawn 都会写）：ego 内嵌 Node 不保证
// 跑在项目根，只认 process.cwd() 在装机版（数据目录带空格与中文）上会让动态 import 解析成坏 URL，
// 整版直接炸成 ERR_INVALID_FILE_URL_HOST（2026-10-23 实测）。cwd 只作兜底。
const ROOT = process.env.MEDIA_HUB_ROOT || process.cwd()
const { openSpace, guardJar } = await import(`${ROOT}/scripts/ego-space.mjs`)

const task = await openSpace(payload.spaceName || 'mp-publish')
const tabs = await task.tabs()
const reused = tabs.find((t) => t.label === 'p1') || tabs.find((t) => !t.label && /mp\.weixin\.qq\.com/.test(t.url))
const page = reused ? (reused.label ? reused.page : await task.adopt(reused.page, { as: 'p1' })) : await task.newPage()
// 同平台挂了几个号：开工前把浏览器罐子换成这个号的登录态，交还空间时自动换回（只有一个号则不动）
await guardJar(task, page, { accountKey: payload.accountKey, platform: payload.platform })
const log = (...a) => console.log('[mp-publish]', ...a)
log('参数文件:', PAYLOAD_PATH, '→', payload.title, `(${payload.imagesAbs?.length || 0} 图)`)
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

/** 注意：evaluate 的第二参不能显式传 undefined（ego 的入参校验会直接报错），有参才传。 */
async function safeEval(fn, arg) {
  const call = () => (arg === undefined ? page.evaluate(fn) : page.evaluate(fn, arg))
  try { return await call() } catch { await sleep(800); return await call() }
}

/** 贴图草稿条数：草稿箱按类型分桶，item_show_type 8 = 贴图。读不到返回 -1（不当成 0，免得把「没读到」报成「没增加」） */
async function readTiepuDraftCount() {
  const token = await safeEval(() => (location.href.match(/token=(\d+)/) || [])[1] || '')
  if (!token) return -1
  try {
    const res = await page.fetch(`https://mp.weixin.qq.com/cgi-bin/appmsg?action=list_card&begin=0&count=1&type=77&token=${token}&lang=zh_CN&f=json&ajax=1`)
    const cnt = JSON.parse(res.body)?.app_msg_info?.file_cnt?.draft_type_cnt || []
    return cnt.find((c) => c.item_show_type === 8)?.count ?? 0
  } catch {
    return -1
  }
}

// ---- 1. 首页取 token（顺带确认登录） ----
await page.goto('https://mp.weixin.qq.com/')
// 登录后首页会自己带上 token；没登录则是扫码墙——两种都算「到位」，交给下面的 token 判断
const landed = await waitReady(() => safeEval(() =>
  /token=\d+/.test(location.href) || /扫码登录|请使用微信扫码/.test(document.body?.innerText || '')), 20000, 700)
log('首页到位:', landed)
const token = await safeEval(() => (location.href.match(/token=(\d+)/) || [])[1] || '')
if (!token) {
  console.log(JSON.stringify({ ok: false, error: '公众号未登录或拿不到 token：请在 Ego Lite 里扫码登录 mp.weixin.qq.com 后重试。' }))
  await task.handOff()
  process.exit(1)
}

// ---- 2. 直达贴图编辑器 ----
await page.goto(`https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/appmsg_edit_v2&action=edit&isNew=1&type=10&createType=8&token=${token}&lang=zh_CN`)
const editorOk = await waitReady(() => safeEval(() =>
  !!document.querySelector('.title-editor__input .ProseMirror') &&
  !!document.querySelector('.share-text__input .ProseMirror')), 25000, 1200)
if (!editorOk) {
  console.log(JSON.stringify({ ok: false, error: '没进到贴图编辑器（可能改版），请在 Ego Lite 里人工新建「贴图」后重试。', url: await page.url() }))
  await task.finish({ keep: ['p1'] })
  process.exit(1)
}

// ---- 3. 传图（上限 20 张）：成功信号是底部缩略图条 `.image-selector__bottom-list-item` 的张数。
//         别拿「N/20」当计数——贴图编辑器里那个 frm_counter 是**标题**字数（上限 20），图片空态文案传完就消失；
//         也别数 img：缩略图是 background-image，DOM 里只有 1 个 <img>。
const images = (payload.imagesAbs?.length ? payload.imagesAbs : [payload.coverAbs]).filter((p) => p && fs.existsSync(p))
if (!images.length) {
  console.log(JSON.stringify({ ok: false, error: '缺少配图（imagesAbs/coverAbs），贴图必须有图' }))
  await task.finish({ keep: ['p1'] })
  process.exit(1)
}
// 判据是编辑器左上角的「当前张 / 上限」计数（`.image-selector__preview-center-tips-area__num`，文案形如 6/20）。
// 三个历史上的错误判据，2026-10-31 全部实测过：
// ① 按图床域名认（/mmbiz/）：平台换到 mmecoa.qpic.cn 后恒返回 0，图传上去了却判「一张都没上来」；
// ② 按 background url 认：缩略图是 background-image，懒渲染，只少数视口里那几张；
// ③ 数 `.image-selector__bottom-list-item` 节点：底部缩略图条是**虚拟列表**，传第 3、4 张时只有 2 个节点在 DOM 里，
//    计数会原地不动甚至倒退，于是脚本判定「第 5 张没上来」——图其实一张没丢，是数法错了。
const readImgState = () => safeEval(() => {
  const el = document.querySelector('.image-selector__preview-center-tips-area__num') || document.querySelector('.image-selector__tags-wrap')
  const raw = (el?.innerText || '').replace(/\s+/g, ' ').trim()
  const m = raw.match(/(\d+)\s*\/\s*(\d+)/)
  return { raw, n: m ? Number(m[1]) : document.querySelectorAll('.image-selector__bottom-list-item').length }
})
const readImgCount = async () => (await readImgState()).n
await sleep(4000)
let uploaded = await readImgCount()
// 逐张传。一次喂多张时平台只认第一张、后面静默丢弃；而且每传一张 `input[accept*="bmp"]` 就会多出
// 一个匹配（编辑器追加了新的隐藏 input），直接拿选择器注入会因严格模式报「matched 2 element」。
// 所以每轮都现场给「那一个」打唯一 id 再喂，喂完摘掉 id，下一轮重新挑。
for (const [i, img] of images.entries()) {
  const expect = uploaded + 1
  // 打**最后一个** accept*=bmp 的控件：每传完一张，编辑器就把旧的 input 摘掉、再挂一个新的。
  // 之前取「第一个」拿到的是已经在 DOM 上失联的旧控件，注入静默无效——计数原地不动，
  // 脚本于是报「第 5 张没上来」，其实一张没丢（2026-10-31 实测：改成取最后一个，7 张逐张都进）。
  const tagged = await safeEval(() => {
    const all = [...document.querySelectorAll('input[type="file"]')].filter((x) => /bmp/.test(x.getAttribute('accept') || ''))
    const t = all[all.length - 1]
    if (!t) return false
    t.id = 'mh-upload-input'
    return true
  })
  if (!tagged) {
    log(`第 ${i + 1} 张：找不到贴图上传控件`)
    break
  }
  await page.setInputFiles('#mh-upload-input', [img]).catch((e) => log(`第 ${i + 1} 张注入抛错：`, String(e.message || e).slice(0, 80)))
  await safeEval(() => { document.querySelector('#mh-upload-input')?.removeAttribute('id'); return true })
  const ok = await waitReady(async () => { uploaded = await readImgCount(); return uploaded >= expect }, 30000, 800)
  if (!ok) {
    const st = await readImgState()
    log(`第 ${i + 1} 张没上来（计数 ${uploaded}，原文「${st.raw}」）`)
    break
  }
}
const draftCountBefore = await readTiepuDraftCount()
log(`图片上传: ${uploaded}/${images.length}，草稿基数 ${draftCountBefore}`)
if (uploaded < images.length) {
  console.log(JSON.stringify({ ok: false, error: `图没传齐（${uploaded}/${images.length}），不填文案也不保存`, draftCountBefore }))
  await task.finish({ keep: ['p1'] })
  process.exit(1)
}

// ---- 3.5 配乐：贴图编辑器工具栏的 ♪ → 插入音乐弹窗。默认曲见 config/publish-music.json（payload.music）
//      必须在填标题/描述之前插——「插入」是把音乐条写进光标所在的正文区，光标跑到描述里就插错地方了。
//      曲库里认不出那首就跳过，绝不退而选别的。
let music = { want: payload.music?.title || '', applied: false, note: '' }
if (payload.music) {
  const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]/g, '')
  const wantT = norm(payload.music.title)
  const wantA = norm(payload.music.author)
  try {
    await safeEval(() => document.querySelector('.edui-for-music')?.click())
    await sleep(3000)
    const searchBox = await safeEval(() => {
      const i = [...document.querySelectorAll('input')].find((x) => /输入歌手、歌名搜索/.test(x.placeholder || ''))
      if (!i) return null
      const r = i.getBoundingClientRect()
      return { cx: Math.round(r.x + r.width / 2), cy: Math.round(r.y + r.height / 2) }
    })
    if (!searchBox) {
      music.note = '没打开「插入音乐」弹窗'
    } else {
      await page.mouse.click(searchBox.cx, searchBox.cy, { label: '聚焦音乐搜索框' })
      await sleep(400)
      await page.keyboard.type(payload.music.query, { delay: 150 })
      await page.keyboard.press('Enter')
      await sleep(5000)
      const card = await safeEval(({ wantT, wantA }) => {
        const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]/g, '')
        for (const el of document.querySelectorAll('.channel-music-item')) {
          const r = el.getBoundingClientRect()
          if (r.width < 10) continue
          const t = norm(el.innerText || '')
          if (!t.includes(wantT) || (wantA && !t.includes(wantA))) continue
          return { cx: Math.round(r.x + r.width / 2), cy: Math.round(r.y + r.height / 2) }
        }
        return null
      }, { wantT, wantA })
      if (!card) {
        music.note = `曲库搜索结果里没有「${payload.music.title}」`
      } else {
        // 实测：点卡片中心即勾选（右下角计数变「已选择 1 / 10」），勾 checkbox 反而点不中
        await page.mouse.click(card.cx, card.cy, { label: '勾选曲目' })
        await sleep(2000)
        const insertBtn = await safeEval(() => {
          const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 }
          const b = [...document.querySelectorAll('a,button,span,div')].filter((e) => (e.innerText || '').trim() === '插入' && vis(e) && e.childElementCount === 0)
          if (!b.length) return null
          const r = b[b.length - 1].getBoundingClientRect()
          return { cx: Math.round(r.x + r.width / 2), cy: Math.round(r.y + r.height / 2) }
        })
        if (!insertBtn) {
          music.note = '勾选后没找到「插入」按钮'
        } else {
          await page.mouse.click(insertBtn.cx, insertBtn.cy, { label: '点「插入」' })
          await sleep(4000)
          const landed = await safeEval((wantT) => {
            const a = document.querySelector('a.wx_plain-music_link, a.js_plain-music_entry')
            const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]/g, '')
            return { applied: !!a && norm(a.innerText || '').includes(wantT), text: (a?.innerText || '').trim() }
          }, wantT)
          music.applied = landed.applied
          music.note = landed.applied ? landed.text : `点完「插入」正文里没有目标音乐条：${landed.text || '（无音乐条）'}`
        }
      }
    }
  } catch (e) {
    music.note = `选曲抛错：${String(e.message || e).slice(0, 80)}`
  }
  log('配乐:', JSON.stringify(music))
}

// ---- 4. 填标题（≤20 字）和描述（≤1000 字）：两个都是 ProseMirror，真键盘输入才不被 Vue 旧 state 覆盖 ----
const title = (payload.title || '').slice(0, 20)
async function focusEditor(sel) {
  return safeEval((s) => {
    const ed = document.querySelector(s)
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
  }, sel)
}

/** CDP 输入偶发超时但内容往往已经落进编辑器，所以超时后先按 DOM 复核，绝不盲目重发（会写成两遍）。 */
async function writeLine(sel, text) {
  if (!text) return true
  const landed = async () => {
    const t = await safeEval((s) => (document.querySelector(s)?.innerText || ''), sel)
    return t.includes(text.slice(0, 12))
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await page.keyboard.insertText(text)
    } catch (e) {
      log(`第 ${attempt + 1} 次写入「${text.slice(0, 10)}…」抛错：${String(e.message || e).slice(0, 60)}`)
      await sleep(1500)
    }
    await sleep(600)
    if (await landed()) return true
  }
  return false
}

const DESC_SEL = '.share-text__input .ProseMirror'
log('标题聚焦:', await focusEditor('.title-editor__input .ProseMirror'))
await writeLine('.title-editor__input .ProseMirror', title)
for (let i = 0; i < payload.lines.length; i++) {
  if (i === 0) {
    log('描述聚焦:', await focusEditor(DESC_SEL))
  } else {
    await page.keyboard.press('Enter').catch(() => {})
    await sleep(200)
  }
  await writeLine(DESC_SEL, payload.lines[i])
}
await sleep(800)

// ---- 5. 「链接」栏挂小程序：点栏 → 菜单「小程序」→ 弹窗粘贴口令 → 确定 ----
let linkState = 'skip'
if (payload.weapp) {
  const rowOk = await safeEval(() => {
    const el = [...document.querySelectorAll('div.wording')].find((e) => (e.innerText || '').includes('支持添加内容链接') && e.getBoundingClientRect().width > 0)
    if (!el) return false
    el.scrollIntoView({ block: 'center' })
    el.click()
    return true
  })
  linkState = rowOk ? 'row' : 'row-not-found'
  if (rowOk) {
    await sleep(1200)
    const menuOk = await safeEval(() => {
      const els = [...document.querySelectorAll('li,div,span,a')].filter((e) => (e.innerText || '').trim() === '小程序' && e.getBoundingClientRect().width > 0)
      const el = els.sort((a, b) => a.querySelectorAll('*').length - b.querySelectorAll('*').length)[0]
      if (!el) return false
      el.click()
      return true
    })
    linkState = menuOk ? 'dialog' : 'menu-not-found'
    if (menuOk) {
      await sleep(2500)
      const focused = await safeEval(() => {
        const inp = document.querySelector('input[placeholder*="粘贴到此处"]')
        if (!inp) return false
        inp.scrollIntoView({ block: 'center' })
        inp.focus()
        return true
      })
      linkState = focused ? 'pasting' : 'dialog-not-found'
      if (focused) {
        // 2026-10-31 实测：keyboard.paste 在这个站点失效（剪贴板写不进去，input.value 仍是空 → 判 paste-failed），
        // 而 keyboard.insertText 是逐字真输入，能触发平台的链接校验（「确定」照样点亮）。
        // 所以先 insertText，真的没填上再退回 paste——两条都试过还是空，才算真失败。
        await page.keyboard.insertText(payload.weapp).catch(() => {})
        await sleep(1200)
        let filled = await safeEval(() => {
          const inp = document.querySelector('input[placeholder*="粘贴到此处"]')
          return inp ? inp.value.length : -1
        })
        if (filled <= 0) {
          await page.keyboard.paste(payload.weapp).catch(() => {})
          await sleep(1500)
          filled = await safeEval(() => {
            const inp = document.querySelector('input[placeholder*="粘贴到此处"]')
            return inp ? inp.value.length : -1
          })
        }
        if (filled > 0) {
          const confirmed = await safeEval(() => {
            const btn = [...document.querySelectorAll('button')].find((b) => (b.innerText || '').trim() === '确定' && b.getBoundingClientRect().width > 0 && !b.disabled)
            if (!btn) return false
            btn.click()
            return true
          })
          linkState = confirmed ? 'ok' : 'confirm-disabled'
          await sleep(1500)
        } else {
          linkState = 'paste-failed'
        }
      }
    }
  }
  log('链接栏挂小程序:', linkState)
}

// ---- 6. 保存前核验：图齐 + 标题逐字对 + 描述逐行内容对（不是数长度）+ 链接栏挂上 ----
const final = await safeEval((s) => ({
  title: (document.querySelector('.title-editor__input .ProseMirror')?.innerText || '').trim(),
  descText: (document.querySelector(s)?.innerText || '').trim(),
  imgs: document.querySelectorAll('.image-selector__bottom-list-item').length,
}), DESC_SEL)
const missing = payload.lines.filter(Boolean).filter((l) => !final.descText.replace(/\s+/g, '').includes(l.replace(/\s+/g, '')))
const descLen = final.descText.length
// 描述里不该再出现裸口令（挂链接栏后引擎也不追加了）；有就是拼装回退错了，停下
const strayWeapp = final.descText.includes('#小程序://')
const linkBad = !!payload.weapp && linkState !== 'ok'
// 图齐不齐只认第 3 步逐张确认的 uploaded：填完文案、挂上小程序之后底部缩略图条会塌成「当前那张 + 加号」，
// 再数一遍拿到的是 1 或 2（2026-10-31 实测），按它判就永远「填写不完整」。
if (!(final.title === title && descLen > 0 && uploaded >= images.length) || missing.length || strayWeapp || linkBad) {
  console.log(JSON.stringify({ ok: false, error: '填写不完整（标题/描述逐行核对有缺项，或小程序未挂上链接栏），不保存草稿', final: { title: final.title, descLen, linkState, strayWeapp, imgs: final.imgs }, missing, wantTitle: title, captchaWaited: false }))
  await task.finish({ keep: ['p1'] })
  process.exit(1)
}

// ---- 7. 点「保存为草稿」（绝不点「发表/群发」） ----
const saved = await safeEval(() => {
  const btn = [...document.querySelectorAll('button,a,span')].find(
    (e) => (e.innerText || '').trim() === '保存为草稿' && e.getBoundingClientRect().width > 0)
  if (!btn) return false
  btn.click()
  return true
})
await sleep(6000)
const draftCountAfter = await readTiepuDraftCount()
const okSave = saved && draftCountAfter > draftCountBefore

console.log(JSON.stringify({
  ok: okSave,
  savedToDraft: okSave,
  images: { want: images.length, got: final.imgs },
  title: final.title,
  descLen: final.descLen,
  weappLink: { want: !!payload.weapp, state: linkState },
  music,
  draftCount: { before: draftCountBefore, after: draftCountAfter },
  next: okSave
    ? '贴图草稿已存进公众号草稿箱。登录 mp.weixin.qq.com → 草稿箱，人工预览后点「发表」——脚本按铁律不会替你点。'
    : `保存未确认（点按钮 ${saved}，贴图草稿计数 ${draftCountBefore}→${draftCountAfter}），请打开草稿箱人工核对。`,
}, null, 2))
log('截图:', await page.screenshot({ path: '/tmp/mp-autopublish-draft.png' }).catch(() => '截图超时'))
await task.finish({ keep: ['p1'] })
