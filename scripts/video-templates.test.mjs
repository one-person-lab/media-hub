import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..')
const j = JSON.parse(readFileSync(join(ROOT, 'config/video-templates.json'), 'utf8'))

/* 这两条查的是「登记的渲染工程真的在盘上」：videos/ 下是各产品的 Remotion 工程，
   成片与小样也在本机——开源副本不带这棵子树（自家商业文案与品牌），那边跳过，本机照跑。 */
const LOCAL_FILMS = existsSync(join(ROOT, 'videos'))
const FILM_SKIP = LOCAL_FILMS ? {} : { skip: '需要本机 videos/ 渲染工程，开源副本不带' }

/** 视频模板库的唯一风险是「登记了一条其实不存在的片子」：
 *  界面上看着能选，点下去渲不出来。所以每条有工程的都要能在代码里找到那个 composition。
 *  例外是从爆款逐字稿上量出来的节奏规格（没有 composition）：平台不渲它，
 *  查的是另一件事——来源读数和节奏必须在，且不许挂渲染入口（见最后那条测试）。 */
const isRhythm = (t) => !t.composition

test('视频模板每条都指着真存在的 Remotion composition', FILM_SKIP, () => {
  assert.ok(Array.isArray(j.templates) && j.templates.length, '视频模板目录不能是空的')
  assert.ok(j.templates.some((t) => t.key === j.default), 'default 指向的模板不在目录里')
  const seen = new Set()
  for (const t of j.templates.filter((x) => x.status !== 'candidate' && !isRhythm(x))) {
    assert.ok(!seen.has(t.key), `key 重复：${t.key}`)
    seen.add(t.key)
    const root = join(ROOT, t.project, 'src/Root.tsx')
    assert.ok(existsSync(root), `${t.key} 的项目 ${t.project} 里没有 src/Root.tsx`)
    assert.ok(
      readFileSync(root, 'utf8').includes(`id="${t.composition}"`),
      `${t.key} 的 composition「${t.composition}」没在 ${t.project}/src/Root.tsx 里注册`,
    )
    /* 渲染命令要么点名这个 composition，要么走项目 package.json 里真存在的那条 script。
       写成「npm run render」却不看 script 是否存在是最容易烂掉的一种登记：脚本名改了，
       命令照样看着像话，点下去才报 missing script（oss 那条就正指着 AiflPromo）。 */
    const m = String(t.render || '').match(/npm run ([\w:-]+)/)
    if (m) {
      const pkg = JSON.parse(readFileSync(join(ROOT, t.project, 'package.json'), 'utf8'))
      assert.ok(pkg.scripts?.[m[1]], `${t.key} 的渲染命令指着 npm run ${m[1]}，项目里没这条 script`)
      assert.ok(
        String(pkg.scripts[m[1]]).includes(t.composition),
        `${t.key} 的 npm run ${m[1]} 渲的是别的 composition，不是 ${t.composition}`,
      )
    } else {
      assert.ok(String(t.render || '').includes(t.composition), `${t.key} 的渲染命令点的不是它自己那个 composition`)
    }
    assert.ok(Array.isArray(t.slots) && t.slots.length, `${t.key} 没登记任何可改的槽位`)
    for (const s of t.slots) assert.ok(s.at && s.what, `${t.key} 有槽位只写了名字没写改什么`)
    assert.ok(String(t.pick || '').length > 8, `${t.key} 缺 pick：为什么算被验证过不能空`)
  }
})

/** 小样不在 = 这条登记写飘了（改了 key 没重截）。界面宁可显示「还没渲过」也不能给一张裂图。 */
test('标 ready 的视频模板必须真有成片和小样文件', FILM_SKIP, () => {
  for (const t of j.templates.filter((x) => x.status === 'ready')) {
    for (const rel of [t.poster, t.preview, t.film]) {
      const p = join(ROOT, rel.startsWith('/') ? `public${rel}` : rel)
      assert.ok(existsSync(p) && readFileSync(p).length > 1000, `${t.key} 标了 ready，但 ${rel} 不在或小得可疑`)
    }
  }
  for (const t of j.templates.filter((x) => x.status !== 'ready')) {
    assert.ok(!t.poster && !t.preview, `${t.key} 还没成片，不该挂着小样地址`)
  }
})

/** 全目录 key 唯一：候选也要算进来，撞了 key 的两条会在界面上互相顶掉 */
test('视频模板 key 不重复', () => {
  const seen = new Set()
  for (const t of j.templates) {
    assert.ok(!seen.has(t.key), `key 重复：${t.key}`)
    seen.add(t.key)
  }
})

/** 收编来的节奏规格（候选与转正后的都算）：它不渲，所以必须说清「抄哪条爆款、抄出来的节奏是什么数」，
 *  并且不许挂着 composition / 渲染命令 / 小样——那些一挂就等于宣称这条能出片。 */
test('收编来的节奏规格带来源与节奏读数，且没有渲染入口', () => {
  for (const t of j.templates.filter(isRhythm)) {
    assert.ok(t.source?.noteId, `${t.key} 的候选没记来源笔记号`)
    assert.ok(t.source?.platform, `${t.key} 的候选没记来源平台`)
    assert.ok(Number(t.source?.heat) > 0 || t.source?.likes, `${t.key} 的候选没带热度读数`)
    const st = t.structure
    assert.ok(st && st.durationSec > 0 && st.beats >= 3, `${t.key} 的候选没量出节奏（要 ≥3 拍）`)
    assert.ok(st.charsPerSec > 0 && st.beatSec > 0, `${t.key} 的候选缺语速或拍长`)
    assert.ok(!t.composition && !t.project && !t.render, `${t.key} 是收编来的结构规格，不该有渲染入口`)
    assert.ok(!t.poster && !t.preview && !t.film, `${t.key} 收编来的候选不该挂成片或小样`)
    assert.ok(String(t.pick || '').length > 8, `${t.key} 缺 pick：凭什么算被验证过不能空`)
  }
})
