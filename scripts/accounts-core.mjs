#!/usr/bin/env node
/**
 * 账号登记的读写：config/accounts.json 是本机账号的唯一事实源，
 * 授权页「新增账号」与「改昵称」都从这里落盘，界面不碰 JSON 也不碰路径。
 *
 * 为什么要有 config/platforms.json 这张模板表：
 *   一个号的后台地址、推草稿脚本、形态说明都是**平台级**的固定信息，
 *   只有 id / key / 昵称是账号级的。新增时照模板抄前者、现推后者，
 *   人才不必去手工编辑 JSON——上一轮手工加的那个号，昵称至今写着「待改成真实昵称」。
 *
 * 账号级两件套的口径（scripts/collect-note-core.mjs 的 listAccounts 逐条校验）：
 *   id    号在本仓的身份：发布排期目录名、md 里「草稿已推-x」后缀、登录态键
 *   key   metrics 快照桶名，同平台两个号必须各有各的，否则读数叠在一起
 *         它同时是本机登录态库的文件名（metrics/account-cookies/<key>.json）：
 *         同平台的第二个号靠换 cookie 隔离，不再要人在 Ego Lite 里多建一只 profile
 * 一平台第一个号沿用旧口径：id = 平台名、key = 平台模板键。
 * id 是身份不是标签，改名只动 nickname——动了 id，发布排期目录和登录态读数会当场断链。
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { hasIdentityReader } from './account-identity-core.mjs'

const ROOT = process.env.MEDIA_HUB_ROOT || process.cwd()

function readJson(p) {
  try {
    return JSON.parse(readFileSync(p, 'utf8'))
  } catch {
    return null
  }
}

/** 目录名安全：账号 id 直接当发布排期的目录名，分隔符和 Windows 保留字符得挡掉 */
const UNSAFE_IN_ID = /[/\\:*?"<>|.\s]+/g

export function readAccounts(root = ROOT) {
  const list = readJson(join(root, 'config/accounts.json'))
  if (!Array.isArray(list)) throw new Error('config/accounts.json 读不到或不是数组，先从 config/accounts.example.json 复制一份')
  return list.map((a) => ({ ...a, id: a.id || a.platform }))
}

export function platformTemplates(root = ROOT) {
  const j = readJson(join(root, 'config/platforms.json'))
  const list = Array.isArray(j?.platforms) ? j.platforms : []
  if (!list.length) throw new Error('config/platforms.json 里没有平台模板')
  return list
}

function writeAccounts(root, list) {
  const abs = join(root, 'config/accounts.json')
  // tmp + rename：半截 JSON 会被 gen:data 读成「账号表缺失」，整站账号当场消失
  writeFileSync(`${abs}.tmp`, `${JSON.stringify(list, null, 2)}\n`)
  renameSync(`${abs}.tmp`, abs)
}

/** 昵称：必填、不许带换行。留空就会长出「未登记昵称」这种空位，正是要治的病 */
function cleanNickname(raw) {
  const n = String(raw ?? '').replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim()
  if (!n) throw new Error('昵称要填：这是这一行显示的名字，也是账号 id 的一部分')
  if (n.length > 24) throw new Error('昵称最长 24 字')
  return n
}

function uniqueId(want, list) {
  const taken = new Set(list.map((a) => a.id))
  if (!taken.has(want)) return want
  const base = want.replace(/-\d+$/, '')
  for (let i = 2; ; i += 1) {
    const next = `${base}-${i}`
    if (!taken.has(next)) return next
  }
}

function uniqueKey(want, list) {
  const taken = new Set(list.map((a) => a.key))
  if (!taken.has(want)) return want
  const base = want.replace(/-\d+$/, '')
  for (let i = 2; ; i += 1) {
    const next = `${base}-${i}`
    if (!taken.has(next)) return next
  }
}

/** 照模板算出这条登记该长什么样（不落盘，测试与预览都用它） */
export function planAccount({ templates, list, platform, nickname: raw }) {
  const tpl = templates.find((t) => t.platform === platform)
  if (!tpl) throw new Error(`「${platform}」还没有平台模板（config/platforms.json）与登录态采集器，加不了`)
  const nickname = cleanNickname(raw)
  const rivals = list.filter((a) => a.platform === platform)
  const first = rivals.length === 0

  const entry = {
    id: uniqueId(first ? platform : `${platform}-${nickname.replace(UNSAFE_IN_ID, '')}`, list),
    platform,
    key: uniqueKey(first ? tpl.key : `${tpl.key}-${rivals.length + 1}`, list),
    script: tpl.script,
    backend: tpl.backend,
  }
  if (tpl.quickLogin) entry.quickLogin = tpl.quickLogin
  entry.nickname = nickname
  if (tpl.note) entry.note = tpl.note
  return entry
}

export function addAccount({ platform, nickname }, root = ROOT) {
  const list = readAccounts(root)
  const entry = planAccount({ templates: platformTemplates(root), list, platform, nickname })
  writeAccounts(root, [...list, entry])
  return entry
}

/** 只改昵称：id / key 是发布排期目录名与登录态桶名，动了会断链 */
export function renameAccount({ id, nickname: raw }, root = ROOT) {
  const list = readAccounts(root)
  const at = list.findIndex((a) => a.id === id)
  if (at < 0) throw new Error(`未知账号「${id}」`)
  const nickname = cleanNickname(raw)
  list[at] = { ...list[at], nickname }
  writeAccounts(root, list)
  return list[at]
}

/** 授权页的平台选择器：模板 + 这台机器已经挂了几个号 + 这个平台的后台读不读得出账号名
 *  （identity=false 的平台扫完码没人报名字，界面上那一步才要人自己填昵称） */
export function accountCatalog(root = ROOT) {
  const list = existsSync(join(root, 'config/accounts.json')) ? readAccounts(root) : []
  return platformTemplates(root).map((t) => ({
    platform: t.platform,
    quickLogin: t.quickLogin || '',
    hasScript: existsSync(join(root, t.script || '')),
    accounts: list.filter((a) => a.platform === t.platform).length,
    identity: hasIdentityReader(t.platform),
  }))
}
