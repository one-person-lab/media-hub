import { ref } from 'vue'

/**
 * 人的登录态（不是平台账号那套扫码授权）。
 * 会话 cookie 是 httpOnly 的，前端经手不到、也不该经手：这里只拿「我是谁」这一份展示用的信息，
 * 浏览器自己在请求里带 cookie。所以这个单例只做两件事——回显当前用户、把动作转成一次 POST。
 *
 * 登录法只有两条：邮箱收 6 位码，或 GitHub 授权。没有口令，也就没有「注册」这一步——
 * 发得出验证码的邮箱就是号主，第一次登录同时就是注册。
 */
export interface AuthUser {
  id: string
  email: string
  name: string
  createdAt: string
}
export interface AuthResult {
  ok: boolean
  user?: AuthUser
  error?: string
  /** 服务端说这码多久能再发一次（秒）：界面拿它起倒计时，别让人连点六次 */
  resendIn?: number
  /** false = 这台机器没配发件箱，码在服务端日志里，不在收件箱里 */
  mailSent?: boolean
  reason?: string
}

const me = ref<AuthUser | null>(null)

/** 登录弹层开在哪：顶栏那个按钮和未登录时那一屏用的是同一个，别各开各的 */
export const authOpen = ref(false)

/** OAuth 回调把人送回工作台时带的条子（?login_failed=…）：界面据此在弹层里说一句为什么没登进来 */
export const authFlash = ref('')

const FAILED_SAY: Record<string, string> = {
  state: '这次 GitHub 登录对不上号，重来一次',
  denied: 'GitHub 那侧没给授权，登录没做成',
  nocode: 'GitHub 回来时没带授权码，重来一次',
  noid: 'GitHub 没告诉我们你是谁，重来一次',
  notallowed: '这个邮箱不在开放名单里',
  github: 'GitHub 登录没走通，稍后再试或改用邮箱',
  g_state: '这次 Google 登录对不上号，重来一次',
  g_denied: 'Google 那侧没给授权，登录没做成',
  g_nocode: 'Google 回来时没带授权码，重来一次',
  g_noid: 'Google 没告诉我们你是谁，重来一次',
  gg_net: '这台机器连不上 Google，要么挂出墙代理，要么改用验证码',
  google: 'Google 登录没走通，稍后再试或改用邮箱',
}

async function post(path: string, body: Record<string, string>): Promise<AuthResult> {
  try {
    const r = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    return await r.json()
  } catch {
    return { ok: false, error: '服务没回话，再试一次' }
  }
}

/** 开局问一次我是谁。纯静态托管没这个端点：那种机器上也没有墙，失败就当没登录。 */
export const authReady = (async () => {
  try {
    const o = await (await fetch('/__auth/me', { cache: 'no-store' })).json()
    me.value = o?.user ?? null
  } catch { /* 没有这个端点，按未登录处理 */ }
  const q = new URLSearchParams(location.search)
  const failed = q.get('login_failed')
  if (failed) {
    authFlash.value = FAILED_SAY[failed] || '登录没做成，再试一次'
    // 地址栏留着这个条子，刷新一次就把同一条报错再演一遍
    history.replaceState(null, '', `${location.pathname}${location.hash}`)
  }
})()

/**
 * 未登录点到一个要登录的动作 → 后端回 401 → 这里接成一次登录弹层。
 * 装在 fetch 这一层而不是各个按钮里：界面往服务端写东西的调用点有四十多处、各写各的 fetch，
 * 逐处加「先登录」判据等于把同一条规则抄四十遍，还漏掉以后新加的那一处。
 * 只认写操作：游客读的是演示数据，某个读数没拉到不该半路把人拦下来。
 */
export function installLoginGuard() {
  const native = window.fetch.bind(window)
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) =>
    native(input, init).then((r) => {
      const method = String(init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
      if (r.status === 401 && method !== 'GET') authOpen.value = true
      return r
    })
}

export function useAuth() {
  async function sendCode(email: string) {
    return await post('/__auth/code', { email })
  }
  async function verifyCode(email: string, code: string) {
    const o = await post('/__auth/verify', { email, code })
    if (o.ok) {
      me.value = o.user ?? null
      authOpen.value = false
    }
    return o
  }
  /** 跳去 GitHub：整页走服务端那条 302，回调与 state 都由服务端管，前端不经手 token */
  function githubLogin() {
    location.href = '/__auth/github'
  }
  /** 跳去 Google：同上，授权码、PKCE 与回调都在服务端那一段 */
  function googleLogin() {
    location.href = '/__auth/google'
  }
  async function logout() {
    await post('/__auth/logout', {})
    me.value = null
  }
  return { me, authOpen, authFlash, sendCode, verifyCode, githubLogin, googleLogin, logout }
}
