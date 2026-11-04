/**
 * 用户身份：邮箱验证码、会话签名与用户表的纯函数。
 *
 * 为什么单开一份（照 api-guard-core.mjs 的路子）：这几笔是要算对的东西——定长比较、
 * 签名串的拼接顺序、验证码的过期与尝试次数——写在 server-core 里就没法测，而它们错了不会报错，
 * 只会静默变成「谁都能登进去」。所以这里一个 http 都不碰，全部收输入吐输出，端点那层只做搬运。
 *
 * 会话为什么是无状态签名串而不是 sessions.json：这台机器随时可能被 kill -9，
 * 落盘的会话表会留下一堆没人认领的行；签名串自带过期时间，退出只要让浏览器把 cookie 扔掉。
 *
 * 为什么没有口令这一层：登录 = 收得到这个邮箱的验证码，等于「能打开收件箱的人就是号主」，
 * 比让人设一个 8 位口令更硬，也没有「忘了口令」这条只能靠客服走的路。
 * 2026-11-01 改这条时 users.json 在本机与服务器都还不存在，没有老账号要迁，
 * 所以 scrypt 那一套连根删掉，不留兜底分支。
 */
import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 会话 cookie 名：换名等于把所有人的登录态清掉，动它之前想清楚 */
export const SESSION_COOKIE = 'mh_session'

/** 会话默认活 30 天：这是个天天开的工具，每次进来都要登录会被骂 */
export const SESSION_TTL_SEC = 30 * 24 * 3600

/** 邮箱统一成这个形态再入库，否则 Alice@x.com 和 alice@x.com 会变成两个账号 */
export const normalizeEmail = (email) => String(email || '').trim().toLowerCase()

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/

/** 返回一句能直接贴到界面上的话；null = 这输入能用。校验放服务端，界面的红字只是提前说一遍 */
export function emailProblem(rawEmail) {
  const e = normalizeEmail(rawEmail)
  if (!e) return '邮箱没填'
  if (e.length > 254) return '这个邮箱太长了'
  if (!EMAIL_RE.test(e)) return '邮箱格式不对'
  return null
}

/** 开放名单：逗号或空白分隔的一串邮箱，混进来的坏值和无序大小写当场收成能用的一组 */
export function parseAllowEmails(raw) {
  return String(raw || '')
    .split(/[,\s]+/)
    .map(normalizeEmail)
    .filter((e) => e && !emailProblem(e))
}

/** 名单空数组就是「一个都不放」：对外那一份宁可没人登得进来，也别默认谁收得到码谁就是号主 */
export function emailAllowed(rawEmail, allow) {
  return allow.includes(normalizeEmail(rawEmail))
}

/* ==================== 验证码 ====================
 * 规则和 BuildHub 那份一致：6 位数字、10 分钟有效、60 秒内不许重发、连错 5 次作废。
 * 只存哈希：这份文件一旦泄漏，明文码等于当场可用。
 */
export const CODE_TTL_SEC = 600
export const RESEND_SEC = 60
export const MAX_CODE_ATTEMPTS = 5

/** 10 万到 99 万9999：保证 6 位（不带前导零的 5 位码在界面上看着像填错了） */
export const newCode = () => String(randomInt(100000, 1000000))

export const hashCode = (code) => createHash('sha256').update(String(code)).digest('hex')

export const CODE_RE = /^\d{6}$/

function sameHash(a, b) {
  const x = Buffer.from(String(a), 'hex')
  const y = Buffer.from(String(b), 'hex')
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y)
}

/**
 * 要一枚新码：同一邮箱 60 秒内再要 → 给还差多少秒，不发新码。
 * @returns {{ code: string, resendIn: number } | { error: 'invalid_email' | 'too_fast', waitSec?: number }}
 */
export function issueCode(rawEmail, now = Date.now()) {
  const email = normalizeEmail(rawEmail)
  if (emailProblem(email)) return { error: 'invalid_email' }
  const codes = readCodes()
  const prev = codes[email]
  const lastSent = Number(prev?.lastSentAt) || 0
  if (lastSent && now - lastSent < RESEND_SEC * 1000) {
    return { error: 'too_fast', waitSec: Math.ceil((RESEND_SEC * 1000 - (now - lastSent)) / 1000) }
  }
  const code = newCode()
  codes[email] = { codeHash: hashCode(code), expiresAt: now + CODE_TTL_SEC * 1000, attempts: 0, lastSentAt: now }
  writeCodes(codes)
  return { code, resendIn: RESEND_SEC }
}

/**
 * 兑一枚码。成功就把这一行删掉（一码一次），连错到上限也删——留着一行只会让人以为还能试。
 * @returns {{ ok: true } | { ok: false, reason: 'no_code' | 'expired' | 'bad_code' | 'too_many' | 'invalid_email' }}
 */
