/**
 * 克隆皮预览渲：一套临时皮肤参数 + 几个现成版式 → 各渲一张 1242×1660，
 * 落 public/cards/_clone-preview/<hash>-<版式>.png，给「一键克隆爆款视觉」的并排对比用。
 *
 * 为什么单开一个脚本：候选皮还没进 config，render-cards 吃的是卡片 json（要落 content/），
 * 而 resolveTheme 认不到没登记的 theme.id。这里把 tokens 直接拼成 :root 喂给同一个
 * buildPageHtml，跟正式渲染走同一条合成路径——预览不作弊，存下来的一定就是这个样子。
 *
 * 为什么一次渲两页（封面 + 正文）：正文页大多只吃底色和字色，强调色要封面的色带、
 * 步骤页的序号圆底才看得出来。只给一张正文图，人没法判断这条皮像不像。
 *
 * 参数走 base64 argv，不写 /tmp/media-hub-render.json：那个文件是多会话共享单例，谁写谁被改写。
 * 产物按「版式 + 皮」取哈希名：同样的参数第二次直接复用那张 png，不再开浏览器。
 *
 * 运行：node scripts/run-ego.mjs scripts/render-clone-preview.mjs --args --b64 <base64(json)>
 * 输入：{ layouts: ['cover','items'], tokens }  →  输出：{ ok, pages: [{layout,url,cached}] }
 */
const fs = await import('node:fs/promises')
const path = await import('node:path')
const { createHash } = await import('node:crypto')
const { Buffer } = await import('node:buffer')
const { pathToFileURL } = await import('node:url')

const flag = (name) => {
  const i = process.argv.indexOf(name)
  return i < 0 ? '' : process.argv[i + 1]
}

const ROOT = process.cwd()
const C = await import(pathToFileURL(path.join(ROOT, 'scripts/card-core.mjs')).href)
const OUT_DIR = path.join(ROOT, 'public/cards/_clone-preview')

const fail = (msg) => {
  console.log(JSON.stringify({ ok: false, error: msg }))
  process.exit(1)
}

const b64 = flag('--b64')
if (!b64) fail('缺少 --b64（base64 的 {layouts, tokens}）')
let p
try {
  p = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'))
} catch (e) {
  fail(`参数解不开：${String(e?.message || e)}`)
}
const LAYOUTS = (Array.isArray(p.layouts) ? p.layouts : []).map((s) => String(s || '').trim()).filter(Boolean).slice(0, 3)
const TOKENS = p.tokens && typeof p.tokens === 'object' ? p.tokens : null
if (!LAYOUTS.length || !TOKENS) fail('参数里要有 layouts 和 tokens')

const DEMO = JSON.parse(await fs.readFile(path.join(ROOT, 'templates/cards/_demo.json'), 'utf8'))
await fs.mkdir(OUT_DIR, { recursive: true })
const tokenKey = Object.keys(TOKENS).sort().map((k) => `${k}:${TOKENS[k]}`).join(';')
const hashOf = (layout) => createHash('sha1').update(layout + '|' + tokenKey).digest('hex').slice(0, 12)

const pages = []
for (const layout of LAYOUTS) {
  const key = hashOf(layout)
  const png = path.join(OUT_DIR, `${key}-${layout}.png`)
  const url = `/cards/_clone-preview/${key}-${layout}.png`
  let cached = false
  try {
    cached = (await fs.stat(png)).size >= 10_000
  } catch {
    /* 还没渲过 */
  }
  pages.push({ layout, key, png, url, cached })
}

const todo = pages.filter((x) => !x.cached)
if (todo.length) {
  const themeCss = `:root{${Object.entries(TOKENS).map(([k, v]) => `${k}:${v}`).join(';')}}`
  const task = await taskSpace('media-hub 克隆预览')
  const page = task.page('p1')
  await page.cdp('Emulation.setDeviceMetricsOverride', { width: 1242, height: 1660, deviceScaleFactor: 1, mobile: false })
  try {
    for (const x of todo) {
      const body = DEMO[x.layout]
      if (!body) throw new Error(`示例内容里没有「${x.layout}」这一版式（templates/cards/_demo.json 只备了 ${Object.keys(DEMO).join('、')}）`)
      const html = await C.buildPageHtml({
        root: ROOT,
        templatesDir: path.join(ROOT, 'templates/cards'),
        page: body,
        index: 0,
        total: 1,
        brand: DEMO.brand || '',
        themeCss,
      })
      const tmpHtml = `/tmp/media-hub-clone-${x.key}-${x.layout}.html`
      await fs.writeFile(tmpHtml, html)
      await C.shootPage(page, tmpHtml, x.png)
      const bad = await C.verifyImages([x.png], 1)
      if (bad.length) throw new Error(bad.map((v) => v.detail).join('；'))
    }
  } finally {
    await task.finish({ keep: [] })
  }
}

console.log(JSON.stringify({ ok: true, pages: pages.map(({ layout, url, cached }) => ({ layout, url, cached })) }))
