/**
 * 就地发布：人在工作台弹层里确认，脚本替他点平台草稿箱里那一条的「发布」。
 *
 * 用法：node scripts/run-ego.mjs scripts/press-publish.mjs --args --platform <账号 key> [--probe|--confirm]
 * 参数：/tmp/media-hub-press-<key>.json → { account, title, pushedAt }（服务端按号各写一份，不共用单例）
 * 出：  /tmp/media-hub-publish-preview.png（编辑器整屏截图，界面 3 秒轮一次）+ 收尾一行 JSON
 * 信号：/tmp/media-hub-publish-signal ∈ publish | cancel | raise（走文件不走进程信号，同 open-login）
 *
 * 两档：
 *  --probe   只走到编辑器门口：定位、回读、截图、列出候选按钮与表单控件，一个动作都不点。
 *  --confirm 同上，再等人在弹层里点「发布这一条」，点完回读取证。
 *
 * 档位之下还有「发法」：参数文件里的 mode=publish 直接点发布，mode=schedule 先把平台上那格定时打开、
 *  填上 at 给的时间再点发布。两者都只在人按下之后才动，没按下时一个按钮都不点。
 *
 * 口径（2026-10-23 改，原先写在六处的「最后一下人点」）：机器不自动发——脚本只在人于工作台按下之后才动
 * 平台上的发布按钮。没变的那半条：认不出那一格就绝不点，只点「标题 + 保存时间」双判唯一命中的那一条。
 *
 * 实测（2026-10-23 探针）：小红书草稿箱是发布页右侧抽屉，页签「图文笔记(N)」，
 * 每行 = 封面 + 标题 +「保存于 YYYY-MM-DD HH:mm:ss」+ 编辑/删除。**标题会重复**
 * （抽屉里两条「停止内耗最快的方式：把人生当系统管」只差 2 分钟），所以单靠标题不能定人。
 *
 * 实测（2026-11-04 探针）：小红书编辑器里「定时发布」是表单里的一行开关，点标签文字没用，
 * 开关在行尾（行 308×44，落点取行右缘内缩 56px）；翻开后多出 INPUT.d-text，值形如
 * `YYYY-MM-DD HH:mm`（默认现在+1 小时），平台口径北京时间、未来 1 小时～14 天；同时底部那颗
 * 按钮由「发布」改名「定时发布」——所以「定时发布」四个字会同时出现在行标签和按钮上，
 * 按下时取最靠下的那一个（按钮在表单下面）。挂过定时的草稿再进编辑器就是亮着的样子，
 * 这时绝不能再去点行尾（会把定时关掉）。抖音：编辑器形态未实测，确认档一律拦下。
 */
const fs = await import('node:fs')
const cp = await import('node:child_process')

const ROOT = process.env.MEDIA_HUB_ROOT || process.cwd()
const argv = process.argv
const getArg = (f) => { const i = argv.indexOf(f); return i < 0 ? '' : String(argv[i + 1] || '') }
const key = getArg('--platform')
// 档位只认命令行开关，不认参数文件：手跑忘带 --probe 时最坏也只是只读，绝不会替人按下发布
const mode = argv.includes('--confirm') ? 'confirm' : 'probe'
if (!key) {
  console.error('用法: node scripts/run-ego.mjs scripts/press-publish.mjs --args --platform <账号 key> [--probe|--confirm]')
  process.exit(1)
}

const PARAM = `/tmp/media-hub-press-${key}.json`
const PREVIEW = '/tmp/media-hub-publish-preview.png'
const SIGNAL = '/tmp/media-hub-publish-signal'
const die = (code, error, extra = {}) => {
  console.log(JSON.stringify({ ok: false, mode, code, error, ...extra }))
  process.exit(1)
}

const acct = JSON.parse(fs.readFileSync(`${ROOT}/config/accounts.json`, 'utf8')).find((a) => a.key === key)
if (!acct) die('no_account', `config/accounts.json 里没有 key=${key}`)
if (!['小红书', '抖音'].includes(acct.platform)) die('no_adapter', `「${acct.platform}」还没接就地发布，这一版请人工到平台后台点`)

let want
try {
  want = JSON.parse(fs.readFileSync(PARAM, 'utf8'))
} catch {
  die('param_missing', `读不到 ${PARAM}：界面上点「发布」时由服务端先写好这一条要发什么`)
}
if (!want.title) die('param_bad', '参数里没有标题，没法认草稿箱里那一格')
// 发法只认参数文件里的两种值：别的（含缺省）一律按直接发布走，不许拿一个拼错的值去点定时
const how = want.mode === 'schedule' ? 'schedule' : 'publish'
// 界面那颗日期控件给的是「2026-11-04T21:52」，平台时间框里是空格那一版，进来先归一
const at = String(want.at || '').replace('T', ' ')
if (how === 'schedule' && !/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}$/.test(at)) {
  die('param_bad', `定时发布要给「年-月-日 时:分」，读到的是「${at}」`)
}
// 抖音那一侧的编辑器回读还没实测过：先只放探针，跑通一次只读才允许按下真的「发布」
if (mode === 'confirm' && acct.platform === '抖音') {
  die('adapter_unprobed', `「${acct.id}」的就地发布还在只读阶段（编辑器形态未实测），这一版请人工到平台后台点`)
}

const { openSpace, guardJar } = await import(`${ROOT}/scripts/ego-space.mjs`)
const sync = await import(`${ROOT}/scripts/sync-step.mjs`)

