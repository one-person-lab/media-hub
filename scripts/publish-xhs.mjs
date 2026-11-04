/**
 * 小红书图文「一键发布（存草稿）」ego-browser 脚本（stdin 运行）
 *
 * 输入：/tmp/media-hub-publish.json → { title, lines[], tags[], imagesAbs[], coverAbs, accountKey, platform }
 * 流程：打开发布页 → 切「上传图文」→ 传图（多页图卡一次全传；编辑器有图才出现）→ 解风控 → 填标题/正文/话题
 *       → 点「暂存离开」进草稿箱 → 以草稿箱计数 +1 验证
 * 风控：「限制访问/浏览器异常」遮罩是纯前端 DOM，detectBlocker 识别 + waitCaptcha 等人工；
 *       默认 profile 装有 ChatGPT/Markdown Reader/语雀 三个内容脚本扩展，易触发风控——
 *       干净 profile 只能在 Ego Lite 界面里手建，脚本代不了，所以这里只识遮罩、只等人工。
 * 输出：JSON 状态（savedToDraft / draftCount / captchaWaited）
 * 铁律：**本脚本绝不点击「发布」** —— 只到草稿箱为止；真要发出是 press-publish.mjs 在人确认后点的那一下。
 * 配乐：payload 带了 `music`（默认曲见 config/publish-music.json），本脚本不接——
 *      2026-10-01 实测小红书图文编辑器只有 #话题/@用户/表情/内容设置，全表单零「音乐·配乐」字样，没有配乐入口。
 */

const fs = await import('node:fs')
const payload = JSON.parse(fs.readFileSync('/tmp/media-hub-publish.json', 'utf8'))
// 根目录优先取宿主注入的 MEDIA_HUB_ROOT（run-ego / 服务端 spawn 都会写）：ego 内嵌 Node 不保证
// 跑在项目根，只认 process.cwd() 在装机版（数据目录带空格与中文）上会让动态 import 解析成坏 URL，
// 整版直接炸成 ERR_INVALID_FILE_URL_HOST（2026-10-23 实测）。cwd 只作兜底。
const ROOT = process.env.MEDIA_HUB_ROOT || process.cwd()
const { openSpace, guardJar } = await import(`${ROOT}/scripts/ego-space.mjs`)

const task = await openSpace(payload.spaceName || 'xhs-publish')
// 复用的空间里 p1 可能已被关（上次跑完/人工关页），拿不到就新开一页
const page = (await task.pages()).find((p) => p.label === 'p1') || (await task.newPage())
// 同平台挂了几个号：开工前把浏览器罐子换成这个号的登录态，交还空间时自动换回（只有一个号则不动）
await guardJar(task, page, { accountKey: payload.accountKey, platform: payload.platform })
const log = (...a) => console.log('[xhs-publish]', ...a)

/** 等条件成立再往下走：命中立刻返回，最多等 budget 毫秒（cond 抛错当作「还没好」） */
async function waitReady(cond, budget, step = 1000) {
  const deadline = Date.now() + budget
  for (;;) {
    // cond 同步抛错（页面正在跳转）也算「还没好」
    let hit = false
    try { hit = await cond() } catch { hit = false }
    if (hit) return true
    if (Date.now() >= deadline) return false
    await page.waitForTimeout(step)
  }
}

/** 清掉挡路的 JS 原生对话框（accept = 点确定） */
async function clearDialog() {
  try {
    await page.acceptDialog()
    log('已关闭一个 JS 对话框')
    return true
  } catch {
    return false
  }
}

/** 容错 evaluate：dialog 挡路时 accept 后重试一次 */
async function safeEval(fn) {
  try {
    return await page.evaluate(fn)
  } catch (e) {
    if (await clearDialog()) return await page.evaluate(fn)
    throw e
  }
}

/**
 * 是否被风控遮罩挡住。
 * 关键修正：不能用「编辑器不可点」判断验证码——传图前编辑器本就不存在，会误判干等。
 * 改为只认真实遮罩层：r-captcha-modal / restricted-content / 覆盖视口的高 z 固定层。
 */
