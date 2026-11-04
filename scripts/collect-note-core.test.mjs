import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { markTopicConverted, writeArticleText, setTopicForm, promoteTopic } from './collect-note-core.mjs'

function scratch() {
  return mkdtempSync(join(tmpdir(), 'media-hub-topic-'))
}

function card(root, rel, withFrontmatter = true) {
  const abs = join(root, rel)
  mkdirSync(join(abs, '..'), { recursive: true })
  writeFileSync(abs, withFrontmatter ? `---\ntitle: 测试卡\n---\n\n# 卡\n` : `# 没有 frontmatter 的卡\n`)
  return abs
}

test('采集笔记（平铺）与爆款采集（平台子目录）都能打转化标记', () => {
  const root = scratch()
  try {
    const flat = card(root, 'content/Inbox/采集笔记/某条笔记.md')
    const nested = card(root, 'content/Inbox/爆款采集/douyin/7663451783460703524.md')
    assert.equal(markTopicConverted('content/Inbox/采集笔记/某条笔记.md', root).ok, true)
    assert.equal(markTopicConverted('content/Inbox/爆款采集/douyin/7663451783460703524.md', root).ok, true)
    for (const abs of [flat, nested]) {
      assert.match(readFileSync(abs, 'utf8'), /^---\nconvertedToTopic: \d{4}-\d{2}-\d{2}\n/m)
    }
    // 重复打标记不报错、不重复写
    assert.deepEqual(markTopicConverted('content/Inbox/爆款采集/douyin/7663451783460703524.md', root), { ok: true, already: true })
    assert.equal(readFileSync(nested, 'utf8').match(/convertedToTopic:/g).length, 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('目录外与缺 frontmatter 的卡一律拒绝，且不动文件', () => {
  const root = scratch()
  try {
    card(root, 'content/Projects/选题池/某个选题.md')
    assert.throws(
      () => markTopicConverted('content/Projects/选题池/某个选题.md', root),
      /只能给 Inbox/,
    )
    const noFm = card(root, 'content/Inbox/采集笔记/没头.md', false)
    assert.throws(() => markTopicConverted('content/Inbox/采集笔记/没头.md', root), /frontmatter/)
    assert.equal(readFileSync(noFm, 'utf8').includes('convertedToTopic'), false)
    // 平台子目录外的文件不存在时如实报错，不静默通过
    assert.throws(
      () => markTopicConverted('content/Inbox/爆款采集/douyin/不存在的卡.md', root),
      /文件不存在/,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

/* ==================== 手改一版稿（界面直接编辑正文） ==================== */

/** 账号注册表是 accounts.json；测试用一份假表，绝不碰真仓里那份 */
function hubRoot() {
  const root = scratch()
  mkdirSync(join(root, 'config'), { recursive: true })
  writeFileSync(join(root, 'config/accounts.json'), JSON.stringify([
    { id: '小红书', platform: '小红书', key: 'xhs' },
    { id: '抖音-成长号', platform: '抖音', key: 'douyin-growth' },
  ]))
  return root
}

function article(root, rel, md) {
  const abs = join(root, rel)
  mkdirSync(join(abs, '..'), { recursive: true })
  writeFileSync(abs, md)
  return abs
}

const XHS_MD = `---\ntitle: 忘掉收入\n---\n\n# 忘掉自己的收入，像小学生一样花钱\n\n## 正文\n\n第一条：把收入忘掉。\n\n第二条：花完不心疼。\n\n## 话题标签\n\n#理财 #消费观\n\n## 发布后数据\n\n草稿已推-小红书: 2026-10-27 10:00\n`

test('手改稿：标题写 H1、正文整段替换，其余段落与机器读数一个字不动', () => {
  const root = hubRoot()
  try {
    const rel = 'content/Projects/发布排期/小红书/待发布/忘掉收入.md'
    const abs = article(root, rel, XHS_MD)
    const r = writeArticleText(rel, { title: '  新标题  ', copy: '只留一条：把收入忘掉。' }, root)
    assert.deepEqual(r.changed, ['标题', '正文'])
    const md = readFileSync(abs, 'utf8')
    assert.match(md, /^# 新标题$/m)
    assert.match(md, /## 正文\n\n只留一条：把收入忘掉。\n+\n## 话题标签/)
    assert.ok(md.includes('#理财 #消费观'))
    assert.ok(md.includes('草稿已推-小红书: 2026-10-27 10:00'))
    assert.ok(md.startsWith('---\ntitle: 忘掉收入'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('没改动就不写盘：改回原样 changed 为空，文件时间戳不动', () => {
  const root = hubRoot()
  try {
    const rel = 'content/Projects/发布排期/小红书/待发布/忘掉收入.md'
    const abs = article(root, rel, XHS_MD)
    const r = writeArticleText(rel, { title: '忘掉自己的收入，像小学生一样花钱', copy: '' }, root)
    assert.deepEqual(r.changed, [])
    assert.equal(readFileSync(abs, 'utf8'), XHS_MD)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('短文案形态写自己那段：抖音稿不碰正文，缺段就补在稿尾', () => {
  const root = hubRoot()
  try {
    const rel = 'content/Projects/发布排期/抖音-成长号/已排期/2026-10/2026-10-27-忘掉收入.md'
    const abs = article(root, rel, `# 标题\n\n## 正文\n\n母本正文，不直接发。\n`)
    writeArticleText(rel, { copy: '发出去就这一句。' }, root)
    let md = readFileSync(abs, 'utf8')
    assert.match(md, /## 抖音文案\n\n发出去就这一句。\n$/)
    assert.ok(md.includes('母本正文，不直接发。'))

    // 已有段：整段换掉，不追加第二份
    writeArticleText(rel, { copy: '换成这一句。' }, root)
    md = readFileSync(abs, 'utf8')
    assert.equal((md.match(/## 抖音文案/g) || []).length, 1)
    assert.ok(md.includes('换成这一句。'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('归档区与越界路径一律拒绝，文件不动', () => {
  const root = hubRoot()
  try {
    assert.throws(
      () => writeArticleText('content/Archive/发布排期/小红书/忘掉收入.md', { title: 'x' }, root),
      /R3 违规/,
    )
    assert.throws(() => writeArticleText('content/../../etc/pwd.md', { title: 'x' }, root), /越界/)
    assert.throws(
      () => writeArticleText('content/Projects/发布排期/小红书/待发布/没有这条.md', { title: 'x' }, root),
      /文件不存在/,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('产出形态只认图文与视频：写进卡上独立一行，改第二次只换那一行', () => {
  const root = scratch()
  const rel = 'content/Projects/选题池/某个选题.md'
  try {
    const abs = join(root, rel)
    mkdirSync(join(abs, '..'), { recursive: true })
    writeFileSync(abs, '# 某个选题\n\n- 状态：创作中\n- 归属品牌：\n- 立项平台：小红书 抖音\n')
    assert.equal(setTopicForm(rel, 'video', root).ok, true)
    let md = readFileSync(abs, 'utf8')
    assert.match(md, /^- 产出形态：视频$/m)
    assert.match(md, /^- 立项平台：小红书 抖音$/m)
    assert.equal(setTopicForm(rel, 'image', root).ok, true)
    md = readFileSync(abs, 'utf8')
    assert.equal(md.match(/^- 产出形态：/gm).length, 1)
    assert.match(md, /^- 产出形态：图文$/m)
    assert.throws(() => setTopicForm(rel, 'audio', root), /只有图文与视频/)
    assert.throws(() => setTopicForm('content/Projects/选题池/归档/某个选题.md', 'video', root), /选题池/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('送去创作按卡上「归属品牌」那一行取数：品牌随立项写进每一版稿骨架', () => {
  const root = hubRoot()
  try {
    const rel = 'content/Projects/选题池/某个选题.md'
    article(root, rel, '# 某个选题\n\n- 状态：待创作\n- 来源信号：自有产品推广\n- 归属品牌：醒醒老己小程序\n- 立项平台：\n')
    const r = promoteTopic(rel, undefined, root)
    assert.equal(r.ok, true)
    assert.deepEqual(r.platforms, ['小红书', '抖音-成长号'])
    for (const d of r.drafts) {
      assert.ok(!d.skipped, `骨架没建出来：${d.skipped}`)
      assert.match(readFileSync(join(root, d.rel), 'utf8'), /^- 归属品牌：醒醒老己小程序$/m)
    }
    // 卡本身：状态翻成创作中、账号清单写回，归属品牌那一行不动
    const card = readFileSync(join(root, rel), 'utf8')
    assert.match(card, /^- 状态：创作中$/m)
    assert.match(card, /^- 立项平台：小红书 抖音-成长号$/m)
    assert.match(card, /^- 归属品牌：醒醒老己小程序$/m)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
