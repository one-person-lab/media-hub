#!/usr/bin/env node
/**
 * 环境清单：这台机器到底具备没有，一次列全——只列一部分等于看不见缺什么。
 *
 * 每条判据都从"真正用它的那段代码"取，界面不许自己另定一套看起来就绪：
 *   取料二进制 → fetch-binaries 的 gate（真跑一次，ffmpeg 必须认到 libx264）
 *   命令行工具 → 我们这个进程叫不叫得动它（叫不动，脚本同样叫不动）
 *   登录态     → publish-check 派生的 metrics/login-state.json
 *   模型与依赖  → 文件在不在
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { MEDIA_HUB_ROOT, vendorBinDir, toolBin } from './collect-note-core.mjs'
import { readLlmKey } from './llm-core.mjs'
import { checkTool, REQUIRED_TOOLS, HOST_ARCH } from './fetch-binaries.mjs'
import { WHISPER_MODEL } from './capture-script.mjs'

const ROOT = MEDIA_HUB_ROOT

function readJson(p) {
  try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return null }
}

function sizeHuman(p) {
  try {
    const b = statSync(p).size
    return b >= 1048576 ? `${Math.round(b / 1048576)} MB` : `${Math.round(b / 1024)} KB`
  } catch { return '' }
}

/** 「09-30 15:04」；读不到时间就不显示 */
function stamp(iso) {
  const d = iso ? new Date(iso) : null
  if (!d || Number.isNaN(d.getTime())) return ''
  const p = (n) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 版本行只留版本号：「ffmpeg version 6.0 Copyright (c) 2000-…」整行塞进卡片没人读 */
export function justVersion(line) {
  return String(line || '').split(/\s+(?:Copyright|LLVM|clang)/)[0].trim()
}

/** 命令行工具在哪：包内 → Homebrew / /usr/local → 服务进程 PATH → ~/.local/bin。
 *  toolBin 只看前两级（ego 内嵌 Node 的 PATH 常不含 Homebrew），所以还要自己扫一遍 PATH。
 *  只回有没有：绝对路径不进界面。 */
export function hasCli(name) {
  if (existsSync(join(vendorBinDir({ root: ROOT }), name))) return true
  if (toolBin(name) !== name) return true
  return [...(process.env.PATH || '').split(':'), join(homedir(), '.local/bin')]
    .some((dir) => dir && existsSync(join(dir, name)))
}

/** 五个平台的登录态：没检测过和检测出没登录是两件事，别报成"没登录" */
function loginItems() {
  const accounts = readJson(join(ROOT, 'config/accounts.json')) || []
  const got = readJson(join(ROOT, 'metrics/login-state.json'))?.platforms || {}
  return accounts.map((a) => {
    const r = got[a.platform]
    const at = stamp(r?.checkedAt)
    const base = { id: `login-${a.key}`, label: a.platform, use: '', fix: 'accounts' }
    if (!r) return { ...base, state: 'missing', note: '还没检测过' }
    if (r.state === 'ok') return { ...base, state: 'ready', note: `${r.evidence || '已登录'}${at ? ` · ${at}` : ''}` }
    return { ...base, state: 'missing', note: `${r.error || '未登录'}${at ? ` · ${at}` : ''}` }
  })
}

/** 全量清单。分组顺序 = 一条内容从采到发的顺序，不是按依赖类型排。
 *  on/off 是这组的措辞：装软件说「已装」，说登录态就得讲「已登录」。 */
export async function checkEnv() {
  const video = []
  for (const t of REQUIRED_TOOLS) {
    const r = await checkTool(HOST_ARCH, t)
    video.push({
      id: t, label: t, use: t === 'ffmpeg' ? '渲片与抽帧' : '读时长与流信息',
      state: r.ready ? 'ready' : 'missing', note: r.ready ? justVersion(r.version) : r.reason === 'invalid' ? r.detail : '',
    })
  }

  const ocrBin = join(vendorBinDir({ root: ROOT }), 'ocr')
  const ocr = existsSync(ocrBin) ? ocrBin : join(ROOT, 'tools/ocr')
  const key = readLlmKey()

  return {
    ok: true,
    arch: HOST_ARCH,
    groups: [
      { id: 'video', title: '视频取料', task: 'fetch-bin', on: '已装', off: '未装', items: video },
      {
        id: 'collect', title: '采集通路', on: '已装', off: '未装', items: [
          {
            id: 'ego', label: 'ego-browser', use: '采集、发布检测、推草稿的执行器',
            state: hasCli('ego-browser') ? 'ready' : 'missing',
            note: hasCli('ego-browser') ? '' : '要装 Ego Lite 的命令行工具；装完点「重新检查」',
          },
          {
            id: 'llm-key', label: 'AI 引擎 Key', use: '爆款拆解与图文/视频创作',
            state: key ? 'ready' : 'missing', note: key ? '' : '还没填', fix: 'config',
          },
        ],
      },
      { id: 'login', title: '账号登录', on: '已登录', off: '未登录', items: loginItems() },
      {
        id: 'script', title: '逐字稿兜底', on: '已装', off: '未装', items: [
          {
            id: 'ocr', label: 'Vision OCR', use: '认画面上的硬字幕',
            state: existsSync(ocr) ? 'ready' : 'missing', note: existsSync(ocr) ? sizeHuman(ocr) : '首次用到时现场编一次',
          },
          {
            id: 'swiftc', label: 'Xcode 命令行工具', use: '现场编 OCR 才用得上',
            state: hasCli('swiftc') ? 'ready' : 'missing',
            note: hasCli('swiftc') ? '' : '要人工装：苹果的开发者命令行工具',
          },
          {
            id: 'whisper-cli', label: 'whisper-cli', use: '没硬字幕的口播片转文字',
            state: hasCli('whisper-cli') ? 'ready' : 'missing',
            note: hasCli('whisper-cli') ? '' : '要装 whisper.cpp（Homebrew 有），不装则无字幕视频扒不出逐字稿',
          },
          {
            id: 'whisper-model', label: 'Whisper 模型', use: '转写要用的权重文件',
            state: existsSync(WHISPER_MODEL) ? 'ready' : 'missing',
            note: existsSync(WHISPER_MODEL) ? sizeHuman(WHISPER_MODEL) : '没下过：无字幕视频扒不出逐字稿',
          },
        ],
      },
      {
        id: 'brand', title: '宣传片（可选线）', on: '已装', off: '未装', items: [
          {
            id: 'remotion', label: 'Remotion 工程依赖', use: '品牌宣传片那条渲染线',
            state: existsSync(join(ROOT, 'videos/promo-video-mediahub/node_modules')) ? 'ready' : 'missing',
            note: existsSync(join(ROOT, 'videos/promo-video-mediahub/node_modules')) ? '' : '没还原过：横屏宣传片渲不了',
          },
        ],
      },
    ],
  }
}
