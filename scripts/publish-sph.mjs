/**
 * 视频号「图文动态存草稿」ego-browser 脚本（stdin 运行）
 *
 * 输入：/tmp/media-hub-publish.json → { title, lines[], tags[], imagesAbs[], coverAbs, accountKey, platform, spaceName? }
 * 流程：直达发表动态页 → 点上传区挂 file input → 一次传全部图卡 → 填标题/描述/#话题 → 点「保存草稿」→ 去草稿箱核对
 * 实测（2026-09-23）：
 *  - 发表动态直达 URL：`/platform/post/finderNewLifeCreate`（图文管理 → 发表动态），不必点导航；
 *  - 字段：图片最多 **18 张**（单张 ≤20MB）、**标题 22 字符内**、描述 1000 字符内，描述区带 #话题 / @视频号；
 *  - **有网页草稿箱**（按钮「保存草稿」，侧栏「草稿箱」）——铁律在这里就是「进草稿箱」，不像快手要停在发布页；
 *  - 「链接」只能挂 **公众号文章 / 红包封面**，挂不了小程序（小程序入口在视频形态，且本号未绑定小程序）。
 *    所以视频号的转化路径是「视频号动态 → 公众号文章 → 文章里的小程序」，本期不挂链接（贴图还在草稿箱，选不到）；
 *  - **整张表单在 wujie 微前端的 shadow DOM 里**：普通选择器命中的节点会被 `<wujie-app>` 拦截指针事件（click 直接超时），
 *    所以坐标一律由遍历 shadowRoot 求得后用 mouse.click；标题是真 `<input>`，`page.fill` 能穿透 shadow DOM 直接写；
 *  - 传图 input 平时不存在，点「发布图片动态」才会挂上（accept="image/*" multiple）；而**这一下点击会直接弹系统文件框**，
 *    不先 `waitForFileChooser()` 就点，ego 会判成「文件选择框被取消」整轮报错退出——所以走 FileChooser.setFiles；
 *    传成功的判据是 shadow DOM 里 `img[src^="blob:"]` 的张数（页面没有「N/18」这种计数）。
 *  - 描述区按坐标点不动（焦点会留在 wujie 的 iframe 上，字全丢），要 `page.focus('div.input-editor')` + 光标置尾；
 *  - 草稿箱（`/platform/post/draftListManager`）的卡**只有缩略图和时间，不显示标题**，
 *    所以存证判据是「条数 +1」再把最新一条「编辑」回读标题核对，而不是在列表里搜标题。
 * 铁律：**绝不点击「发表」** —— 只存草稿，最后一下由人完成；识别到验证码/风控只报告并交还人工，不破解。
 * 配乐：payload 带了 `music`（默认曲见 config/publish-music.json），但**本脚本故意不接**——
 *      2026-10-01 探到图文动态发布页时登录态已掉到 login.html，没看到过配乐入口，未实测的点击会撞坏这张 wujie 表单。
 *      要接：先人工扫码登录 channels.weixin.qq.com，实测入口后再补一段选曲。
 */

const fs = await import('node:fs')
const payload = JSON.parse(fs.readFileSync('/tmp/media-hub-publish.json', 'utf8'))
// 根目录优先取宿主注入的 MEDIA_HUB_ROOT（run-ego / 服务端 spawn 都会写）：ego 内嵌 Node 不保证
// 跑在项目根，只认 process.cwd() 在装机版（数据目录带空格与中文）上会让动态 import 解析成坏 URL，
// 整版直接炸成 ERR_INVALID_FILE_URL_HOST（2026-10-23 实测）。cwd 只作兜底。
const ROOT = process.env.MEDIA_HUB_ROOT || process.cwd()
const { openSpace, guardJar } = await import(`${ROOT}/scripts/ego-space.mjs`)

