/**
 * 抖音图文「一键发布（存草稿）」ego-browser 脚本（stdin 运行）
 *
 * 输入：/tmp/media-hub-publish.json → { title, lines[], tags[], imagesAbs[], coverAbs, accountKey, platform, spaceName? }
 * 流程：打开创作页 → 切「发布图文」→ 传图（多页图卡一次全传，自动跳编辑器）→ 填正文 → 填/校标题（上限 20 字）
 *       → Esc 关话题联想 → 点「暂存离开」→ 回上传页看到「上次未发布的图文」横幅即草稿成立
 * 实测坑（2026-09-19）：
 *  - 标题 input 上限 20 字，正文开头几个字若因焦点残留在标题框会把它顶满 —— 正文打完后再强制校一次标题；
 *  - 打完 #话题 会弹联想下拉，须先 Escape 再点「暂存离开」，否则点击被下拉吃掉；
 *  - 草稿不叫「草稿箱」：存成功后回到上传页，顶部出现「你还有上次未发布的图文，是否继续编辑?」。
 * 铁律：**本脚本绝不点击「发布」** —— 只到草稿箱为止；真要发出是 press-publish.mjs 在人确认后点的那一下。
 */

const fs = await import('node:fs')
const payload = JSON.parse(fs.readFileSync('/tmp/media-hub-publish.json', 'utf8'))
// 根目录优先取宿主注入的 MEDIA_HUB_ROOT（run-ego / 服务端 spawn 都会写）：ego 内嵌 Node 不保证
// 跑在项目根，只认 process.cwd() 在装机版（数据目录带空格与中文）上会让动态 import 解析成坏 URL，
// 整版直接炸成 ERR_INVALID_FILE_URL_HOST（2026-10-23 实测）。cwd 只作兜底。
const ROOT = process.env.MEDIA_HUB_ROOT || process.cwd()
const { openSpace, guardJar } = await import(`${ROOT}/scripts/ego-space.mjs`)

const task = await openSpace(payload.spaceName || 'douyin-publish')
// 复用的空间里 p1 可能已被关（上次跑完/人工关页），拿不到就新开一页
const page = (await task.pages()).find((p) => p.label === 'p1') || (await task.newPage())
// 同平台挂了几个号：开工前把浏览器罐子换成这个号的登录态，交还空间时自动换回（只有一个号则不动）
await guardJar(task, page, { accountKey: payload.accountKey, platform: payload.platform })
const log = (...a) => console.log('[dy-publish]', ...a)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 等条件成立，不再按「最慢那一次」干等：命中立刻走，最多等 budget 毫秒。
 *  cond 抛错当作「还没好」（页面在跳转时 evaluate 会失败）。 */
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

/** 风控/验证码是否挡路（滑块、验证码字样），抖音的验证须人工完成 */
async function detectBlocker() {
  return page.evaluate(() => {
    if (/验证码|安全验证|滑动完成拼图|访问验证/.test(document.body.innerText || '')) {
      const m = [...document.querySelectorAll('div')].find((d) => {
        const s = getComputedStyle(d)
        const r = d.getBoundingClientRect()
        return (s.position === 'fixed' || s.position === 'absolute') && +s.zIndex > 100 &&
          r.width > innerWidth * 0.3 && r.height > innerHeight * 0.25
      })
      if (m) return true
    }
    return false
  })
}

async function waitCaptcha(label) {
  if (!(await detectBlocker().catch(() => false))) return false
  log(`${label}：检测到验证/风控——请在 Ego Lite 里人工完成，最多等 240 秒…`)
  const deadline = Date.now() + 240000
  while (Date.now() < deadline) {
    await sleep(5000)
    if (!(await detectBlocker().catch(() => false))) break
  }
  if (await detectBlocker().catch(() => true)) {
    console.log(JSON.stringify({ ok: false, error: '等待验证超时。页面已在 Ego Lite 打开，请人工完成后重试。', captchaWaited: true }))
    await task.handOff()
    process.exit(1)
  }
  log('验证已解除，继续')
  return true
}

// ---- 1. 打开创作上传页，确认登录 ----
await page.goto('https://creator.douyin.com/creator-micro/content/upload')
// 页面渲染完（要么登录墙、要么创作台入口）再判登录态，否则空 body 会判成「已登录」
const rendered = await waitReady(() => page.evaluate(() =>
  /扫码登录|登录抖音|发布图文|上传视频|上传图文|内容管理/.test(document.body?.innerText || '')), 25000, 800)
log('页面到位:', rendered)
const loggedIn = await page.evaluate(() => !/扫码登录|登录抖音/.test((document.body.innerText || '').slice(0, 2000)))
if (!loggedIn) {
  console.log(JSON.stringify({ ok: false, error: '抖音创作者中心未登录，请先在 Ego Lite 登录 creator.douyin.com' }))
  process.exit(1)
}

