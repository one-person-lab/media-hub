/** 演示站里那些「看起来像真数据」的条目：全部是示例，每一条身上都带着「示例」或「（演示数据）」。
 *
 *  为什么要单独造：真账号名、别人的爆款原文与逐字稿、本机路径一律不许出门；可这几站空着，
 *  来看的人只见到半个工作台——采集长什么样、拆解长什么样、知识库长什么样全得靠想象。
 *  所以这一份只借真产物的**形状**（平台 key、账号 id、字段结构），文字与读数一律换成示例。
 */
import { localDay, shiftDay } from './day-core.mjs'

const DEMO = '（演示数据）'

/** 拆解五层（灵感库/爆款采集/选题详情共用一份结构），演示站里每层只说这一层是干什么的 */
const ANALYSIS = {
  subject: `${DEMO}这一层写清楚：这条内容讲的是什么、给谁看。真卡上是读完原图或逐字稿之后写的一段话。`,
  hook: `${DEMO}第一页凭什么让人停下：一句原话、一个数字，还是点名了一类人。`,
  structure: `${DEMO}页与页怎么接上：封面 → 清单 → 自己的话 → 收尾一个动作。`,
  emotion: `${DEMO}它给的是焦虑还是掌控感，最后落在哪个动作上。`,
  mechanism: `${DEMO}为什么会被收藏：条目能不能照抄，句子能不能截图。`,
}

const READ_TITLES = [
  '示例 · 一个人做内容，每天真正写得出的只有两百字',
  '示例 · 清单型笔记为什么比长文好抄',
  '示例 · 采集回来的东西不落到一张卡上就等于没采',
  '示例 · 先攒二十条选题，再谈排期',
  '示例 · 同一篇稿子发两个平台，要拆成两样写法',
  '示例 · 封面前七个字决定这张卡有没有第二眼',
  '示例 · 复盘不看总曝光，看这一条比上一条多留了几秒',
  '示例 · 把每天重复的三步写成脚本，人就只管点发布',
  '示例 · 收藏数比点赞诚实，它才代表有人要回去用',
  '示例 · 选题库断供的那周，我停止更新了什么',
]
const VIRAL_TITLES = [
  '示例 · 把做过三遍的动作写成脚本',
  '示例 · 原话开场为什么比自我介绍留人',
  '示例 · 平台不同，同一段话要拆成两样',
  '示例 · 每天七点四十，机器自己去拉同赛道最热的笔记',
  '示例 · 一个人做号，最先该建的是采集而不是账号',
  '示例 · 图文卡片页序：钩子、清单、自己的话、一个动作',
  '示例 · 为什么你的爆款抄不动：缺的是机制那一层',
  '示例 · 排期不是日历，是每天该交的那一份东西',
  '示例 · 数据复盘只看三行，多一行就没人看了',
  '示例 · 本地 markdown 当数据库，十年后还打得开',
]

const author = '示例博主'

/** 立项出来的三条示例选题：A/B 已进创作台（各带一版稿），C 还躺在选题库 */
const TP_STUDIO = VIRAL_TITLES[0]
const TP_READY = VIRAL_TITLES[2]
const TP_LIBRARY = READ_TITLES[3]
const TP_HOT = VIRAL_TITLES[1]

/** 演示站只有一平台一号（真那份的第二号连 id 都带着真人名），所以这些 id 由调用方给 */

const PLATFORM_KEY = { 小红书: 'xiaohongshu', 抖音: 'douyin', 公众号: 'mp', 快手: 'kuaishou', 视频号: 'sph' }

/** 「已发布列表」的自动检测读数：演示站没有真后台，每个号给一个演示用的正常态 */
function loginSeed(ids, now) {
  const checkedAt = now.toISOString()
  return {
    checkedAt,
    platforms: Object.fromEntries(
      ids.map((id) => [id, {
        state: 'ok',
        account: '示例号',
        evidence: `${DEMO}登录态每天在本机检测一次`,
        checkedAt,
      }]),
    ),
  }
}

