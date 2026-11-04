import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MEDIA_HUB_ROOT = mkdtempSync(join(tmpdir(), 'agent-cancel-'))
mkdirSync(join(process.env.MEDIA_HUB_ROOT, 'config'), { recursive: true })
// Agent 命令 = 一直读 stdin 不退出：只有取消能让它停
writeFileSync(join(process.env.MEDIA_HUB_ROOT, 'config/llm.json'), JSON.stringify({
  agent: { command: 'node', args: ['-e', 'process.stdin.resume()'], model: 'test' },
}))

const { runAgentJob } = await import('./llm-core.mjs')

test('signal 一 abort，Agent 就死：几秒内返回，不许等超时', async () => {
  const ac = new AbortController()
  setTimeout(() => ac.abort(), 50)
  const t0 = Date.now()
  const r = await runAgentJob('随便写点什么', { timeoutMs: 600_000, label: 'create', signal: ac.signal })
  assert.equal(r.ok, false)
  assert.equal(r.aborted, true)
  assert.match(r.error, /已停止/)
  assert.ok(Date.now() - t0 < 20_000, `取消要在几秒内生效，实际 ${Date.now() - t0}ms`)
})

test('已经在跑的 signal 一进来就是断的：不等超时直接退', async () => {
  const ac = new AbortController()
  ac.abort()
  const r = await runAgentJob('随便写点什么', { timeoutMs: 600_000, label: 'create', signal: ac.signal })
  assert.equal(r.aborted, true)
})

test('没给 signal 时行为不变：超时仍然是超时', async () => {
  const t0 = Date.now()
  const r = await runAgentJob('随便写点什么', { timeoutMs: 300, label: 'create' })
  assert.equal(r.ok, false)
  assert.equal(r.aborted, undefined)
  assert.match(r.error, /超时/)
  assert.ok(Date.now() - t0 < 30_000)
})
