/**
 * 采集即补脚本：把卡片的「## 脚本」段扒出来写回。全程本机，零 token 零外发。
 * 图文＝逐页源图 → macOS Vision OCR（tools/ocr）；视频＝源片 → ffmpeg 抽帧 OCR 硬字幕，
 * 认不到硬字幕才退到 whisper.cpp 本地语音转写（ASR 同音字多，只当兜底）。
 * 脚本是拆与写的唯一原料（口径见 content/Knowledge/爆款拆解.md），拿不到料才允许留空。
 *
 * 用法（命令行，给旧卡回填或单条重扒）：
 *   node scripts/capture-script.mjs <content/.../x.md> [--video <本地mp4路径>]
 *   node scripts/capture-script.mjs --pending        # 扫爆款采集卡与收藏搬运卡：有源料却没脚本的当场扒完
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, existsSync } from 'node:fs'
import { join, basename, relative } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { MEDIA_HUB_ROOT, toolBin, vendorBinDir, hasAudioStream } from './collect-note-core.mjs'
import { progress } from './sync-step.mjs'
import { STOPPED_TEXT, isUserStop } from './run-jobs.mjs'

const run = promisify(execFile)
const OCR_SRC = 'tools/ocr.swift'
const OCR_BIN = 'tools/ocr'
/** whisper.cpp 模型：`brew install whisper-cpp` 后把 ggml-*.bin 放这儿 */
export const WHISPER_MODEL = process.env.WHISPER_MODEL || join(homedir(), '.cache/media-hub/whisper/ggml-small.bin')
/** 简体中文提示词：whisper 认中文默认出繁体，给它一句简体样例它就会跟着用简体 */
const ZH_PROMPT = '以下是口播原文，请用简体中文逐字记录：'

/** Vision OCR：包内二进制（取料脚本编好的两架构）→ 本机现编的 tools/ocr → 现场编译一次 */
async function ocrBin(root, signal) {
  const inPackage = join(vendorBinDir({ root }), 'ocr')
  if (existsSync(inPackage)) return inPackage
  const bin = join(root, OCR_BIN)
  if (existsSync(bin)) return bin
  const out = await run('swiftc', [join(root, OCR_SRC), '-o', bin], { signal }).then(() => bin).catch((e) => { if (isUserStop(e)) throw e; return '' })
  if (!out) throw new Error('本机 OCR 没编出来：这台机器没有 swiftc 工具链')
  return out
}

/** 一次喂多张图：每张 ~0.2 秒，起一个进程比逐张开一次快得多 */
async function ocrImages(files, root, strict = true, signal) {
  if (!files.length) return []
  const bin = await ocrBin(root, signal)
  const { stdout, stderr } = await run(bin, files, { maxBuffer: 64 * 1024 * 1024, signal })
  const got = new Map()
  let cur = null
  for (const line of stdout.split(/\r?\n/)) {
    if (line.startsWith('@@@')) {
      cur = line.slice(3).trim()
      got.set(cur, [])
    } else if (cur) {
      got.get(cur).push(line)
    }
  }
  const texts = files.map((f) => (got.get(f) || []).join('\n').trim())
  // 一张字都没认出来多半是图根本读不到（路径错/格式不支持），别把空壳写进卡里
  if (strict && !texts.some(Boolean)) throw new Error(`本机 OCR 一个字符都没认出来：${(stderr || '图里确实没有文字').split(/\r?\n/)[0]}`)
  return texts
}

/** 源图目录：带 / 的按 public/ 下相对路径解析（爆款采集线落在 viral/<平台>/<id>），
 *  老的灵感卡只写裸目录名 → 仍在 public/inspiration/ 下 */
const imgDirOf = (dirName, root) => join(root, 'public', dirName.includes('/') ? dirName : `inspiration/${dirName}`)

/** Vision 按画面行切，一句长话常被版心劈成两三行。这里按「行尾没到句末标点」把折行接回去；
 *  下一行像新起一条（有序号/项目符号）就不接，宁可留断行也不把清单糊成一段。 */
