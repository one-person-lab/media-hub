/**
 * GitHub OAuth：拿 code 换 token，再拿 token 换这个人是谁。
 *
 * 只碰网络不碰 http 服务端——授权跳转、cookie 那些在 server-core 那层，这里给的是能测的两步。
 * 凭据只从环境变量读（GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET），没配就别出登录入口。
 *
 * 为什么用 OAuth App 而不是 GitHub App：这是一台个人工作台，不需要装到仓库上的权限，
 * 一个 OAuth App 的「读一个邮箱」就够，而且 GitHub App 的私钥要轮换，不值得为登录养一套。
 */
export const GITHUB_AUTHORIZE = 'https://github.com/login/oauth/authorize'
export const GITHUB_TOKEN = 'https://github.com/login/oauth/access_token'
export const GITHUB_API = 'https://api.github.com'

export function githubConfigured(env = process.env) {
  return !!(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET)
}

/** 跳去 GitHub 的那条 URL。scope 只要 read:user + user:email：登录要的是邮箱，不是他的仓库 */
export function authorizeUrl({ clientId, redirectUri, state }) {
  const q = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: 'read:user user:email',
    state,
  })
  return `${GITHUB_AUTHORIZE}?${q}`
}

/** code 换 access_token。GitHub 这一段要 form-encoded，且明确要 JSON 回来 */
export async function exchangeCode({ code, redirectUri, clientId, clientSecret, fetchImpl = fetch }) {
  const res = await fetchImpl(GITHUB_TOKEN, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, code, redirect_uri: redirectUri }),
    signal: AbortSignal.timeout(10_000),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok || !body.access_token) {
    throw new Error(String(body.error_description || body.error || `GitHub 换 token 失败（HTTP ${res.status}）`))
  }
  return body.access_token
}

/**
 * token 换这个人。GitHub 允许把邮箱设成私有，/user 里就是空——那种号再问一次 /user/emails
 * 拿验证过的主邮箱；还拿不到就回 email: ''，由上层按 GitHub id 建号，别硬造一个假邮箱。
 */
export async function githubIdentity(token, { fetchImpl = fetch } = {}) {
  const headers = { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'user-agent': 'media-hub' }
  const me = await (await fetchImpl(`${GITHUB_API}/user`, { headers, signal: AbortSignal.timeout(10_000) })).json()
  let email = String(me.email || '').trim()
  if (!email) {
    const list = await (await fetchImpl(`${GITHUB_API}/user/emails`, { headers, signal: AbortSignal.timeout(10_000) })).json()
    const rows = Array.isArray(list) ? list : []
    email = String((rows.find((r) => r.primary && r.verified) || rows.find((r) => r.verified) || {}).email || '').trim()
  }
  return { id: String(me.id || ''), login: String(me.login || ''), email }
}