// 空间名跟推草稿脚本一字不差：同一只浏览器才看得见刚推进去的那条草稿
const prefix = acct.platform === '小红书' ? 'xhs' : 'douyin'
let task
try {
  task = await openSpace(`${prefix}-publish`)
} catch (e) {
  // ego 抛完还会追一段栈，界面只留尾巴：把原因放进 JSON 里那句
  die('browser', `开不出浏览器：${String(e?.message || e).split('\n')[0]}`)
}
const page = (await task.pages()).find((p) => p.label === 'p1') || (await task.newPage())
// 同平台挂了几个号：这一步要在「看得见那条草稿」的号身上做，先把罐子换成它
try {
  await guardJar(task, page, { accountKey: acct.key, platform: acct.platform, root: ROOT })
} catch (e) {
  die('browser', String(e?.message || e))
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...a) => console.log('[press-publish]', ...a)

/** 等条件成立：命中立刻返回，最多等 budget 毫秒（cond 抛错当作「还没好」） */
async function waitReady(cond, budget, stepMs = 1000) {
  const deadline = Date.now() + budget
  for (;;) {
    let hit = false
    try { hit = await cond() } catch { hit = false }
    if (hit) return true
    if (Date.now() >= deadline) return false
    await sleep(stepMs)
  }
}
async function clearDialog() {
  try { await page.acceptDialog(); return true } catch { return false }
}
async function safeEval(fn) {
  try {
    return await page.evaluate(fn)
  } catch (e) {
    if (await clearDialog()) return await page.evaluate(fn)
    throw e
  }
}

/** 标题归一：与 build-data 判已发布同一把尺子（去大小写与非字非数），否则两处判据会各认一套 */
const norm = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
/** 同一条内容在平台上的两种写法：整标题，或文案首行（短文案版没有独立标题时后台就摆这行） */
function titleHits(rowText) {
  const r = norm(rowText)
  if (r.length < 6) return false
  const cands = [want.title, want.firstLine].filter((t) => norm(t).length >= 6).map(norm)
  return cands.some((c) => r.includes(c) || c.includes(r))
}
/** 「保存于2026-10-03 18:55:01」→ 毫秒；界面给的 pushedAt 是本地 "YYYY-MM-DD HH:mm" */
const toMs = (s) => {
  const m = String(s || '').match(/(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/)
  if (!m) return NaN
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)).getTime()
}
const wantMs = toMs(want.pushedAt)
/** 时间窗 10 分钟：推草稿脚本从进编辑器到落「草稿已推」最多差这一截 */
const nearTime = (savedAt) => !Number.isFinite(wantMs) || Math.abs(toMs(savedAt) - wantMs) <= 10 * 60_000

function takeSignal() {
  try {
    const v = fs.readFileSync(SIGNAL, 'utf8').trim()
    fs.unlinkSync(SIGNAL)
    return v
  } catch {
    return ''
  }
}
const dropPreview = () => { try { fs.unlinkSync(PREVIEW) } catch { /* 没有就删个空 */ } }
function writePreview(dataUrl) {
  try {
    fs.writeFileSync(`${PREVIEW}.tmp`, Buffer.from(String(dataUrl).replace(/^data:image\/\w+;base64,/, ''), 'base64'))
    fs.renameSync(`${PREVIEW}.tmp`, PREVIEW) // 界面每 3 秒读一次，不能读到半张图
    return true
  } catch {
    return false
  }
}
function raise() {
  try { cp.execFileSync('/usr/bin/open', ['-a', 'ego lite']); return true } catch { return false }
}

/**
 * 穿透 closed shadow root 点一个按文字找的按钮。
 * 小红书「发布/暂存离开」住在 <xhs-publish-btn> 的 closed shadow 里，普通 DOM 查询看不见
 * （2026-10-23 探针实测 publishBtn 恒为空），只能走 CDP pierce 树 —— 同 publish-xhs 存草稿那段。
 * 只点「唯一命中」的那一个：命中多个一律不点，宁可不发。
 */
async function pierceClick(re, label) {
  const doc = await page.cdp('DOM.getDocument', { depth: -1, pierce: true })
  const parent = new Map()
  const hits = []
  ;(function walk(node, par) {
    parent.set(node.nodeId, par)
    if (node.nodeName === '#text' && re.test(node.nodeValue || '')) hits.push(node)
    for (const c of [...(node.children || []), ...(node.shadowRoots || []), ...(node.pseudoElements || [])]) walk(c, node)
    if (node.contentDocument) walk(node.contentDocument, node)
  })(doc.root, null)
  log(`pierce 找「${label}」命中 ${hits.length} 个文本节点`)
  if (hits.length !== 1) return hits.length ? 'ambiguous' : 'not_found'
  let el = parent.get(hits[0].nodeId)
  let hop = 0
  while (el && el.nodeName !== '#document') {
    try {
      await page.cdp('DOM.scrollIntoViewIfNeeded', { backendNodeId: el.backendNodeId }).catch(() => {})
      await sleep(500)
      const rn = await page.cdp('DOM.resolveNode', { backendNodeId: el.backendNodeId })
      const cf = await page.cdp('Runtime.callFunctionOn', {
        objectId: rn.object.objectId,
        returnByValue: true,
        functionDeclaration: 'function(){ const r = this.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height } }',
      })
      const v = cf.result?.value
      if (v && v.w > 10 && v.h > 5) {
        await page.mouse.click(v.x + v.w / 2, v.y + v.h / 2, { label: `点「${label}」` })
        log(`已按坐标点「${label}」（祖先#${hop} <${el.nodeName}> ${Math.round(v.w)}×${Math.round(v.h)}）`)
        return true
      }
    } catch (e) {
      log(`祖先#${hop} 取框异常:`, String(e?.message || e).split('\n')[0].slice(0, 140))
    }
    el = parent.get(el.nodeId)
    hop++
  }
  return 'no_box'
}