async function detectBlocker() {
  return safeEval(() => {
    if (document.querySelector('.r-captcha-modal')) return true
    if (/限制访问|浏览器异常|请完成验证|安全验证/.test(document.body.innerText || '')) {
      const m = [...document.querySelectorAll('div')].find((d) => {
        const s = getComputedStyle(d)
        const r = d.getBoundingClientRect()
        return (s.position === 'fixed' || s.position === 'absolute') && +s.zIndex > 100 &&
          r.width > innerWidth * 0.4 && r.height > innerHeight * 0.3
      })
      if (m) return true
    }
    return false
  })
}

/** 正文编辑器是否已就绪（存在且未被遮罩挡住） */
async function editorReady() {
  if (await detectBlocker()) return false
  return safeEval(() => {
    const ed = document.querySelector('.ProseMirror')
    if (!ed) return false
    const r = ed.getBoundingClientRect()
    const hit = document.elementFromPoint(r.x + r.width / 2, Math.max(80, Math.min(r.y + r.height / 2, innerHeight - 80)))
    return !!hit && (hit === ed || ed.contains(hit))
  })
}

/** 尝试纯前端移除「限制访问/浏览器异常」遮罩（2026-09-19 实测：移除后填写与存草稿均正常） */
async function dismissBlockerDom() {
  return safeEval(() => {
    document.querySelectorAll('.r-captcha-modal').forEach((e) => e.remove())
    ;[...document.querySelectorAll('div')].forEach((d) => {
      const s = getComputedStyle(d)
      const r = d.getBoundingClientRect()
      if ((s.position === 'fixed' || s.position === 'absolute') && +s.zIndex > 9000 &&
        r.width > innerWidth * 0.5 && r.height > innerHeight * 0.5 &&
        !d.querySelector('input,textarea,.ProseMirror')) d.remove()
    })
    return !document.querySelector('.r-captcha-modal') &&
      !/限制访问|浏览器异常/.test((document.querySelector('div[style*="z-index"]')?.innerText) || '')
  })
}

/** 等风控解除：先试自动移除遮罩；移不掉再轮询等用户人工完成（最多 240s） */
async function waitCaptcha(label) {
  if (!(await detectBlocker())) return false
  if (await dismissBlockerDom().catch(() => false) && !(await detectBlocker())) {
    log(`${label}：风控遮罩已自动移除（纯前端 DOM），继续`)
    return true
  }
  log(`${label}：检测到风控遮罩/验证码——请在 Ego Lite 里完成验证（关弹窗或旋转图），最多等 240 秒…`)
  const deadline = Date.now() + 240000
  while (Date.now() < deadline) {
    await page.waitForTimeout(5000)
    if (!(await detectBlocker())) break
  }
  if (await detectBlocker()) {
    console.log(JSON.stringify({ ok: false, error: '等待风控解除超时。发布页已在 Ego Lite 打开，请手动关闭弹窗/完成验证后重试。', captchaWaited: true }))
    await task.handOff()
    process.exit(1)
  }
  log('风控已解除，继续')
  return true
}

// ---- 1. 打开发布页 ----
await page.goto('https://creator.xiaohongshu.com/publish/publish?source=official')
// 渲染完（登录墙或创作台）再判登录态，否则空页面会判成「已登录」往下撞
const rendered = await waitReady(() => safeEval(() =>
  /扫码登录|请登录|上传图文|草稿箱|图片|文字/.test(document.body?.innerText || '')), 25000, 800)
log('页面到位:', rendered)

// 已登录检查
const loggedIn = await safeEval(() => !/扫码登录|请登录/.test(document.body.innerText || ''))
if (!loggedIn) {
  console.log(JSON.stringify({ ok: false, error: '小红书未登录，请先在 Ego Lite 登录 creator.xiaohongshu.com' }))
  process.exit(1)
}

// 草稿箱计数只能在这里读：一旦进入编辑器（传图/填字）页面上就没有「草稿箱(N)」标签了。
// 早先它在保存后才读，拿到 0 当基线，于是 0→5 报成成功——那是假证据。
async function readDraftCount() {
  for (let i = 0; i < 4; i++) {
    const n = await safeEval(() => +((document.body.innerText || '').match(/草稿箱\((\d+)\)/) || [])[1] || -1)
    if (n >= 0) return n
    await page.waitForTimeout(2500)
  }
  return -1
}
const draftCountBefore = await readDraftCount()
log('草稿箱基线数量:', draftCountBefore)