/** 灵感库：采集回来的笔记卡。真卡带逐页原图与原文，演示卡只留结构与读数的样子，一张图都不搬 */
function readingsSeed(day, iso) {
  const pick = (arr, i) => arr[i % arr.length]
  return READ_TITLES.map((title, i) => {
    const fav = i === 3 || i === 5 || i === 8
    return {
      id: `demo-read-${i + 1}`,
      title,
      file: `Inbox/采集笔记/示例/demo-read-${i + 1}.md`,
      chars: 1200 + i * 300,
      format: i % 4 === 1 ? 'video' : 'image',
      excerpt: `${DEMO}这段是采集卡正文的开头。真卡的正文是抓回来的原文，拆解写在卡上的字段里。`,
      analysis: i === 0 ? null : ANALYSIS,
      analyzedAt: i === 0 ? null : day,
      tags: '示例 内容方法',
      source: fav ? 'favorite' : 'link',
      platform: pick(['小红书', '抖音'], i),
      author,
      url: '',
      coverImage: '',
      images: [],
      videoUrl: '',
      likes: pick(['1.2万', '8643', '2371', '4.6万', '972', '1.9万'], i),
      collects: pick(['980', '412', '173', '3120', '88', '1405'], i),
      comments: pick(['214', '88', '36', '507', '19', '132'], i),
      postedAt: day,
      collectedAt: iso,
      favOrder: fav ? i : null,
      converted: i === 3 ? day : '',
      convertedTopic: i === 3 ? TP_LIBRARY : '',
      script: '',
      body: `${DEMO}原文正文在这里（演示站不放别人的原文）。`,
    }
  })
}

/** 爆款采集：按定位关键词搜回来的热门笔记。已立项的那两条从列表消失、进「历史」，所以列表里只剩两条没立项的 */
function viralSeed(day, iso) {
  const pick = (arr, i) => arr[i % arr.length]
  return VIRAL_TITLES.map((title, i) => ({
    id: `demo-viral-${i + 1}`,
    platform: i % 2 ? 'douyin' : 'xiaohongshu',
    format: i % 3 === 2 ? 'video' : 'image',
    publishedAt: day,
    title,
    author,
    likes: pick(['40225', '18306', '9722', '53012', '27480', '6115', '12890', '34077'], i),
    collects: pick(['21004', '9120', '', '', '11380', '4021', '6650', '18240'], i),
    comments: pick(['812', '341', '126', '1544', '608', '97', '233', '1102'], i),
    coverImage: '',
    images: [],
    videoFile: '',
    url: '',
    keyword: pick(['示例关键词一', '示例关键词二'], i),
    capturedAt: day,
    converted: i === 0 || i === 2 ? day : '',
    convertedTopic: i === 0 ? TP_STUDIO : i === 2 ? TP_READY : '',
    analysis: i === 1 || i === 6 ? null : ANALYSIS,
    analyzedAt: i === 1 || i === 6 ? null : day,
    researchScore: i === 1 || i === 6 ? null : 88 - (i % 7) * 4,
    script: '',
    file: `Inbox/爆款采集/示例/demo-viral-${i + 1}.md`,
  }))
}

