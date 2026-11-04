#!/usr/bin/env node
/**
 * 取料：把工作台要用的外部命令行工具装进 bin/darwin-<arch>/，
 * 让客户装完不用再 brew install（spec §三 第三步）。
 *
 * 下载走 curl 而不是 fetch：Node 的 fetch 不认 https_proxy，GitHub/HF 直连在本机不通。
 * 每个候选下完都跑能力校验（ffmpeg 必须有 libx264），不过就换下一个；全不过就非零退出。
 * 用法：npm run fetch:bin [-- --arch=arm64] [-- --only=ffmpeg,ffprobe] [-- --force]
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, existsSync, readFileSync, writeFileSync, renameSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { MEDIA_HUB_ROOT, vendorBinDir } from './collect-note-core.mjs'
import { stopRequested } from './sync-step.mjs'
import { STOPPED_TEXT } from './run-jobs.mjs'

const run = promisify(execFile)

/* 界面上按了停止要立刻掐掉正在下载的那一趟：curl 的 --max-time 给到 900 秒，等它自己跑完等于没给停止。
 * execFile 收 AbortSignal 会把 curl 一起收走；已下载的只在 tmp 里，没过能力校验就 rename 不到 bin/。 */
const stopAc = new AbortController()
const stopWatch = setInterval(() => { if (stopRequested()) stopAc.abort() }, 1000)
stopWatch.unref()

export const ARCHES = ['darwin-arm64', 'darwin-x64']
export const REQUIRED_TOOLS = ['ffmpeg', 'ffprobe']
/** 本机架构：界面只报这一份料，另一架构是打包时的事 */
export const HOST_ARCH = `darwin-${process.arch}`
const BIN = join(MEDIA_HUB_ROOT, 'bin')
const MANIFEST = join(BIN, 'manifest.json')

/** 带 sha256 的镜像源排第一：钉死哈希防换料，而且实测快一千倍（09-30 本机 npmmirror 13 MB/s、
 *  osxexperts 14 KB/s——放后面的话客户要干等 15 分钟才轮到能用的源）。
 *  原先让 osxexperts 打头是怕 darwin 的 ffmpeg-static 不含 libx264；实测镜像那个包认得到，
 *  能力校验照样兜着，过不了门就自动换下一个源。 */
const CANDIDATES = {
  'darwin-arm64': {
    ffmpeg: [
      { label: 'ffmpeg-static b6.1.1', url: 'https://registry.npmmirror.com/-/binary/ffmpeg-static/b6.1.1/ffmpeg-darwin-arm64',
        sha256: 'a90e3db6a3fd35f6074b013f948b1aa45b31c6375489d39e572bea3f18336584' },
      { label: 'osxexperts ffmpeg9 GPL', url: 'https://www.osxexperts.net/ffmpeg9arm.zip' },
    ],
    ffprobe: [
      { label: 'ffmpeg-static b6.1.1', url: 'https://registry.npmmirror.com/-/binary/ffmpeg-static/b6.1.1/ffprobe-darwin-arm64',
        sha256: 'bb2db6f5d8cef919da12fbf592119a987202a8c060a886f3cab091f9cab90b64' },
      { label: 'osxexperts ffprobe9 GPL', url: 'https://www.osxexperts.net/ffprobe9arm.zip' },
    ],
  },
  'darwin-x64': {
    ffmpeg: [
      { label: 'ffmpeg-static b6.1.1', url: 'https://registry.npmmirror.com/-/binary/ffmpeg-static/b6.1.1/ffmpeg-darwin-x64',
        sha256: 'ebdddc936f61e14049a2d4b549a412b8a40deeff6540e58a9f2a2da9e6b18894' },
      { label: 'osxexperts ffmpeg8 intel GPL', url: 'https://www.osxexperts.net/ffmpeg80intel.zip' },
    ],
    ffprobe: [
      { label: 'ffmpeg-static b6.1.1', url: 'https://registry.npmmirror.com/-/binary/ffmpeg-static/b6.1.1/ffprobe-darwin-x64',
        sha256: 'fa3add0ce901f7241abe0dfc0155d958fc834aca3f8ce61f87cc712ae669c1e0' },
      { label: 'osxexperts ffprobe8 intel GPL', url: 'https://www.osxexperts.net/ffprobe80intel.zip' },
    ],
  },
}

