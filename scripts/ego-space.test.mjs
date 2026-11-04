import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { currentPath, readCurrent, readVault, writeVault } from './cookie-vault.mjs'
import { guardJar, openSpace } from './ego-space.mjs'

/** ego 的 taskSpace 等只在 ego 内嵌 Node 里存在，这里按脚本实际会拿到的形状挂上 globalThis。
 *  被测的是我们这层胶水（同名空间先认领、替哪个号干活就换哪个号的罐子），不是 ego 本身。 */
function egoStub({ spaces = [] } = {}) {
  const calls = { taskSpace: [], claim: [], takeOver: [] }
  const g = globalThis
  g.listTaskSpaces = async () => spaces
  g.taskSpace = async (name, options) => { calls.taskSpace.push({ name, options }); return { name, kind: 'new', finish: async () => 'finished', handOff: async () => 'handed-off' } }
  g.claimTaskSpace = async (id) => { calls.claim.push(id); return { id, kind: 'claim' } }
  g.takeOverTaskSpace = async (id) => { calls.takeOver.push(id); return { id, kind: 'takeOver' } }
  return calls
}

/** 假浏览器：只认 getAllCookies / deleteCookies / setCookie 三条 */
function jar(cookies = []) {
  const live = [...cookies]
  return {
    live,
    async cdp(method, params = {}) {
      if (method === 'Network.getAllCookies') return { cookies: live.map((x) => ({ ...x })) }
      if (method === 'Network.deleteCookies') {
        const at = live.findIndex((x) => x.domain === params.domain && x.name === params.name && (x.path || '/') === (params.path || '/'))
        if (at >= 0) live.splice(at, 1)
        return {}
      }
      if (method === 'Network.setCookie') {
        const at = live.findIndex((x) => x.domain === params.domain && x.name === params.name && (x.path || '/') === (params.path || '/'))
        const next = { path: '/', ...params }
        if (at >= 0) live[at] = next
        else live.push(next)
        return {}
      }
      throw new Error(`假浏览器不认 ${method}`)
    },
  }
}

const c = (domain, name, value = 'v') => ({ domain, name, value, path: '/' })

/** 一台假机器：账号表按传进来的号写死，保险库目录现成 */
function machineRoot(accounts) {
  const r = join(tmpdir(), `ego-space-${Math.random().toString(36).slice(2)}`)
  mkdirSync(`${r}/config`, { recursive: true })
  mkdirSync(`${r}/metrics/account-cookies`, { recursive: true })
  writeFileSync(`${r}/config/accounts.json`, JSON.stringify(accounts))
  return r
}

test('同名空间先认领回来；认领不动就改用接管（上次 finish 交还的空间是这一种）', async () => {
  let calls = egoStub({ spaces: [{ id: 7, name: 'publish-check', ownership: 'user' }] })
  assert.deepEqual(await openSpace('publish-check'), { id: 7, kind: 'claim' })
  assert.equal(calls.taskSpace.length, 0)

  calls = egoStub({ spaces: [{ id: 7, name: 'xhs-publish' }] })
  globalThis.claimTaskSpace = async () => { throw new Error('EGO_TASK_SPACE_NAME_IN_USE') }
  assert.equal((await openSpace('xhs-publish')).kind, 'takeOver')

  egoStub()
  assert.equal((await openSpace('brand-new')).kind, 'new')
})

test('一个平台只有一个号：不换罐也不碰浏览器，主号的登录态本来就在罐里', async () => {
  const root = machineRoot([{ id: '抖音', platform: '抖音', key: 'douyin', nickname: '' }])
  const page = jar([c('douyin.com', 'n_mh', '主')])
  assert.equal((await guardJar({}, page, { accountKey: 'douyin', platform: '抖音', root })).applied, 'single')
  assert.equal(page.live.length, 1)
})

test('没传账号或平台（老参数文件）时一条命令都不发', async () => {
  const page = jar([c('douyin.com', 'n_mh', '主')])
  assert.equal((await guardJar({}, page, { root: machineRoot([]) })).applied, 'noop')
  assert.equal(page.live.length, 1)
})

