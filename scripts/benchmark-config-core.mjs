#!/usr/bin/env node
/**
 * 对标采集口径的读写：config/benchmarks.json 是唯一事实源。
 * 对标账号页「采集条件」弹窗的保存走这里落盘（界面不碰 JSON 也不碰路径），
 * scripts/benchmark-collect.mjs 与 build-data.mjs 都只读它——改口径只有这一个入口。
 *
 * 校验口径（与爆款那份各管各的门槛，两线判据不同）：
 *  - 关键词：定位词，两平台共用；至少一个，自动去重去空白
 *  - 平台：scripts/benchmark-collect.mjs 的 PLATFORMS 键子集，至少留一个
 *  - 门槛三件套（minFollowers / maxInactiveDays / dailyLimitPerPlatform）：非负/正整数。
 *    门槛是「什么算值得长期对标」的定义，归用户拍板——这里只挡非法值，不替用户决定松紧
 */
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.env.MEDIA_HUB_ROOT || process.cwd()
export const BENCH_CONFIG_REL = 'config/benchmarks.json'

/** 支持找号的平台。与 scripts/benchmark-collect.mjs 的 PLATFORMS 键保持一致——
 *  加平台先改那里（搜索聚合与主页读数在那实现），这里只是白名单，别漂移。 */
export const SUPPORTED_PLATFORMS = ['xiaohongshu', 'douyin']

/** 弹窗可改的字段；其余键（_说明 一类注释、visitLimit/noteSample 这类不常动的）原样保留 */
const EDITABLE = ['keywords', 'platforms', 'minFollowers', 'maxInactiveDays', 'dailyLimitPerPlatform']

function readJson(p) {
  try {
    return JSON.parse(readFileSync(p, 'utf8'))
  } catch {
    return null
  }
}

/** 读出口径（不存在/读崩了返回 null，由调用方决定是报错还是不展示） */
export function readBenchConfig(root = ROOT) {
  const j = readJson(join(root, BENCH_CONFIG_REL))
  if (!j || typeof j !== 'object') return null
  return j
}

function intOf(raw, { min, label }) {
  const n = Number(raw)
  if (!Number.isInteger(n) || n < min) throw new Error(`${label} 得是 ≥ ${min} 的整数`)
  return n
}

/** 关键词：去空白、去重、保序 */
function cleanKeywords(raw) {
  const list = Array.isArray(raw) ? raw : []
  const out = []
  for (const k of list) {
    const t = String(k ?? '').trim()
    if (!t) continue
    if (!out.includes(t)) out.push(t)
    if (out.length > 30) throw new Error('关键词最多 30 个，采得过来才拆得过来')
  }
  if (!out.length) throw new Error('关键词至少要留一个：没有定位词，对标线不知道找谁的号')
  return out
}

function cleanPlatforms(raw) {
  const list = Array.isArray(raw) ? raw : []
  const out = list.map((p) => String(p ?? '').trim()).filter((p) => SUPPORTED_PLATFORMS.includes(p))
  const bad = list.map((p) => String(p ?? '').trim()).filter((p) => p && !SUPPORTED_PLATFORMS.includes(p))
  if (bad.length) throw new Error(`还不支持找号：${[...new Set(bad)].join('、')}（先加主页读数抓取，再加白名单）`)
  if (!out.length) throw new Error('平台至少要留一个')
  return [...new Set(out)]
}

/** 校验并规范化一份提交上来的口径（不落盘，测试与预览都用它） */
export function planBenchConfig(patch, root = ROOT) {
  const cur = readBenchConfig(root)
  if (!cur) throw new Error(`${BENCH_CONFIG_REL} 读不到，先确认文件在`)
  const next = { ...cur }
  if (patch.keywords !== undefined) next.keywords = cleanKeywords(patch.keywords)
  if (patch.platforms !== undefined) next.platforms = cleanPlatforms(patch.platforms)
  if (patch.minFollowers !== undefined) next.minFollowers = intOf(patch.minFollowers, { min: 0, label: '粉丝下限' })
  if (patch.maxInactiveDays !== undefined) next.maxInactiveDays = intOf(patch.maxInactiveDays, { min: 1, label: '停更上限（天）' })
  if (patch.dailyLimitPerPlatform !== undefined) next.dailyLimitPerPlatform = intOf(patch.dailyLimitPerPlatform, { min: 1, label: '每平台每天建档数' })
  return Object.fromEntries(EDITABLE.map((k) => [k, next[k]]))
}

/** 合并写回：未提交的字段（含 _说明 与 visitLimit 那类）保持原样，界面只改它自己那几项 */
export function writeBenchConfig(patch, root = ROOT) {
  const next = planBenchConfig(patch, root)
  const cur = readBenchConfig(root)
  const abs = join(root, BENCH_CONFIG_REL)
  // tmp + rename：半截 JSON 会让采集线当场读崩，界面还看不出哪来的
  writeFileSync(`${abs}.tmp`, `${JSON.stringify({ ...cur, ...next }, null, 2)}\n`)
  renameSync(`${abs}.tmp`, abs)
  return next
}