/** 穿透 pierce 树只读地数命中几个（探针用，绝不点）。「发布」在 closed shadow 里，DOM 查询看不见。 */
async function pierceTexts(re) {
  const doc = await page.cdp('DOM.getDocument', { depth: -1, pierce: true })
  const hits = []
  ;(function walk(node) {
    if (node.nodeName === '#text' && re.test((node.nodeValue || '').trim())) hits.push((node.nodeValue || '').trim())
    for (const c of [...(node.children || []), ...(node.shadowRoots || []), ...(node.pseudoElements || [])]) walk(c)
    if (node.contentDocument) walk(node.contentDocument)
  })(doc.root)
  return hits
}

/** 穿透 pierce 树把所有输入框的形态抄回来（探针用）：定时那一格长什么样（type/placeholder/现值）
 *  只能靠这个看——各平台的日期控件都躲在 shadow 或微前端里，普通 evaluate 一个也看不见。 */
async function pierceInputs() {
  const doc = await page.cdp('DOM.getDocument', { depth: -1, pierce: true })
  const out = []
  ;(function walk(node) {
    if (/^(INPUT|TEXTAREA)$/.test(node.nodeName)) {
      const a = node.attributes || []
      const get = (k) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : '' }
      out.push({
        tag: node.nodeName, type: get('type'), placeholder: get('placeholder'), value: get('value'),
        readOnly: !!get('readonly'), disabled: !!get('disabled'), id: get('id'), cls: get('class').slice(0, 60),
      })
    }
    for (const c of [...(node.children || []), ...(node.shadowRoots || []), ...(node.pseudoElements || [])]) walk(c)
    if (node.contentDocument) walk(node.contentDocument)
  })(doc.root)
  return out
}

/** 穿透 pierce 树按文本找节点，连父节点表一起带回：shadow 里拿不到 DOM handle，只能靠这棵树往上爬祖先 */
async function pierceByText(re) {
  const doc = await page.cdp('DOM.getDocument', { depth: -1, pierce: true })
  const parent = new Map()
  const hits = []
  ;(function walk(node, par) {
    parent.set(node.nodeId, par)
    if (node.nodeName === '#text' && re.test((node.nodeValue || '').trim())) hits.push(node)
    for (const c of [...(node.children || []), ...(node.shadowRoots || []), ...(node.pseudoElements || [])]) walk(c, node)
    if (node.contentDocument) walk(node.contentDocument, node)
  })(doc.root, null)
  return { hits, parent }
}

/** 取一个 pierce 节点的屏幕框（先滚进视口再量：一趟量到的是滚之前的坐标） */
async function boxOfNode(el) {
  try {
    await page.cdp('DOM.scrollIntoViewIfNeeded', { backendNodeId: el.backendNodeId }).catch(() => {})
    await sleep(400)
    const rn = await page.cdp('DOM.resolveNode', { backendNodeId: el.backendNodeId })
    const cf = await page.cdp('Runtime.callFunctionOn', {
      objectId: rn.object.objectId,
      returnByValue: true,
      functionDeclaration: 'function(){ const r = this.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height } }',
    })
    return cf.result?.value || null
  } catch {
    return null
  }
}

/** 按文本找到「它所在那一行」的框：往上收到够宽（≥300）够矮（28–90）的那层祖先，多个命中取最靠上的那个。
 *  行尾那颗圆钮（开关）不在文字上——2026-11-04 探针实测：点文字只弹说明气泡，开关纹丝不动；
 *  收到只包住文字的那层（宽 212 高 20）也不行，圆钮在它的兄弟上。
 *  「定时发布」这四个字会同时出现在设置行和右下角那颗按钮上（开关一亮按钮就改名），所以不能要求唯一命中：
 *  按钮永远在页面底部，取 y 最小的那一行就是设置行。 */
async function pierceRowBox(re, label) {
  const { hits, parent } = await pierceByText(re)
  log(`pierce 找「${label}」所在行，命中 ${hits.length} 个文本节点`)
  if (!hits.length) return { error: 'not_found' }
  let best = null
  for (const h of hits) {
    let el = parent.get(h.nodeId)
    for (let hop = 0; el && el.nodeName !== '#document' && hop < 12; hop++) {
      const v = await boxOfNode(el)
      if (v && v.w >= 300 && v.h >= 28 && v.h <= 90) {
        if (!best || v.y < best.y) best = v
        break
      }
      el = parent.get(el.nodeId)
    }
  }
  return best ? { box: best } : { error: 'no_row' }
}

/** 在某一行的行尾从右往左试几个落点，直到 cond() 成立：各家圆钮宽窄不一，一次点不中很正常 */
async function clickRowTail(box, cond, label, offsets = [56, 30, 82, 14]) {
  for (const d of offsets) {
    await page.mouse.click(box.x + box.w - d, box.y + box.h / 2, { label: `点「${label}」行尾 -${d}` })
    await sleep(1600)
    if (await cond()) return d
  }
  return false
}