export function candidateFor(arch, tool) {
  const list = CANDIDATES[arch]?.[tool]
  if (!list?.length) throw new Error(`候选表缺 ${arch}/${tool}：去 CANDIDATES 补，别让它空着`)
  return list
}

/** unzip -Z1 的清单里挑条目：优先与工具同名的裸文件，其次任何同名（含子目录前缀） */
export function pickArchiveEntry(entries, toolName) {
  const clean = entries.filter((e) => e && !e.startsWith('__MACOSX') && !e.endsWith('/'))
  const exact = clean.find((e) => e === toolName)
  if (exact) return exact
  return clean.find((e) => e.split('/').pop() === toolName) ?? null
}

export async function sha256Of(file) {
  const { stdout } = await run('/usr/bin/shasum', ['-a', '256', file])
  return stdout.trim().split(/\s+/)[0]
}

export function isCurrent(manifest, arch, tool, sha) {
  return manifest?.[arch]?.[tool]?.sha256 === sha
}

async function curlTo(url, dest) {
  // --max-time 是整段传输的硬上限：osxexperts 实测会「连上了但不再吐字节」，只给 connect-timeout 会把整轮取料挂死
  await run('/usr/bin/curl', ['-fsSL', '--retry', '2', '--connect-timeout', '20', '--max-time', '900', '-o', dest, url], { maxBuffer: 8 * 1024 * 1024, signal: stopAc.signal })
}

/** zip 里只有一个可执行文件；裸文件（npmmirror 那路）直接搬 */
async function unpack(src, tool) {
  if (!src.endsWith('.zip')) return src
  const dir = mkdtempSync(join(tmpdir(), 'mh-unpack-'))
  const { stdout } = await run('/usr/bin/unzip', ['-Z1', src])
  const entry = pickArchiveEntry(stdout.split(/\r?\n/), tool)
  if (!entry) throw new Error(`${src} 里找不到 ${tool}`)
  await run('/usr/bin/unzip', ['-o', '-q', src, entry, '-d', dir])
  return join(dir, entry)
}

/** 装到位：tmp + rename，去隔离属性，ad-hoc 重签（下载来的 Mach-O 不签会被系统 kill 掉） */
async function install(dest, fromFile) {
  mkdirSync(join(dest, '..'), { recursive: true })
  const tmp = `${dest}.tmp-${Date.now()}`
  renameSync(fromFile, tmp)
  chmodSync(tmp, 0o755)
  await run('/usr/bin/xattr', ['-dr', 'com.apple.quarantine', tmp]).catch(() => {})
  await run('/usr/bin/codesign', ['--force', '--sign', '-', tmp]).catch(() => {})
  renameSync(tmp, dest)
}

/** 能力校验：认不出 libx264 的 ffmpeg 一律算不合格，宁可报错也不留下跑不出片的料 */
export async function gate(tool, path) {
  if (tool === 'ffprobe') {
    const { stdout } = await run(path, ['-v', 'error', '-version'])
    return stdout.split(/\r?\n/)[0]
  }
  const { stdout } = await run(path, ['-hide_banner', '-encoders'])
  if (!/libx264/.test(stdout)) throw new Error('这个构建不含 libx264，渲出的片子不能用')
  const v = await run(path, ['-hide_banner', '-version'])
  return v.stdout.split(/\r?\n/)[0]
}

/** 装好的料到底能不能用——装机与验收用同一把尺子，界面不许自己另定一套判据。
 *  不认 manifest 里的记账：那台脚本自己写的账，只认真跑一次的输出。 */