function unwrap(text) {
  const out = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    const prev = out[out.length - 1]
    const breaks = /[。！？…；：）】》”’』.!?)\]}]$/.test(prev ?? '')
    const startsItem = /^[\d①②③④⑤⑥⑦⑧⑨⑩•·◦#*\->＞]/.test(line)
    if (prev && !breaks && !startsItem) {
      out[out.length - 1] = /[\u4e00-\u9fa5（]/.test(line[0]) ? prev + line : `${prev} ${line}`
    } else {
      out.push(line)
    }
  }
  return out.join('\n')
}

/** 图文：每一页图上的文字逐字抄下来，按页序 */
async function scriptFromPages(imgDir, root = MEDIA_HUB_ROOT, signal) {
  const dir = imgDirOf(imgDir, root)
  const files = readdirSync(dir).filter((f) => /\.(jpe?g|png|webp)$/i.test(f)).sort().map((f) => join(dir, f))
  if (!files.length) throw new Error(`源图目录是空的：${dir}`)
  const texts = await ocrImages(files, root, true, signal)
  const pages = texts.map((text, i) => ({ n: i + 1, text: unwrap(text) || '（无文字）' }))
  const chars = pages.reduce((n, p) => n + (p.text === '（无文字）' ? 0 : p.text.length), 0)
  // 只搬回封面时 OCR 出来就是海报上那几个字，写进卡会骗人去拆——宁可报错让人重采源图
  if (chars < 40) throw new Error(`源图 ${pages.length} 页只认到 ${chars} 字，不像完整图文（多半只搬回封面），回详情页重采逐页原图`)
  return {
    kind: 'image',
    note: `图文逐页图内文字，共 ${pages.length} 页（本机 Vision OCR 逐页识别，不经任何模型）。`,
    body: pages.map((p) => `### 第 ${p.n} 页\n${p.text}`).join('\n\n'),
  }
}

/** 一段文字里首尾汉字之间的部分：AI 插画类视频的整幅画面都是英文花字，
 *  OCR 会把它们和中文口播混进同一段，取中文跨度就能把两头的花字甩掉。 */
const CJK = /[\u3400-\u9fff]/
function cjkSpan(text) {
  const chars = [...text]
  let first = -1
  let last = -1
  chars.forEach((c, i) => {
    if (!CJK.test(c)) return
    if (first < 0) first = i
    last = i
  })
  return first < 0 ? '' : chars.slice(first, last + 1).join('').trim()
}

