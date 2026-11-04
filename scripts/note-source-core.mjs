/**
 * 详情页取料：爆款采集与收藏搬运都要进原帖详情页，一次拿齐两样东西——
 *   源料：图文=逐页原图直链，视频=源片直链（抖音是 DASH 分轨，画面轨与音频轨要合流）
 *   文案：发布正文、话题、发布时间、赞藏评三个计数（列表页只给赞）
 * 签名接口调不动（406/403），所以全部靠页面自己那次渲染：SSR 状态 + 资源计时。
 * 直链都带签名会过期，采到当场就得下载。
 */
import { writeFileSync, readFileSync, mkdirSync, rmSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { MEDIA_HUB_ROOT, toolBin, hasAudioStream } from './collect-note-core.mjs'

const run = promisify(execFile)

/** 源片体积上限：CDN 直链偶尔给到 4K 原盘，本机 OCR 用不着，也别把盘塞爆 */
export const MAX_SOURCE_BYTES = 200 * 1024 * 1024

/** 拉一个 URL 的字节；Referer 是抖音/小红书 CDN 的硬要求，缺头 403。失败或超限给 null */
async function fetchBytes(url, referer, maxBytes) {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', Referer: referer || '' }, redirect: 'follow' })
    if (!res.ok) return null
    if (Number(res.headers.get('content-length') || 0) > maxBytes) return null
    const buf = Buffer.from(await res.arrayBuffer())
    return buf.length && buf.length <= maxBytes ? buf : null
  } catch {
    return null
  }
}

/** 按文件头认图片格式：CDN 的 content-type 会说谎（webp 报成 jpeg），扩展名错了本机 OCR 就读不出 */
function sniffImageType(buf) {
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'jpg'
  if (buf[0] === 0x89 && buf[1] === 0x50) return 'png'
  if (buf.subarray(8, 12).toString() === 'WEBP') return 'webp'
  return 'jpg'
}

/** 图文源料：逐页原图 → <dirRel>/page-NN.*（页序即滑动顺序，脚本靠它 OCR） */
async function downloadPages(urls, dirRel, root, maxBytes) {
  mkdirSync(join(root, 'public', dirRel), { recursive: true })
  let count = 0
  for (let i = 0; i < urls.length; i++) {
    const buf = await fetchBytes(urls[i], '', maxBytes)
    if (!buf) continue
    writeFileSync(join(root, 'public', dirRel, `page-${String(i + 1).padStart(2, '0')}.${sniffImageType(buf)}`), buf)
    count++
  }
  return count
}

/** 视频源料：画面轨拉不到就算失败；音频轨拉不到只当哑片（硬字幕 OCR 不受影响）。 */
async function downloadVideoSource({ videoUrl, audioUrl }, dirRel, referer, root, maxBytes) {
  mkdirSync(join(root, 'public', dirRel), { recursive: true })
  const out = join(root, 'public', dirRel, 'source.mp4')
  const v = await fetchBytes(videoUrl, referer, maxBytes)
  if (!v) return { ok: false, error: '源片没拉到（直链过期或体积超限）' }
  writeFileSync(out, v)
  const a = join(root, 'public', dirRel, 'audio.m4a')
  const ab = audioUrl ? await fetchBytes(audioUrl, referer, maxBytes) : null
  if (!ab) return { ok: true, bytes: v.length, muted: !(await hasAudioStream(out)) }
  writeFileSync(a, ab)
  const merged = `${out}.mux`
  try {
    await run(toolBin('ffmpeg'), ['-v', 'error', '-y', '-i', out, '-i', a, '-map', '0:v:0', '-map', '1:a:0', '-c', 'copy', merged])
    rmSync(out, { force: true })
    renameSync(merged, out)
    return { ok: true, bytes: readFileSync(out).length, muted: !(await hasAudioStream(out)) }
  } catch {
    // 合流失败不丢源片：画面照样抽得出帧做 OCR，只是没了语音兜底
    rmSync(merged, { force: true })
    return { ok: true, bytes: v.length, muted: true }
  } finally {
    rmSync(a, { force: true })
  }
}