export function redeemCode(rawEmail, input, now = Date.now()) {
  const email = normalizeEmail(rawEmail)
  if (emailProblem(email)) return { ok: false, reason: 'invalid_email' }
  if (!CODE_RE.test(String(input || ''))) return { ok: false, reason: 'no_code' }
  const codes = readCodes()
  const row = codes[email]
  if (!row) return { ok: false, reason: 'no_code' }
  if (Number(row.expiresAt) <= now) {
    delete codes[email]
    writeCodes(codes)
    return { ok: false, reason: 'expired' }
  }
  if (Number(row.attempts) >= MAX_CODE_ATTEMPTS) {
    delete codes[email]
    writeCodes(codes)
    return { ok: false, reason: 'too_many' }
  }
  if (!sameHash(row.codeHash, hashCode(input))) {
    row.attempts = Number(row.attempts) + 1
    if (row.attempts >= MAX_CODE_ATTEMPTS) delete codes[email]
    writeCodes(codes)
    return { ok: false, reason: 'bad_code' }
  }
  delete codes[email]
  writeCodes(codes)
  return { ok: true }
}

/** 离下一次能重发还差几秒：界面把「重新发送」灰着倒计时要用它 */
export function resendWaitSec(rawEmail, now = Date.now()) {
  const row = readCodes()[normalizeEmail(rawEmail)]
  const lastSent = Number(row?.lastSentAt) || 0
  if (!lastSent) return 0
  return Math.max(0, Math.ceil((RESEND_SEC * 1000 - (now - lastSent)) / 1000))
}

const b64url = (buf) => Buffer.from(buf).toString('base64url')

/** 会话串：base64url(userId.exp) + HMAC。签名的是这一串文本本身，不重新序列化一遍，
 *  否则 JSON 键序一变，签好的 cookie 就全废了。 */
export function signSession(secret, userId, ttlSec = SESSION_TTL_SEC) {
  const payload = b64url(`${userId}.${Math.floor(Date.now() / 1000) + ttlSec}`)
  return `${payload}.${b64url(hmac(secret, payload))}`
}

/** 认一枚会话串，返回 userId；不认就给 null。过期、改过字节、密钥换了都走同一条路。 */
export function verifySession(secret, token) {
  const parts = String(token || '').split('.')
  if (parts.length !== 2) return null
  const [payload, sig] = parts
  if (!payload || !sig) return null
  const want = b64url(hmac(secret, payload))
  const a = Buffer.from(sig, 'base64url')
  const b = Buffer.from(want, 'base64url')
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null
  let body
  try {
    body = Buffer.from(payload, 'base64url').toString('utf8')
  } catch {
    return null
  }
  const [userId, exp] = body.split('.')
  if (!userId || !/^\d+$/.test(exp)) return null
  if (Number(exp) * 1000 <= Date.now()) return null
  return userId
}

function hmac(secret, data) {
  return createHmac('sha256', String(secret || '')).update(data).digest()
}

/** Set-Cookie 的值。httpOnly 是重点：会读 localStorage 的 XSS 同样读不到 cookie，
 *  但脚本压根不该持有会话——所以别让前端经手它。 */
export function sessionCookieValue(token, { maxAgeSec = 0, secure = false } = {}) {
  return [
    `${SESSION_COOKIE}=${token || ''}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.max(0, Math.floor(maxAgeSec))}`,
    secure ? 'Secure' : '',
  ].filter(Boolean).join('; ')
}

/** 读 Cookie 头。只给鉴权用，所以不处理引号包值这些边角——我们自己不写那种 cookie。 */
export function parseCookies(header) {
  const out = {}
  for (const pair of String(header || '').split(';')) {
    const i = pair.indexOf('=')
    if (i < 0) continue
    const k = pair.slice(0, i).trim()
    if (k) out[k] = decodeURIComponent(pair.slice(i + 1).trim())
  }
  return out
}

/** 会话密钥：环境变量优先（多实例要共用一枚，否则 A 机签的 cookie 在 B 机不认），
 *  没有就落一个随机文件，权限收到 0600——它泄了等于所有人的登录态都能伪造。 */
export function resolveSessionSecret(env = process.env, readKey, writeKey) {
  const fromEnv = String(env.WORKBENCH_SESSION_SECRET || '').trim()
  if (fromEnv.length >= 16) return fromEnv
  const existing = readKey()
  if (existing && existing.trim().length >= 32) return existing.trim()
  const fresh = randomBytes(32).toString('hex')
  writeKey(fresh)
  return fresh
}

/* ==================== 落盘 ====================
 * 用户表、验证码表和会话密钥都放 ~/.config/media-hub/，不放仓里：这个仓要出开源快照，
 * 邮箱和验证码哈希留在仓内迟早跟着 git 出门，密钥更是直接等于所有人的登录态。
 * 写法照 llm-core 的 key 文件：目录 0700、文件 0600、改整表走 tmp + rename。
 */