const task = await openSpace(payload.spaceName || 'sph-publish')
const tabs = await task.tabs()
const reused = tabs.find((t) => t.label === 'p1') || tabs.find((t) => !t.label && /channels\.weixin\.qq\.com/.test(t.url))
const page = reused ? (reused.label ? reused.page : await task.adopt(reused.page, { as: 'p1' })) : await task.newPage()
// 同平台挂了几个号：开工前把浏览器罐子换成这个号的登录态，交还空间时自动换回（只有一个号则不动）
await guardJar(task, page, { accountKey: payload.accountKey, platform: payload.platform })
const log = (...a) => console.log('[sph-publish]', ...a)
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

/** 注意：evaluate 的第二参不能显式传 undefined（ego 的入参校验直接报错），有参才传。 */
async function safeEval(fn, arg) {
  const call = () => (arg === undefined ? page.evaluate(fn) : page.evaluate(fn, arg))
  try { return await call() } catch { await sleep(800); return await call() }
}

/** 按精确文本求可见叶子节点的视口中心（返回 null 表示没找到）。
 *  两趟：先滚动到视口并打标记，再重新量一次 rect——一趟里 scrollIntoView 之后拿到的还是滚动前的坐标，
 *  按旧坐标点会打空（「保存草稿」第一次就是这么没点到的）。 */
async function boxOfText(re) {
  const marked = await safeEval(new Function('re', `
    const rx = new RegExp(re); const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 };
    let hit = 0; const walk = (root) => { for (const el of root.querySelectorAll('*')) {
      if (!hit && el.children.length === 0 && vis(el) && rx.test((el.textContent || '').trim())) { el.setAttribute('data-ego-box', '1'); hit = 1 }
      if (el.shadowRoot) walk(el.shadowRoot) } };
    walk(document);
    if (!hit) return false;
    document.querySelector('[data-ego-box]')?.scrollIntoView({ block: 'center' }); return true`), re.source)
  if (!marked) return null
  await sleep(500)
  return safeEval(() => {
    let box = null
    const walk = (root) => {
      for (const el of root.querySelectorAll('*')) {
        if (!box && el.hasAttribute?.('data-ego-box')) {
          const r = el.getBoundingClientRect()
          box = { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
          el.removeAttribute('data-ego-box')
        }
        if (el.shadowRoot) walk(el.shadowRoot)
      }
    }
    walk(document)
    return box
  })
}

/** 表单现状：标题值、描述文本、已上传图（blob 缩略图）张数 */
const readForm = () => safeEval(() => {
  const res = { title: '', desc: '', blobs: 0 }
  const walk = (root) => {
    for (const el of root.querySelectorAll('*')) {
      if (el.tagName === 'INPUT' && (el.placeholder || '').includes('22个字符')) res.title = el.value || ''
      if (el.classList?.contains('input-editor') && el.getBoundingClientRect().width > 0) res.desc = (el.innerText || '').trim()
      if (el.tagName === 'IMG' && /^blob:/.test(el.src || '')) res.blobs++
      if (el.shadowRoot) walk(el.shadowRoot)
    }
  }
  walk(document)
  return res
})

/** 风控/验证码是否挡路（识别到就停手交给人，脚本不破解） */
const detectBlocker = () => safeEval(() => {
  let txt = ''
  const walk = (root) => { for (const el of root.querySelectorAll('*')) { if (el.children.length === 0) txt += ' ' + (el.textContent || ''); if (el.shadowRoot) walk(el.shadowRoot) } }
  walk(document)
  return (txt.match(/验证码|安全验证|滑动完成|访问验证|操作频繁|请稍后再试/) || [])[0] || ''
})
async function reportBlocker(where) {
  const hit = await detectBlocker()
  if (!hit) return false
  console.log(JSON.stringify({ ok: false, error: `${where}遇到「${hit}」——按铁律不破解，页面交给你人工处理，处理完重跑本脚本`, captchaWaited: true }))
  await task.handOff()
  process.exit(1)
}

/** 草稿箱条数：页面上写的是「草稿箱 (N)」；草稿卡只有缩略图和时间，**不显示标题**，所以存证只能靠条数 + 回读 */
const readDraftCount = () => safeEval(() => {
  let txt = ''
  const walk = (root) => { for (const el of root.querySelectorAll('*')) { if (el.children.length === 0) txt += ' ' + (el.textContent || ''); if (el.shadowRoot) walk(el.shadowRoot) } }
  walk(document)
  return +((txt.match(/草稿箱\s*\((\d+)\)/) || [])[1] ?? -1)
})
/** 列表要等 wujie 子应用渲染完才有「草稿箱 (N)」，冷启动 7 秒都还没出来（实测），所以要轮询而不是读一次 */
async function waitDraftCount(where, limit = 12) {
  for (let i = 0; i < limit; i++) {
    const n = await readDraftCount()
    if (n >= 0) return n
    await sleep(3000)
  }
  log(`${where}：草稿箱条数没读出来（页面可能改版）`)
  return -1
}
/** 草稿卡上的时间戳（用来确认「今天这条」真的在列表里） */
const draftDates = () => safeEval(() => {
  let txt = ''
  const walk = (root) => { for (const el of root.querySelectorAll('*')) { if (el.children.length === 0) txt += ' ' + (el.textContent || ''); if (el.shadowRoot) walk(el.shadowRoot) } }
  walk(document)
  return (txt.match(/\d{4}年\d{2}月\d{2}日 \d{2}:\d{2}/g) || []).slice(0, 10)
})

/** 可见短文本清单（点完按钮后取差集就是 toast 文案） */
const leafTexts = () => safeEval(() => {
  const skip = new Set(['STYLE', 'SCRIPT', 'NOSCRIPT', 'TITLE'])
  const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 }
  const out = []
  const walk = (root) => { for (const el of root.querySelectorAll('*')) { if (!skip.has(el.tagName) && !el.children.length && vis(el)) { const t = (el.textContent || '').trim(); if (t && t.length < 40) out.push(t) } if (el.shadowRoot) walk(el.shadowRoot) } }
  walk(document)
  return out
})

