import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildPublishPayload, buildPublishPreview } from './collect-note-core.mjs'

/** 一份最小仓库骨架：账号表、默认配乐、一条两页图卡（第 2 页故意不落盘）+ 四家平台的稿。
 *  预览不许造第二套读数，所以断言全部对着 buildPublishPayload 的产物比。 */
function scratch() {
  const root = mkdtempSync(join(tmpdir(), 'media-hub-preview-'))
  mkdirSync(join(root, 'config'), { recursive: true })
  writeFileSync(
    join(root, 'config/accounts.json'),
    JSON.stringify([
      { id: '小红书', platform: '小红书', key: 'xiaohongshu' },
      { id: '抖音', platform: '抖音', key: 'douyin' },
      { id: '公众号', platform: '公众号', key: 'mp' },
      { id: '快手', platform: '快手', key: 'ks' },
    ]),
  )
  writeFileSync(
    join(root, 'config/publish-music.json'),
    JSON.stringify({ enabled: true, query: 'III', title: 'III (Find Yourself)', author: 'Athletics' }),
  )
  mkdirSync(join(root, 'content/Projects/卡片'), { recursive: true })
  writeFileSync(join(root, 'content/Projects/卡片/preview-test.json'), JSON.stringify({ slug: 'preview-test' }))
  const cardDir = join(root, 'public/cards/preview-test')
  mkdirSync(cardDir, { recursive: true })
  writeFileSync(join(cardDir, '01.png'), 'png')
  writeFileSync(
    join(cardDir, 'manifest.json'),
    JSON.stringify({ slug: 'preview-test', images: [join(cardDir, '01.png'), join(cardDir, '02.png')] }),
  )
  const draft = (platform, name, body) => {
    const abs = join(root, `content/Projects/发布排期/${platform}/待发布/${name}.md`)
    mkdirSync(join(abs, '..'), { recursive: true })
    writeFileSync(abs, body)
    return `content/Projects/发布排期/${platform}/待发布/${name}.md`
  }
  return {
    root,
    xhs: draft(
      '小红书',
      '长标题稿',
      '# 这是一个明显超过二十字上限的预览测试标题\n\n卡片数据：preview-test.json\n\n## 正文\n\n第一段正文。\n\n第二段正文。\n\n## 话题标签\n\n#预览 #异常态\n',
    ),
    douyin: draft(
      '抖音',
      '缺段稿',
      '# 缺短文案段的稿\n\n卡片数据：preview-test.json\n\n## 正文\n\n首行当钩子。\n\n第二行不该出现在短文案里。\n\n## 话题标签\n\n#预览\n',
    ),
    mp: draft(
      '公众号',
      '贴图稿',
      '# 公众号贴图稿\n\n卡片数据：preview-test.json\n\n## 正文\n\n长正文母本，不发布。\n\n## 贴图描述\n\n贴图第一段。\n\n贴图第二段。\n\n## 话题标签\n\n#预览\n',
    ),
    ks: draft(
      '快手',
      '短稿',
      '# 快手标题根本不进草稿\n\n卡片数据：preview-test.json\n\n## 正文\n\n正文不发布。\n\n## 快手文案\n\n发出去的就是这一段。\n\n## 话题标签\n\n#预览\n',
    ),
  }
}

test('预览与真推同源：标题按脚本规则截断，正文/话题/图逐字对齐 payload', () => {
  const { root, xhs } = scratch()
  try {
    const { payload } = buildPublishPayload(xhs, root, '小红书')
    const p = buildPublishPreview(xhs, root, '小红书')
    assert.equal(p.titleChars, [...payload.title].length)
    assert.equal(p.title, [...payload.title].slice(0, 20).join(''))
    assert.equal(p.titleLimit, 20)
    assert.equal(p.body, payload.lines.join('\n'))
    assert.deepEqual(p.tags, payload.tags)
    // 图：public/ 下的换成浏览器能取的路径，缺文件的标 exists:false，不许静默少一张
    assert.deepEqual(p.images, [
      { url: '/cards/preview-test/01.png', exists: true },
      { url: '/cards/preview-test/02.png', exists: false },
    ])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('各家形态差异照实画：快手无标题框、公众号不推话题、公众号与小红书都不配乐', () => {
  const { root, ks, mp, xhs } = scratch()
  try {
    const k = buildPublishPreview(ks, root, '快手')
    assert.equal(k.titlePushed, false)
    assert.equal(k.title, '快手标题根本不进草稿')
    assert.equal(k.body, '发出去的就是这一段。')
    assert.equal(k.music.title, 'III (Find Yourself)')

    const m = buildPublishPreview(mp, root, '公众号')
    assert.equal(m.tagsPushed, false)
    assert.deepEqual(m.tags, ['#预览'])
    assert.equal(m.body, '贴图第一段。\n\n贴图第二段。')
    assert.equal(m.music, null)

    assert.equal(buildPublishPreview(xhs, root, '小红书').music, null)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('缺短文案段不静默回退：预览带告警，正文是回退后的那一行', () => {
  const { root, douyin } = scratch()
  try {
    const p = buildPublishPreview(douyin, root, '抖音')
    assert.deepEqual(p.warnings, ['缺「## 抖音文案」段，取正文首行当钩子'])
    assert.equal(p.body, '首行当钩子。')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
