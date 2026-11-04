/**
 * 模板小样预渲：config/card-templates.json 里每条模板渲 3:4 图，
 * 落 public/cards/_templates/，供创作台的模板选择器和素材库直接读图。
 *
 * 为什么预渲而不是现渲：本机一页要 10–15 秒，选择器一开就渲十几张等于把界面冻住。
 * 所以只在「模板新增 / 版式 HTML 变了 / 皮肤 token 变了 / 示例文案变了」时重渲，
 * 判据是下面这个指纹，写进 public/cards/_templates/manifest.json 给 build-data 读。
 *
 * 一条模板两张：正文页 <key>.png、封面页 <key>-cover.png。封面单列一张是因为
 * 素材库那一屏的第一眼就是封面——能不能被点开全在那一张上，只给正文页等于把最能打的部份藏起来。
 * cover 与 body 是同一个版式时（仿截图那两条）不再重渲，一张就够。
 *
 * 运行：node scripts/run-ego.mjs scripts/render-template-thumbs.mjs --args --all
 *      node scripts/run-ego.mjs scripts/render-template-thumbs.mjs --args --templates mono-list,ink-steps
 *      串行跑，一条命令一次最多一屏；渲染参数不落 /tmp 共享文件（那是多会话单例）。
 */
const fs = await import('node:fs/promises')
const path = await import('node:path')
const { pathToFileURL } = await import('node:url')

const flag = (name) => {
  const i = process.argv.indexOf(name)
  return i < 0 ? '' : process.argv[i + 1]
}
const ALL = process.argv.includes('--all')
const WANT = (flag('--templates') || '').split(',').map((s) => s.trim()).filter(Boolean)

const ROOT = process.cwd()
const C = await import(pathToFileURL(path.join(ROOT, 'scripts/card-core.mjs')).href)
const readJson = async (rel) => JSON.parse(await fs.readFile(path.join(ROOT, rel), 'utf8'))

const TPLS = await readJson('config/card-templates.json')
const THEMES = await readJson('config/card-themes.json')
const LAYOUTS = await readJson('config/card-layouts.json')
const DEMO = await readJson('templates/cards/_demo.json')
const OUT_DIR = path.join(ROOT, 'public/cards/_templates')
const MANIFEST = path.join(OUT_DIR, 'manifest.json')

const pick = (key) => (TPLS.templates || []).find((t) => t.key === key)
const targets = ALL ? (TPLS.templates || []).filter((t) => t.status !== 'archived') : WANT.map(pick).filter(Boolean)
const unknown = WANT.filter((k) => !pick(k))
if (!targets.length) {
  console.log(JSON.stringify({ ok: false, error: unknown.length ? `模板目录里没有：${unknown.join('、')}` : '没指定要渲的模板（--all 或 --templates key,key）' }))
  process.exit(1)
}

/** 指纹算法在 card-core：渲图这边写进 manifest，build-data 那边用同一函数现算比对。 */
const fingerprint = (t) =>
  C.templateFingerprint({ template: t, themes: THEMES, demo: DEMO, templatesDir: path.join(ROOT, 'templates/cards') })

/** 这条模板要出哪几张图：正文页必出，封面页只在与正文版式不同且备了示例时才出。 */
const shotsFor = (t) => {
  const out = []
  if (DEMO[t.layouts?.body]) out.push({ page: DEMO[t.layouts.body], file: `${t.key}.png` })
  const cover = t.layouts?.cover && t.layouts.cover !== t.layouts.body ? DEMO[t.layouts.cover] : null
  if (cover) out.push({ page: cover, file: `${t.key}-cover.png` })
  return out
}

await fs.mkdir(OUT_DIR, { recursive: true })
const prev = JSON.parse(await fs.readFile(MANIFEST, 'utf8').catch(() => '{"items":{}}'))
const task = await taskSpace('media-hub 模板小样')
const page = await task.page('p1')
await page.cdp('Emulation.setDeviceMetricsOverride', { width: 1242, height: 1660, deviceScaleFactor: 1, mobile: false })

const items = { ...prev.items }
const rendered = []
const failed = []
const warnings = []
for (const t of targets) {
  const shots = shotsFor(t)
  if (!shots.length) {
    failed.push({ key: t.key, error: `示例内容里没有 ${t.layouts?.body} 版式那一份（templates/cards/_demo.json）` })
    continue
  }
  const theme = C.resolveTheme(THEMES, { id: t.theme })
  if (!theme.css) {
    failed.push({ key: t.key, error: `皮肤「${t.theme}」不在 config/card-themes.json 里` })
    continue
  }
  warnings.push(...C.themeLayoutWarnings(LAYOUTS, shots.map((s) => s.page), theme.id).map((w) => ({ template: t.key, ...w })))
  const sizes = {}
  try {
    for (const s of shots) {
      const html = await C.buildPageHtml({
        root: ROOT,
        templatesDir: path.join(ROOT, 'templates/cards'),
        page: s.page,
        index: 0,
        total: 1,
        brand: DEMO.brand || '',
        themeCss: theme.css,
      })
      const tmp = `/tmp/media-hub-template-${s.file.replace(/\.png$/, '')}.html`
      await fs.writeFile(tmp, html)
      const png = path.join(OUT_DIR, s.file)
      await C.shootPage(page, tmp, png)
      const bad = await C.verifyImages([png], 1)
      if (bad.length) throw new Error(bad.map((v) => v.detail).join('；'))
      sizes[s.file] = (await fs.stat(png)).size
    }
    items[t.key] = {
      fingerprint: await fingerprint(t),
      bytes: sizes[`${t.key}.png`] || 0,
      coverBytes: sizes[`${t.key}-cover.png`] || 0,
    }
    rendered.push(t.key)
  } catch (e) {
    failed.push({ key: t.key, error: String(e?.message || e) })
  }
}
await task.finish({ keep: [] })

await fs.writeFile(MANIFEST, JSON.stringify({ generatedAt: new Date().toISOString(), items }, null, 2) + '\n')
console.log(JSON.stringify({
  ok: !failed.length && rendered.length > 0,
  rendered,
  failed,
  unknown,
  warnings,
  manifest: path.relative(ROOT, MANIFEST),
}))