// ---- 0. 先记草稿箱基线条数（判「真的多了一条」用） ----
await page.goto('https://channels.weixin.qq.com/platform/post/draftListManager')
await sleep(1500)
const draftsBefore = await waitDraftCount('基线')
log('草稿箱基线条数:', draftsBefore)

/** 动态编辑页是否到位：标题输入框（placeholder 带「22个字符」）在 wujie 子应用的 shadowRoot 里，要穿透才看得到 */
const createReady = () => safeEval(() => {
  if (/login/i.test(location.href)) return true
  let hit = false
  const walk = (root) => {
    for (const el of root.querySelectorAll('*')) {
      if (!hit && el.tagName === 'INPUT' && (el.placeholder || '').includes('22个字符')) hit = true
      if (!hit && el.shadowRoot) walk(el.shadowRoot)
    }
  }
  walk(document)
  return hit
})

// ---- 1. 直达发表动态页，确认登录 ----
await page.goto('https://channels.weixin.qq.com/platform/post/finderNewLifeCreate')
const formReady = await waitReady(createReady, 25000, 1000)
log('编辑页到位:', formReady)
if (/login/i.test(await page.url())) {
  console.log(JSON.stringify({ ok: false, error: '视频号助手未登录，请先在 Ego Lite 扫码登录 channels.weixin.qq.com' }))
  await task.finish({ keep: ['p1'] })
  process.exit(1)
}
await reportBlocker('打开页面后')
// 上一次中断留下的半成品会带进来，非空就重载一次拿干净表单
const prefilled = await readForm()
if (prefilled.title || prefilled.desc) {
  log('表单非空，重载取干净页面')
  await page.reload()
  await waitReady(createReady, 20000, 1000)
}

