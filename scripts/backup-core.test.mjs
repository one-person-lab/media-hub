import test from 'node:test'
import assert from 'node:assert/strict'
import { commitTitle, isBackupPath, planBackup, pickRemotes, PUSH_REMOTES } from './backup-core.mjs'

const MB = 1024 * 1024

test('内容进快照，代码留在人自己手里', () => {
  const plan = planBackup({
    tracked: [
      { path: 'content/Inbox/采集笔记/收藏/小红书/abc.md' },
      { path: 'config/auto-run.json' },
      { path: 'public/cards/xingxing-life/01.png' },
      { path: 'src/views/StudioView.vue' },
      { path: 'scripts/serve.mjs' },
    ],
    untracked: [{ path: 'content/Projects/发布排期/小红书/待发布/2026-11/new.md', bytes: 4096 }],
  })
  assert.deepEqual(plan.stage, [
    'content/Inbox/采集笔记/收藏/小红书/abc.md',
    'config/auto-run.json',
    'public/cards/xingxing-life/01.png',
    'content/Projects/发布排期/小红书/待发布/2026-11/new.md',
  ])
  assert.deepEqual(plan.code, ['src/views/StudioView.vue', 'scripts/serve.mjs'])
  // 别的工程落在本机的产物（本来就没入过库）一句都不提：报出来是 1200 行噪音
  const quiet = planBackup({ untracked: [{ path: 'dist-film/shot-01.mp4', bytes: 12 * MB }] })
  assert.deepEqual(quiet.stage, [])
  assert.deepEqual(quiet.code, [])
})

test('删除也是内容改动，照样进这一趟快照', () => {
  // 归档=移文件：旧位置消失 + 新位置未入库，两边都得收，否则云端留下一份幽灵稿
  const plan = planBackup({
    tracked: [{ path: 'content/Projects/发布排期/小红书/待发布/2026-11/a.md' }],
    untracked: [{ path: 'content/Projects/发布排期/小红书/已发布/2026-11/a.md', bytes: 2048 }],
  })
  assert.equal(plan.stage.length, 2)
})

test('新塞进来的成片不进备份：git 不是视频仓库', () => {
  const plan = planBackup({
    untracked: [
      { path: 'public/inspiration/xx/movie.mp4', bytes: 900 * MB },
      { path: 'public/shots/new-screen.png', bytes: 2 * MB },
    ],
  })
  assert.deepEqual(plan.stage, ['public/shots/new-screen.png'])
  assert.deepEqual(plan.skip, ['public/inspiration/xx/movie.mp4'])
  // 已经入库的大文件后来又改：历史里本来就有它，这次不该装作没改
  assert.deepEqual(planBackup({ tracked: [{ path: 'public/inspiration/xx/big.png' }] }).stage, ['public/inspiration/xx/big.png'])
})

test('公开仓那条永远推不出去', () => {
  const available = ['origin', 'oss-public', 'cloud']
  assert.deepEqual(pickRemotes(['origin', 'cloud'], available).remotes, ['origin', 'cloud'])
  // 有人手滑点名公开仓：当场拒，不给它「已经在本机配上了」的豁免
  const bad = pickRemotes(['oss-public'], available)
  assert.equal(bad.ok, false)
  assert.match(bad.error, /不在自动备份的名单里/)
  assert.ok(!PUSH_REMOTES.includes('oss-public'))
  // 没配的远端要说清去哪加，别让人以为备份做完了
  const missing = pickRemotes(['origin', 'cloud'], ['origin'])
  assert.equal(missing.ok, false)
  assert.match(missing.error, /本机还没有这些远端：cloud/)
})

test('快照标题说的是这一趟干了什么', () => {
  assert.equal(
    commitTitle({ day: '2026-11-03', clock: '21:40', files: 37 }),
    'chore(backup): 2026-11-03 21:40 内容快照（37 个文件·自动）',
  )
})

test('只认真正的内容目录，别把同级同名前缀也算进来', () => {
  assert.equal(isBackupPath('content/x.md'), true)
  assert.equal(isBackupPath('content.private/x.md'), false)
  assert.equal(isBackupPath('metrics/content/x.json'), false)
})
