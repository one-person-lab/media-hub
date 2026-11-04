/**
 * 发件箱：登录验证码邮件。
 *
 * 复用 BuildHub 那套 SMTP（同一台服务器上的 .env 里那五项），凭据只进环境变量，
 * 不进代码、不进仓（.env 已在 .gitignore 与开源快照排除清单里）。
 *
 * 没配发件箱时不静默失败：本机那份让端点把码打进服务端日志，人照样能就地登进去；
 * 远程那份（公网挂在 nginx 后面）没有日志可看，所以那边发不出就判不可用，界面据此提示。
 */
export const SMTP_KEYS = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM']

/** 三项齐了才叫能发信：只配一半比不配更坏——每封邮件都超时，人只知道「点了没反应」 */
export function mailConfigured(env = process.env) {
  return !!(env.SMTP_HOST && env.SMTP_USER && env.SMTP_PASS)
}

let transport = null

/** nodemailer 懒加载：没装依赖的读者 import 到这个文件不该一起炸 */
async function getTransport(env) {
  if (transport) return transport
  const mod = await import('nodemailer')
  const port = Number(env.SMTP_PORT || 465)
  // 465 是隐式 TLS，别的端口走 STARTTLS 升级；判错了就是连不上或明文发口令
  transport = mod.createTransport({
    host: env.SMTP_HOST,
    port,
    secure: port === 465,
    auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
  })
  return transport
}

/**
 * 发一封登录验证码。返回 { ok, error }，错误文本给端点折成界面能说的话。
 * @param {string} to 收件邮箱 @param {string} code 6 位数字
 */
export async function sendLoginCode(to, code, env = process.env) {
  if (!mailConfigured(env)) return { ok: false, error: 'mail_not_configured' }
  try {
    const t = await getTransport(env)
    await t.sendMail({
      from: env.SMTP_FROM || env.SMTP_USER,
      to,
      subject: `${code} 是你的 Media Hub 登录码`,
      text: `${code}\n\n这是 Media Hub 创作者工作台的登录验证码，10 分钟内有效。不是你本人操作的话，忽略这封就行。`,
      html: `<div style="font:16px/1.6 -apple-system,'PingFang SC',sans-serif;color:#111">
  <p style="margin:0 0 12px">你的登录验证码：</p>
  <p style="margin:0 0 16px;font-size:32px;font-weight:700;letter-spacing:6px">${code}</p>
  <p style="margin:0;color:#666">10 分钟内有效。不是你本人操作的话，忽略这封就行。</p>
</div>`,
    })
    return { ok: true }
  } catch (e) {
    return { ok: false, error: String(e?.message || e).slice(0, 200) }
  }
}