// ---- 2. 切「上传图文」tab（页面有多个隐藏副本，点可见的最内层） ----
await safeEval(() => {
  const els = [...document.querySelectorAll('div,span,li,button')].filter((e) => {
    const t = (e.innerText || '').trim()
    if (!t.startsWith('上传图文')) return false
    const r = e.getBoundingClientRect()
    return r.width > 20 && r.height > 10 && getComputedStyle(e).visibility !== 'hidden'
  })
  els.find((e) => !els.some((o) => o !== e && e.contains(o)))?.click()
})
await page.waitForTimeout(1200)

const hasFileInput = () => safeEval(() =>
  [...document.querySelectorAll('input[type="file"]')].some((i) => /image|jpg|png|webp/i.test(i.accept)))
let tabOk = await waitReady(hasFileInput, 12000, 800)
if (!tabOk) {
  await clearDialog()
  await page.waitForTimeout(1500)
  await safeEval(() => {
    const els = [...document.querySelectorAll('div,span,li,button')].filter((e) => {
      const t = (e.innerText || '').trim()
      if (!t.startsWith('上传图文')) return false
      const r = e.getBoundingClientRect()
      return r.width > 20 && r.height > 10
    })
    els.find((e) => !els.some((o) => o !== e && e.contains(o)))?.click()
  })
  tabOk = await waitReady(hasFileInput, 12000, 800)
  if (!tabOk) {
    console.log(JSON.stringify({ ok: false, error: '没能切到「上传图文」tab，页面可能改版' }))
    process.exit(1)
  }
}

// ---- 3. 先等风控验证码（在传图/填字段之前） ----
let captchaWaited = await waitCaptcha('传图前')

// ---- 4. 传图：小红书图文必须先有图，标题/正文编辑器（.ProseMirror）才会出现 ----
// 2026-09-18 实测：顺序反了会卡在「编辑器不存在」，所以传图提到填字之前。
// 多页图卡按 pages[] 顺序一次全传（imagesAbs），旧稿只有一张封面时退化成单图。
const images = (payload.imagesAbs?.length ? payload.imagesAbs : [payload.coverAbs]).filter(Boolean)
if (!images.length || !images.every((p) => fs.existsSync(p))) {
  console.log(JSON.stringify({ ok: false, error: '这篇没有配图（coverImage / 卡片数据），小红书图文必须有图。先给内容配图。' }))
  process.exit(1)
}
try {
  await page.setInputFiles('input[type="file"]', images)
} catch (e) {
  await clearDialog()
  await page.setInputFiles('input[type="file"]', images)
}
const uploadedAt = Date.now()
// 必须先有图编辑器才出现，所以「.ProseMirror 出现」就是传图完成的信号；16 页图卡走完真实上传给 120s 预算
const editorOk = await waitReady(() => safeEval(() => !!document.querySelector('.ProseMirror')), 120000, 2000)
log(`传图 → 编辑器就位：${Date.now() - uploadedAt}ms`)
await page.waitForTimeout(2000)
if (!editorOk) {
  console.log(JSON.stringify({ ok: false, error: '传完图后编辑器仍未出现，页面可能改版' }))
  await task.finish({ keep: ['p1'] })
  process.exit(1)
}
// 传图常触发风控遮罩——先解除再填字，否则 fill/click 会被 div 拦截
captchaWaited = (await waitCaptcha('传图后')) || captchaWaited

// ---- 5. 填标题（上限 20 字） ----
const title = (payload.title || '').slice(0, 20)
try {
  await page.fill('input[placeholder*="标题"]', title)
} catch (e) {
  await clearDialog()
  await page.fill('input[placeholder*="标题"]', title)
}
await page.waitForTimeout(600)

// ---- 6. 填正文（ProseMirror）+ 话题 ----
const editorText = () => safeEval(() => document.querySelector('.ProseMirror')?.innerText || '')
/** 七张图上传后主线程常被渲染占住，CDP 的 Input.* 会 30s 超时（2026-09-22 实测：正文写完、
 *  写话题时超时）。超时不等于没写进去，所以先核编辑器现状，确实缺了才用剪贴板补一次。 */
