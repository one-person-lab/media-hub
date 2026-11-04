import test from 'node:test'
import assert from 'node:assert/strict'
import {
  reviewDue, reviewQueue, reviewTopics, topicSiblings, topicKeyOf, lessonIndex, renderLedger, ledgerDigest,
  findTopic, reviewEvidence, metricsLine, T_PLUS_DAYS,
} from './lesson-core.mjs'

const art = (over = {}) => ({
  file: 'Projects/发布排期/小红书/已排期/2026-10/2026-10-20-测试稿.md',
  title: '测试稿',
  account: '小红书',
  date: '2026-10-20',
  status: 'published',
  lesson: '',
  metrics: { views: 12000, likes: 300, collects: 210, comments: 15, shares: null, follows: 8, completeRate: '' },
  ...over,
})

test('T+3 当天判太早，第四天进待复盘', () => {
  const a = art()
  assert.equal(reviewDue(a, { today: '2026-10-22' }).reason, 'too_soon')
  assert.equal(reviewDue(a, { today: '2026-10-22' }).due, false)
  assert.equal(reviewDue(a, { today: '2026-10-23' }).days, T_PLUS_DAYS)
  assert.equal(reviewDue(a, { today: '2026-10-23' }).due, true)
})

test('已写过结论、未发布、没有排期日都不进待复盘清单', () => {
  assert.equal(reviewDue(art({ lesson: '这篇的结论是标题党会被完读率打回来' }), { today: '2026-10-30' }).reason, 'already')
  assert.equal(reviewDue(art({ status: 'ready' }), { today: '2026-10-30' }).reason, 'not_published')
  assert.equal(reviewDue(art({ date: null }), { today: '2026-10-30' }).reason, 'no_date')
  // 一句话的结论也算写过：占位空段与「待补」不该再催一遍，但短到不像结论的要留下
  assert.equal(reviewDue(art({ lesson: '待补' }), { today: '2026-10-30' }).reason, 'due')
})

test('待复盘清单按逾期天数倒序：拖得最久的排最先', () => {
  const q = reviewQueue([
    art({ title: '刚过线', date: '2026-10-24' }),
    art({ title: '拖最久', date: '2026-10-10' }),
    art({ title: '中间', date: '2026-10-18' }),
    art({ title: '还没到', date: '2026-10-28' }),
  ], { today: '2026-10-29' })
  assert.deepEqual(q.map((x) => x.article.title), ['拖最久', '中间', '刚过线'])
})

test('结论索引只收已发布且有正文的，缺项读数不拿 0 冒充', () => {
  const list = lessonIndex([
    art({ lesson: '收藏型选题的封面要给出可带走的清单' }),
    art({ title: '没结论', lesson: '' }),
    art({ title: '还没发', status: 'ready', lesson: 'x'.repeat(20) }),
  ])
  assert.equal(list.length, 1)
  assert.match(list[0].rel, /^content\/Projects\/发布排期/)
  assert.equal(metricsLine(list[0].metrics).includes('享'), false)
  assert.match(metricsLine(list[0].metrics), /播放 1\.2万/)
})

test('台账带出处与读数，空索引也给出「还没有结论」而不是空文件', () => {
  const md = renderLedger(lessonIndex([art({ lesson: '结论是封面要给可带走的清单' })]), { generatedAt: '2026-10-29' })
  assert.match(md, /共 1 条，截至 2026-10-29/)
  assert.match(md, /出处：content\/Projects/)
  assert.match(md, /当时的读数：播放 1\.2万/)
  assert.match(renderLedger([], { generatedAt: '2026-10-29' }), /还没有结论/)
})

test('注入切片按条数和字数双重封顶，并留全文回链', () => {
  const many = Array.from({ length: 60 }, (_, i) => art({
    title: `第${i}篇`, date: `2026-01-${String(i % 28 + 1).padStart(2, '0')}`,
    lesson: `结论${i}` + '，这一句要足够长才能把预算吃满，否则截断分支测不到。'.repeat(8),
  }))
  const digest = ledgerDigest(lessonIndex(many), { limit: 10, maxChars: 1200 })
  assert.ok(digest.length <= 1400, `切片没压住：${digest.length}`)
  assert.match(digest, /全文见 metrics\/lessons\.md/)
})

