/**
 * 读仓根的 .env 进 process.env。
 *
 * 为什么要它：发件箱与 GitHub OAuth 的凭据不能写进代码——这个仓要出开源快照，也装在别人机器上。
 * 但本机 dev（vite 起的）没有传环境变量的入口，`npm run serve` 与 systemd 那份才有，
 * 所以给本机补一个文件读取：键值写 .env，已在环境里的不覆盖（systemd 与服务壳给的算数）。
 *
 * 只支持 KEY=VALUE 与引号包值，不做变量插值——它是凭据袋，不是 shell。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export function loadEnvFile(root) {
  let raw = ''
  try {
    raw = readFileSync(join(root, '.env'), 'utf8')
  } catch {
    return { loaded: false, keys: [] }
  }
  const keys = []
  for (const line of raw.split('\n')) {
    const s = line.trim()
    if (!s || s.startsWith('#')) continue
    const i = s.indexOf('=')
    if (i < 1) continue
    const key = s.slice(0, i).trim()
    let val = s.slice(i + 1).trim()
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1)
    }
    if (process.env[key] === undefined && val !== '') {
      process.env[key] = val
      keys.push(key)
    }
  }
  return { loaded: true, keys }
}
