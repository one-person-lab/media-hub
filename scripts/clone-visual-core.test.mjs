import test from 'node:test'
import assert from 'node:assert/strict'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { cloneThemeKey, dropClone, promoteClone, sanitizeTokens, saveClone } from './clone-visual-core.mjs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/** 每次开一个干净的临时仓库根：只拷两份 config 和一张假小样，测试不碰真配置 */
function sandbox() {
  const root = join(tmpdir(), `clone-visual-${Math.random().toString(36).slice(2, 8)}`)
  mkdirSync(join(root, 'config'), { recursive: true })
  mkdirSync(join(root, 'public/cards/_templates'), { recursive: true })
  for (const rel of ['config/card-themes.json', 'config/card-templates.json']) {
    copyFileSync(join(ROOT, rel), join(root, rel))
  }
  writeFileSync(join(root, 'public/cards/_templates/manifest.json'), JSON.stringify({ items: { 'mono-list': { fingerprint: 'x', bytes: 99 } } }, null, 2))
  return { root, read: (rel) => JSON.parse(readFileSync(join(root, rel), 'utf8')) }
}

const TOKENS = {
  '--page': '#F4EDE2',
  '--surface': '#EAE0CF',
  '--ink': '#1A1A1A',
  '--accent': '#FFD400',
  '--accent-ink': '#111111',
  '--rule': '#1A1A1A',
  '--rule-w': '5px',
  '--font': '"PingFang SC", "Hiragino Sans GB", sans-serif',
}
const INPUT = {
  name: '试色克隆',
  tokens: TOKENS,
  layouts: { cover: 'cover', body: 'steps', closing: 'closing' },
  shape: ['步骤'],
  source: { platform: 'xiaohongshu', title: '某条爆款' },
}

test('色位把关：没登记的键和不像颜色的值都退回，不静默丢', () => {
  const themes = JSON.parse(readFileSync(join(ROOT, 'config/card-themes.json'), 'utf8'))
  const ok = sanitizeTokens({ '--page': '#FFF', '--ink': '#111' }, themes)
  assert.deepEqual(ok.rejected, [])
  assert.equal(Object.keys(ok.tokens).length, 2)

  const bad = sanitizeTokens({ '--page': '红色', '--nope': '#FFF', '--rule-w': '5pt' }, themes)
  assert.deepEqual(bad.tokens, {})
  assert.equal(bad.rejected.length, 3)

  // token 原样拼进 :root，能撑破样式块的值必须在入库前就挡掉
  const inj = sanitizeTokens({ '--font': 'x; } body { display:none', '--page': '#FFF' }, themes)
  assert.deepEqual(Object.keys(inj.tokens), ['--page'])
  assert.equal(inj.rejected.length, 1)
})

test('存候选：皮和模板都挂 candidate，同一条克隆存两次不多出记录', () => {
  const s = sandbox()
  const r1 = saveClone(INPUT, { root: s.root })
  assert.equal(r1.reusedTheme, false)
  assert.match(r1.themeKey, /^clone-/)
  assert.equal(r1.templateKey, `${r1.themeKey}-steps`)

  const themes = s.read('config/card-themes.json')
  const tpls = s.read('config/card-templates.json')
  assert.equal(themes.themes.find((t) => t.key === r1.themeKey).status, 'candidate')
  assert.equal(tpls.templates.find((t) => t.key === r1.templateKey).status, 'candidate')
  assert.equal(tpls.templates.find((t) => t.key === r1.templateKey).layouts.body, 'steps')

  const r2 = saveClone(INPUT, { root: s.root })
  assert.equal(r2.themeKey, r1.themeKey)
  assert.equal(s.read('config/card-themes.json').themes.length, themes.themes.length)
  assert.equal(s.read('config/card-templates.json').templates.length, tpls.templates.length)
})

