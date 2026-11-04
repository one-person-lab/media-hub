#!/usr/bin/env node
/**
 * ego-browser 脚本包装器：ego 内嵌 Node 的 cwd 恒为 /、且不透传宿主环境变量，
 * 直接 `ego-browser nodejs < x.mjs` 会让脚本里的 process.cwd() 定位不到项目根。
 * 这里在喂给 stdin 的脚本前注入一行 process.chdir，用宿主 Node 的真实 cwd 兜底。
 *
 * 用法：node scripts/run-ego.mjs <script.mjs> [额外 ego-browser 参数...] [--args <脚本参数...>]
 * --args 之后的参数注入进脚本的 process.argv（ego 不透传宿主环境变量，脚本开关只能走参数）。
 */
import { readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'

const script = process.argv[2]
if (!script) {
  console.error('用法: node scripts/run-ego.mjs <script.mjs> [ego 参数...] [--args 脚本参数...]')
  process.exit(1)
}

const sep = process.argv.indexOf('--args')
const egoArgs = ['nodejs', ...(sep < 0 ? process.argv.slice(3) : process.argv.slice(3, sep))]
const scriptArgs = sep < 0 ? [] : process.argv.slice(sep + 1)

const child = spawn('ego-browser', egoArgs, { stdio: ['pipe', 'inherit', 'inherit'] })

child.stdin.write(`process.chdir(${JSON.stringify(process.cwd())});\n`)
// ego 不透传宿主环境变量：宿主 Node 路径与 PATH 只能注入进脚本自身；EGO_TASK 是这次跑的任务 key（进度与停止信号都靠它认身份）
child.stdin.write(
  `process.env.MEDIA_HUB_NODE=${JSON.stringify(process.execPath)};process.env.PATH=${JSON.stringify(process.env.PATH || '')};` +
  `process.env.EGO_TASK=${JSON.stringify(process.env.MEDIA_HUB_TASK || '')};\n`,
)
if (scriptArgs.length) child.stdin.write(`process.argv.push(${scriptArgs.map(JSON.stringify).join(', ')});\n`)
child.stdin.write(readFileSync(script, 'utf8'))
child.stdin.end()

child.on('error', (e) => {
  console.error(`[run-ego] 启动 ego-browser 失败: ${e.message}`)
  process.exit(1)
})
child.on('exit', (code) => process.exit(code ?? 1))