test('选题卡按标题回找容忍话题与裁短，找不到返回 null 不硬攀', () => {
  const topics = [{ title: '把每周的动作固定下来' }, { title: '完全不相干的题' }]
  assert.equal(findTopic(topics, '把每周的动作固定下来 #习惯养成')?.title, '把每周的动作固定下来')
  assert.equal(findTopic(topics, '把每周的动作固定')?.title, '把每周的动作固定下来')
  assert.equal(findTopic(topics, '另一件事'), null)
})

test('选题卡回找先认文件名聚合键：各版自己起了标题也找得到当初那张卡', () => {
  const topics = [{ title: '把自己产品化' }]
  const a = art({ title: '不想打工的人，先把自己做成产品', file: 'Projects/发布排期/抖音/已排期/2026-10/2026-10-10-把自己产品化.md' })
  assert.equal(findTopic(topics, a)?.title, '把自己产品化')
})

test('各版自己起了标题也仍是一题：归并看文件名聚合键，不看 H1', () => {
  const five = ['小红书', '抖音', '公众号', '快手', '视频号'].map((p, i) => plateArt(p, { title: `第${i}版各自起的标题` }))
  assert.equal(topicKeyOf(five[0]), '一个题')
  assert.equal(reviewTopics(five, { today: '2026-10-20' }).length, 1)
  assert.equal(reviewTopics(five, { today: '2026-10-20' })[0].files.length, 5)
})

test('预答证据把当初的判据与已有结论摆进来，缺项如实说基线未成型', () => {
  const ev = reviewEvidence({
    article: art({ conversion: { 主页访问: '32' } }),
    topic: { judge: '①挂得上：带产品', basis: '2026-10-08-A · 封面给清单收藏更高' },
    lessons: [{ rel: 'content/Projects/x.md', date: '2026-10-08', title: 'A', lesson: '封面给清单收藏更高' }],
  })
  assert.match(ev, /转化数据（手填）：主页访问 32/)
  assert.match(ev, /当初立项时写的判据/)
  assert.match(ev, /基线未成型/)
  assert.match(ev, /已有复盘结论/)
  assert.equal(reviewEvidence({}), '')
})

const plateArt = (account, over = {}) => art({
  account,
  title: '一个题',
  date: '2026-10-10',
  file: `Projects/发布排期/${account}/已排期/2026-10/2026-10-10-一个题.md`,
  ...over,
})

test('同题五平台归并成一题：一次复盘，写回各版', () => {
  const five = ['小红书', '抖音', '公众号', '快手', '视频号'].map(plateArt)
  const others = art({ title: '另一题', date: '2026-10-09', file: 'Projects/发布排期/小红书/已排期/2026-10/2026-10-09-另一题.md' })
  const q = reviewTopics([...five, others], { today: '2026-10-20' })
  assert.equal(q.length, 2)
  const one = q.find((x) => x.title === '一个题')
  assert.equal(one.files.length, 5)
  assert.equal(one.days, 10)
  // 主稿取有读数的那一版：没读数的稿摆不出证据，不能当预答的主角
  assert.equal(one.primary.account, '小红书')
  assert.equal(topicSiblings(five, five[0]).length, 4)
})

test('同题各版都没读数时主稿回落第一版，同选题读数一并摆进证据', () => {
  const noData = ['抖音', '快手'].map((p) => plateArt(p, { metrics: {} }))
  const q = reviewTopics(noData, { today: '2026-10-20' })
  assert.equal(q[0].primary.account, '抖音')
  const ev = reviewEvidence({ article: noData[0], siblings: topicSiblings(noData, noData[0]) })
  assert.match(ev, /同选题其他平台的稿/)
  assert.match(ev, /快手（2026-10-10）：无读数/)
})