// ---- 2. 切「发布图文」tab ----
await page.evaluate(() => {
  const els = [...document.querySelectorAll('div,span,li')].filter((e) => {
    const t = (e.innerText || '').trim()
    if (t !== '发布图文') return false
    const r = e.getBoundingClientRect()
    return r.width > 20 && r.height > 10
  })
  els[els.length - 1]?.click()
})
await sleep(1200)
const hasImageInput = await waitReady(() => page.evaluate(() =>
  [...document.querySelectorAll('input[type="file"]')].some((i) => /image|jpg|png|webp/i.test(i.accept)),
), 15000, 800)
if (!hasImageInput) {
  console.log(JSON.stringify({ ok: false, error: '没能切到「发布图文」，页面可能改版' }))
  process.exit(1)
}

// ---- 3. 传图（会自动跳到图文编辑器页）：多页图卡一次全传，旧稿退化成单封面 ----
const images = (payload.imagesAbs?.length ? payload.imagesAbs : [payload.coverAbs]).filter(Boolean)
if (!images.length || !images.every((p) => fs.existsSync(p))) {
  console.log(JSON.stringify({ ok: false, error: '缺少配图（imagesAbs/coverAbs），抖音图文必须有图' }))
  process.exit(1)
}
let captchaWaited = await waitCaptcha('传图前')
await page.setInputFiles('input[type="file"][accept*="image"]', images)
// 传完图才会跳到图文编辑器页，所以「编辑器出现」就是传图完成的信号（脚本头注释实测）；
// 16 页图卡慢的时候要走完真实上传，预算给到 120s。
const editorOk = await waitReady(() => page.evaluate(() =>
  !!document.querySelector('input[placeholder="添加作品标题"]') &&
  !!document.querySelector('.zone-container.editor-kit-container'),
), 120000, 2000)
if (!editorOk) {
  console.log(JSON.stringify({ ok: false, error: '传图后编辑器（标题/正文）未出现，页面可能改版' }))
  await task.finish({ keep: ['p1'] })
  process.exit(1)
}
captchaWaited = (await waitCaptcha('传图后')) || captchaWaited

// ---- 4. 填正文（先正文后标题：正文打字可能因焦点残留顶满 20 字标题框） ----
const focused = await page.evaluate(() => {
  const ed = document.querySelector('.zone-container.editor-kit-container')
  ed.scrollIntoView({ block: 'center' })
  ed.focus()
  const sel = window.getSelection()
  const range = document.createRange()
  range.selectNodeContents(ed)
  range.collapse(false)
  sel.removeAllRanges()
  sel.addRange(range)
  return ed.contains(document.activeElement) || document.activeElement === ed
})
log('编辑器聚焦:', focused)
await sleep(400)
for (let i = 0; i < payload.lines.length; i++) {
  await page.keyboard.insertText(payload.lines[i])
  if (i < payload.lines.length - 1) await page.keyboard.press('Enter')
}
if (payload.tags?.length) {
  await page.keyboard.press('Enter')
  await page.keyboard.insertText(payload.tags.join(' '))
}
await sleep(600)
// 关掉 #话题 联想下拉，否则它会盖住「暂存离开」的点击
await page.keyboard.press('Escape')
await sleep(300)

// ---- 5. 填/校标题（上限 20 字，React 受控 input 用原生 setter） ----
const title = (payload.title || '').slice(0, 20)
const titleState = await page.evaluate((t) => {
  const el = [...document.querySelectorAll('input')].find((i) => (i.placeholder || '').includes('标题'))
  if (!el) return 'no-title-input'
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  setter.call(el, t)
  el.dispatchEvent(new Event('input', { bubbles: true }))
  return 'ok:' + el.value
}, title)
log('标题:', titleState)
await sleep(600)

// ---- 6. 保存前核验：标题/正文/图片三者齐 ----
const final = await page.evaluate(() => {
  const t = [...document.querySelectorAll('input')].find((i) => (i.placeholder || '').includes('标题'))?.value || ''
  const body = document.querySelector('.zone-container.editor-kit-container')?.innerText || ''
  return { title: t, bodyLen: body.length, coverOk: !!document.querySelector('img[src*="byteimg"], img[src*="pic"], img[src*="obj"]') }
})
if (!(final.title === title && final.bodyLen > 0 && final.coverOk)) {
  console.log(JSON.stringify({ ok: false, error: '填写不完整（标题/正文/图缺一项），不保存草稿', final, captchaWaited }))
  await task.finish({ keep: ['p1'] })
  process.exit(1)
}