/** 对标账号：建档时那次主页实测的读数全换成示例数，头像与主页链接一律不搬 */
function benchmarksSeed(day) {
  const rows = [
    { platform: 'douyin', score: 88.5, followers: 237000, likesCollects: 5012000, works: 106, top: 3514000, median: 2570, days: 1 },
    { platform: 'xiaohongshu', score: 71.2, followers: 41200, likesCollects: 388000, works: 214, top: 62000, median: 1830, days: 4 },
    { platform: 'douyin', score: 60.4, followers: 9800, likesCollects: 74000, works: 38, top: 15400, median: 640, days: 12 },
    { platform: 'xiaohongshu', score: 82.6, followers: 128000, likesCollects: 1640000, works: 173, top: 412000, median: 3180, days: 2 },
    { platform: 'douyin', score: 55.1, followers: 4300, likesCollects: 21800, works: 61, top: 8900, median: 410, days: 26 },
    { platform: 'xiaohongshu', score: 67.9, followers: 23600, likesCollects: 158000, works: 96, top: 37400, median: 1210, days: 7 },
  ]
  return rows.map((r, i) => ({
    id: `demo:baccount-${i + 1}`,
    nickname: `示例账号 ${String.fromCharCode(65 + i)}`,
    platform: r.platform,
    url: '',
    position: '示例定位',
    desc: `${DEMO}这里是对方主页的自我介绍原文，建档时抓回来一次。`,
    why: `${DEMO}为什么留它：命中「示例关键词」，而且它的爆款你抄得动。`,
    avatar: '',
    score: r.score,
    followers: r.followers,
    likesCollects: r.likesCollects,
    works: r.works,
    recentSample: 20,
    recentTopLikes: r.top,
    recentMedianLikes: r.median,
    lastPublishDays: r.days,
    ipLocation: '',
    capturedAt: day,
    keywords: ['示例关键词'],
    snapshots: [
      `${day}：粉丝 ${r.followers} · 作品 ${r.works} 条 · 近 20 条最高 ${r.top} 赞 · 最近发布 ${r.days} 天前（演示数据）`,
    ],
    patterns: [`${DEMO}值得偷的模式：它的封面第一句怎么写、条目怎么排、收尾要什么动作。`],
    file: 'Resources/对标账号/示例/demo.md',
  }))
}

/** 选题池：闸门四问与立项依据都留形，逐字稿为空——那正是「先补采再动笔」的缺口态 */
function topicsSeed(day, viral, readings) {
  const base = (over) => ({
    id: over.id,
    title: over.title,
    status: over.status,
    source: `${DEMO}来源卡标题：${over.from}`,
    judge: `${DEMO}闸门四问的逐条判断写在这里：挂不挂得上定位、人群认不认、答不答得出、能不能解释。`,
    basis: `${DEMO}立项依据：来源卡的赞藏数与拆解结论。演示站的来源是示例卡，所以只有形状。`,
    sourceFile: over.sourceFile,
    sourceTitle: over.from,
    sourceUrl: '',
    analysis: ANALYSIS,
    analyzedAt: day,
    script: '',
    likes: '9191',
    collects: '4120',
    comments: '233',
    format: 'image',
    platforms: over.platforms,
    product: '',
    file: `Projects/选题池/${over.id}.md`,
  })
  const hit = (cards, id) => cards.find((c) => c.id === id)
  return [
    base({
      id: TP_STUDIO, title: TP_STUDIO, status: '创作中', from: hit(viral, 'demo-viral-1').title,
      sourceFile: `content/${hit(viral, 'demo-viral-1').file}`,
      platforms: [],
    }),
    base({
      id: TP_READY, title: TP_READY, status: '创作中', from: hit(viral, 'demo-viral-3').title,
      sourceFile: `content/${hit(viral, 'demo-viral-3').file}`,
      platforms: [],
    }),
    base({
      id: TP_LIBRARY, title: TP_LIBRARY, status: '待创作', from: hit(readings, 'demo-read-4').title,
      sourceFile: `content/${hit(readings, 'demo-read-4').file}`,
      platforms: [],
    }),
    base({
      id: TP_HOT, title: TP_HOT, status: '待创作', from: hit(viral, 'demo-viral-2').title,
      sourceFile: `content/${hit(viral, 'demo-viral-2').file}`,
      platforms: [],
    }),
    ...VIRAL_TITLES.slice(4, 9).map((t, i) => base({
      id: t, title: t, status: '待创作', from: hit(viral, `demo-viral-${i + 5}`).title,
      sourceFile: `content/${hit(viral, `demo-viral-${i + 5}`).file}`,
      platforms: [],
    })),
  ]
}

