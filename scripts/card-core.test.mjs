import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  resolveTheme,
  buildPageHtml,
  checkCard,
  pageTexts,
  themeLayoutWarnings,
  templateHalfWarnings,
  templateFingerprint,
} from './card-core.mjs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const TDIR = join(ROOT, 'templates/cards')
const THEMES = JSON.parse(readFileSync(join(ROOT, 'config/card-themes.json'), 'utf8'))
const LAYOUTS = JSON.parse(readFileSync(join(ROOT, 'config/card-layouts.json'), 'utf8'))
const TPLS = JSON.parse(readFileSync(join(ROOT, 'config/card-templates.json'), 'utf8'))
const DEMO = JSON.parse(readFileSync(join(TDIR, '_demo.json'), 'utf8'))

/** 一份「改造前」的老卡片：没有 theme、没有 template，字段全是当年那套 */
const LEGACY = {
  layout: 'cover',
  title: [['忘掉自己的收入', 'hot'], ['像小学生一样花钱', 'pale']],
  echo: '**真正的放松，不是花钱。**',
  items: [{ zh: '**每天放学按时回家**', en: 'Go straight home after school' }],
}

test('老卡片不注入皮肤：没写 theme 就一个字都不加', async () => {
  const t = resolveTheme(THEMES, undefined)
  assert.equal(t.css, '')
  assert.deepEqual(t.warnings, [])
  const html = await buildPageHtml({ root: ROOT, templatesDir: TDIR, page: LEGACY, index: 0, total: 1, brand: 'x', themeCss: t.css })
  assert.ok(!html.includes(':root{'), '不写 theme 的卡片不许出现皮肤层，否则老稿子会跟着变样')
  assert.ok(html.includes('忘掉自己的收入'))
})