/** 找到那个时间输入框：值形如「2026-11-04 04:59」。shadow 里没有 placeholder 可认，只按值认。 */
async function pierceTimeInput() {
  const doc = await page.cdp('DOM.getDocument', { depth: -1, pierce: true })
  const attr = (node, k) => { const i = (node.attributes || []).indexOf(k); return i >= 0 ? node.attributes[i + 1] : '' }
  let hit = null
  ;(function walk(node) {
    if (hit) return
    if (node.nodeName === 'INPUT' && /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}$/.test(attr(node, 'value'))) hit = node
    for (const c of [...(node.children || []), ...(node.shadowRoots || [])]) walk(c)
    if (node.contentDocument && !hit) walk(node.contentDocument)
  })(doc.root)
  return hit
}

/** 读回时间输入框现在的值（没这个框回空串） */
async function readTimeInput() {
  const n = await pierceTimeInput()
  if (!n) return ''
  const i = (n.attributes || []).indexOf('value')
  return i >= 0 ? n.attributes[i + 1] : ''
}

/** 给一个 pierce 节点写值并补发 input/change：Vue 只认这两个事件，直接赋 .value 它收不到。 */
async function setPierceValue(node, v) {
  try {
    const rn = await page.cdp('DOM.resolveNode', { backendNodeId: node.backendNodeId })
    const cf = await page.cdp('Runtime.callFunctionOn', {
      objectId: rn.object.objectId,
      returnByValue: true,
      functionDeclaration: `function(v){
        const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
        s.call(this, v)
        this.dispatchEvent(new Event('input', { bubbles: true }))
        this.dispatchEvent(new Event('change', { bubbles: true }))
        return this.value
      }`,
      arguments: [{ value: v }],
    })
    return cf.result?.value || ''
  } catch {
    return ''
  }
}

/** 按文本找按钮，命中多个时取最靠下那个：开关一翻开，「定时发布」这四个字同时出现在行标签和右下角那颗按钮上，
 *  而按钮永远在表单下面。一个都不命中或量不到框就绝不点。 */
async function pierceLowestBox(re, label) {
  const { hits, parent } = await pierceByText(re)
  log(`pierce 找「${label}」命中 ${hits.length} 个文本节点（取最靠下的）`)
  if (!hits.length) return { error: 'not_found' }
  let best = null
  for (const h of hits) {
    let el = parent.get(h.nodeId)
    for (let hop = 0; el && el.nodeName !== '#document' && hop < 8; hop++) {
      const v = await boxOfNode(el)
      if (v && v.w > 40 && v.h > 18 && v.h <= 90) {
        if (!best || v.y > best.y) best = v
        break
      }
      el = parent.get(el.nodeId)
    }
  }
  return best ? { box: best } : { error: 'no_box' }
}

async function pierceClickLowest(re, label) {
  const { box, error } = await pierceLowestBox(re, label)
  if (!box) return error
  await page.mouse.click(box.x + box.w / 2, box.y + box.h / 2, { label: `点「${label}」` })
  log(`已点「${label}」${Math.round(box.w)}×${Math.round(box.h)} @y=${Math.round(box.y)}`)
  return true
}

/** 整屏截一张（编辑器已 loaded 的那一版才是给人核对的东西） */
async function shotViewport() {
  try {
    const shot = await page.cdp('Page.captureScreenshot', { format: 'png' }, { timeout: 5000 })
    return shot?.data ? writePreview(`data:image/png;base64,${shot.data}`) : false
  } catch {
    return false // 页面在导航，下一轮再截
  }
}

/* ==================== 小红书 ==================== */

const XHS_PUBLISH = 'https://creator.xiaohongshu.com/publish/publish?source=official'

/** 风控遮罩：纯前端 DOM，能拆就拆；拆不掉直接收工报「风控挡路」，不在这里干等（人在工作台前） */
async function xhsBlocker() {
  return await safeEval(() => {
    const t = document.body?.innerText || ''
    if (!/限制访问|浏览器异常|请完成验证|安全验证/.test(t)) return false
    const modal = document.querySelector('.r-captcha-modal')
    if (modal) return true
    return [...document.querySelectorAll('div,section')].some((e) => {
      const s = getComputedStyle(e)
      const r = e.getBoundingClientRect()
      return (s.position === 'fixed' || s.position === 'absolute') && +s.zIndex > 100
        && r.width > innerWidth * 0.3 && r.height > innerHeight * 0.25
    })
  })
}
async function xhsDismiss() {
  await safeEval(() => {
    // 只拆纯装饰层：把带「限制访问」字样的固定层连同其遮罩一起摘掉，页面本体留着继续读
    for (const e of [...document.querySelectorAll('div,section')]) {
      const s = getComputedStyle(e)
      const r = e.getBoundingClientRect()
      if ((s.position === 'fixed' || s.position === 'absolute') && +s.zIndex > 100
        && r.width > innerWidth * 0.3 && r.height > innerHeight * 0.25) e.remove()
    }
  })
  await sleep(800)
}