/** 金句摘录：真卡挂书名与作者，演示卡只演示这一排的版式 */
const quotesSeed = () => [
  { id: 'demo-quote-1', category: '示例分类', text: `${DEMO}这里放你从书里摘下来的那一句，卡片渲染时它会带出处。`, source: '示例出处' },
  { id: 'demo-quote-2', category: '示例分类', text: `${DEMO}第二句：一句话能截图，就有人替你传播。`, source: '示例出处' },
  { id: 'demo-quote-3', category: '示例分类', text: `${DEMO}流程只替你跑重复的那三步，判断还是你的。`, source: '示例出处' },
  { id: 'demo-quote-4', category: '示例分类', text: `${DEMO}选题不是灵感，是库存。`, source: '示例出处' },
  { id: 'demo-quote-5', category: '示例分类', text: `${DEMO}数据不解释为什么，它只告诉你下一步查什么。`, source: '示例出处' },
]

/** 方案库：一条方案 = 页序 + 每页槽位；「一键同款」要本机渲染，网页上先看懂结构。
 *  样张优先用演示站本来就公开的那条真图卡；游客那份没有图，就退成「只有结构」的一条，产品名取真档案 */
function playbooksSeed(cardSample) {
  const sample = cardSample || { slug: '', urls: [], product: '', texts: [] }
  return [{
    slug: 'demo-quote-open',
    name: '示例 · 原话开场',
    structure: '一句最狠的原话 → 点名一类人 → 类型对号入座 → 结果接行动 → 只留一个动作',
    why: `${DEMO}封面不介绍产品，先甩一句产品自己写出来的话，让人在第一页认出自己；入口留到最后一页。`,
    source: { noteId: 'demo', title: VIRAL_TITLES[1], author, likes: 0, cover: '', url: '' },
    sample,
    applies: [sample.product].filter(Boolean),
    pages: [
      { layout: 'cover', role: '钩子', shots: 0, edit: ['title', 'echo'] },
      { layout: 'items', role: '清单', shots: 0, edit: ['title', 'items'] },
      { layout: 'closing', role: '收尾', shots: 0, edit: ['head', 'lines', 'cta'] },
    ],
  }]
}

/** 采集留痕：界面上「上次什么时候采的、采回多少条」全靠这几行；演示站给假时刻与假条数 */
function collectRunsSeed(ids, day, ts) {
  const keys = ids.map((id) => PLATFORM_KEY[id] || id)
  const byKey = (n) => Object.fromEntries(keys.map((k, i) => [k, { state: 'ok', count: n[i % n.length], note: '' }]))
  const counts = (n) => Object.fromEntries(keys.map((k, i) => [k, n[i % n.length]]))
  const run = (task, n, ago) => ({
    task, day, startedAt: ts - ago, finishedAt: ts, exitCode: 0, stopped: false,
    ok: true, partial: false, failedPlatforms: [], platforms: byKey(n), counts: counts(n), tail: '',
  })
  return [run('collect', [12, 8, 3, 5, 4], 90_000), run('viral', [20, 17, 0, 0, 0], 80_000), run('publish-check', [10, 42, 19, 10, 0], 70_000)]
}