test('替第二个号干活：换进他的罐子，收尾（finish）时自动换回主号', async () => {
  const root = machineRoot([
    { id: '抖音', platform: '抖音', key: 'douyin', nickname: '' },
    { id: '抖音-成长号', platform: '抖音', key: 'douyin-2', nickname: '成长号' },
  ])
  const 主号 = [c('douyin.com', 'n_mh', '主'), c('douyin.com', 'sid', '主')]
  writeVault('douyin', 主号, root)
  writeVault('douyin-2', [c('douyin.com', 'n_mh', '二'), c('douyin.com', 'sid', '二')], root)
  writeFileSync(currentPath('抖音', root), JSON.stringify({ key: 'douyin' }))
  const page = jar(主号)
  const task = { finish: async () => 'finished', handOff: async () => 'handed-off' }

  const hit = await guardJar(task, page, { accountKey: 'douyin-2', platform: '抖音', root })
  assert.equal(hit.applied, 'swapped')
  assert.deepEqual(page.live.map((x) => x.value).sort(), ['二', '二'])
  assert.equal(readCurrent('抖音', root), 'douyin-2')

  assert.equal(await task.finish(), 'finished', '包一层不能改收尾的返回值')
  assert.deepEqual(page.live.map((x) => x.value).sort(), ['主', '主'], '收尾必须把罐子换回动手前那位')
  assert.equal(readCurrent('抖音', root), 'douyin')
})

test('交还（handOff）同样换回：验证码那条路也会走出脚本', async () => {
  const root = machineRoot([
    { id: '抖音', platform: '抖音', key: 'douyin', nickname: '' },
    { id: '抖音-成长号', platform: '抖音', key: 'douyin-2', nickname: '成长号' },
  ])
  writeVault('douyin', [c('douyin.com', 'n_mh', '主')], root)
  writeVault('douyin-2', [c('douyin.com', 'n_mh', '二')], root)
  const page = jar([c('douyin.com', 'n_mh', '主')])
  const task = { handOff: async () => 'handed-off' }

  await guardJar(task, page, { accountKey: 'douyin-2', platform: '抖音', root })
  assert.deepEqual(page.live.map((x) => x.value), ['二'])
  assert.equal(await task.handOff(), 'handed-off')
  assert.deepEqual(page.live.map((x) => x.value), ['主'])
})

test('平台第一次分号：库里一套都没有，先把罐里这位认作主号，才谈得上换罐', async () => {
  const root = machineRoot([
    { id: '抖音', platform: '抖音', key: 'douyin', nickname: '' },
    { id: '抖音-成长号', platform: '抖音', key: 'douyin-2', nickname: '成长号' },
  ])
  const page = jar([c('douyin.com', 'n_mh', '主')])
  const hit = await guardJar({}, page, { accountKey: 'douyin', platform: '抖音', root })
  assert.equal(hit.applied, 'claimed')
  assert.deepEqual(readVault('douyin', root), [c('douyin.com', 'n_mh', '主')])
  assert.equal(readCurrent('抖音', root), 'douyin')
})

test('换罐从没跑过、又要替非主号干活：宁可报错，不拿别人的会话冒充', async () => {
  const root = machineRoot([
    { id: '抖音', platform: '抖音', key: 'douyin', nickname: '' },
    { id: '抖音-成长号', platform: '抖音', key: 'douyin-2', nickname: '成长号' },
  ])
  writeVault('douyin', [c('douyin.com', 'n_mh', '主')], root)
  const page = jar([c('douyin.com', 'n_mh', '主')])
  await assert.rejects(
    () => guardJar({}, page, { accountKey: 'douyin-2', platform: '抖音', root }),
    /「抖音·成长号」还没收过登录态：在授权页给它扫一次码/,
  )
  assert.deepEqual(page.live.map((x) => x.value), ['主'], '报错前也不许动罐子')
})

test('账号表读不到时不动罐子：宁可什么都不做，别清错别人的登录态', async () => {
  const page = jar([c('douyin.com', 'n_mh', '主')])
  assert.equal((await guardJar({}, page, { accountKey: 'douyin', platform: '抖音', root: '/不存在的那台机器' })).applied, 'single')
  assert.equal(page.live.length, 1)
})