export async function checkTool(arch, tool) {
  const path = join(BIN, arch, tool)
  if (!existsSync(path)) return { tool, ready: false, reason: 'missing' }
  try {
    return { tool, ready: true, version: await gate(tool, path) }
  } catch (e) {
    return { tool, ready: false, reason: 'invalid', detail: String(e.message || e) }
  }
}

async function fetchTool(arch, tool, manifest, { force = false, log = console.log } = {}) {
  const dir = join(BIN, arch)
  const dest = join(dir, tool)
  if (!force && existsSync(dest)) {
    const sha = await sha256Of(dest)
    if (isCurrent(manifest, arch, tool, sha)) { log(`✓ ${arch}/${tool} 已就绪（${sha.slice(0, 8)}）`); return manifest[arch][tool] }
  }
  const problems = []
  for (const c of candidateFor(arch, tool)) {
    // 人在界面上按了停止：一个源都不再试。已装好的那份不受影响（下载先落 tmp，过了校验才 rename）
    if (stopRequested()) throw new Error(STOPPED_TEXT)
    log(`… ${arch}/${tool} ← ${c.label}`)
    try {
      // 扩展名跟着 URL 走：unpack() 靠 .zip 辨认压缩包，裸文件直接搬
      const raw = join(tmpdir(), `mh-${arch}-${tool}-${Date.now()}` + (c.url.endsWith('.zip') ? '.zip' : ''))
      await curlTo(c.url, raw)
      if (c.sha256) {
        const sha = await sha256Of(raw)
        if (sha !== c.sha256) throw new Error(`哈希对不上：${sha} ≠ ${c.sha256}`)
      }
      const file = await unpack(raw, tool)
      await install(dest, file)
      const sha = await sha256Of(dest)
      const version = await gate(tool, dest)
      const rec = { url: c.url, label: c.label, sha256: sha, version, takenAt: new Date().toISOString() }
      ;(manifest[arch] ||= {})[tool] = rec
      writeFileSync(`${MANIFEST}.tmp`, JSON.stringify(manifest, null, 2))
      renameSync(`${MANIFEST}.tmp`, MANIFEST)
      log(`✓ ${arch}/${tool} ← ${c.label}（${version}）`)
      return rec
    } catch (e) {
      problems.push(`${c.label}: ${String(e.message || e).split(/\r?\n/).pop()}`)
      log(`… ${arch}/${tool} 试 ${c.label} 失败`)
    }
  }
  throw new Error(`${arch}/${tool} 全部候选失败：\n  ${problems.join('\n  ')}`)
}

function parseArgs(argv) {
  const get = (k) => { const a = argv.find((s) => s.startsWith(`--${k}=`)); return a && a.slice(k.length + 3) }
  return {
    // 默认只取本机那份：bin/ 不进仓库也不进分发包，每台机器各取各的，没必要替别人下载
    arches: (get('arch') || HOST_ARCH).split(',').map((a) => (a.startsWith('darwin-') ? a : `darwin-${a}`)),
    tools: (get('only') || REQUIRED_TOOLS.join(',')).split(','),
    force: argv.includes('--force'),
  }
}

export async function main(argv = process.argv.slice(2)) {
  const { arches, tools, force } = parseArgs(argv)
  const log = console.log
  const manifest = existsSync(MANIFEST) ? JSON.parse(readFileSync(MANIFEST, 'utf8')) : {}
  if (!existsSync(join(BIN, HOST_ARCH, 'ffmpeg'))) {
    log(`提示：本机（${HOST_ARCH}）的料还没取全，动效渲染会退回系统的 ffmpeg。`)
  }
  for (const arch of arches) for (const tool of tools) await fetchTool(arch, tool, manifest, { force, log })
  return manifest
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/^\.?\//, ''))) {
  main().catch((e) => {
    const msg = String(e.message || e)
    console.error(msg)
    // 人在界面上按了停止退 3：服务端靠这一格把它记成「人工停止」，不许和真下载失败混成一类
    process.exit(msg === STOPPED_TEXT ? 3 : 1)
  })
}
