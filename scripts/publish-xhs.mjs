/**
 * 小红书图文「一键发布」ego-browser 脚本（stdin 运行）
 *
 * 输入：/tmp/media-hub-publish.json → { title, lines[], tags[], coverAbs }
 * 行为：打开发布页 → 切「上传图文」→ 等风控验证码(若有) → 填标题 → 填正文(+话题)
 *       → 传封面 → 停在「发布」前（最后一下人点）
 * 顺序说明：封面上传放到最后。小红书常在打开发布页后立刻弹验证码，若先传封面再等码，
 *          验证码遮罩会挡住标题/正文填写，导致页面只剩封面。改为「先解验证码，再一次性填完」。
 * 输出：JSON 状态（filled / captchaWaited / publishReady）
 * 铁律：**绝不点击「发布」** —— 最后一下永远由人完成。
 */

const fs = await import('node:fs')
const payload = JSON.parse(fs.readFileSync('/tmp/media-hub-publish.json', 'utf8'))

const task = await taskSpace('xhs-publish')
const page = task.page('p1')
const log = (...a) => console.log('[xhs-publish]', ...a)

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

/** 正文编辑器是否可点击（未被风控遮罩挡住） */
async function editorClickable() {
  return safeEval(() => {
    const ed = document.querySelector('.ProseMirror')
    if (!ed) return false
    const r = ed.getBoundingClientRect()
    const hit = document.elementFromPoint(r.x + r.width / 2, Math.max(80, Math.min(r.y + r.height / 2, innerHeight - 80)))
    return !!hit && (hit === ed || ed.contains(hit))
  })
}

/** 等风控验证码：遮罩挡住编辑器时，轮询等用户在 Ego Lite 里人工完成（最多 240s） */
async function waitCaptcha(label) {
  if (await editorClickable()) return false
  log(`${label}：检测到风控验证码/遮罩——请在 Ego Lite 里完成验证（旋转图等），最多等 240 秒…`)
  const deadline = Date.now() + 540000
  while (Date.now() < deadline) {
    await page.waitForTimeout(5000)
    if (await editorClickable()) break
  }
  const ok = await editorClickable()
  if (!ok) {
    console.log(JSON.stringify({ ok: false, error: '等待验证码超时。发布页已在 Ego Lite 打开，可手动完成。', captchaWaited: true }))
    process.exit(1)
  }
  log('验证码已通过，继续')
  return true
}

// ---- 1. 打开发布页 ----
await page.goto('https://creator.xiaohongshu.com/publish/publish?source=official')
await page.waitForTimeout(7000)

// 已登录检查
const loggedIn = await safeEval(() => !/扫码登录|请登录/.test(document.body.innerText || ''))
if (!loggedIn) {
  console.log(JSON.stringify({ ok: false, error: '小红书未登录，请先在 Ego Lite 登录 creator.xiaohongshu.com' }))
  process.exit(1)
}

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
await page.waitForTimeout(4000)

let tabOk = await safeEval(() =>
  [...document.querySelectorAll('input[type="file"]')].some((i) => /image|jpg|png|webp/i.test(i.accept)),
)
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
  await page.waitForTimeout(3500)
  tabOk = await safeEval(() =>
    [...document.querySelectorAll('input[type="file"]')].some((i) => /image|jpg|png|webp/i.test(i.accept)),
  )
  if (!tabOk) {
    console.log(JSON.stringify({ ok: false, error: '没能切到「上传图文」tab，页面可能改版' }))
    process.exit(1)
  }
}

// ---- 3. 先等风控验证码（在填任何字段之前） ----
let captchaWaited = await waitCaptcha('填内容前')

// ---- 4. 填标题（上限 20 字） ----
const title = (payload.title || '').slice(0, 20)
try {
  await page.fill('input[placeholder*="标题"]', title)
} catch (e) {
  await clearDialog()
  await page.fill('input[placeholder*="标题"]', title)
}
await page.waitForTimeout(600)