// ---- 2. 传图：先点上传区把 file input 挂上，再按 blob 缩略图张数确认（上限 18） ----
const images = (payload.imagesAbs?.length ? payload.imagesAbs : [payload.coverAbs]).filter((p) => p && fs.existsSync(p))
if (!images.length) {
  console.log(JSON.stringify({ ok: false, error: '缺少配图（imagesAbs/coverAbs），视频号图文必须有图' }))
  await task.finish({ keep: ['p1'] })
  process.exit(1)
}
async function tryUpload() {
  const zone = await boxOfText(/发布图片动态/)
  if (zone) {
    // 实测：点这块区域会直接弹系统文件框。不先挂 waitForFileChooser 的话，ego 会把这一下判成
    // 「文件选择框被取消」并整轮报错退出，所以走 FileChooser.setFiles，setInputFiles 只做兜底。
    const chooserPromise = page.waitForFileChooser({ timeout: 15000 }).catch(() => null)
    await page.mouse.click(zone.x, zone.y, { label: '点图片上传区' })
    const chooser = await chooserPromise
    if (chooser) {
      const res = await chooser.setFiles(images).catch((e) => log('setFiles 抛错:', String(e.message).slice(0, 60)))
      if (res?.dialog) await page.acceptDialog().catch(() => {})
    } else {
      log('没等到 FileChooser，退回 setInputFiles')
      await sleep(1500)
      await page.setInputFiles('input[type="file"]', images).catch((e) => log('setInputFiles 抛错:', String(e.message).slice(0, 60)))
    }
  } else {
    await page.setInputFiles('input[type="file"]', images).catch((e) => log('setInputFiles 抛错:', String(e.message).slice(0, 60)))
  }
  for (let i = 0; i < 10; i++) {
    await sleep(3000)
    const n = (await readForm()).blobs
    if (n >= images.length) return n
  }
  return (await readForm()).blobs
}
let uploaded = await tryUpload()
if (uploaded < images.length) {
  log(`第 1 次只传进 ${uploaded}/${images.length}，重点上传区再试`)
  uploaded = await tryUpload()
}
log(`图片上传: ${uploaded}/${images.length}`)
if (uploaded < images.length) {
  console.log(JSON.stringify({ ok: false, error: `图没传齐（${uploaded}/${images.length}），不填文案也不存草稿` }))
  await task.finish({ keep: ['p1'] })
  process.exit(1)
}

// ---- 3. 标题（≤22 字符，真 input 可穿透 shadow DOM 直接 fill） ----
const title = (payload.title || '').slice(0, 22)
await page.fill('input[placeholder="填写标题, 22个字符内"]', title).catch((e) => log('标题 fill 抛错:', String(e.message).slice(0, 60)))
await sleep(800)

// ---- 4. 描述：page.focus 穿透 shadow DOM 拿焦点 + 光标置尾，再真键盘逐行写，末尾补 #话题 ----
// 实测：按坐标 mouse.click 打不动这个 contenteditable（activeElement 停在 __finder-page，字全丢了），
// 必须先让 ego 把焦点/输入路由到 wujie 的 iframe，evaluate 里再把光标放到末尾。
const descExists = await safeEval(() => {
  let ed = null
  const walk = (root) => {
    for (const el of root.querySelectorAll('*')) {
      if (el.classList?.contains('input-editor') && el.getBoundingClientRect().width > 0) ed = el
      if (el.shadowRoot) walk(el.shadowRoot)
    }
  }
  walk(document)
  return !!ed
})
if (!descExists) {
  console.log(JSON.stringify({ ok: false, error: '找不到图文描述区（.input-editor），页面可能改版' }))
  await task.finish({ keep: ['p1'] })
  process.exit(1)
}
await page.focus('div.input-editor').catch((e) => log('page.focus 抛错，靠 evaluate 兜底:', String(e.message).slice(0, 50)))
await safeEval(() => {
  let ed = null
  const walk = (root) => {
    for (const el of root.querySelectorAll('*')) {
      if (el.classList?.contains('input-editor')) ed = el
      if (el.shadowRoot) walk(el.shadowRoot)
    }
  }
  walk(document)
  if (!ed) return
  ed.scrollIntoView({ block: 'center' })
  ed.focus()
  const sel = window.getSelection()
  const r = document.createRange()
  r.selectNodeContents(ed)
  r.collapse(false)
  sel?.removeAllRanges()
  sel?.addRange(r)
})
await sleep(500)

