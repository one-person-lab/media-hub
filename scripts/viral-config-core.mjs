#!/usr/bin/env node
/**
 * 爆款采集口径的读写：config/viral.json 是唯一事实源。
 * 采集页「口径」弹窗的保存走这里落盘（界面不碰 JSON 也不碰路径），
 * scripts/viral-collect.mjs 与 build-data.mjs 都只读它——改口径只有这一个入口。
 *
 * 校验口径（与 cron 指令 config/cron/viral-collect.md 同一把尺）：
 *  - 关键词：定位词，两平台共用；至少一个，自动去重去空白
 *  - 平台：scripts/viral-collect.mjs 的 PLATFORMS 键子集，至少留一个
 *  - 门槛四件套（minLikes / minComments / withinDays / dailyLimitPerPlatform）：非负/正整数。
 *    门槛是「什么算爆款」的定义，归用户拍板——这里只挡非法值，不替用户决定松紧
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.env.MEDIA_HUB_ROOT || process.cwd()
export const VIRAL_CONFIG_REL = 'config/viral.json'

/** 支持的搜索平台。与 scripts/viral-collect.mjs 的 PLATFORMS 键保持一致——
 *  加平台先改那里（详情页源料抓取在那实现），这里只是白名单，别漂移。 */
export const SUPPORTED_PLATFORMS = ['xiaohongshu', 'douyin']

/** 弹窗可改的字段；其余键（_说明 一类注释）原样保留，人手写的说明不被冲掉 */
const EDITABLE = ['keywords', 'platforms', 'minLikes', 'minComments', 'withinDays', 'dailyLimitPerPlatform']

function readJson(p) {
  try {
    return JSON.parse(readFileSync(p, 'utf8'))
  } catch {
    return null
  }
}

/** 读出口径（不存在/读崩了返回 null，由调用方决定是报错还是不展示） */
export function readViralConfig(root = ROOT) {
  const j = readJson(join(root, VIRAL_CONFIG_REL))
  if (!j || typeof j !== 'object') return null
  return j
}

function intOf(raw, { min, label }) {
  const n = Number(raw)
  if (!Number.isInteger(n) || n < min) throw new Error(`${label} 得是 ≥ ${min} 的整数`)
  return n
}

/** 关键词：去空白、去重、保序；空串是「没填」，不是「删掉这个」 */
function cleanKeywords(raw) {
  const list = Array.isArray(raw) ? raw : []
  const out = []
  for (const k of list) {
    const t = String(k ?? '').trim()
    if (!t) continue
    if (!out.includes(t)) out.push(t)
    if (out.length > 30) throw new Error('关键词最多 30 个，采得过来才拆得过来')
  }
  if (!out.length) throw new Error('关键词至少要留一个：没有定位词，采集线不知道搜什么')
  return out
}

/** 平台：只认白名单，至少留一个；白名单外的平台采不了（viral-collect 没实现详情页抓取） */
function cleanPlatforms(raw) {
  const list = Array.isArray(raw) ? raw : []
  const out = list.map((p) => String(p ?? '').trim()).filter((p) => SUPPORTED_PLATFORMS.includes(p))
  const bad = list.map((p) => String(p ?? '').trim()).filter((p) => p && !SUPPORTED_PLATFORMS.includes(p))
  if (bad.length) throw new Error(`还不支持采集：${[...new Set(bad)].join('、')}（先加平台抓取，再加白名单）`)
  if (!out.length) throw new Error('搜索平台至少要留一个')
  return [...new Set(out)]
}

/** 校验并规范化一份提交上来的口径（不落盘，测试与预览都用它） */
export function planViralConfig(patch, root = ROOT) {
  const cur = readViralConfig(root)
  if (!cur) throw new Error(`${VIRAL_CONFIG_REL} 读不到，先确认文件在`)
  const next = { ...cur }
  if (patch.keywords !== undefined) next.keywords = cleanKeywords(patch.keywords)
  if (patch.platforms !== undefined) next.platforms = cleanPlatforms(patch.platforms)
  if (patch.minLikes !== undefined) next.minLikes = intOf(patch.minLikes, { min: 0, label: '点赞门槛' })
  if (patch.minComments !== undefined) next.minComments = intOf(patch.minComments, { min: 0, label: '评论门槛' })
  if (patch.withinDays !== undefined) next.withinDays = intOf(patch.withinDays, { min: 1, label: '时间窗（天）' })
  if (patch.dailyLimitPerPlatform !== undefined) next.dailyLimitPerPlatform = intOf(patch.dailyLimitPerPlatform, { min: 1, label: '每平台条数' })
  // 只带回可编辑字段给调用方展示；_说明 之类注释键不进界面
  return Object.fromEntries(EDITABLE.map((k) => [k, next[k]]))
}

function writeViralConfigFile(root, cfg) {
  const abs = join(root, VIRAL_CONFIG_REL)
  // tmp + rename：半截 JSON 会让采集线当场读崩，界面还看不出哪来的
  writeFileSync(`${abs}.tmp`, `${JSON.stringify(cfg, null, 2)}\n`)
  renameSync(`${abs}.tmp`, abs)
}

/** 合并写回：未提交的字段（含 _说明）保持原样，界面只改它自己那几项 */
export function writeViralConfig(patch, root = ROOT) {
  const next = planViralConfig(patch, root)
  const cur = readViralConfig(root)
  writeViralConfigFile(root, { ...cur, ...next })
  return next
}
