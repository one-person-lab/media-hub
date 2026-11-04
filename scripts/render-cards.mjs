/**
 * 图文卡片渲染：文案 JSON → templates/cards/<版式>.html → 多页 1242×1660 PNG
 *
 * 运行：node scripts/run-ego.mjs scripts/render-cards.mjs --args --card <卡片json路径> [--only 2,5]
 *      （--only 是 1 基页号，只重渲改动页；创作台保存文字时用它，全量渲染不必带）
 *      兼容旧参数文件：/tmp/media-hub-render.json → { cardJson(绝对路径) 或 cardRel(仓库根相对路径), root }
 *
 * 输出：public/cards/<slug>/01.png、02.png …（一页一张，小红书/抖音图文按顺序上传）
 *      同时写 public/cards/<slug>/manifest.json → { slug, images: [绝对路径…] }
 *
 * 版式不固定：卡片 json 的 pages[] 逐页声明 layout，渲染器按名取 templates/cards/<layout>.html。
 * 新增一种排版 = 往 templates/cards/ 丢一个 html，不必改这里的逻辑。
 * 皮肤与内容核查都在 scripts/card-core.mjs（这里只做取参数、打回、截图、落清单）。
 * 兼容旧格式：没有 pages[] 时，按「单页问题 + 编号清单」渲染 templates/reverse-card.html。
 */
const fs = await import('node:fs/promises')
const path = await import('node:path')
const { pathToFileURL } = await import('node:url')

/** 脚本开关只能走 argv：ego 内嵌 Node 不透传宿主环境变量，/tmp 参数文件又是多会话共享单例（并发会互相改写） */
const flag = (name) => {
  const i = process.argv.indexOf(name)
  return i < 0 ? '' : process.argv[i + 1]
}

const cardArg = flag('--card')
// 带 --card 时完全不读参数文件：那是多会话共享单例，残留的 root 会把路径带偏
const params = cardArg ? {} : JSON.parse(await fs.readFile('/tmp/media-hub-render.json', 'utf8').catch(() => '{}'))
const ROOT = params.root || process.cwd()
const CARD_JSON = cardArg ? path.resolve(ROOT, cardArg) : params.cardJson || (params.cardRel ? path.join(ROOT, params.cardRel) : '')
if (!CARD_JSON) {
  console.log(JSON.stringify({ ok: false, error: '缺少 --card <卡片json路径>（或 /tmp/media-hub-render.json 里的 cardJson/cardRel）' }))
  process.exit(1)
}
// --only 2,5：1 基页号，只重渲这几页（其余页沿用已渲染的 png）
const ONLY = (flag('--only') || '').split(',').map((s) => Number(s.trim())).filter((n) => n >= 1)

const C = await import(pathToFileURL(path.join(ROOT, 'scripts/card-core.mjs')).href)
const card = JSON.parse(await fs.readFile(CARD_JSON, 'utf8'))
// 署名只从卡片 json 取（card.brand / page.brand / card.foot）；引擎不写死任何人的号名，取不到就不落署名
const BRAND = card.brand || ''

const readJson = async (rel) => JSON.parse(await fs.readFile(path.join(ROOT, rel), 'utf8').catch(() => 'null'))
const THEMES = await readJson('config/card-themes.json')
const LAYOUTS = await readJson('config/card-layouts.json')
const TEMPLATES = await readJson('config/card-templates.json')

const pages = card.pages || null
const TEMPLATES_DIR = path.join(ROOT, 'templates/cards')

/* 渲染前 gate：内容硬违规不渲染，报错即打回（旧格式无 pages[] 时不查）。
   皮肤相关的软提示（主题不存在 / 这版式不吃皮肤）跟违规分开收，照样随结果带出去。 */
const THEME = C.resolveTheme(THEMES, card.theme)
const gate = pages
  ? (() => {
      const g = C.checkCard(card)
      g.warnings.push(
        ...THEME.warnings,
        ...C.themeLayoutWarnings(LAYOUTS, pages, THEME.id),
        ...C.templateHalfWarnings(TEMPLATES, LAYOUTS, card),
      )
      return g
    })()
  : { violations: [], warnings: [] }

const summarize = C.summarize
// 产物落 public/ 而不是 dist/：dist 是构建输出，dev server 不服务它——
// 落在 public/cards/ 工作台才翻得到图（发布脚本仍按 manifest 里的绝对路径取图）
const outDir = path.join(ROOT, 'public/cards', card.slug)
await fs.mkdir(outDir, { recursive: true })

if (gate.violations.length) {
  console.log(JSON.stringify({ ok: false, phase: 'gate', slug: card.slug, violations: gate.violations, warnings: gate.warnings, error: summarize(gate.violations) }))
  process.exit(1)
}

const task = await taskSpace('media-hub 卡片渲染')
const page = task.page('p1')
await page.cdp('Emulation.setDeviceMetricsOverride', { width: 1242, height: 1660, deviceScaleFactor: 1, mobile: false })

const images = []
const rendered = []
const has = C.hasFile
if (pages) {
  for (let i = 0; i < pages.length; i++) {
    const png = path.join(outDir, `${String(i + 1).padStart(2, '0')}.png`)
    // 只重渲改动页：其余页沿用上次产物，manifest 仍是完整页序（发布按清单取全量图）
    if (ONLY.length && !ONLY.includes(i + 1) && (await has(png))) {
      images.push(png)
      continue
    }
    const tmp = `/tmp/media-hub-card-${card.slug}-${i + 1}.html`
    await fs.writeFile(tmp, await C.buildPageHtml({
      root: ROOT, templatesDir: TEMPLATES_DIR, page: pages[i], index: i, total: pages.length, brand: BRAND, themeCss: THEME.css,
    }))
    await C.shootPage(page, tmp, png)
    images.push(png)
    rendered.push(i + 1)
  }
} else {
  // 旧格式兜底：单页问题 + 编号清单
  const tpl = await fs.readFile(path.join(ROOT, 'templates/reverse-card.html'), 'utf8')
  const items = (card.lines || []).map((l, i) => `<li><span class="no">${i + 1}</span><span>${C.esc(l)}</span></li>`).join('\n')
  const q = C.esc(card.question || card.title || '')
  const hl = card.highlight ? C.esc(card.highlight) : ''
  const title = hl && q.includes(hl) ? q.replace(hl, `<span class="hl">${hl}</span>`) : q
  const html = tpl
    .replace('__TITLE__', title)
    .replace('__SERIES__', C.esc(card.series || ''))
    .replace('__ITEMS__', items)
    .replace('__FOOT__', C.esc(card.foot || BRAND))
  const tmp = `/tmp/media-hub-card-${card.slug}.html`
  await fs.writeFile(tmp, html)
  const png = path.join(outDir, `${card.slug}.png`)
  await C.shootPage(page, tmp, png)
  images.push(png)
  rendered.push(1)
}
await task.finish({ keep: [] })

// 渲染后核查：页数齐、每张 PNG 非空（空截图 = 字体没加载，肉眼基本不可读）
const imgViolations = await C.verifyImages(images, pages ? pages.length : null)
await fs.writeFile(path.join(outDir, 'manifest.json'), JSON.stringify({ slug: card.slug, images }, null, 2))
if (imgViolations.length) {
  console.log(JSON.stringify({ ok: false, phase: 'images', slug: card.slug, violations: imgViolations, warnings: gate.warnings, error: summarize(imgViolations) }))
  process.exit(1)
}
console.log(JSON.stringify({ ok: true, slug: card.slug, pages: images.length, rendered, images, warnings: gate.warnings }))