const STORE_DIR = process.env.MEDIA_HUB_STORE_DIR || join(homedir(), '.config/media-hub')
const USERS_FILE = join(STORE_DIR, 'users.json')
const CODES_FILE = join(STORE_DIR, 'verify-codes.json')
const SECRET_FILE = join(STORE_DIR, 'session.key')

const readKeyFile = () => {
  try {
    return readFileSync(SECRET_FILE, 'utf8')
  } catch {
    return ''
  }
}

/** 会话密钥：一个进程内只算一次，注册和验 cookie 必须是同一枚 */
export const sessionSecret = (() => {
  let cached = ''
  return () => cached || (cached = resolveSessionSecret(
    process.env,
    readKeyFile,
    (k) => {
      mkdirSync(STORE_DIR, { recursive: true, mode: 0o700 })
      writeFileSync(SECRET_FILE, k + '\n', { mode: 0o600 })
    },
  ))
})()

function writeJson(file, obj) {
  mkdirSync(STORE_DIR, { recursive: true, mode: 0o700 })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(obj, null, 1), { mode: 0o600 })
  renameSync(tmp, file)
}

function readJson(file) {
  try {
    const o = JSON.parse(readFileSync(file, 'utf8'))
    return o && typeof o === 'object' ? o : {}
  } catch {
    return {}
  }
}

export function readUsers() {
  return readJson(USERS_FILE)
}

export function writeUsers(users) {
  writeJson(USERS_FILE, users)
}

function readCodes() {
  return readJson(CODES_FILE)
}

function writeCodes(codes) {
  writeJson(CODES_FILE, codes)
}

/** 出界面的用户：验证码哈希与会话密钥一旦进了 JSON 响应，就等于躺在浏览器历史和日志里 */
export const publicUser = (u) => (u ? { id: u.id, email: u.email, name: u.name || '', createdAt: u.createdAt } : null)

const newUser = (key, fields) => ({
  id: `u_${randomBytes(8).toString('hex')}`,
  email: key.includes('@') ? key : '',
  name: '',
  createdAt: new Date().toISOString(),
  ...fields,
})

/** 邮箱登录：认不出这个号就当场建一个——发得出验证码就等于认领了这个邮箱，没有第二道注册流程 */
export function findOrCreateByEmail(rawEmail) {
  const email = normalizeEmail(rawEmail)
  const users = readUsers()
  if (users[email]) return users[email]
  const user = newUser(email, {})
  users[email] = user
  writeUsers(users)
  return user
}

/**
 * GitHub 登录：先认 githubId，其次认 GitHub 给的邮箱（同一个邮箱并到同一个号，
 * 他先用邮箱登过、后来点 GitHub，不该多出一个分身号）。
 * 没公开邮箱的号只能按 githubId 建，键用 gh_<id>，界面上显示 login。
 */
export function findOrCreateByGithub({ id, login, email }) {
  const users = readUsers()
  const ghId = String(id || '')
  const byId = Object.values(users).find((u) => u.githubId && String(u.githubId) === ghId)
  if (byId) {
    if (login && byId.name !== login) { byId.name = login; writeUsers(users) }
    return byId
  }
  const e = normalizeEmail(email)
  const key = e || `gh_${ghId}`
  const existing = users[key]
  if (existing) {
    existing.githubId = ghId
    if (login) existing.name = login
    writeUsers(users)
    return existing
  }
  const user = newUser(key, { githubId: ghId, name: login || '' })
  users[key] = user
  writeUsers(users)
  return user
}

/**
 * Google 登录：认法和 GitHub 那一条对称——先认 googleId，其次认 Google 给的（且验证过的）邮箱，
 * 同一个邮箱并到同一个号，他先用邮箱登过、后来点 Google，不该多出一个分身号。
 * 拿不到验证邮箱的只能按 Google 的 sub 建，键用 gg_<sub>，界面上显示名字。
 */
export function findOrCreateByGoogle({ id, email, name }) {
  const users = readUsers()
  const ggId = String(id || '')
  const byId = Object.values(users).find((u) => u.googleId && String(u.googleId) === ggId)
  if (byId) {
    if (name && byId.name !== name) { byId.name = name; writeUsers(users) }
    return byId
  }
  const e = normalizeEmail(email)
  const key = e || `gg_${ggId}`
  const existing = users[key]
  if (existing) {
    existing.googleId = ggId
    if (name && !existing.name) existing.name = name
    writeUsers(users)
    return existing
  }
  const user = newUser(key, { googleId: ggId, name: name || '' })
  users[key] = user
  writeUsers(users)
  return user
}

export const findByEmail = (rawEmail) => readUsers()[normalizeEmail(rawEmail)] || null
export function findById(id) {
  const users = readUsers()
  return Object.values(users).find((u) => u.id === id) || null
}