test('判重命中走另存：只加模板，不再加一层同样的皮', () => {
  const s = sandbox()
  const before = s.read('config/card-themes.json').themes.length
  const r = saveClone({ ...INPUT, baseTheme: 'poster-mono' }, { root: s.root })
  assert.equal(r.reusedTheme, true)
  assert.equal(r.themeKey, 'poster-mono')
  assert.equal(s.read('config/card-themes.json').themes.length, before)
  assert.match(r.templateKey, /^poster-mono-steps$/)
})

test('两条爆款撞同皮同排法：报「库里已有」，不把上一条的来源读数盖没', () => {
  const s = sandbox()
  const before = s.read('config/card-templates.json').templates.length
  const a = saveClone({ ...INPUT, source: { noteId: 'aaaa0001', likes: '97353', title: '甲' } }, { root: s.root })
  const b = saveClone({ ...INPUT, name: '另一条', source: { noteId: 'bbbb0002', likes: '97025', title: '乙' } }, { root: s.root })
  assert.equal(b.duplicate, true)
  assert.equal(b.templateKey, a.templateKey)
  assert.equal(b.duplicateLabel, '试色克隆·步骤')
  assert.equal(s.read('config/card-templates.json').templates.length, before + 1)

  const kept = s.read('config/card-templates.json').templates.find((t) => t.key === a.templateKey)
  assert.equal(kept.source.noteId, 'aaaa0001')
  assert.equal(kept.source.likes, '97353')

  // 同一条笔记重收算刷新来源读数，不是撞车
  const again = saveClone({ ...INPUT, source: { noteId: 'aaaa0001', likes: '99000', title: '甲' } }, { root: s.root })
  assert.equal(again.duplicate, undefined)
  assert.equal(s.read('config/card-templates.json').templates.find((t) => t.key === a.templateKey).source.likes, '99000')
})

test('转正：皮跟着放开，在架数顶到上限就挡住', () => {
  const s = sandbox()
  const { templateKey, themeKey } = saveClone(INPUT, { root: s.root })
  const r = promoteClone({ template: templateKey }, { root: s.root })
  assert.equal(r.label, '试色克隆·步骤')
  assert.equal(s.read('config/card-templates.json').templates.find((t) => t.key === templateKey).status, 'active')
  assert.equal('status' in s.read('config/card-themes.json').themes.find((t) => t.key === themeKey), false)

  // 上限压到现有条数，下一条候选就转不动了
  const tpls = s.read('config/card-templates.json')
  tpls.maxActive = tpls.templates.filter((t) => !t.status || t.status === 'active').length
  writeFileSync(join(s.root, 'config/card-templates.json'), JSON.stringify(tpls, null, 2))
  const another = saveClone({ ...INPUT, name: '另一条', tokens: { ...TOKENS, '--page': '#000000' } }, { root: s.root })
  assert.throws(() => promoteClone({ template: another.templateKey }, { root: s.root }), /先下线一条/)
})

test('删候选：模板、独占的皮、小样和 manifest 记录一起清', () => {
  const s = sandbox()
  const { templateKey, themeKey } = saveClone(INPUT, { root: s.root })
  writeFileSync(join(s.root, 'public/cards/_templates', `${templateKey}.png`), 'fake')
  const r = dropClone({ template: templateKey }, { root: s.root })
  assert.equal(r.droppedTheme, themeKey)
  assert.equal(existsSync(join(s.root, 'public/cards/_templates', `${templateKey}.png`)), false)
  assert.equal(s.read('config/card-templates.json').templates.some((t) => t.key === templateKey), false)
  assert.equal(s.read('config/card-themes.json').themes.some((t) => t.key === themeKey), false)
  assert.equal('mono-list' in s.read('public/cards/_templates/manifest.json').items, true)
})

test('皮 key 只由色值决定：换个顺序也是同一条', () => {
  const a = cloneThemeKey({ '--page': '#FFF', '--ink': '#111' })
  const b = cloneThemeKey({ '--ink': '#111', '--page': '#FFF' })
  assert.equal(a, b)
  assert.notEqual(a, cloneThemeKey({ '--page': '#EEE', '--ink': '#111' }))
})