/** 打开草稿箱抽屉、切到「图文笔记」页签 */
async function xhsOpenDrawer() {
  await page.goto(XHS_PUBLISH, { waitUntil: 'domcontentloaded' })
  if (!(await waitReady(() => safeEval(() => /草稿箱\(\d+\)|扫码登录|请登录|上传图文/.test(document.body?.innerText || '')), 25000))) {
    return 'page_not_ready'
  }
  if (await safeEval(() => /扫码登录|请登录/.test(document.body?.innerText || ''))) return 'logged_out'
  const opened = await safeEval(() => {
    const els = [...document.querySelectorAll('div,span,a,button')]
      .filter((e) => /^草稿箱\s*[（(]\d+[)）]$/.test((e.innerText || '').trim()) && e.getBoundingClientRect().width > 0)
    els.find((e) => !els.some((o) => o !== e && e.contains(o)))?.click()
    return els.length > 0
  })
  if (!opened) return 'no_drawer'
  await sleep(2000)
  await safeEval(() => {
    const els = [...document.querySelectorAll('div,span,li,button')]
      .filter((e) => /^图文笔记[（(]\d+[)）]$/.test((e.innerText || '').trim()))
    els.find((e) => !els.some((o) => o !== e && e.contains(o)))?.click()
  })
  await sleep(2500)
  return 'ok'
}

/** 抽屉里所有图文草稿行：{title, savedAt, box, cover}。行认「保存于」那一串，往上收到含「编辑」的容器。
 *  实测（2026-10-23）：15 条全在 DOM 里，但视口外的封面是懒加载的（querySelector('img') 拿不到），
 *  早先拿「有图」当行判据会把 11 条丢掉——只认「保存于 + 编辑」，图有就有、没有拉倒。 */
async function xhsRows() {
  return await safeEval(() => {
    const out = []
    const seen = new Set()
    for (const node of [...document.querySelectorAll('div,span,p,time')]) {
      const t = (node.innerText || '').trim()
      const m = t.match(/^保存于\s*(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})$/)
      if (!m) continue
      let row = node
      let ok = false
      for (let hop = 0; hop < 6 && row; hop++) {
        const txt = (row.innerText || '').replace(/\s+/g, ' ').trim()
        if (/编辑/.test(txt) && txt.length < 200) { ok = true; break }
        row = row.parentElement
      }
      // 爬到顶也没凑出「含编辑、只这一条」的容器：不是行，丢掉
      if (!ok || !row) continue
      const r = row.getBoundingClientRect()
      const k = `${Math.round(r.x)},${Math.round(r.y)},${Math.round(r.width)}`
      if (seen.has(k) || r.width < 60) continue
      seen.add(k)
      const im = row.querySelector('img')
      const lines = (row.innerText || '').replace(/\s+/g, ' ').trim()
      out.push({
        title: lines.replace(/保存于.*$/, '').replace(/(编辑|删除)\s*$/, '').trim() || '暂无笔记标题',
        savedAt: m[1],
        cover: im ? (im.currentSrc || im.src || '') : '',
        box: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) },
      })
    }
    const tab = ((document.body?.innerText || '').match(/图文笔记[（(](\d+)[)）]/) || [])[1]
    return { rows: out, total: tab ? +tab : out.length }
  })
}

/** 点某一行里的「编辑」：两趟量框（先滚进视口再量，一趟量到的坐标是滚之前的） */
async function xhsEditRow(row) {
  const marked = await page.evaluate((b) => {
    const inRow = (e) => { const r = e.getBoundingClientRect(); return r.x >= b.x - 4 && r.y >= b.y - 4 && r.right <= b.x + b.width + 4 && r.bottom <= b.y + b.height + 4 }
    const els = [...document.querySelectorAll('a,button,span,div,i')].filter((e) => (e.innerText || '').trim() === '编辑' && inRow(e) && e.getBoundingClientRect().width > 0)
    const inner = els.find((e) => !els.some((o) => o !== e && e.contains(o)))
    if (!inner) return false
    inner.setAttribute('data-ego-edit', '1')
    inner.scrollIntoView({ block: 'center' })
    return true
  }, row.box)
  if (!marked) return false
  await sleep(600)
  const pos = await page.evaluate(() => {
    const el = document.querySelector('[data-ego-edit]')
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
  })
  if (!pos) return false
  await page.mouse.click(pos.x, pos.y, { label: '点「编辑」' })
  await sleep(4000)
  return true
}

/** 编辑器回读：标题、正文长度、图数。
 *  实测（2026-10-23 三次探针）：点「编辑」是原地加载，草稿灌进表单的快慢不定
 *  ——一次 3 秒就好了，一次 20 秒还是张空表（读到 title:"" images:3，那 3 张是页面头像）。
 *  所以水合判据要能撑到 40 秒：标题非空，或正文编辑器出现且缩略图多于页面装饰。
 *  标题框的 placeholder 是「填写标题会有更多赞哦」，含「标题」二字。 */
const HYDRATED = () => {
  const t = document.querySelector('input[placeholder*="标题"]')?.value || ''
  const imgs = [...document.querySelectorAll('img')].filter((i) => /xhscdn/.test(i.currentSrc || i.src)).length
  return t.length > 0 || (!!document.querySelector('.ProseMirror') && imgs >= 4)
}
async function xhsEditor() {
  const hydrated = await waitReady(() => safeEval(HYDRATED), 40000, 1500)
  const ed = await safeEval(() => {
    const t = document.querySelector('input[placeholder*="标题"]')?.value || ''
    const body = [...document.querySelectorAll('.ProseMirror,.ql-editor,[contenteditable="true"]')]
      .map((e) => (e.innerText || '').trim()).sort((a, b) => b.length - a.length)[0] || ''
    const imgs = new Set([...document.querySelectorAll('img')].map((i) => i.currentSrc || i.src).filter((s) => /xhscdn/.test(s)))
    return { url: location.href, title: t, bodyLen: body.length, bodyHead: body.slice(0, 60), images: imgs.size }
  })
  return { ...ed, hydrated }
}