export const DETAIL = {
  xiaohongshu: {
    label: '小红书',
    referer: 'https://www.xiaohongshu.com/',
    /** 图文看 SSR 的 imageList，视频只能看播放器实际拉没拉：state 里的 masterUrl 不带 sign */
    detailReady: (id) => {
      const n = window.__INITIAL_STATE__?.note?.noteDetailMap?.[id]?.note
      if (!n) return false
      return n.type === 'video'
        ? performance.getEntriesByType('resource').some((e) => /\.mp4/.test(e.name))
        : (n.imageList || []).length > 0
    },
    detailRead: (id) => {
      const map = window.__INITIAL_STATE__?.note?.noteDetailMap || {}
      const n = map[Object.keys(map).find((x) => x.startsWith(id))]?.note || {}
      const streams = Object.values(n.video?.media?.stream || {}).flat()
      const it = n.interactInfo || {}
      return {
        noteType: n.type === 'video' ? 'video' : 'image',
        imageUrls: (n.imageList || []).map((i) => i.urlDefault || i.url || '').filter(Boolean),
        videoUrl:
          performance.getEntriesByType('resource').map((e) => e.name).find((x) => /\.mp4\?/.test(x)) ||
          streams.map((s) => s.masterUrl).filter(Boolean).sort((a, b) => b.length - a.length)[0] ||
          '',
        audioUrl: '',
        title: n.title || '',
        desc: n.desc || '',
        tags: (n.tagList || []).map((t) => t?.name || '').filter(Boolean),
        timeMs: Number(n.time || n.lastUpdateTime || 0) || 0,
        likes: it.likedCount || '',
        collects: it.collectedCount || '',
        comments: it.commentCount || '',
        durationSec: Math.round(Number(n.video?.media?.stream?.duration || 0) / 1000) || 0,
      }
    },
  },

  douyin: {
    label: '抖音',
    referer: 'https://www.douyin.com/',
    // 抖音详情页持续拉流，load 事件基本不会触发；等「画面真的出现了」而不是等页面加载完
    waitUntil: 'commit',
    /** 抖音是 DASH 分轨，画面轨/音频轨得合流才是一条能听能抽帧的源片 */
    dash: true,
    detailReady: () => {
      const res = performance.getEntriesByType('resource').map((e) => e.name)
      return res.some((n) => /media-video/.test(n)) || document.querySelectorAll('img').length > 6
    },
    detailRead: () => {
      const res = performance.getEntriesByType('resource').map((e) => e.name)
      // 图文笔记没有大轮播图就是还没渲染完，宁可下一轮再读
      const imgs = [...document.querySelectorAll('img')]
        .filter((i) => i.naturalWidth >= 400 && i.naturalHeight >= 400)
        .map((i) => i.currentSrc || i.src)
      /* 计数与文案有两个来源：路由数据里的 item（纯数字，最准），和播放器工具条上的文字（「72.5万」这种）。
         实测视频页的 _ROUTER_DATA 里翻不出 statistics（2026-11-04 探过，图文页偶尔有），所以 DOM 这条是常用路径：
         数字一律先认工具条那个图标自己身上的文字，往上一层就串到兄弟按钮了（收藏位曾读到「786214651211」这种粘连串）。 */
      let stat = null
      try {
        const stack = [window._ROUTER_DATA]
        while (stack.length && !stat) {
          const x = stack.pop()
          if (!x || typeof x !== 'object') continue
          if (x.statistics && typeof x.statistics === 'object') {
            stat = x
            break
          }
          for (const v of Object.values(x)) if (v && typeof v === 'object') stack.push(v)
        }
      } catch {}
      const domCount = (keys) => {
        for (const k of keys) {
          const el = document.querySelector(`[data-e2e="${k}"]`)
          if (!el) continue
          let node = el
          for (let up = 0; up < 4 && node; up++) {
            const m = String(node.innerText || '').replace(/\s+/g, ' ').trim().match(/^([\d.]+\s*[万千wW]?)$/)
            if (m && m[1] !== '0') return m[1].trim()
            node = node.parentElement
          }
        }
        return ''
      }
      const num = (v) => (v == null ? '' : String(v))
      const video = document.querySelector('video')
      const durSec = Math.round(Number(video?.duration) || Number(stat?.video?.duration || 0) / 1000) || 0
      // 抖音没有独立标题，页头那条 h1 就是发布正文；话题是正文里的 #锚点，单独摘出来当标签
      const h1 = (document.querySelector('h1')?.innerText || '').replace(/\s+/g, ' ').trim()
      const extra = (stat?.textExtra || []).map((x) => x?.hashtag_name || '').filter(Boolean)
      const hashTags = [...new Set(
        [...document.querySelectorAll('a')]
          .filter((a) => /^#[^#\s]+$/.test((a.innerText || '').trim()))
          .map((a) => a.innerText.trim().slice(1)),
      )]
      return {
        noteType: video ? 'video' : 'image',
        videoUrl: res.find((n) => /media-video/.test(n)) || '',
        audioUrl: res.find((n) => /media-audio/.test(n)) || '',
        imageUrls: [...new Set(imgs)],
        title: stat?.title || '',
        desc: stat?.desc || h1,
        tags: extra.length ? extra : hashTags,
        timeMs: Number(stat?.create_time || 0) * 1000,
        likes: stat ? num(stat.statistics.digg_count) : domCount(['video-player-digg']),
        collects: stat ? num(stat.statistics.collect_count) : domCount(['video-player-collect']),
        comments: stat ? num(stat.statistics.comment_count) : domCount(['feed-comment-icon', 'comment-count']),
        durationSec: durSec,
      }
    },
  },
}

/** 进详情页把这一包读回来：图文=逐页原图直链，视频=画面轨/音频轨直链，外加发布正文与计数。
 *  视频轨/音频轨要播放器真跑起来才拉，而它启不启动是看脸（自动播放策略）：
 *  键盘空格有时不生效（焦点不在播放器上），所以补几次真鼠标点击——只有可信事件能解掉静音态。 */
export async function readNoteDetail(page, platform, { link, id, format }) {
  const impl = DETAIL[platform]
  const empty = { noteType: format === 'video' ? 'video' : 'image', imageUrls: [], videoUrl: '', audioUrl: '', title: '', desc: '', tags: [], timeMs: 0 }
  try {
    await page.goto(link, { waitUntil: impl.waitUntil || 'load', timeout: 30000 })
  } catch {}
  let src = empty
  try {
    await page.waitForFunction(impl.detailReady, id, { timeout: 15000, polling: 1000 })
    src = (await page.evaluate(impl.detailRead, id)) || empty
  } catch {}
  if (src.noteType !== 'video') return src
  const enough = () => !!src.videoUrl && (!impl.dash || !!src.audioUrl)
  const refresh = async () => { src = (await page.evaluate(impl.detailRead, id)) || src }
  for (const wake of ['space', 'click', 'click', 'click']) {
    if (enough()) break
    try {
      if (wake === 'space') {
        await page.keyboard.press('Space')
      } else {
        const box = await page.evaluate(() => {
          const v = document.querySelector('video')
          if (!v || v.paused === false) return null
          const r = v.getBoundingClientRect()
          return { x: r.x, y: r.y, w: r.width, h: r.height }
        })
        if (box && box.w > 0) await page.mouse.click(box.x + box.w / 2, Math.min(box.y + box.h / 2, 700), { label: '唤醒播放器' })
      }
    } catch {}
    await page.waitForTimeout(3000)
    await refresh()
  }
  return src
}

/** 读 + 下载一步到位：返回详情页那包字段，再并上源料落盘结果（videoFile / sourceImages / pages / muted）或 error。
 *  只影响「这张卡能不能就地扒出脚本」，采不到也不拦卡片落盘。 */
export async function captureNoteSource(page, platform, card, dirRel, { root = MEDIA_HUB_ROOT, maxBytes = MAX_SOURCE_BYTES } = {}) {
  const impl = DETAIL[platform]
  const src = await readNoteDetail(page, platform, card)
  if (src.videoUrl) {
    const res = await downloadVideoSource(src, dirRel, impl.referer, root, maxBytes)
    return res.ok ? { ...src, videoFile: `${dirRel}/source.mp4`, muted: !!res.muted } : { ...src, error: res.error }
  }
  // 视频笔记的 imageList 只有封面一张，拿它当源图会扒出一张海报冒充脚本
  if (src.noteType === 'video') return { ...src, error: '详情页没等到视频直链' }
  const pages = await downloadPages(src.imageUrls, dirRel, root, maxBytes)
  return pages ? { ...src, sourceImages: dirRel, pages } : { ...src, error: '详情页没拿到逐页原图' }
}