/** 知识库：真页在你本机 content/Knowledge/ 下，是这套工作台的方法。演示页只把三栏文档站的样貌摆出来 */
const knowledgeSeed = (day) => [
  {
    file: '示例-写作规矩.md',
    title: '示例：写作规矩',
    ai: true,
    updated: day,
    intro: [{ t: 'quote', text: `${DEMO}知识库这一页在你本机是 content/Knowledge/*.md：界面只读渲染，要改就去改那个文件（全仓唯一事实源）。` }],
    sections: [
      {
        name: '一、成品目标',
        blocks: [
          { t: 'p', text: `${DEMO}这一节写清一篇稿子交付什么：正文长度、图卡页数、收尾动作。` },
          { t: 'ul', items: ['正文每段不超过三行，手机上不用横滑', '图卡一页只说一件事，最多五条', '收尾只留一个动作，别同时要赞要关注'] },
          { t: 'table', head: ['项', '口径', '为什么'], rows: [['出处', '只挂观点的权威', '查得到的才敢写'], ['时间戳', '整类不上稿面', '过期就是错']] },
        ],
      },
      {
        name: '二、发布前验收',
        blocks: [
          { t: 'p', text: `${DEMO}发布前逐项核对的清单：脚本只到草稿为止，「发布」那一下由人点。` },
          { t: 'code', text: 'npm run gen:data && npm test' },
          { t: 'h', text: '示例小标题' },
          { t: 'p', text: '一条分隔线收尾——这页顺手把渲染器能吃的所有块型都过了一遍。' },
          { t: 'hr' },
        ],
      },
    ],
  },
  {
    file: '示例-拆解框架.md',
    title: '示例：拆解框架',
    ai: false,
    updated: day,
    intro: [{ t: 'p', text: `${DEMO}文件名带下划线的页只给人看，不进 AI 注入的 prompt。` }],
    sections: [
      {
        name: '拆解五层',
        blocks: [
          { t: 'p', text: '主题、钩子、结构、情绪、机制——一条爆款拆完写回采集卡，选题与创作都从这一份取。' },
          { t: 'ul', items: Object.values(ANALYSIS).map((s) => s.replace(DEMO, '')) },
        ],
      },
    ],
  },
  {
    file: '示例-发布口径.md',
    title: '示例：发布口径',
    ai: true,
    updated: day,
    intro: [{ t: 'p', text: `${DEMO}这一页管「发出去之前必须齐的那几样」：标题、正文、话题、封面、落地链接。` }],
    sections: [
      {
        name: '一、每平台一份',
        blocks: [
          { t: 'p', text: `${DEMO}同一条内容在两个平台是两篇稿：字数、话题数、结尾动作都不一样，各自存一份，不互相覆盖。` },
          { t: 'table', head: ['平台', '标题', '话题'], rows: [['小红书', '20 字内', '最多 10 个'], ['抖音', '首句即钩子', '3-5 个']] },
        ],
      },
      {
        name: '二、只到草稿',
        blocks: [
          { t: 'p', text: `${DEMO}脚本把稿子推进平台草稿箱，「发布」那一下由人点——这条规矩写在这里，不写在代码注释里。` },
        ],
      },
    ],
  },
  {
    file: '示例-复盘口径.md',
    title: '示例：复盘口径',
    ai: true,
    updated: day,
    intro: [{ t: 'p', text: `${DEMO}复盘只填三行：这条比上一条多留了几秒、掉在哪一页、下一版改什么。` }],
    sections: [
      {
        name: '一、三行就够',
        blocks: [
          { t: 'ul', items: ['完播/读完，不看总曝光', '掉页的那一页，写清它上面写了什么', '下一版只改一处，改两处就看不出是谁起的作用'] },
          { t: 'p', text: `${DEMO}填完这三行，界面右下角的「上一轮教训」才有的可显示。` },
        ],
      },
    ],
  },
]

/** 爆款采集口径：自动线在采什么必须看得见，演示站给一组示例词 */
const viralConfigSeed = () => ({
  keywords: ['示例关键词一', '示例关键词二'],
  platforms: ['xiaohongshu', 'douyin'],
  minLikes: 10000,
  withinDays: 90,
  dailyLimitPerPlatform: 5,
  scrollRounds: 3,
})

/** 创作台不该空着：把已经公开发出去的那篇稿子摆回「还在流程里」的样子。
 *  正文与图卡都是真的（演示站本来也公开它），只有状态是示例——左渠道 / 中正文 / 右真图三栏一次看全。
 *  标题一律冠「示例 · 」：不冠的话同一篇稿会在日历上出现两次，一次已发布一次没发，看着像坏了。 */
export const draftFromPublished = (a, { id, file, account, status, date, pushedAt }) => ({
  ...a, id, file, date, account, status, stage: 'pending',
  // 底子已经是示例稿（游客那一屏）就别再冠一层，标题成了「示例 · 示例 · …」
  title: a.title.startsWith('示例') ? a.title : `示例 · ${a.title}`,
  metrics: {}, metricsFilled: false, dataState: 'not_collected',
  draftPushed: pushedAt ? { [account]: pushedAt } : {},
  publishedPlatforms: [], publishLinks: {}, detected: {},
})