// ---- 6.5 配乐：默认曲见 config/publish-music.json（payload.music）。曲库里认不出那首就跳过，绝不退而选别的 ----
let music = { want: payload.music?.title || '', applied: false, note: '' }
if (payload.music) {
  try {
    await page.click('text="选择音乐" >> nth=-1', { label: '打开选曲抽屉' })
    await sleep(3000)
    const searchBox = await page.evaluate(() => {
      const i = [...document.querySelectorAll('input')].find((x) => /搜索音乐/.test(x.placeholder || ''))
      if (!i) return null
      const r = i.getBoundingClientRect()
      return { cx: Math.round(r.x + r.width / 2), cy: Math.round(r.y + r.height / 2) }
    })
    if (!searchBox) {
      music.note = '没找到搜索音乐输入框'
    } else {
      await page.mouse.click(searchBox.cx, searchBox.cy, { label: '聚焦音乐搜索框' })
      await sleep(400)
      await page.keyboard.type(payload.music.query, { delay: 150 })
      await page.keyboard.press('Enter')
      await sleep(5000)
      const row = await page.evaluate(({ wantT, wantA }) => {
        const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]/g, '')
        for (const e of document.querySelectorAll('*')) {
          if (e.childElementCount > 0) continue
          const t = norm(e.innerText || '')
          if (!t || t.length > 40 || !t.includes(wantT)) continue
          const r = e.getBoundingClientRect()
          if (r.width < 10 || r.height < 8 || r.x < 850) continue
          let p = e
          for (let i = 0; i < 6 && p.parentElement; i++) {
            p = p.parentElement
            const pt = norm(p.innerText || '')
            if (pt.includes(wantT) && (!wantA || pt.includes(wantA)) && p.getBoundingClientRect().height < 140) break
          }
          const rr = p.getBoundingClientRect()
          if (rr.height > 160) continue
          return { cx: Math.round(rr.x + rr.width / 2), cy: Math.round(rr.y + rr.height / 2) }
        }
        return null
      }, { wantT: (payload.music.title || '').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]/g, ''), wantA: (payload.music.author || '').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]/g, '') })
      if (!row) {
        music.note = `曲库搜索结果里没有「${payload.music.title}」`
      } else {
        await page.mouse.click(row.cx, row.cy, { label: '选中曲目' })
        await sleep(1500)
        // 「使用」只在鼠标悬停那行时才浮出来，而且浮出后行的内容会左移——
        // 按坐标点会点空（实测），所以先 move 过去稳住悬停，再在页内 JS 直接点按钮。
        await page.mouse.move(row.cx, row.cy)
        await sleep(1200)
        const use = await page.evaluate(() => {
          const b = [...document.querySelectorAll('button')].filter((e) => /apply-btn/.test((e.className || '').toString()) && e.offsetHeight > 0)
          if (!b.length) return null
          b[0].click()
          return true
        })
        if (!use) {
          music.note = '点了曲目但没浮出「使用」按钮'
        } else {
          await sleep(3500)
          const landed = await page.evaluate((wantT) => {
            const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]/g, '')
            const label = [...document.querySelectorAll('[class*="title-content"], span, div')]
              .find((e) => (e.innerText || '').trim() === '选择音乐' && e.offsetHeight > 0 && e.getBoundingClientRect().x < 500)
            let box = label
            for (let i = 0; i < 2 && box && box.parentElement; i++) box = box.parentElement
            const text = box ? norm(box.innerText || '') : ''
            return { applied: text.includes(norm(wantT)), row: box ? (box.innerText || '').replace(/\s+/g, ' ').slice(0, 60) : '' }
          }, payload.music.title)
          music.applied = landed.applied
          music.note = landed.applied ? landed.row : `点完「使用」音乐栏没换成目标曲：${landed.row}`
        }
      }
    }
  } catch (e) {
    music.note = `选曲抛错：${String(e.message || e).slice(0, 80)}`
  }
  log('配乐:', JSON.stringify(music))
  await page.keyboard.press('Escape').catch(() => {})
  await sleep(500)
}

// ---- 7. 点「暂存离开」（绝不点「发布」） ----
const btn = await page.evaluate(() => {
  const cands = [...document.querySelectorAll('button, [role="button"], div, span')].filter((e) => {
    const t = (e.innerText || '').trim()
    return t === '暂存离开' && e.offsetHeight > 0
  })
  if (!cands.length) return null
  const el = cands[cands.length - 1]
  el.scrollIntoView({ block: 'center' })
  const r = el.getBoundingClientRect()
  return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
})
if (!btn) {
  console.log(JSON.stringify({ ok: false, error: '找不到「暂存离开」按钮，页面可能改版；草稿页已保留', final }))
  await task.finish({ keep: ['p1'] })
  process.exit(1)
}
await sleep(400)
await page.mouse.click(btn.x, btn.y, { label: '点击暂存离开' })

// ---- 8. 验证：回到上传页出现「上次未发布的图文」横幅 = 草稿已存 ----
// 存成功后页面自己跳回上传页，所以「跳回去」比干等 3 秒更早告诉我们结果；没跳再自己 goto 一次
const backToUpload = await waitReady(async () => /content\/upload/.test(await page.url()), 15000, 800)
log('点完暂存离开回到上传页:', backToUpload)
if (!backToUpload) await page.goto('https://creator.douyin.com/creator-micro/content/upload')
const draftBanner = await waitReady(() => page.evaluate(() =>
  /上次未发布的图文/.test(document.body.innerText || '')), 20000, 1000)

console.log(JSON.stringify({
  ok: draftBanner,
  draftBanner,
  captchaWaited,
  music,
  next: draftBanner
    ? '抖音图文草稿已存。重进「发布图文」传图后点「继续编辑」可复核，人工确认后再点「发布」。'
    : '未检测到草稿横幅，请打开抖音创作页人工核对。',
}, null, 2))

log('截图:', await page.screenshot({ path: '/tmp/dy-autopublish-draft.png' }))
await task.finish({ keep: ['p1'] })