/** 把这一版挂上定时：翻开「定时发布」开关 → 填时间 → 核对读回来的值。
 *  实测（2026-11-04 探针）：开关是行尾那颗圆钮（点文字只弹说明气泡，四个落点里 -56 那个点得中）；
 *  翻开后右侧长出一个值形如「2026-11-04 04:59」的输入框（默认给 now+1h），
 *  右下角那颗按钮跟着从「发布」变成「定时发布」。平台口径：北京时间，只收未来 1 小时～14 天。 */
async function xhsArmSchedule(at) {
  // 已经挂过定时的草稿再进来就是这一副样子：开关是亮的、时间框已经在了。这时无脑点行尾会把定时关掉。
  const wasOn = Boolean(await readTimeInput())
  let now = await readTimeInput()
  if (!now) {
    const row = await pierceRowBox(/^定时发布$/, '定时发布')
    if (!row.box) return { ok: false, step: 'switch', error: `找不到「定时发布」那一行（${row.error}）` }
    const off = await clickRowTail(row.box, async () => !!(await readTimeInput()), '定时发布')
    if (!off) return { ok: false, step: 'switch', error: '行尾四个落点都没翻开「定时发布」开关' }
    await sleep(1200)
    now = await readTimeInput()
  }
  const n = await pierceTimeInput()
  if (now !== at && n) now = await setPierceValue(n, at)
  if (now !== at) {
    // 组件不认合成事件就打字进去：点框 → 全选 → 逐字 → 回车（同 publish-mp 挂小程序那次的教训）
    const box = n ? await boxOfNode(n) : null
    if (box) {
      await page.mouse.click(box.x + box.w / 2, box.y + box.h / 2, { label: '点时间框' })
      await sleep(800)
      await page.keyboard.press('Meta+a').catch(() => {})
      await page.keyboard.insertText(at).catch(() => {})
      await page.keyboard.press('Enter').catch(() => {})
      await sleep(1500)
      now = await readTimeInput()
    }
  }
  if (now !== at) return { ok: false, step: 'time', error: `时间框读回「${now || '空的'}」，不是要定的「${at}」`, want: at }
  return { ok: true, at, wasOn }
}

/* ==================== 抖音 ==================== */

const DY_UPLOAD = 'https://creator.douyin.com/creator-micro/content/upload'

/** 抖音没有草稿箱列表：图文草稿是单槽，回上传页顶部浮「上次未发布的图文」横幅（同 publish-douyin 的进箱凭据） */
async function dyBanner() {
  await page.goto(DY_UPLOAD, { waitUntil: 'domcontentloaded' })
  if (!(await waitReady(() => safeEval(() => /上次未发布|发布图文|扫码登录|请登录/.test(document.body?.innerText || '')), 25000))) {
    return { state: 'page_not_ready' }
  }
  if (await safeEval(() => /扫码登录|请登录/.test(document.body?.innerText || ''))) return { state: 'logged_out' }
  const hit = await safeEval(() => {
    const els = [...document.querySelectorAll('div,span,a,button,p')].filter((e) => {
      const t = (e.innerText || '').replace(/\s+/g, ' ').trim()
      return /上次未发布/.test(t) && t.length < 120 && e.getBoundingClientRect().width > 0
    })
    const inner = els.find((e) => !els.some((o) => o !== e && e.contains(o)))
    if (!inner) return null
    const r = inner.getBoundingClientRect()
    return { text: (inner.innerText || '').replace(/\s+/g, ' ').trim(), box: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) } }
  })
  return hit ? { state: 'ok', ...hit } : { state: 'no_banner' }
}

/** 点横幅上的「继续编辑」进编辑器（单槽只有一条，不存在认错；标题还要回读校一遍） */
async function dyEnterDraft() {
  const marked = await page.evaluate(() => {
    const els = [...document.querySelectorAll('a,button,span,div')].filter((e) => {
      const t = (e.innerText || '').trim()
      return /^(继续编辑|立即编辑|去编辑)$/.test(t) && e.getBoundingClientRect().width > 0
    })
    const inner = els.find((e) => !els.some((o) => o !== e && e.contains(o)))
    if (!inner) return false
    inner.setAttribute('data-ego-edit', '1')
    inner.scrollIntoView({ block: 'center' })
    return true
  })
  if (!marked) return false
  await sleep(600)
  const pos = await page.evaluate(() => {
    const el = document.querySelector('[data-ego-edit]')
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
  })
  if (!pos) return false
  await page.mouse.click(pos.x, pos.y, { label: '点「继续编辑」' })
  await sleep(5000)
  return true
}

/** 抖音编辑器：标题取第一个非空 input/textarea，正文取最长的 contenteditable。
 *  ⚠️ 未实测（2026-10-23）：抖音这一路只照着 publish-douyin 的形态推的，主流程对抖音的
 *  --confirm 一档先锁死（见下文 adapter_unprobed），跑通一次只读探针才放开。 */
async function dyEditor() {
  await waitReady(() => safeEval(() => [...document.querySelectorAll('input,textarea')]
    .some((e) => (e.value || '').trim().length > 2)), 20000, 1200)
  return await safeEval(() => {
    const inp = [...document.querySelectorAll('input,textarea')].map((e) => e.value || '').filter((v) => v.trim().length > 0)
    const ed = [...document.querySelectorAll('[contenteditable="true"]')].map((e) => (e.innerText || '').trim())
      .sort((a, b) => b.length - a.length)[0] || ''
    return { url: location.href, title: inp[0] || '', inputs: inp.slice(0, 3), bodyLen: ed.length, bodyHead: ed.slice(0, 60) }
  })
}

