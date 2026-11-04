/**
 * 起服务前把系统的出墙代理接到进程环境里。
 *
 * 为什么要有这一层：Google 的换 token 与问身份两步都是服务端自己发请求，机器在墙内就直连不通，
 * 浏览器能打开 accounts.google.com 不代表 node 进程也能——浏览器跟着 macOS 的系统代理走，
 * node 的 fetch 只认 HTTP(S)_PROXY 这类环境变量，而且要在进程启动那一刻就带着（启动后再设无效）。
 * 所以这里在 exec 之前读一次系统代理，把变量塞进环境，再把真正要跑的命令交出去。
 *
 * 只认 macOS 的 `scutil --proxy`；读不到（Linux、Windows、没配代理、只开了 SOCKS）就原样放行，
 * 不装懂也不报错——墙外的机器本来就不需要这一层。
 *
 * 用法：`node scripts/with-system-proxy.mjs vite`（npm run dev / serve / app 都走这一层）
 */
import { spawn, execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/** scutil --proxy 的输出是「Key : Value」逐行，值可能带空格；这里只取要的那几个键 */
export function parseScutil(text) {
  const kv = {}
  for (const line of String(text || '').split('\n')) {
    const m = line.match(/^\s*([A-Za-z0-9]+)\s*:\s*(.*)$/)
    if (m) kv[m[1]] = m[2].trim()
  }
  const on = (k) => kv[k] === '1'
  const port = (v) => {
    const n = Number(v)
    return Number.isInteger(n) && n > 0 && n < 65536 ? n : 0
  }
  // 顺序照系统实际生效的那条：HTTPS 代理优先，其次 HTTP；两者都没有就看 PAC 之外的 SOCKS
  if (on('HTTPSEnable') && kv.HTTPSProxy && port(kv.HTTPSPort)) {
    return { host: kv.HTTPSProxy, port: port(kv.HTTPSPort) }
  }
  if (on('HTTPEnable') && kv.HTTPProxy && port(kv.HTTPPort)) {
    return { host: kv.HTTPProxy, port: port(kv.HTTPPort) }
  }
  // 只有 SOCKS 时不填：node 的 fetch 只认 http 型代理，硬塞 SOCKS 反而把请求送进死路
  return null
}

/** 已经有代理环境变量就别抢方向盘，只补上「让 fetch 认它」那个开关 */
export function proxyEnv(env = process.env, hit = parseScutil('')) {
  const out = { ...env, NODE_USE_ENV_PROXY: '1' }
  const already = out.HTTPS_PROXY || out.https_proxy || out.HTTP_PROXY || out.http_proxy
  if (already || !hit) return out
  const url = `http://${hit.host}:${hit.port}`
  out.HTTP_PROXY = url
  out.HTTPS_PROXY = url
  out.http_proxy = url
  out.https_proxy = url
  return out
}

function readSystemProxy(logger) {
  if (process.platform !== 'darwin') return null
  try {
    return parseScutil(execFileSync('/usr/sbin/scutil', ['--proxy'], { encoding: 'utf8', timeout: 4000 }))
  } catch (e) {
    logger?.(`读系统代理失败，按无代理启动：${String(e?.message || e).slice(0, 60)}`)
    return null
  }
}

/** vite、electron 这类命令 npm 已经放进 node_modules/.bin，直接 exec 名字会找不到 */
function resolveCommand(cmd) {
  if (cmd.includes('/') || cmd.includes('\\')) return cmd
  const local = join(process.cwd(), 'node_modules', '.bin', cmd)
  return existsSync(local) ? local : cmd
}

export function runWithSystemProxy(argv, { logger = (m) => console.log(m) } = {}) {
  const [cmd, ...rest] = argv
  if (!cmd) {
    console.error('用法：node scripts/with-system-proxy.mjs <命令> [参数...]')
    process.exit(2)
  }
  const hit = readSystemProxy(logger)
  const env = proxyEnv(process.env, hit)
  if (hit && !(process.env.HTTPS_PROXY || process.env.https_proxy)) {
    logger(`已把系统代理 ${hit.host}:${hit.port} 交给这个进程（Google 登录要出墙）`)
  }
  const child = spawn(resolveCommand(cmd), rest, { stdio: 'inherit', env })
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => { if (!child.killed) child.kill(sig) })
  }
  child.on('exit', (code, signal) => process.exit(signal ? 1 : (code ?? 0)))
  child.on('error', (e) => {
    console.error(`起不来：${e.message}`)
    process.exit(1)
  })
}

// 直接跑就当启动器；被 import 时（测试）只导出函数
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  runWithSystemProxy(process.argv.slice(2))
}