/** 游客那一屏的「已发布」：号主的真稿子一篇都不搬，这几篇照真产物的形状现造——
 *  字段一栏不缺，历史、日历、复盘才有东西排。标题一律带「示例」，正文一律带（演示数据）。
 *  不给 card：演示产物没有真图卡可引用，游客那一屏于是也不该引用谁的配图（见 guest-core）。 */
export function publishedSeed(ids = [], now = new Date()) {
  const day = localDay(now)
  const names = ids.length ? ids : ['小红书']
  const picks = [VIRAL_TITLES[4], READ_TITLES[6], VIRAL_TITLES[8], READ_TITLES[0]]
  const reads = [
    { views: 4210, likes: 268, collects: 91, comments: 23, shares: 12, follows: 6 },
    { views: 1890, likes: 121, collects: 63, comments: 9, shares: 4, follows: 2 },
    { views: 6420, likes: 402, collects: 288, comments: 31, shares: 44, follows: 17 },
    { views: 980, likes: 57, collects: 22, comments: 5, shares: 3, follows: 1 },
  ]
  return picks.map((title, i) => {
    const account = names[i % names.length]
    const date = shiftDay(day, -(4 + i * 5))
    return {
      id: `${date}-${title}`,
      title,
      file: `Projects/发布排期/${account}/已发布/${date.slice(0, 7)}/${date}-${title}.md`,
      date,
      stage: 'scheduled',
      account,
      status: 'published',
      body: `${DEMO}这里是稿子的长正文。真那一份是你本地 markdown 里的一篇，创作台改哪一栏它就落哪一栏。`,
      copy: `${DEMO}这里是推给平台的短文案：钩子一行、清单几行、收尾一个动作。`,
      copyLabel: '正文',
      caption: '',
      tags: '#示例 #内容方法 #一人公司',
      firstComment: '',
      metrics: { link: '', ...reads[i], completeRate: '32s', bounce: '' },
      metricsFilled: true,
      dataState: 'filled',
      publishedPlatforms: [],
      publishLinks: {},
      detected: { [account]: { publishedAt: `${date} 21:40`, url: '' } },
    }
  })
}

/** 两条示例稿分属两条选题：版本名（= 文件名剥掉日期前缀）必须等于选题卡 id，创作台才认这一组。
 *  一条稿没推、一条已推进草稿箱并排到明天——创作台的「草稿 / 待发布」和看板的三个卡口才都有东西可点。 */
export const demoDraftFiles = (day, ids, iso) => {
  const [first, second] = ids
  const next = shiftDay(day, 1)
  return [
    { file: `Projects/发布排期/${first}/待发布/${day.slice(0, 7)}/${TP_STUDIO}.md`, account: first, status: 'ready', date: day },
    { file: `Projects/发布排期/${second}/待发布/${next.slice(0, 7)}/${TP_READY}.md`, account: second, status: 'ready', date: next, pushedAt: iso },
  ]
}

/** 演示站要摆进产物的那几块示例数据；`cardSample` 是一条真图卡的 urls，方案库拿它当样张 */
export function demoSeed({ now = new Date(), cardSample = null, ids = [] }) {
  const iso = now.toISOString()
  // 演示站的「今天」跟界面同一把尺（本机日历日），否则凌晨生成的那份示例会比界面早一天
  const day = localDay(now)
  const viral = viralSeed(day, iso)
  const readings = readingsSeed(day, iso)
  return {
    day,
    iso,
    ids,
    readings,
    viral,
    benchmarks: benchmarksSeed(day),
    topics: topicsSeed(day, viral, readings),
    quotes: quotesSeed(),
    playbooks: playbooksSeed(cardSample),
    knowledge: knowledgeSeed(day),
    loginState: loginSeed(ids, now),
    collectRuns: collectRunsSeed(ids, day, now.getTime()),
    viralConfig: viralConfigSeed(),
  }
}