/** CDP 输入偶发超时但内容往往已落入——超时后按 DOM 复核再决定重试，绝不盲目重发 */
async function writeLine(text) {
  if (!text) return
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await page.keyboard.insertText(text)
    } catch (e) {
      log(`写入抛错：${String(e.message || e).slice(0, 50)}`)
      await sleep(1500)
    }
    await sleep(600)
    if ((await readForm()).desc.replace(/\s+/g, '').includes(text.slice(0, 10).replace(/\s+/g, ''))) return
  }
}
for (let i = 0; i < payload.lines.length; i++) {
  await writeLine(payload.lines[i])
  if (i < payload.lines.length - 1 || payload.tags?.length) {
    try { await page.keyboard.press('Enter') } catch { await sleep(400) }
    await sleep(250)
  }
}
if (payload.tags?.length) await writeLine(payload.tags.join(' '))
await page.keyboard.press('Escape').catch(() => {})  // 关掉话题联想，别盖住「保存草稿」
await sleep(800)

// ---- 5. 保存前核验：图齐 + 标题逐字对 + 描述逐行内容对，缺一律不存 ----
const final = await readForm()
const norm = (s) => s.replace(/\s+/g, '')
const missing = payload.lines.filter(Boolean).filter((l) => !norm(final.desc).includes(norm(l)))
if (!(final.title === title && final.desc && final.blobs >= images.length) || missing.length) {
  console.log(JSON.stringify({
    ok: false, error: '填写不完整（标题/描述逐行核对有缺项），不存草稿',
    final: { title: final.title, descLen: final.desc.length, blobs: final.blobs }, missing, wantTitle: title,
  }))
  await task.finish({ keep: ['p1'] })
  process.exit(1)
}

// ---- 6. 点「保存草稿」（绝不点「发表」） ----
await reportBlocker('保存草稿前')
/** 按钮状态：wujie 里的按钮靠 class `weui-desktop-btn_disabled` 表意 disabled，
 *  它禁用时点了也没任何反应（第 3、4 次跑就是这么「静默失败」的），所以先看状态再点。 */
