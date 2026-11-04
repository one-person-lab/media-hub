#!/usr/bin/env node
/**
 * 收藏搬运口径的读写：config/favorites.json 是唯一事实源。
 * 灵感库「采集配置」弹窗的保存走这里落盘（界面不碰 JSON 也不碰路径），
 * scripts/favorites-collect.mjs 只读它——改名单只有这一个入口。
 *
 * 校验口径：
 *  - 专辑名：两个平台共用一份名单，按名字原样匹配；至少留一个，去空白去重
 *  - 平台：scripts/favorites-collect.mjs 的 PLATFORMS 键子集，至少留一个
 *  - xiaohongshuUserId / maxScrollRounds 不在弹窗里改（换号是改配置，不是日常口径）
 */
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.env.MEDIA_HUB_ROOT || process.cwd()
export const FAVORITES_CONFIG_REL = 'config/favorites.json'

/** 与 scripts/viral-collect.mjs、scripts/favorites-collect.mjs 的 PLATFORMS 键保持一致 */
export const SUPPORTED_PLATFORMS = ['xiaohongshu', 'douyin']

/** 弹窗可改的字段；其余键（_说明 一类注释）原样保留，人手写的说明不被冲掉 */
const EDITABLE = ['albums', 'platforms']

function readJson(p) {
  try {
    return JSON.parse(readFileSync(p, 'utf8'))
  } catch {
    return null
  }
}

/** 读出口径（不存在/读崩了返回 null，由调用方决定是报错还是不展示） */
export function readFavoritesConfig(root = ROOT) {
  const j = readJson(join(root, FAVORITES_CONFIG_REL))
  if (!j || typeof j !== 'object') return null
  return j
}

/** 专辑名：去空白、去重、保序；空串是「没填」，不是「删掉这个」 */
export function cleanAlbums(raw) {
  const list = Array.isArray(raw) ? raw : []
  const out = []
  for (const a of list) {
    const t = String(a ?? '').trim()
    if (!t) continue
    if (!out.includes(t)) out.push(t)
    if (out.length > 20) throw new Error('专辑最多 20 个，翻得过来才搬得过来')
  }
  if (!out.length) throw new Error('专辑至少要留一个：没有名单，搬运线不知道去哪个收藏夹里取')
  return out
}

/** 平台：只认白名单，至少留一个 */
export function cleanPlatforms(raw) {
  const list = Array.isArray(raw) ? raw : []
  const out = list.map((p) => String(p ?? '').trim()).filter((p) => SUPPORTED_PLATFORMS.includes(p))
  const bad = list.map((p) => String(p ?? '').trim()).filter((p) => p && !SUPPORTED_PLATFORMS.includes(p))
  if (bad.length) throw new Error(`还不支持搬运：${[...new Set(bad)].join('、')}（先在 favorites-collect 加平台，再加白名单）`)
  if (!out.length) throw new Error('采集平台至少要留一个')
  return [...new Set(out)]
}

/** 校验并规范化一份提交上来的口径（不落盘，测试与预览都用它） */
export function planFavoritesConfig(patch, root = ROOT) {
  const cur = readFavoritesConfig(root)
  if (!cur) throw new Error(`${FAVORITES_CONFIG_REL} 读不到，先确认文件在`)
  const next = { ...cur }
  if (patch.albums !== undefined) next.albums = cleanAlbums(patch.albums)
  if (patch.platforms !== undefined) next.platforms = cleanPlatforms(patch.platforms)
  return Object.fromEntries(EDITABLE.map((k) => [k, next[k]]))
}

/** 合并写回：未提交的字段（含 _说明）保持原样，界面只改它自己那两项 */
export function writeFavoritesConfig(patch, root = ROOT) {
  const next = planFavoritesConfig(patch, root)
  const cur = readFavoritesConfig(root)
  const abs = join(root, FAVORITES_CONFIG_REL)
  // tmp + rename：半截 JSON 会让搬运线当场读崩，界面还看不出哪来的
  writeFileSync(`${abs}.tmp`, `${JSON.stringify({ ...cur, ...next }, null, 2)}\n`)
  renameSync(`${abs}.tmp`, abs)
  return next
}