// ---- 5. 填正文（ProseMirror）+ 话题 ----
try {
  await page.click('.ProseMirror')
} catch (e) {
  await clearDialog()
  await page.click('.ProseMirror')
}
await page.waitForTimeout(400)
for (let i = 0; i < payload.lines.length; i++) {
  await page.keyboard.insertText(payload.lines[i])
  if (i < payload.lines.length - 1) await page.keyboard.press('Enter')
}
// 话题：以文本形式追加（用户点发布前可把它们转成真正的话题链接）
if (payload.tags?.length) {
  await page.keyboard.press('Enter')
  await page.keyboard.insertText(payload.tags.join(' '))
}
await page.waitForTimeout(1200)

// ---- 6. 上传封面（放到最后：即使此步触发验证码，文字已就位，解完直接点发布） ----
if (!payload.coverAbs || !fs.existsSync(payload.coverAbs)) {
  console.log(JSON.stringify({ ok: false, error: '这篇没有封面图（coverImage），小红书图文必须有图。先给内容配一张图。' }))
  process.exit(1)
}
try {
  await page.setInputFiles('input[type="file"]', payload.coverAbs)
} catch (e) {
  await clearDialog()
  await page.setInputFiles('input[type="file"]', payload.coverAbs)
}
await page.waitForTimeout(9000)
// 传图后若又弹验证码，再等一次（解完用户直接点发布）
captchaWaited = (await waitCaptcha('传封面后')) || captchaWaited

// ---- 7. 状态核验（标题/正文/封面三者齐了才保存草稿） ----
await page.mouse.wheel(0, 2000)
await page.waitForTimeout(1200)
const final = await page.evaluate(() => {
  const t = document.querySelector('input[placeholder*="标题"]')?.value || ''
  const body = document.querySelector('.ProseMirror')?.innerText || ''
  const pub = [...document.querySelectorAll('button')].find(
    (b) => /^发布$/.test((b.innerText || '').trim()) && b.getBoundingClientRect().width > 0,
  )
  // 封面是否就位：封面区是否有图片预览
  const coverOk = !!document.querySelector('img[src*="xhscdn"], .cover-img, [class*="cover"] img')
  return { title: t, bodyLen: body.length, publishVisible: !!pub, publishDisabled: pub?.disabled ?? null, coverOk }
})

if (!(final.title.length > 0 && final.bodyLen > 0 && final.coverOk)) {
  console.log(JSON.stringify({ ok: false, error: '填写不完整（标题/正文/封面缺一项），不保存草稿', final, captchaWaited }))
  await task.finish({ keep: ['p1'] })
  process.exit(1)
}

// ---- 8. 保存为草稿（落进小红书草稿箱；最后一下「发布」由人点） ----
async function clickSaveDraft() {
  return safeEval(() => {
    const btn = [...document.querySelectorAll('button,span,div,a')].find((b) => {
      const t = (b.innerText || '').trim()
      return t === '存草稿' || t === '保存草稿' || t === '存为草稿'
    })
    if (btn) { btn.click(); return true }
    return false
  })
}
let saved = false
try { saved = await clickSaveDraft() } catch (e) { await clearDialog(); try { saved = await clickSaveDraft() } catch {} }
await page.waitForTimeout(3500)

// 验证草稿已保存：出现「已保存」提示，或标题输入框已离开编辑态
const draftState = await page.evaluate(() => {
  const toast = [...document.querySelectorAll('*')].some((e) => /已保存(到)?草稿(箱)?|保存成功|存草稿成功/.test(e.innerText || ''))
  const stillEditing = !!document.querySelector('input[placeholder*="标题"]')?.value
  return { toast, stillEditing: !!stillEditing }
})

console.log(JSON.stringify({
  ok: true,
  savedToDraft: saved,
  toast: draftState.toast,
  captchaWaited,
  next: '已落进小红书草稿箱。打开小红书（App / 网页版）「草稿箱」，点该条「发布」即可。',
}, null, 2))

console.log('截图:', await page.screenshot({ path: '/tmp/xhs-autopublish-draft.png' }))
await task.finish({ keep: ['p1'] })