/* ==================== 主流程 ==================== */

const out = { ok: true, mode, how, account: acct.id, platform: acct.platform, title: want.title, pushedAt: want.pushedAt || '', at }
let keepPage = true
try {
  try { await page.cdp('Emulation.setFocusEmulationEnabled', { enabled: true }) } catch { /* 不支持就认了 */ }
  dropPreview()
  takeSignal() // 上一轮没取走的信号别带到这一次

  const isXhs = acct.platform === '小红书'
  let rows = []
  let hit = null
  let drawerTotal = null

  if (isXhs) {
    if (await xhsBlocker()) { await xhsDismiss(); if (await xhsBlocker()) { out.outcome = 'blocked'; out.error = '小红书风控遮罩挡路（限制访问/浏览器异常），脚本没有点任何东西' } }
    if (!out.outcome) {
      const opened = await xhsOpenDrawer()
      if (opened !== 'ok') { out.outcome = opened }
      else {
        const r = await xhsRows()
        rows = r.rows || []
        drawerTotal = r.total ?? rows.length
        sync.progress(acct.platform, '找那一格', undefined, undefined, `草稿箱 ${drawerTotal} 条，按标题+时间筛`)
      }
    }
  } else {
    if (await safeEval(() => /限制访问|验证码|安全验证|滑动完成拼图/.test(document.body?.innerText || '')).catch(() => false)) {
      out.outcome = 'blocked'
      out.error = '抖音风控挡路，脚本没有点任何东西'
    }
    if (!out.outcome) {
      const b = await dyBanner()
      if (b.state !== 'ok') out.outcome = b.state
      else {
        // 横幅上的文案带标题时顺手校一眼；对不上也照走（单槽只有一条），但把疑点记进输出
        out.banner = b.text
        hit = { title: b.text, savedAt: '', box: b.box, single: true }
      }
    }
  }

  if (!out.outcome) {
    if (isXhs) {
      const byTitle = rows.filter((r) => titleHits(r.title))
      // 标题唯一就直接认；标题重复（实测箱里五条「停止内耗…」）才用「保存于」落在推送时间 ±10 分钟里分辨。
      // 时间不能当硬筛：一进「编辑」平台就把那一条的保存时间刷成当下（2026-10-23 探针第二次就这样找不到自己了）。
      const cands = byTitle.length === 1 ? byTitle : byTitle.filter((r) => nearTime(r.savedAt))
      out.candidates = rows.length
      if (cands.length !== 1) {
        out.outcome = cands.length > 1 ? 'ambiguous' : 'not_found'
        // 认不出就把整屏截回去给人看，别只留一句「没找到」；顺带把箱里到底有什么列出来
        out.lookedFor = { title: want.title, pushedAt: want.pushedAt || '' }
        out.inBox = rows.slice(0, 12).map((r) => `${r.title} · 保存于 ${r.savedAt}`)
        out.similar = byTitle.slice(0, 5).map((r) => `${r.title} · 保存于 ${r.savedAt}`)
        if (cands.length > 1) out.error = `标题「${want.title}」在草稿箱里命中 ${cands.length} 条且保存时间分不开，脚本一个都没点，请人工到后台确认哪一条是这一版`
        const full = await page.cdp('Page.captureScreenshot', { format: 'png' }, { timeout: 5000 }).catch(() => null)
        if (full?.data) writePreview(`data:image/png;base64,${full.data}`)
      } else {
        hit = cands[0]
        out.matched = { title: hit.title, savedAt: hit.savedAt }
      }
    }
  }

  if (!out.outcome && hit) {
    // 只进一次编辑器：人要核对的是编辑器里真正 loaded 的这一版，不是抽屉里那张缩略图
    sync.progress(acct.platform, '打开这一格', undefined, undefined, `${hit.title} · ${hit.savedAt || '单槽草稿'}`)
    const entered = isXhs ? await xhsEditRow(hit) : await dyEnterDraft()
    out.entered = entered
    if (!entered) {
      out.outcome = 'editor_not_open'
      out.error = isXhs ? '点了那一行的「编辑」但编辑器没打开，脚本没有点发布' : '横幅上没找到「继续编辑」，脚本没有点发布'
    } else {
      const ed = isXhs ? await xhsEditor() : await dyEditor()
      out.editor = ed
      // 最后一道闸：编辑器里的标题必须就是这一版。推草稿时标题按平台上限截过（小红书 20 字），
      // 所以两边允许是前后缀关系；正文与图都读到空说明表单还没灌上，宁可不发。
      const edT = norm(ed?.title)
      const wantT = norm(want.title)
      out.editorTitleMatches = edT.length >= 6 && (edT === wantT || wantT.startsWith(edT) || edT.startsWith(wantT))
      const emptyForm = !(ed?.bodyLen > 0 || ed?.images > 0)
      if (ed?.hydrated === false) {
        out.outcome = 'editor_not_ready'
        out.error = '编辑器等了 40 秒还没把这一版灌上表单（读到空表），脚本没有点发布'
      } else if (!out.editorTitleMatches || emptyForm) {
        out.outcome = 'mismatch'
        out.error = `编辑器里的标题不是这一版（读到「${ed?.title || ''}」${emptyForm ? '，而且正文和图都是空的' : ''}），脚本没有点发布`
      } else {
        // 定时这一档在人按下之前就要翻开：人要核对的是平台上真正挂上去的那个时间，不是稿上写的串
        if (mode === 'confirm' && how === 'schedule') {
          if (!isXhs) {
            out.outcome = 'schedule_unprobed'
            out.error = `「${acct.platform}」的定时控件还没实测过，这一版请人工到平台后台挂定时`
          } else {
            sync.progress(acct.platform, '挂上定时', undefined, undefined, `定时 ${at}`)
            const armed = await xhsArmSchedule(at)
            out.armed = armed
            if (!armed.ok) {
              out.outcome = 'schedule_not_armed'
              out.error = `${armed.error}——脚本一个按钮都没点`
            }
          }
        }
        out.previewWritten = await shotViewport()
        if (mode === 'probe') {
          // 探针档：把门口看见的东西列回来，一个动作都不点
          out.publishButtons = (await pierceTexts(/^发布$/)).length
          out.buttonTexts = [...new Set(await pierceTexts(/^(发布|定时发布|暂存离开|发布笔记|笔记预览|封面预览)$/))]
          out.scheduleTexts = [...new Set(await pierceTexts(/定时|预约|时间|草稿/))].slice(0, 20)
          out.inputs = (await pierceInputs()).slice(0, 30)
          // 把「真要按下时会点哪一格」量回来：探针既不翻开关也不点按钮
          out.timeInput = await readTimeInput()
          out.pressTarget = await pierceLowestBox(how === 'schedule' ? /^定时发布$/ : /^发布$/,
            how === 'schedule' ? '定时发布' : '发布')
          out.outcome = 'probed'
        } else if (!out.outcome) {
          const DEADLINE = Date.now() + 240_000 // 必须落在服务端任务超时之内，否则被从外面掐死（没输出）
          let sig = ''
          const t0 = Date.now()
          for (;;) {
            sig = takeSignal()
            // 人在界面上按了停止：与取消同一条路——这一版绝不点「发布」
            if (sig === 'cancel' || sync.stopRequested()) break
            if (sig === 'raise') { raise(); try { await page.cdp('Page.bringToFront') } catch { /* 拉不到就算了 */ } }
            if (sig === 'publish') break
            if (await shotViewport()) out.previewWritten = true // 编辑器还在补渲染时第一张可能是半成品，每轮补一张
            sync.progress(acct.platform, '等你确认', undefined, undefined, `${ed.title} · 已等 ${Math.round((Date.now() - t0) / 1000)} 秒`)
            if (Date.now() > DEADLINE) break
            await sleep(2500)
          }
          if (sig !== 'publish') {
            out.outcome = sig === 'cancel' || sync.stopRequested() ? 'cancelled' : 'timeout'
          } else {
            // 翻开定时之后，右下角那颗按钮的字就从「发布」换成了「定时发布」——点的字跟着发法走
            const pressed = how === 'schedule'
              ? await pierceClickLowest(/^定时发布$/, '定时发布')
              : await pierceClick(/^发布$/, '发布')
            out.pressed = pressed
            if (pressed !== true) {
              out.outcome = 'no_publish_btn'
              out.error = pressed === 'ambiguous'
                ? `页面上有多个「${how === 'schedule' ? '定时发布' : '发布'}」，认不出该点哪个，没点`
                : `没找到可点的「${how === 'schedule' ? '定时发布' : '发布'}」按钮，没点`
            } else {
              await sleep(4000)
              // 有的平台点完发布弹二次确认（「确认发布/确定」）。只认唯一命中的，多个一律不点。
              out.confirmed = await pierceClick(/^(确认发布|确定发布|确认并发布|确定)$/, '二次确认')
              await sleep(6000)
              // 挂上定时与直接发出，在草稿箱里是同一个动作：那一条都不再躺在箱里
              const done = how === 'schedule' ? 'scheduled' : 'published'
              if (isXhs) {
                const reopened = await xhsOpenDrawer()
                const after = reopened === 'ok' ? await xhsRows() : null
                out.drafts = { before: drawerTotal, after: after?.total ?? null }
                if (!after) {
                  out.outcome = 'unverified'
                  out.error = `点完${how === 'schedule' ? '定时发布' : '发布'}后回读草稿箱没成功（${reopened}），请到平台确认这一条发出去了没`
                } else if (after.total < drawerTotal) {
                  out.outcome = done
                } else {
                  out.outcome = 'unverified'
                  out.error = `点了${how === 'schedule' ? '定时发布' : '发布'}但草稿箱没少一条（${drawerTotal} → ${after.total}），请到平台确认`
                }
              } else {
                const b = await dyBanner()
                out.bannerAfter = b.state
                out.outcome = b.state === 'no_banner' ? done : 'unverified'
                if (out.outcome === 'unverified') out.error = '点完但「上次未发布的图文」还在，草稿没被发出去，请到平台确认'
              }
            }
          }
        }
      }
    }
  }
  out.ok = ['published', 'scheduled', 'probed'].includes(out.outcome)
} catch (e) {
  out.ok = false
  out.outcome = 'crashed'
  out.error = String(e?.stack || e).split('\n').slice(0, 3).join(' | ')
} finally {
  dropPreview() // 收工后别让下一张弹层误显示这张过期的图
  if (out.outcome === 'cancelled') keepPage = false
}

console.log('[press-publish] ' + JSON.stringify(out))
try {
  await task.finish({ keep: keepPage ? [page.label] : [] })
} catch {
  try { await task.finish({ keep: [] }) } catch { /* 交不回收尾不影响结果 */ }
}