async function insertOrPaste(text) {
  if (!text) return
  try {
    await page.keyboard.insertText(text)
  } catch (e) {
    log(`insertText 超时（${String(e.message).split('\n')[0]}），核对编辑器内容`)
  }
  await page.waitForTimeout(500)
  const tail = text.slice(-14)
  if ((await editorText()).includes(tail)) return
  log('内容未落进编辑器，改用剪贴板粘贴')
  await page.keyboard.paste(text)
  await page.waitForTimeout(800)
}
/** Enter 同样可能超时；失败时退化成粘贴换行 */
async function pressEnter() {
  try {
    await page.keyboard.press('Enter')
  } catch {
    await page.keyboard.paste('\n').catch(() => {})
  }
}
// 优先点击聚焦；若被残留遮罩拦截，退回 evaluate 里 focus + 光标置末尾
try {
  await page.click('.ProseMirror')
} catch (e) {
  await clearDialog()
  try {
    await page.click('.ProseMirror')
  } catch {
    await safeEval(() => {
      const ed = document.querySelector('.ProseMirror')
      ed?.focus()
      const sel = window.getSelection()
      sel?.removeAllRanges()
      const r = document.createRange()
      r.selectNodeContents(ed)
      r.collapse(false)
      sel?.addRange(r)
    })
  }
}
await page.waitForTimeout(400)
for (let i = 0; i < payload.lines.length; i++) {
  await insertOrPaste(payload.lines[i])
  if (i < payload.lines.length - 1) await pressEnter()
}
// 话题：以文本形式追加（用户点发布前可把它们转成真正的话题链接）
if (payload.tags?.length) {
  await pressEnter()
  await insertOrPaste(payload.tags.join(' '))
}
await page.waitForTimeout(1200)
// 打完 #话题 会弹联想下拉，可能盖住/吃掉「暂存离开」的点击（抖音脚本 2026-09-19 同款坑），先 Esc 关掉
await page.keyboard.press('Escape').catch(() => {})
await page.waitForTimeout(400)

// ---- 7. 状态核验（标题/正文/封面三者齐了才保存草稿） ----
await page.mouse.wheel(0, 2000).catch((e) => log('滚动核验区失败（不影响保存）：', e.message))
await page.waitForTimeout(1200)
const final = await safeEval(() => {
  const t = document.querySelector('input[placeholder*="标题"]')?.value || ''
  const body = document.querySelector('.ProseMirror')?.innerText || ''
  const pub = [...document.querySelectorAll('button')].find(
    (b) => /^发布$/.test((b.innerText || '').trim()) && b.getBoundingClientRect().width > 0,
  )
  // 封面是否就位：封面区是否有图片预览
  const coverOk = !!document.querySelector('img[src*="xhscdn"], .cover-img, [class*="cover"] img')
  return { title: t, bodyLen: body.length, publishVisible: !!pub, publishDisabled: pub?.disabled ?? null, coverOk }
}) || { title: '', bodyLen: 0, coverOk: false }

if (!(final.title.length > 0 && final.bodyLen > 0 && final.coverOk)) {
  console.log(JSON.stringify({ ok: false, error: '填写不完整（标题/正文/封面缺一项），不保存草稿', final, captchaWaited }))
  await task.finish({ keep: ['p1'] })
  process.exit(1)
}

