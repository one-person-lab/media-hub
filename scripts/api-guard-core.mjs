/**
 * 本机接口的来源闸门。
 *
 * 为什么要它：这些 /__* 端点能把本机浏览器开进任何平台后台、能起脚本，等于一台没有锁的机器的门把手。
 * 网页里的脚本只要 fetch('http://127.0.0.1:5173/__run-script') 就能拧动它——CORS 拦不住「发出去」，
 * 只拦「读回包」，所以光收紧 Access-Control-Allow-Origin 是假的安全感。真正拦得住的是看请求从哪儿来：
 * 浏览器一定会带 Origin，非浏览器客户端（cron 的 curl、Electron 主进程）不带。
 */

/** 采集扩展的弹窗页：chrome-extension://<id>，它只被授权了本机那一个端口 */
const EXTENSION_ORIGIN = 'chrome-extension://'

/**
 * 这一笔请求是不是本机自己人发的。
 * 没带 Origin = 不是网页（cron、curl、桌面壳主进程）；同源 = 工作台界面自己；扩展 = 采集按钮。
 * 其余一律不认：同源判定用请求的 Host 头比，所以局域网换 IP、桌面壳换随机端口都不用改配置。
 */
export function originAllowed(headers = {}) {
  const origin = headers.origin
  if (!origin) return true
  if (origin.startsWith(EXTENSION_ORIGIN)) return true
  try {
    return new URL(origin).host === String(headers.host || '').trim()
  } catch {
    return false
  }
}

/** 只读请求放行；POST/PUT/PATCH/DELETE 才要过闸门（GET 里最重的也只是回话，改不了机器状态） */
export const isMutating = (method) => !['GET', 'HEAD', 'OPTIONS'].includes(String(method || '').toUpperCase())

/**
 * 回给浏览器的 CORS 头：只回声被认下的来源，绝不写 *。
 * 写 * 等于告诉任意网页「你的回包可以读」——脚本、草稿、平台读数都在回包里。
 */
export function corsHeaders(headers = {}) {
  const origin = headers.origin
  if (!origin || !originAllowed(headers)) return {}
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    Vary: 'Origin',
  }
}

/** 被闸门挡下时给界面/日志看的那句话：说清是谁在挡、该怎么走 */
export const GUARD_DENIED = '这笔请求的来路不是本机工作台，已拒绝：只有打开这个工作台的页面和自己的采集扩展能使唤本机接口'