test('写了对应主题才换皮，主题名不认识时按默认渲并如实报', async () => {
  const mono = resolveTheme(THEMES, { id: 'poster-mono' })
  assert.equal(mono.id, 'poster-mono')
  assert.match(mono.css, /--page:#FFFFFF/)
  const html = await buildPageHtml({ root: ROOT, templatesDir: TDIR, page: LEGACY, index: 0, total: 1, brand: 'x', themeCss: mono.css })
  assert.ok(html.includes(':root{--page:#FFFFFF'), '皮肤要真的进 HTML，不能只是算出来')

  const bogus = resolveTheme(THEMES, { id: '不存在的皮' })
  assert.equal(bogus.css, '')
  assert.equal(bogus.warnings[0].rule, '主题不存在')

  const over = resolveTheme(THEMES, { id: 'poster-mono', colors: { '--ink': '#123456', '--nope': '#fff', '--rule-w': '9px' } })
  assert.match(over.css, /--ink:#123456/)
  assert.match(over.css, /--rule-w:9px/)
  assert.ok(!over.css.includes('--nope'), '未登记的色位不许进 CSS')
  assert.equal(over.warnings.length, 1)
})

test('小样指纹：皮肤 token、版式 HTML、示例文案任一变化都要变', async () => {
  const tpl = TPLS.templates.find((t) => t.key === 'mono-points')
  const base = await templateFingerprint({ template: tpl, themes: THEMES, demo: DEMO, templatesDir: TDIR })

  const themes2 = JSON.parse(JSON.stringify(THEMES))
  themes2.themes.find((t) => t.key === 'poster-mono').tokens['--ink'] = '#000001'
  assert.notEqual(await templateFingerprint({ template: tpl, themes: themes2, demo: DEMO, templatesDir: TDIR }), base,
    '改一个色位还沿用旧小样，等于拿旧图冒充新皮')

  const demo2 = JSON.parse(JSON.stringify(DEMO))
  demo2.points.title[0][0] = '换了个说法'
  assert.notEqual(await templateFingerprint({ template: tpl, themes: THEMES, demo: demo2, templatesDir: TDIR }), base)

  const dir = join(tmpdir(), `card-core-fp-${process.pid}`)
  mkdirSync(dir, { recursive: true })
  try {
    for (const n of ['cover', 'points', 'closing']) writeFileSync(join(dir, `${n}.html`), readFileSync(join(TDIR, `${n}.html`), 'utf8'))
    assert.equal(await templateFingerprint({ template: tpl, themes: THEMES, demo: DEMO, templatesDir: dir }), base,
      '同样内容换目录算出来的指纹必须一致')
    writeFileSync(join(dir, 'points.html'), readFileSync(join(dir, 'points.html'), 'utf8') + '\n/* 改了行距 */\n')
    assert.notEqual(await templateFingerprint({ template: tpl, themes: THEMES, demo: DEMO, templatesDir: dir }), base,
      '版式 HTML 改了必须重渲小样')
    assert.equal(await templateFingerprint({ template: tpl, themes: THEMES, demo: DEMO, templatesDir: dir }),
      await templateFingerprint({ template: tpl, themes: THEMES, demo: DEMO, templatesDir: dir }),
      '同样输入两次算出来的指纹要稳定，否则每次 gen:data 都会判成过期')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('分栏页的文案进核查与编辑名单：漏了左右栏等于没核', () => {
  const page = DEMO.split
  const labels = pageTexts(page).map(([l]) => l)
  for (const l of ['左栏名', '右栏名', '左栏第1条', '右栏第3条', '结论']) assert.ok(labels.includes(l), `pageTexts 漏了 ${l}`)

  const bad = {
    slug: 't',
    intent: 'value',
    pages: [
      { layout: 'cover', title: [['开不开第三个号', 'hot']], items: [{ zh: '一句话', en: 'One line' }] },
      {
        layout: 'split',
        title: [['开三个号，还是把一个打透']],
        left: { name: '三个号', items: [{ zh: '小红书上看不到' }, { zh: 'B' }, { zh: 'C' }, { zh: 'D' }, { zh: 'E' }, { zh: 'F' }] },
        right: { name: '一个号', items: [{ zh: '每天上线' }] },
        verdict: '先发满 60 篇',
      },
      { layout: 'closing', kicker: '写在最后', head: [['先把一个号打透']], lines: [{ zh: '能上线的东西比计划值钱' }] },
    ],
  }
  const { violations } = checkCard(bad)
  assert.ok(violations.some((v) => v.rule === '每页 ≤5 条' && v.page === 2), '左栏 6 条要按分栏规则拦下来')
  assert.ok(violations.some((v) => v.rule === '平台名' && v.page === 2), '左栏里的小红书要被抓到')
})

test('皮肤与版式的搭配登记自洽：模板引用的东西必须真存在且能吃皮', () => {
  const seen = new Set()
  const shapes = new Set(['清单', '观点', '步骤', '测评', '金句', '数据'])
  const active = TPLS.templates.filter((t) => !t.status || t.status === 'active')
  assert.ok(active.length <= TPLS.maxActive, `可选模板 ${active.length} 条，超过 maxActive=${TPLS.maxActive}`)
  for (const t of active) {
    assert.ok(!seen.has(t.key), `模板 key 重复：${t.key}`)
    seen.add(t.key)
    assert.ok(THEMES.themes.some((x) => x.key === t.theme), `${t.key} 的皮肤 ${t.theme} 没登记`)
    for (const [role, name] of Object.entries(t.layouts)) {
      const def = LAYOUTS.layouts.find((l) => l.layout === name)
      assert.ok(def, `${t.key} 的 ${role} 版式 ${name} 没登记`)
      assert.equal(def.themeReady, true, `${t.key} 的 ${role} 版式 ${name} 还没接皮肤层，不能进模板目录`)
      assert.equal(def.family, 'value', `${t.key} 用了 ${name}：产品/宣传版式自带皮，不进模板目录`)
    }
    assert.ok(Array.isArray(t.shape) && t.shape.length, `${t.key} 没写适用形态`)
    for (const s of t.shape) assert.ok(shapes.has(s), `${t.key} 的形态「${s}」不在受控词表里`)
    assert.ok(String(t.pick || '').length > 8, `${t.key} 缺 pick：推荐理由不能空`)
  }
  assert.ok(TPLS.templates.some((t) => t.key === TPLS.default), 'default 指向的模板不在目录里')
})

test('自带皮的版式不跟着换肤，界面要说这一页而不是这一稿', () => {
  const warn = themeLayoutWarnings(LAYOUTS, [{ layout: 'promo-shot' }], 'poster-mono')
  assert.equal(warn.length, 1)
  assert.match(warn[0].detail, /对它不生效/, '要说清是这一页不吃皮，不是整稿没换成功')
  const ok = themeLayoutWarnings(LAYOUTS, [{ layout: 'items' }], 'poster-mono')
  assert.deepEqual(ok, [])
  assert.deepEqual(themeLayoutWarnings(LAYOUTS, [{ layout: 'items' }], ''), [], '没选主题就不该有提示')
})

test('模板只套了一半要当场说：写了 template 就得逐页版式跟着换', () => {
  const tpl = TPLS.templates.find((t) => t.status !== 'draft')
  const L = tpl.layouts
  const full = { template: tpl.key, pages: [{ layout: L.cover }, { layout: L.body }, { layout: L.closing }] }
  assert.deepEqual(templateHalfWarnings(TPLS, LAYOUTS, full), [], '整套都对，不该有提示')

  // 故意拿一个「存在但不是这条模板要的那个」版式，避免碰上 body 恰好就是 items
  const other = LAYOUTS.layouts.find((x) => x.themeReady && x.family === 'value' && x.layout !== L.body && x.layout !== L.cover && x.layout !== L.closing).layout
  const half = { template: tpl.key, pages: [{ layout: L.cover }, { layout: other }, { layout: L.closing }] }
  const warn = templateHalfWarnings(TPLS, LAYOUTS, half)
  assert.equal(warn.length, 1)
  assert.equal(warn[0].rule, '模板只套了一半')
  assert.equal(warn[0].page, 2, '要点名是哪一页')
  assert.match(warn[0].detail, new RegExp(L.body), '要说清这一页该换成哪个版式')

  const shot = { template: tpl.key, pages: [{ layout: L.cover }, { layout: other, img: 'x.png' }, { layout: L.closing }] }
  assert.deepEqual(templateHalfWarnings(TPLS, LAYOUTS, shot), [], '放真机截图的页本来就不跟随模板')

  assert.equal(templateHalfWarnings(TPLS, LAYOUTS, { template: 'no-such-tpl', pages: [{ layout: 'cover' }] })[0].rule, '模板不存在')
  assert.deepEqual(templateHalfWarnings(TPLS, LAYOUTS, { pages: [{ layout: 'cover' }] }), [], '老稿子没写 template = 没选过，不催')
})