// ---- 8. 保存为草稿（落进小红书草稿箱；最后一下「发布」由人点） ----
// 实测（2026-09-19）：「暂存离开/发布」在 <xhs-publish-btn> 的 closed shadow root 里，
// 普通 DOM 查询与 DOM.performSearch 都找不到；须用 CDP pierce 树定位 + 真实鼠标点击。
// 实测（2026-10-01）：按钮区有 zoom/缩放，DOM.getBoxModel 的高度会算成 0（按钮其实渲染正常），
// 用它判「按钮在不在」每次都假报错——坐标改从 JS getBoundingClientRect 拿。
async function clickSaveDraft() {
  const byDom = await safeEval(() => {
    const btn = [...document.querySelectorAll('button,span,div,a')].find((b) => {
      const t = (b.innerText || '').trim()
      return t === '暂存离开' || t === '存草稿' || t === '保存草稿' || t === '存为草稿'
    })
    if (btn) { btn.click(); return true }
    return false
  })
  if (byDom) return true
  // CDP pierce：穿透 closed shadow root 找文本节点，取其元素父级坐标后真实点击
  const doc = await page.cdp('DOM.getDocument', { depth: -1, pierce: true })
  const parent = new Map()
  const all = []
  ;(function walk(node, par) {
    all.push(node)
    parent.set(node.nodeId, par)
    for (const c of [...(node.children || []), ...(node.shadowRoots || []), ...(node.pseudoElements || [])]) walk(c, node)
    if (node.contentDocument) walk(node.contentDocument, node)
  })(doc.root, null)
  const text = all.find((n) => n.nodeName === '#text' && /暂存离开/.test(n.nodeValue || ''))
  log(`pierce 扫描 ${all.length} 节点，「暂存离开」文本节点命中:`, text ? JSON.stringify(text.nodeValue.trim()) : '无')
  let el = text ? parent.get(text.nodeId) : null
  let hop = 0
  while (el && el.nodeName !== '#document') {
    try {
      await page.cdp('DOM.scrollIntoViewIfNeeded', { backendNodeId: el.backendNodeId }).catch(() => {})
      await page.waitForTimeout(600)
      const rn = await page.cdp('DOM.resolveNode', { backendNodeId: el.backendNodeId })
      const cf = await page.cdp('Runtime.callFunctionOn', {
        objectId: rn.object.objectId,
        returnByValue: true,
        functionDeclaration: 'function(){ const r = this.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height } }',
      })
      const v = cf.result?.value
      log(`祖先#${hop} <${el.nodeName}> rect: ${v ? `${Math.round(v.w)}×${Math.round(v.h)}@${Math.round(v.x)},${Math.round(v.y)}` : '无'}`)
      if (v && v.w > 10 && v.h > 5) {
        await page.mouse.click(v.x + v.w / 2, v.y + v.h / 2, { label: '点击暂存离开' })
        log('已按坐标点击「暂存离开」')
        return true
      }
    } catch (e) {
      log(`祖先#${hop} <${el.nodeName}> 取框/点击异常:`, String(e.message).split('\n')[0].slice(0, 160))
    }
    el = parent.get(el.nodeId)
    hop++
  }
  const near = await safeEval(() => [...new Set([...document.querySelectorAll('button,div,span,a')]
    .map((e) => (e.innerText || '').trim())
    .filter((t) => t && t.length <= 8 && /暂存|草稿|发布|预览/.test(t)))])
  log('找不到「暂存离开」，页面上相近文案:', (near || []).join(' | ') || '(无)')
  return false
}
let saved = false
try { saved = await clickSaveDraft() } catch (e) {
  log('第一次保存尝试异常:', String(e.message).split('\n')[0].slice(0, 200))
  await clearDialog()
  try { saved = await clickSaveDraft() } catch (e2) { log('第二次保存尝试异常:', String(e2.message).split('\n')[0].slice(0, 200)) }
}
await page.waitForTimeout(3500)

// 验证：草稿箱计数 +1 是最硬的证据（toast 不一定出现，页面可能原地不跳转）
// 没点成「暂存离开」时绝不跳转——那次 goto 会把填好的表单冲回空的上传页，人工反而没了可点的按钮
let draftCountAfter = draftCountBefore
if (saved) {
  await page.goto('https://creator.xiaohongshu.com/publish/publish?source=official').catch(() => {})
  await waitReady(() => safeEval(() => /草稿箱\(\d+\)/.test(document.body?.innerText || '')), 20000, 1000)
  draftCountAfter = await readDraftCount()
}

console.log(JSON.stringify({
  ok: saved && draftCountAfter > draftCountBefore,
  savedToDraft: saved,
  draftCount: { before: draftCountBefore, after: draftCountAfter },
  captchaWaited,
  error: !saved
    ? '没找到「暂存离开」按钮，草稿未保存——页面停在已填好的发布页上，请人工点「暂存离开」存草稿。'
    : (draftCountAfter <= draftCountBefore ? `点了暂存但草稿箱计数没涨（${draftCountBefore} → ${draftCountAfter}），请人工确认草稿箱。` : undefined),
  next: saved
    ? `草稿箱 ${draftCountBefore} → ${draftCountAfter}。打开小红书 App/网页「草稿箱」，人工点该条「发布」即可。`
    : '窗口留在填好的发布页，人工点一次「暂存离开」即进草稿箱（标题/正文/话题/图片均已由脚本填好）。',
}, null, 2))

// 截图只是证据，超时不该让整次推草稿以失败收场（JSON 已经打出去了）
console.log('截图:', await page.screenshot({ path: '/tmp/xhs-autopublish-draft.png' }).catch((e) => `截图超时：${e.message}`))
await task.finish({ keep: ['p1'] })
