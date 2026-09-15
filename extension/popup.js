/** 采集弹窗逻辑：识别笔记页 → 抓取 → POST localhost:5173/__collect → 状态反馈 */

const $ = (id) => document.getElementById(id)
const statusEl = $('status')
const btn = $('collectBtn')
let currentTab = null

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
  const img = container
    ? [...container.querySelectorAll('img')].find((i) => /sns-webpic/.test(i.src))
    : null

  const tags = [...document.querySelectorAll('.tag, #detail-desc .tag')]
    .map((e) => e.innerText.trim())
    .filter((t) => t.startsWith('#'))
    .slice(0, 10)

  return {
    title: pick('#detail-title') || '',
    desc: pick('#detail-desc') || '',
    author: pick('.username') || '',
    postedAt: pick('.date') || '',
    likes: counters[0] ?? '',
    collects: counters[1] ?? '',
    comments: counters[2] ?? '',
    image: img ? img.src : '',
    tags,
  }
}

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  currentTab = tab
  const url = tab?.url || ''
  if (/xiaohongshu\.com\/(explore|discovery\/item)\//.test(url)) {
    $('pageState').textContent = '✓ 当前是笔记页'
    btn.disabled = false
  } else if (/xiaohongshu\.com/.test(url)) {
    $('pageState').textContent = '当前是小红书，但不是笔记详情页'
    setStatus('请先打开某条笔记的详情页再采集。')
  } else {
    $('pageState').textContent = '当前页面不是小红书'
    setStatus('打开小红书笔记详情页后，再点本插件。')
  }
}

btn.addEventListener('click', async () => {
  if (!currentTab?.id) return
  btn.disabled = true
  btn.textContent = '采集中…'
  setStatus('')
  try {
    // 1. 注入页面抓取
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: currentTab.id },
      func: scrapeNote,
    })
    const data = res?.result
    if (!data || (!data.title && !data.desc)) {
      throw new Error('页面还没加载完（标题和正文都为空），等两秒重试')
    }

    // 2. POST 给 dev server 落盘
    const resp = await fetch('http://localhost:5173/__collect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: currentTab.url, ...data }),
    })
    const out = await resp.json()
    if (!resp.ok || !out.ok) throw new Error(out.error || `HTTP ${resp.status}`)

    // 3. 反馈
    btn.textContent = '✓ 已采集'
    setStatus(`已写入：${out.file}\n${out.image ? '封面图已存\n' : ''}记得让 AI 补拆解（analysis）`, 'ok')
  } catch (e) {
    btn.textContent = '↗ 采集当前笔记'
    btn.disabled = false
    const msg = String(e?.message || e)
    setStatus(
      msg.includes('Failed to fetch')
        ? '连不上 localhost:5173 —— 自媒体工作台的 dev server 没在跑。'
        : `采集失败：${msg}`,
      'error',
    )
  }
})

init()
