/** 采集弹窗逻辑：识别笔记/作品页 → 抓取 → POST localhost:5173/__collect → 状态反馈 */

const $ = (id) => document.getElementById(id)
const statusEl = $('status')
const btn = $('collectBtn')
const btnLabel = $('btnLabel')
const btnIcon = $('btnIcon')
const pageStateEl = $('pageState')
let currentTab = null

/** 按钮三种样子：可点 / 正在跑 / 已采完。图标跟着换，文字只走 #btnLabel */
function setBtn(label, kind = '') {
  btnLabel.textContent = label
  btn.className = kind
  btnIcon.innerHTML = kind === 'done'
    ? '<path d="M20 6 9 17l-5-5"/>'
    : '<path d="M7 17 17 7M9 7h8v8"/>'
}

function setPageState(text, ok = false) {
  pageStateEl.className = ok ? 'ok' : ''
  pageStateEl.innerHTML = `<i class="dot"></i><span></span>`
  pageStateEl.lastElementChild.textContent = text
}

function setStatus(text, kind = '') {
  statusEl.textContent = text
  statusEl.className = kind
  statusEl.style.display = text ? 'block' : 'none'
}

/** 注入页面的抓取函数（必须自包含，会被序列化执行） */
function scrapeNote() {
  const pick = (sel) => document.querySelector(sel)?.innerText?.trim() ?? null
  const counters = [
    ...document.querySelectorAll("[class*='count-wrapper'] span, .interact-container .count"),
  ].map((e) => e.innerText.trim())

  const container = document.querySelector('.note-detail, #noteContainer, .note-container')
  const webpics = container
    ? [...new Set([...container.querySelectorAll('img')].filter((i) => /sns-webpic/.test(i.src)).map((i) => i.src))]
    : []
  const img = webpics[0] || ''

  // 轮播全量图：优先取笔记数据里的 imageList（顺序=滑动顺序，含封面），拿不到再退回 DOM
  let images = []
  try {
    const state = window.__INITIAL_STATE__
    const map = state?.note?.noteDetailMap || state?._rawValue?.note?.noteDetailMap
    const noteKey = map && Object.keys(map)[0]
    const list = noteKey ? (map[noteKey]?.note?.imageList || map[noteKey]?._rawValue?.note?.imageList) : null
    images = (list || [])
      .map((it) => it?.urlDefault || it?.url || (Array.isArray(it?.urlList) ? it.urlList[0] : ''))
      .filter(Boolean)
  } catch {}
  if (!images.length) images = webpics

  const tags = [...document.querySelectorAll('.tag, #detail-desc .tag')]
    .map((e) => e.innerText.trim())
    .filter((t) => t.startsWith('#'))
    .slice(0, 10)

  // 视频笔记也要拿到源片地址：工作台靠它抽帧扒口播字幕。blob: 分段流下载不了，退到笔记数据里的直链
  const xhsVideo = document.querySelector('video')
  const xhsElSrc = (xhsVideo && (xhsVideo.currentSrc || xhsVideo.src)) || ''
  let xhsSrc = /^https?:/.test(xhsElSrc) ? xhsElSrc : ''
  if (!xhsSrc) {
    try {
      const map = window.__INITIAL_STATE__?.note?.noteDetailMap
      const key = map && Object.keys(map)[0]
      const entry = key ? map[key] : null
      const n = entry?._rawValue?.note ?? entry?.note ?? entry?._rawValue ?? entry
      const streams = Object.values(n?.video?.media?.stream || {}).flat()
      xhsSrc = streams.map((s) => s && s.masterUrl).filter(Boolean).sort((a, b) => b.length - a.length)[0]
        || (n?.video?.url && /^https?:/.test(n.video.url) ? n.video.url : '')
    } catch {}
  }

  return {
    title: pick('#detail-title') || '',
    desc: pick('#detail-desc') || '',
    author: pick('.username') || '',
    postedAt: pick('.date') || '',
    likes: counters[0] ?? '',
    collects: counters[1] ?? '',
    comments: counters[2] ?? '',
    image: img,
    images,
    tags,
    videoSrc: /^https?:/.test(xhsSrc) ? xhsSrc : '',
    format: xhsSrc ? 'video' : 'image',
  }
}

