/**
 * Google 登录（OAuth 2.0 授权码 + PKCE）：拿 code 换 token，再拿 token 问一次「这个人是谁」。
 *
 * 和 github-auth-core 一个分工：这里只碰网络，授权跳转、cookie、回调路由都在 server-core 那层。
 * 凭据只从环境变量读（GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET），没配就别出登录入口。
 *
 * 为什么问 userinfo 而不是解 id_token：解 id_token 要验签名，就得跟着养一套 Google 公钥轮换，
 * 而手里已经有一个只属于这次的 access_token，GET 一次 userinfo 拿到的就是同一份 claims，代码少一半。
 * 为什么要 PKCE：Google 对公开客户端强制要求，机密客户端也建议带上——多这一层能挡住「授权码被别人截走直接换 token」。
 */
import { createHash, randomBytes } from 'node:crypto'

export const GOOGLE_AUTHORIZE = 'https://accounts.google.com/o/oauth2/v2/auth'
export const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token'
export const GOOGLE_USERINFO = 'https://openidconnect.googleapis.com/v1/userinfo'

/** 只要登录要的那两样：他是谁 + 邮箱。不碰 Gmail、Drive 那些 scope */
export const GOOGLE_SCOPE = 'openid email profile'

export function googleConfigured(env = process.env) {
  return !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET)
}

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

/** PKCE 那一对：verifier 自己留着（回调时核对 code 用），challenge 跟着跳转送出去 */
export function pkcePair() {
  const verifier = b64url(randomBytes(32))
  const challenge = b64url(createHash('sha256').update(verifier).digest())
  return { verifier, challenge }
}

/** 跳去 Google 的那条 URL。prompt=select_account：一个浏览器登过好几个 Google 号时，让他当场挑 */
export function authorizeUrl({ clientId, redirectUri, state, codeChallenge }) {
  const q = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: GOOGLE_SCOPE,
    state,
    prompt: 'select_account',
  })
  if (codeChallenge) {
    q.set('code_challenge', codeChallenge)
    q.set('code_challenge_method', 'S256')
  }
  return `${GOOGLE_AUTHORIZE}?${q}`
}

/** code 换 access_token：这一段是 form-encoded，且必须把跳转时那串 verifier 一起交出去 */
export async function exchangeCode({ code, redirectUri, clientId, clientSecret, codeVerifier, fetchImpl = fetch }) {
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    code,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
  })
  if (codeVerifier) body.set('code_verifier', codeVerifier)
  const res = await fetchImpl(GOOGLE_TOKEN, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body,
    signal: AbortSignal.timeout(10_000),
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok || !json.access_token) {
    throw new Error(String(json.error_description || json.error || `Google 换 token 失败（HTTP ${res.status}）`))
  }
  return json.access_token
}

/**
 * token 换这个人。Google 的 userinfo 里邮箱可能没验证过（比如别人填了一个他收不到信的地址），
 * 那种邮箱不许拿并号——并进一个能被抢注的邮箱等于把号白送，只在明确说没验证过时丢掉它，
 * 按 sub 建号。字段缺失就当验证过：Google 只在给了 email scope 时回这一份，一律判死反而把
 * 先用邮箱码登过、后来点 Google 的人拆成两个号。
 */
export async function googleIdentity(token, { fetchImpl = fetch } = {}) {
  const res = await fetchImpl(GOOGLE_USERINFO, {
    headers: { authorization: `Bearer ${token}`, accept: 'application/json', 'user-agent': 'media-hub' },
    signal: AbortSignal.timeout(10_000),
  })
  const me = await res.json().catch(() => ({}))
  if (!res.ok || !me.sub) throw new Error(`Google 没回身份（HTTP ${res.status}）`)
  const email = me.email_verified === false ? '' : String(me.email || '').trim()
  return { id: String(me.sub), email, name: String(me.name || '').trim(), picture: String(me.picture || '').trim() }
}