const saveBtn = await safeEval(() => {
  let leaf = null
  const walk = (root) => { for (const el of root.querySelectorAll('*')) { if (!leaf && el.children.length === 0 && (el.textContent || '').trim() === '保存草稿') leaf = el; if (el.shadowRoot) walk(el.shadowRoot) } }
  walk(document)
  if (!leaf) return null
  leaf.scrollIntoView({ block: 'center' })
  const r = leaf.getBoundingClientRect()
  return { disabled: /_disabled/.test(String(leaf.className)), tag: leaf.tagName, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
})
if (!saveBtn) {
  console.log(JSON.stringify({ ok: false, error: '找不到「保存草稿」按钮，页面可能改版；表单已填好，交人工点', final: { title: final.title, blobs: final.blobs } }))
  await task.handOff()
  process.exit(1)
}
if (saveBtn.disabled) {
  console.log(JSON.stringify({ ok: false, error: '「保存草稿」仍是禁用态（平台认为内容没就绪，多半是图还在上传/审核），不点，交人工核对', final: { title: final.title, descLen: final.desc.length, blobs: final.blobs } }))
  await task.handOff()
  process.exit(1)
}
const textsBefore = await leafTexts()
const urlBefore = await page.url()
await sleep(600)
// JS click 优先（实测 wujie 里这类按钮 JS 点击有效）；只有它毫无反应时才用坐标补一次，避免点两下存进两条草稿
const jsClicked = await safeEval(() => {
  let leaf = null
  const walk = (root) => { for (const el of root.querySelectorAll('*')) { if (!leaf && el.children.length === 0 && (el.textContent || '').trim() === '保存草稿') leaf = el; if (el.shadowRoot) walk(el.shadowRoot) } }
  walk(document)
  if (!leaf) return false
  leaf.click()
  return true
})
await sleep(2500)
let toast = (await leafTexts()).filter((t) => !textsBefore.includes(t)).slice(0, 8)
const moved = (await page.url()) !== urlBefore
log('保存草稿：JS click =', jsClicked, 'toast =', JSON.stringify(toast), 'URL 变了 =', moved)
if (!toast.length && !moved) {
  log('JS click 没反应，按坐标补点一次', JSON.stringify(saveBtn))
  await page.mouse.click(saveBtn.x, saveBtn.y, { label: '坐标补点保存草稿' })
  await sleep(4000)
  toast = [...new Set([...toast, ...(await leafTexts()).filter((t) => !textsBefore.includes(t))])].slice(0, 8)
  log('补点后新增文案:', JSON.stringify(toast))
} else {
  await sleep(2500)
}

// ---- 7. 存证：草稿箱要多一条，再把最新那条「编辑」回来逐字核对（不信任按钮点击本身） ----
await page.goto('https://channels.weixin.qq.com/platform/post/draftListManager')
await sleep(1500)
const draftsAfter = await waitDraftCount('存证')
const dates = await draftDates()
const d = new Date()
const today = `${d.getFullYear()}年${String(d.getMonth() + 1).padStart(2, '0')}月${String(d.getDate()).padStart(2, '0')}日`
const added = draftsBefore >= 0 ? draftsAfter > draftsBefore : dates.some((s) => s.startsWith(today))
let readback = null
if (added) {
  // 「编辑」在卡片 hover 层里，rect 是 0——按坐标点不到，直接 JS click（实测能跳回发表动态页并回填）
  const editClicked = await safeEval(() => {
    let done = false
    const walk = (root) => { for (const el of root.querySelectorAll('*')) { if (!done && el.children.length === 0 && (el.textContent || '').trim() === '编辑') { (el.closest('button, a') || el).click(); done = true } if (el.shadowRoot) walk(el.shadowRoot) } }
    walk(document)
    return done
  })
  await sleep(14000)
  const rb = editClicked ? await safeEval(() => {
    const res = { title: '', desc: '', imgs: 0 }
    const walk = (root) => { for (const el of root.querySelectorAll('*')) {
      if (el.tagName === 'INPUT' && (el.placeholder || '').includes('22个字符')) res.title = el.value || ''
      if (el.classList?.contains('input-editor')) res.desc = (el.innerText || '').trim()
      if (el.tagName === 'IMG' && el.getBoundingClientRect().width > 40) res.imgs++
      if (el.shadowRoot) walk(el.shadowRoot) } }
    walk(document)
    return res
  }) : null
  if (rb) {
    readback = {
      title: rb.title,
      titleOk: rb.title === title,
      descOk: norm(rb.desc).startsWith(norm(payload.lines[0])) && norm(rb.desc).includes(norm(payload.lines[payload.lines.length - 1])),
      descLen: rb.desc.length,
      imgs: rb.imgs,
    }
    log('草稿回读:', JSON.stringify(readback))
  }
}
const savedToDraft = added && (!readback || (readback.titleOk && readback.descOk))
console.log(JSON.stringify({
  ok: savedToDraft,
  savedToDraft,
  drafts: { before: draftsBefore, after: draftsAfter },
  draftDates: dates.slice(0, 4),
  toast,
  readback,
  images: { want: images.length, got: final.blobs },
  title: final.title,
  descLen: final.desc.length,
  tags: payload.tags?.length || 0,
  next: savedToDraft
    ? '图文动态已存进视频号草稿箱。到 channels.weixin.qq.com → 草稿箱 人工预览后点「发表」——脚本按铁律不会替你点。'
    : '点了「保存草稿」但草稿箱没多出一条（或回读对不上），请人工到草稿箱核对——不要重复跑脚本，免得存进两条。',
}, null, 2))
log('截图:', await page.screenshot({ path: '/tmp/sph-autopublish-draft.png' }).catch(() => '截图超时'))
await task.finish({ keep: ['p1'] })