/** 抖音作品抓取（注入执行，必须自包含，可为 async）。两种形态都走这里：
 *  ① 详情页 /video/|/note/  ② 沉浸弹窗（搜索页/精选页点卡片，URL 变 ?modal_id=<id>，页面不跳转）。
 *  抖音 DOM 类名全是哈希，只有 data-e2e 属性和「发布时间：」文本签名是稳定的——选择器据此来。
 *  弹窗里同时挂着相邻作品的播放器，一切取数以当前条容器（feed-active-video）为界，否则会把别条的点赞采过来。 */
async function scrapeDouyin() {
  const isModal = /[?&]modal_id=\d{15,20}/.test(location.href)
  const root = document.querySelector('[data-e2e="feed-active-video"]')
    || document.querySelector('[data-e2e="note-detail"], [data-e2e="video-detail"]')
    || document.body
  const e2e = (k) => root.querySelector(`[data-e2e="${k}"]`)?.innerText?.trim() || ''
  // 抖音 h1/标题把话题标签拼在正文尾巴上；标题要干净（它还是文件名），标签归 tags
  const h1 = document.querySelector('h1')?.innerText?.trim() || ''
  // 图文页没有 h1，浏览器标签页标题是截断的——只拿它当前缀定位正文用
  const titleGuess = (h1 || document.title).replace(/\s*-\s*抖音.*$/, '').replace(/\s+#\S+/g, '').trim()

  // 源图：轮播图带 biz_tag=aweme_images；限定在 root 内取，侧栏推荐位自然隔离在外
  const seen = new Set()
  const rootImgs = [...root.querySelectorAll('img')]
    .map((i) => i.src)
    .filter((s) => s && !seen.has(s) && (seen.add(s), true))
  const images = rootImgs.filter((s) => /aweme_images/.test(s))
  const isNote = /\/note\//.test(location.pathname) || images.length > 0
  let image = (isNote ? images[0] : '') || rootImgs.find((s) => /pcweb_cover/.test(s)) || ''

  // 正文：详情页用「发布时间：」签名定位最小容器；弹窗里没这文本，退回 video-desc 整段
  let cap = null
  for (const e of root.querySelectorAll('div,span,p')) {
    const t = (e.innerText || '').trim()
    if (t.includes('发布时间：') && t.length < 1000 && t.startsWith(titleGuess.slice(0, 8))) {
      if (!cap || t.length < cap.innerText.length) cap = e
    }
  }
  const capText = cap ? cap.innerText.trim() : ''
  let postedAt = (capText.match(/发布时间：([0-9: -]+)/) || [])[1] || ''
  let desc = capText.replace(/\s*发布时间：[\s\S]*$/, '').replace(/\n*展开$/, '').trim()
  if (!desc) desc = e2e('video-desc').replace(/\n*展开$/, '').trim()
  if (!postedAt) {
    // 弹窗的日期藏在 video-info：「@作者\n· 2025年10月13日\n正文…」
    postedAt = (e2e('video-info').match(/·\s*([0-9]{4}年[0-9]{1,2}月[0-9]{1,2}日|[0-9]{1,2}月[0-9]{1,2}日)/) || [])[1] || ''
  }
  // 无 h1 时标题取正文第一句（到句读为止），宁短勿断在半截；标签不进标题（它还是文件名）
  const descHead = desc.replace(/#[^\s#]+/g, '').trim()
  const firstSentence = (descHead.match(/^[^。！？!?]{2,}?[。！？!?]/) || [descHead.slice(0, 30)])[0].trim()
  const title = h1
    ? h1.replace(/\s+#\S+/g, '').trim()
    : firstSentence.length <= 30 ? firstSentence : firstSentence.slice(0, 30)

  const author = [...(root.querySelector('[data-e2e="user-info"]')?.querySelectorAll('span,a') || [])]
    .map((e) => e.innerText.trim()).find((t) => t && t.length < 15 && !/\d/.test(t))
    || e2e('feed-video-nickname').replace(/^@/, '').split(/\s*·\s*/)[0]

  // 视频封面兜底：详情页 poster 与弹窗封面常是黑帧占位，直接截当前条播放器的 1 秒处画面。
  // 服务端优先用 imageData，image URL 只留作降级。
  // 视频源：工作台入库后按它下载源片、抽帧扒口播字幕——采集时没带脚本，事后就得回源重采，所以这里宁肯多等两轮
  let videoSrc = ''
  let imageData = ''
  /** 抖音视频直链：播放器的 currentSrc 基本是 blob: MSE 分段流，下载不了。三条来源按可靠性排：
   *  播放器 https 直链 → 页面自带作品数据里的 playApi/play_addr → 资源计时里播放器真正拉的那条。
   *  资源计时是整页读数，混着信息流里刚播过的别条：09-28 就把「做成大事」的源片采成同页前一条
   *  「用 AI 学习搭知识库」——封面正文都对，脚本整段是别人的话。所以详情页（URL 带作品 id）一律不认它，
   *  宁可卡上留「缺脚本」回源重采，也不拿别条视频的逐字稿冒充。 */
  const readVideoSrc = () => {
    const awemeId = (location.pathname.match(/\/(?:video|note)\/(\d{15,20})/) || location.href.match(/[?&]modal_id=(\d{15,20})/) || [])[1] || ''
    const el = root.querySelector('video')
    const elSrc = el ? el.currentSrc || el.src || '' : ''
    if (/^https?:/.test(elSrc)) return elSrc
    try {
      const ld = window._ROUTER_DATA?.loaderData
      const key = ld && Object.keys(ld).find((k) => /video|note/.test(k))
      const detail = key ? (ld[key]?.videoInfoRes?.item_list?.[0] || ld[key]?.noteInfoRes?.item_list?.[0]) : null
      const s = detail?.video?.play_addr?.url_list?.[0] || detail?.video?.play_api || ''
      if (/^https?:\/\//.test(s) && !s.includes('[')) return s
    } catch {}
    if (awemeId && /\/(?:video|note)\/\d{15,20}/.test(location.pathname)) return ''
    const res = performance.getEntriesByType('resource').map((e) => e.name)
    const cdn = res.filter((n) => /^https?:/.test(n) && /media-video|\.mp4\?/.test(n) && !n.startsWith(location.origin))
    const mine = awemeId ? cdn.filter((n) => n.includes(awemeId)) : cdn
    return mine.length ? mine[mine.length - 1] : ''
  }
  const isVideoPost = !isNote || /\/video\//.test(location.pathname)
  if (isVideoPost) {
    const v = root.querySelector('video')
    for (let i = 0; i < 3 && !videoSrc; i++) {
      videoSrc = readVideoSrc()
      if (videoSrc || !v) break
      // 播放器还没起播就没有任何流可认：先把它叫醒（自动播放策略下带声播放常被拒，先静音再解静音）
      try {
        v.muted = true
        await v.play()
      } catch {}
      await new Promise((r) => setTimeout(r, 1500))
    }
    try {
      if (v && !v.paused) {
        v.pause()
        v.muted = false
      }
      if (v && v.videoWidth > 0) {
        v.currentTime = Math.min(1, (v.duration || 2) / 2)
        await Promise.race([
          new Promise((r) => v.addEventListener('seeked', r, { once: true })),
          new Promise((r) => setTimeout(r, 1500)),
        ])
        await new Promise((r) => setTimeout(r, 250))
        const c = document.createElement('canvas')
        c.width = v.videoWidth
        c.height = v.videoHeight
        c.getContext('2d').drawImage(v, 0, 0)
        const url = c.toDataURL('image/jpeg', 0.85)
        // 黑帧（首帧淡入）就再往后截一帧
        if (url.length > 20000) imageData = url
        else {
          v.currentTime = Math.min(2, v.duration || 3)
          await Promise.race([
            new Promise((r) => v.addEventListener('seeked', r, { once: true })),
            new Promise((r) => setTimeout(r, 1500)),
          ])
          await new Promise((r) => setTimeout(r, 250))
          c.getContext('2d').drawImage(v, 0, 0)
          imageData = c.toDataURL('image/jpeg', 0.85)
        }
      }
    } catch {}
  }

  const tags = (desc.match(/#[^\s#]+/g) || []).slice(0, 10)
  const v0 = document.querySelector('video')

  return {
    title, desc, author, postedAt,
    likes: e2e('video-player-digg'),
    collects: e2e('video-player-collect'),
    comments: e2e('feed-comment-icon'),
    image, images, imageData, videoSrc, tags,
    // 播放器时长：服务端拿它核对下回来的源片是不是这条作品（对不上就丢，宁缺勿错）
    videoDuration: v0 && Number.isFinite(v0.duration) ? Math.round(v0.duration) : 0,
    format: isNote ? 'image' : 'video',
  }
}

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  currentTab = tab
  const url = tab?.url || ''
  if (/xiaohongshu\.com\/(explore|discovery\/item)\//.test(url)) {
    setPageState('小红书笔记页已识别', true)
    btn.disabled = false
  } else if (/douyin\.com\/(video|note)\/\d+/.test(url) || (/douyin\.com/.test(url) && /[?&]modal_id=\d{15,20}/.test(url))) {
    setPageState('抖音作品页已识别', true)
    btn.disabled = false
  } else if (/xiaohongshu\.com/.test(url)) {
    setPageState('当前是小红书，不是笔记详情页')
    setStatus('请先打开某条笔记的详情页再采集。')
  } else if (/douyin\.com/.test(url)) {
    setPageState('当前是抖音，不是作品详情页')
    setStatus('请先打开某条视频或图文的详情页再采集。')
  } else {
    setPageState('当前页面不支持')
    setStatus('打开小红书笔记或抖音作品详情页后，再点本插件。')
  }
}

btn.addEventListener('click', async () => {
  if (!currentTab?.id) return
  btn.disabled = true
  setBtn('采集中…')
  setStatus('')
  try {
    // 1. 注入页面抓取（按站点选抓取函数）。MAIN world：作品数据（_ROUTER_DATA / __INITIAL_STATE__）只在页面世界里有
    const isDouyin = /douyin\.com/.test(currentTab.url || '')
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: currentTab.id },
      world: 'MAIN',
      func: isDouyin ? scrapeDouyin : scrapeNote,
    })
    const data = res?.result
    if (!data || (!data.title && !data.desc)) {
      throw new Error('页面还没加载完（标题和正文都为空），等两秒重试')
    }

    // 2. POST 给 dev server 落盘。弹窗形态的 URL（搜索页?modal_id=…）会过期，换成规范作品链接
    let url = currentTab.url || ''
    const mid = url.match(/[?&]modal_id=(\d{15,20})/)
    if (isDouyin && mid && !/douyin\.com\/(video|note)\//.test(url)) {
      url = `https://www.douyin.com/${data.format === 'image' ? 'note' : 'video'}/${mid[1]}`
    }
    const resp = await fetch('http://localhost:5173/__collect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, platform: isDouyin ? '抖音' : '小红书', ...data }),
    })
    const out = await resp.json()
    if (!resp.ok || !out.ok) throw new Error(out.error || `HTTP ${resp.status}`)

    // 3. 反馈：脚本与拆解由服务端收尾自动跑，这里报去向 + 源料缺时当场说清
    setBtn('已采集', 'done')
    const lines = [`已写入：${out.file}`]
    if (out.image) lines.push('封面图已存')
    if (data.format === 'video') {
      lines.push(out.videoFile ? '源片已存：工作台详情里能直接播' : '没拿到视频源片：等画面开始播再采一次，否则脚本扒不出来')
    }
    lines.push('脚本与拆解自动跑，稍后在工作台看结果')
    if (out.converted) lines.push(`这条已立项「${out.converted}」，灵感库收在「已立项」档里`)
    setStatus(lines.join('\n'), 'ok')
  } catch (e) {
    setBtn('采集当前笔记')
    btn.disabled = false
    const msg = String(e?.message || e)
    setStatus(
      msg.includes('Failed to fetch')
        ? '连不上 localhost:5173 —— 创作者增长平台的 dev server 没在跑。'
        : `采集失败：${msg}`,
      'error',
    )
  }
})

init()