/** 视频：抽帧 OCR 硬字幕 → 去相邻重复 → 按时间序拼成口播逐字稿；没硬字幕退 ASR */
async function scriptFromVideo(mp4, root = MEDIA_HUB_ROOT, signal) {
  const { stdout } = await run(toolBin('ffprobe'), ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', mp4], { signal })
  const dur = Number(stdout.trim()) || 0
  if (!dur) throw new Error('读不到视频时长，抽帧无从下手')
  // 1.2 秒一帧足够接住字幕切换；超过 5 分钟的长片放宽到 2.4 秒，别把帧数打爆
  const step = dur > 300 ? 2.4 : 1.2
  const work = join(tmpdir(), `media-hub-script-${Date.now()}`)
  mkdirSync(work, { recursive: true })
  try {
    // 字幕带取画面下半幅：竖屏口播的字幕（中英双行）都落在这一带，切掉上半幅能少一半像素
    await run(toolBin('ffmpeg'), ['-v', 'error', '-i', mp4, '-vf', `fps=${1 / step},crop=iw:ih*0.5:0:ih*0.5,scale=760:-1`, join(work, 'f-%04d.jpg')], { signal })
    const frames = readdirSync(work).filter((f) => f.endsWith('.jpg')).sort().map((f) => join(work, f))
    if (!frames.length) throw new Error('ffmpeg 没抽出帧')
    // 没硬字幕是常态（不是读图失败），这里不 strict，交给下面的 ASR 兜底
    const texts = await ocrImages(frames, root, false, signal)
    // 平台水印常年吊在字幕行尾（「@心理能量」），逐行剥掉行尾的 @xxx，不然每句都带一条假口癖
    const blocks = texts.map((raw, i) => ({
      stamp: `${(i * step).toFixed(0)}s`,
      list: raw.split(/\r?\n/).map((l) => l.replace(/(\s*@[^\s@]+)+\s*$/, '').trim()).filter(Boolean),
    }))
    // 中文口播认得出足够多中文，才敢把纯英文块当花字丢掉；英文字幕的视频不满足，原样保留
    const cjkLen = blocks.reduce((n, f) => n + f.list.reduce((m, l) => m + cjkSpan(l).length, 0), 0)
    const rawLen = blocks.reduce((n, f) => n + f.list.join('').length, 0)
    const dropLatin = cjkLen >= 40 && cjkLen < rawLen
    const lines = []
    for (const frame of blocks) {
      const t = (dropLatin ? frame.list.map(cjkSpan).filter(Boolean) : frame.list).join(' ').replace(/\s+/g, ' ').trim()
      if (!t) continue
      const prev = lines[lines.length - 1]
      // 同一条字幕会连着占几帧；换句时偶尔只认出后半截，包含关系也当重复
      if (prev && (prev.text === t || prev.text.includes(t) || t.includes(prev.text))) {
        if (t.length > prev.text.length) lines[lines.length - 1] = { stamp: prev.stamp, text: t }
        continue
      }
      lines.push({ stamp: frame.stamp, text: t })
    }
    if (lines.length >= 5) {
      return {
        kind: 'video',
        note: `全程口播逐字稿（源片 ${Math.round(dur)} 秒，每 ${step} 秒抽一帧本机 OCR 硬字幕，零 token），〔Ns〕是该句出现的秒数。`,
        body: lines.map((l) => `[${l.stamp}] ${l.text}`).join('\n'),
      }
    }
    // 画面没烧字幕：退到本地语音转写。但抖音的 DASH 源片常常只有画面轨——哑片没得转，直说别硬编
    if (!(await hasAudioStream(mp4))) {
      throw new Error('这条视频画面没烧字幕，源片里又没有音轨（采集时只拉到画面轨），本机两条路都走不通')
    }
    const asr = await transcribe(mp4, dur, signal)
    if (!asr) throw new Error('这条视频既没认出硬字幕、也没有可转写的语音')
    return {
      kind: 'video',
      note: `全程口播逐字稿（源片 ${Math.round(dur)} 秒，画面无硬字幕 → 本机 whisper 语音转写；同音字可能有误，复刻前请对音频核一遍）。`,
      body: asr,
    }
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

/** 本地 ASR 兜底：ffmpeg 抽音轨 → whisper-cli 转写 → 读回 txt */
async function transcribe(mp4, dur, signal) {
  const cli = toolBin('whisper-cli')
  if (!existsSync(cli) || !existsSync(WHISPER_MODEL)) return ''
  const work = join(tmpdir(), `media-hub-asr-${Date.now()}`)
  mkdirSync(work, { recursive: true })
  try {
    const wav = join(work, 'a.wav')
    await run(toolBin('ffmpeg'), ['-v', 'error', '-y', '-i', mp4, '-vn', '-ac', '1', '-ar', '16000', wav], { signal })
    // 转写耗时约等于片长，20 分钟的视频别按 3 倍超时掐掉
    await run(cli, ['-m', WHISPER_MODEL, '-f', wav, '-l', 'auto', '--prompt', ZH_PROMPT, '-otxt', '-of', join(work, 'a')], {
      timeout: Math.max(600_000, dur * 60_000),
      maxBuffer: 32 * 1024 * 1024,
      signal,
    })
    return readFileSync(join(work, 'a.txt'), 'utf8').replace(/\s*\n\s*/g, '\n').trim()
  } catch (e) {
    // 这段吞错是「转写没成功就当没字幕」，但人按的停止不能吞——吞了会说成「既没硬字幕也没语音」
    if (isUserStop(e)) throw e
    return ''
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

/** 下载视频源到临时目录。抖音/小红书的 CDN 认 Referer，缺头就 403 */
async function downloadVideo(src, referer, signal) {
  const file = join(tmpdir(), `media-hub-script-${Date.now()}.mp4`)
  const res = await fetch(src, { headers: { 'User-Agent': 'Mozilla/5.0', Referer: referer || '' }, redirect: 'follow', signal })
  if (!res.ok) throw new Error(`下载视频源失败：HTTP ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.length < 100_000) throw new Error(`下载的视频源太小（${buf.length} 字节），不像成片`)
  writeFileSync(file, buf)
  return file
}

const fm = (md, k) => (md.match(new RegExp('^' + k + ':\\s*(.*)$', 'm')) || [])[1]?.trim() || ''

/** 写回/替换卡里的「## 脚本」段（幂等：重扒不叠加） */
export function withScriptSection(md, script) {
  const section = `## 脚本（拆解与创作的唯一材料）\n\n> ${script.note}\n\n${script.body}\n`
  const re = /\n## 脚本[^\n]*\n[\s\S]*?(?=\n## |\n---\s*$|$)/
  if (re.test(md)) return md.replace(re, '\n' + section)
  return md.replace(/\s*$/, '') + '\n\n---\n\n' + section
}

/** 卡片自带的本地源片（public/ 下相对路径，或绝对路径）——爆款采集线采回来就是这个形态 */
function localVideo(md, root) {
  const p = fm(md, 'videoFile')
  if (!p) return ''
  const abs = p.startsWith('/') ? p : join(root, 'public', p)
  return existsSync(abs) ? abs : ''
}

/** 总入口：按卡片形态选路——有逐页源图走图文 OCR，视频要本地源片（videoFile / --video）或可下载的 videoSrc */
export async function captureScript(rel, opts = {}) {
  const root = opts.root || MEDIA_HUB_ROOT
  const file = join(root, rel)
  let md = readFileSync(file, 'utf8')
  const src = fm(md, 'videoSrc')
  // 有视频源就按视频走：视频笔记的 sourceImages 往往只有封面，拿它 OCR 出来的是海报不是脚本
  // 老爆款卡没写 format，链接里的 /video/<id> 是最后一条线索
  const isVideo =
    !!src || !!opts.videoFile || !!fm(md, 'videoFile') ||
    fm(md, 'format') === 'video' || fm(md, 'type') === 'video' || /\/video\/\d/.test(fm(md, 'url'))
  const imgDir = fm(md, 'sourceImages')

  let script
  try {
    if (isVideo) {
      const local = opts.videoFile || localVideo(md, root)
      if (!local && !src) return { ok: false, error: '视频卡没有源片：采集时没抓到视频，也没有可下载的 videoSrc' }
      let tmp = local
      try {
        if (!tmp) tmp = await downloadVideo(src, fm(md, 'url'), opts.signal)
        script = await scriptFromVideo(tmp, root, opts.signal)
      } finally {
        if (tmp && tmp !== local) rmSync(tmp, { force: true })
      }
    } else {
      if (!imgDir) return { ok: false, error: '图文卡没有逐页源图目录（sourceImages 为空）' }
      if (!existsSync(imgDirOf(imgDir, root))) return { ok: false, error: `源图目录不存在：public/${imgDir.includes('/') ? imgDir : `inspiration/${imgDir}`}` }
      script = await scriptFromPages(imgDir, root, opts.signal)
    }
  } catch (e) {
    if (isUserStop(e)) return { ok: false, aborted: true, error: STOPPED_TEXT }
    throw e
  }

  writeFileSync(file, withScriptSection(md, script))
  return { ok: true, kind: script.kind, chars: script.body.length, file: rel, name: basename(rel) }
}

/** 同一张卡不并发重扒（采集与手动重扒可能同时命中） */
const running = new Map()
export function captureScriptOnce(rel, opts) {
  if (!running.has(rel)) {
    const p = captureScript(rel, opts).finally(() => running.delete(rel))
    running.set(rel, p)
  }
  return running.get(rel)
}

function walkMd(dir) {
  const out = []
  if (!existsSync(dir)) return out
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...walkMd(p))
    else if (e.name.endsWith('.md') && e.name !== 'README.md') out.push(p)
  }
  return out
}

/** 采集卡的自动补扒扫描：有源料（逐页原图/源片）却没脚本的一次性扒完。
 *  爆款采集与收藏搬运两条线采回来都当场把源料落在 public/，这里纯本机 OCR/转写，不再回平台二次采集。 */
const PENDING_DIRS = ['content/Inbox/爆款采集', 'content/Inbox/采集笔记/收藏']

async function pendingScripts(root, limit) {
  const mdOf = (p) => readFileSync(p, 'utf8')
  const hasMaterial = (md) => /^(sourceImages|videoFile|videoSrc):\s*\S/m.test(md)
  // 与 build-data 的 cardScript 同口径：「## 脚本」段里去掉 > 引导行后有正文 = 已扒到
  const hasScript = (md) => {
    const m = md.match(/\n## 脚本[^\n]*\n([\s\S]*?)(?=\n## |\n---\s*$|$)/)
    return !!m && m[1].split('\n').filter((l) => l.trim() && !l.startsWith('>')).join('').trim().length > 0
  }
  const pending = PENDING_DIRS.flatMap((d) => walkMd(join(root, d)))
    .filter((p) => !p.includes('归档') && hasMaterial(mdOf(p)) && !hasScript(mdOf(p)))
    .map((p) => relative(root, p).replaceAll('\\', '/'))
  if (!pending.length) return console.log('[script] 采集卡脚本已齐，无需补扒')
  if (limit && pending.length > limit) console.log(`[script] 待补扒 ${pending.length} 张，本轮只处理前 ${limit} 张（视频 OCR 慢，剩下的下一轮）`)
  let ok = 0
  const todo = limit ? pending.slice(0, limit) : pending
  for (const [i, rel] of todo.entries()) {
    // 一张视频卡转写要几分钟，不逐卡报数界面就只能干等
    progress('', '本机转写', i + 1, todo.length, basename(rel))
    // captureScript 对「只搬回封面」「哑片无音轨」等是抛错而非返回失败，逐卡兜住才不断链
    const r = await captureScriptOnce(rel, { root }).catch((e) => ({ ok: false, error: String(e?.message || e) }))
    console.log(`[script] ${r.ok ? '✓' : '✗'} ${basename(rel)}：${r.ok ? `${r.kind} ${r.chars} 字` : r.error}`)
    if (r.ok) ok++
  }
  console.log(`[script] 自动补扒完成 ${ok}/${pending.length} 张`)
}

if (process.argv[1]?.endsWith('capture-script.mjs')) {
  const args = process.argv.slice(2)
  if (args.includes('--pending')) {
    const limit = Number((args.find((a) => a.startsWith('--limit=')) || '').slice(8)) || 0
    await pendingScripts(MEDIA_HUB_ROOT, limit)
    process.exit(0)
  }
  const rel = args.find((a) => !a.startsWith('--'))
  const vi = args.indexOf('--video')
  const videoFile = vi < 0 ? '' : args[vi + 1]
  if (!rel) {
    console.error('用法: node scripts/capture-script.mjs <content/.../x.md> [--video <本地mp4>] | --pending [--limit=N]')
    process.exit(1)
  }
  try {
    console.log(JSON.stringify(await captureScript(rel, { videoFile }), null, 2))
  } catch (e) {
    console.log(JSON.stringify({ ok: false, error: String(e?.message || e) }))
    process.exit(1)
  }
}
