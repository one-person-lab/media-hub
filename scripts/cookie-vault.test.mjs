import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { COOKIE_DOMAINS, adoptLogin, clearJar, clearSiteData, currentPath, forSetCookie, hasStorage, jarHas, ownerOfCookies, readCurrent, readVault, readVaultFull, restoreJar, sameCookies, seedCurrent, snapshotJar, stashLive, useAccount, vaultPath, writeVault } from './cookie-vault.mjs'

const root = () => join(tmpdir(), `vault-${Math.random().toString(36).slice(2)}`)
const c = (domain, name, value = 'v', extra = {}) => ({ domain, name, value, path: '/', ...extra })
const set = (platform, key, root) => writeFileSync(currentPath(platform, root), JSON.stringify({ key }))
const 后台 = 'https://creator.douyin.com'

/** 假 localStorage：只给当前 origin 那一格 */
function fakeLocal(store) {
  const keys = () => Object.keys(store)
  return {
    get length() { return keys().length },
    key: (i) => keys()[i] ?? null,
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v) },
    clear: () => { for (const k of keys()) delete store[k] },
  }
}

/** 假浏览器：认 getAllCookies / deleteCookies / setCookie / clearDataForOrigin，罐子按 域+路径+名 覆盖。
 *  再带一格按域名分开的 localStorage——页面站到哪个 origin，evaluate 读写的是哪一格，和真浏览器一样。 */
function jar(cookies = [], storage = {}) {
  const live = [...cookies]
  const calls = []
  let url = 'about:blank'
  return {
    calls,
    live,
    storage,
    async cdp(method, params = {}) {
      calls.push([method, params])
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
      if (method === 'Storage.clearDataForOrigin') return {}
      throw new Error(`假浏览器不认 ${method}`)
    },
    async url() { return url },
    async goto(target) { url = String(target); return null },
    async evaluate(fn, arg) {
      const here = (storage[new URL(url).origin] ||= {})
      globalThis.localStorage = fakeLocal(here)
      try { return fn(arg) } finally { delete globalThis.localStorage }
    },
  }
}

test('写回 CDP 前把只读字段与不认识的 sameSite 摘掉', () => {
  const out = forSetCookie(c('douyin.com', 'n_mh', 'x', { secure: true, httpOnly: true, sameSite: 'NoSameSite', expires: -1, priority: 'Medium', sourceScheme: 'Secure' }))
  assert.deepEqual(out, { name: 'n_mh', value: 'x', domain: 'douyin.com', path: '/', secure: true, httpOnly: true })
  assert.equal(forSetCookie(c('d', 'n', 'v', { sameSite: 'Lax', expires: 1_800_000_000 })).sameSite, 'Lax')
})

test('判是不是同一位要连值一起比：两个号的 cookie 名是一模一样的', () => {
  assert.ok(sameCookies([c('douyin.com', 'n_mh', 'a')], [c('douyin.com', 'n_mh', 'a')]))
  assert.ok(!sameCookies([c('douyin.com', 'n_mh', '主')], [c('douyin.com', 'n_mh', '二')]), '同名不同值就是两个号')
  assert.ok(!sameCookies([c('douyin.com', 'n_mh', 'a')], [c('douyin.com', 'n_mh', 'a'), c('douyin.com', 'sid', 'b')]))
})

test('保险库落盘读得回，坏文件按没存过处理', () => {
  const r = root()
  writeVault('douyin-2', [c('douyin.com', 'n_mh', 'x')], r)
  assert.equal(readVault('douyin-2', r).length, 1)
  assert.match(readFileSync(vaultPath('douyin-2', r), 'utf8'), /"value": "x"/)
  assert.equal(readVault('没存过', r), null)
  writeFileSync(vaultPath('douyin-2', r), '{ 半截')
  assert.equal(readVault('douyin-2', r), null)
})

test('扫完码收下罐子里这套，并记下"罐里现在住的是他"', async () => {
  const r = root()
  const page = jar([c('douyin.com', 'n_mh', '二', { httpOnly: true }), c('creator.xiaohongshu.com', 'sid', '别的平台'), c('douyin.com', 'other', 'z')])
  assert.equal((await adoptLogin(page, { key: 'douyin-2', platform: '抖音', root: r })).count, 2)
  assert.deepEqual(readVault('douyin-2', r).map((x) => x.name).sort(), ['n_mh', 'other'])
  assert.equal(readCurrent('抖音', r), 'douyin-2')
  assert.equal((await adoptLogin(page, { key: 'douyin-2', platform: '抖音', root: r })).changed, false)
  await assert.rejects(() => adoptLogin(jar([]), { key: 'k', platform: '抖音', root: r }), /没读到任何 cookie/)
})

test('换罐：把当前这位换出去、把要干活的号放进来，restore 原样换回', async () => {
  const r = root()
  const 主号 = [c('douyin.com', 'n_mh', '主'), c('douyin.com', 'sid', '主')]
  writeVault('douyin', 主号, r)
  writeVault('douyin-2', [c('douyin.com', 'n_mh', '二'), c('douyin.com', 'sid', '二')], r)
  set('抖音', 'douyin', r)
  const page = jar(主号)

  const hit = await useAccount(page, { key: 'douyin-2', platform: '抖音', root: r })
  assert.equal(hit.applied, 'swapped')
  assert.deepEqual(page.live.map((x) => x.value).sort(), ['二', '二'])
  assert.equal(readCurrent('抖音', r), 'douyin-2')

  await hit.restore()
  assert.deepEqual(page.live.map((x) => x.value).sort(), ['主', '主'], '干完活罐子必须还是动手前那个人')
  assert.equal(readCurrent('抖音', r), 'douyin')
})

test('save 只把这一轮活着的会话落回库、浏览器照旧登着他：单号平台用这条，别把旧会话还回去', async () => {
  const r = root()
  writeVault('douyin', [c('douyin.com', 'n_mh', '旧'), c('douyin.com', 'sid', '旧')], r)
  const page = jar([c('douyin.com', 'n_mh', '死'), c('douyin.com', 'sid', '死')])
  const hit = await useAccount(page, { key: 'douyin', platform: '抖音', backend: 后台, root: r })
  assert.equal(hit.applied, 'swapped')
  page.live.forEach((x) => { x.value = '刷新后' }) // 干活途中平台把会话值刷了
  await hit.save()
  assert.deepEqual(readVault('douyin', r).map((x) => x.value).sort(), ['刷新后', '刷新后'], '活会话要存住')
  assert.deepEqual(page.live.map((x) => x.value).sort(), ['刷新后', '刷新后'], '浏览器不换回去')
  assert.equal(readCurrent('抖音', r), 'douyin', '主人栏认下他，下一轮走 already')
})

test('主人栏说他、可罐里那几条已被同域名的另一个平台扫掉：照旧换罐，别报 already', async () => {
  const r = root()
  const 公众号那套 = [c('mp.weixin.qq.com', 'sid', '公'), c('weixin.qq.com', 'w', '公')]
  writeVault('mp', 公众号那套, r)
  set('公众号', 'mp', r)
  // 视频号的域名表是 weixin.qq.com，换它那次把 mp.weixin.qq.com 这一条一起扫走了
  const page = jar([c('weixin.qq.com', 'w', '公')])
  const hit = await useAccount(page, { key: 'mp', platform: '公众号', backend: 'https://mp.weixin.qq.com', root: r })
  assert.equal(hit.applied, 'swapped', '值一个没变但条目少了，就是被人扫过，得重换')
  assert.deepEqual(page.live.map((x) => `${x.domain}|${x.value}`).sort(), ['mp.weixin.qq.com|公', 'weixin.qq.com|公'])
})

test('换罐只动这个平台自己那一栏：公众号不碰视频号与 weixin 根域的 cookie', async () => {
  const r = root()
  writeVault('mp', [c('mp.weixin.qq.com', 'sid', '公'), c('channels.weixin.qq.com', 'f', '旧的'), c('weixin.qq.com', 'w', '旧的')], r)
  // 罐里此刻视频号那半套是活的，根域那条也是
  const page = jar([c('channels.weixin.qq.com', 'f', '活的'), c('weixin.qq.com', 'w', '活的')])
  const hit = await useAccount(page, { key: 'mp', platform: '公众号', backend: 'https://mp.weixin.qq.com', root: r })
  assert.equal(hit.applied, 'swapped')
  assert.ok(page.live.some((x) => x.domain === 'channels.weixin.qq.com' && x.value === '活的'), '兄弟平台那一栏一条不许动')
  assert.ok(page.live.some((x) => x.domain === 'weixin.qq.com' && x.value === '活的'), '根域那条照旧留活值')
  assert.ok(page.live.some((x) => x.domain === 'mp.weixin.qq.com'), '自己那一栏换进来了')
})

test('force：兜底重读要的是库里那套，不许拿 already 搪过去', async () => {
  const r = root()
  writeVault('mp', [c('mp.weixin.qq.com', 'sid', '库里的新值')], r)
  set('公众号', 'mp', r)
  const page = jar([c('mp.weixin.qq.com', 'sid', '罐里的旧值')])
  const hit = await useAccount(page, { key: 'mp', platform: '公众号', backend: 'https://mp.weixin.qq.com', root: r, force: true })
  assert.equal(hit.applied, 'swapped', '主人栏已经认下他也要真换一遍——库里那套可能比罐里的新')
  assert.deepEqual(page.live.map((x) => x.value), ['库里的新值'])
})

test('stashLive：读通了把罐里这套落回库，浏览器一条命令都不发', async () => {
  const r = root()
  writeVault('mp', [c('mp.weixin.qq.com', 'sid', '落库那天的旧值')], r)
  const page = jar([c('mp.weixin.qq.com', 'sid', '刚刷新的值'), c('channels.weixin.qq.com', 'f', '顺带')])
  assert.equal(await stashLive(page, { key: 'mp', platform: '公众号', backend: 'https://mp.weixin.qq.com', root: r }), 2)
  assert.deepEqual(readVault('mp', r).map((x) => x.value).sort(), ['刚刷新的值', '顺带'], '库跟着活会话一起新')
  assert.deepEqual(page.calls.map((x) => x[0]), ['Network.enable', 'Network.getAllCookies'], '只读不写')
  // 罐里读不到东西时不许拿空表覆盖库里那一套
  assert.equal(await stashLive(jar([]), { key: 'mp', platform: '公众号', backend: 'https://mp.weixin.qq.com', root: r }), 0)
  assert.equal(readVault('mp', r).length, 2, '读空了也不动库')
})

test('jarHas：值刷新了算还在，条目少了才算丢', () => {
  const want = [c('mp.weixin.qq.com', 'sid', '公'), c('weixin.qq.com', 'w', '公')]
  assert.ok(jarHas([c('mp.weixin.qq.com', 'sid', '刷新后'), c('weixin.qq.com', 'w', '刷新后')], want))
  assert.ok(!jarHas([c('weixin.qq.com', 'w', '公')], want), '少了 mp 那一条就是被扫掉了')
})

test('罐里已经是要干活的号就不换罐；平台刷新过 cookie 就顺手把新值落回库', async () => {
  const r = root()
  const 二号 = [c('douyin.com', 'n_mh', '二')]
  writeVault('douyin-2', 二号, r)
  set('抖音', 'douyin-2', r)
  const same = jar(二号)
  assert.equal((await useAccount(same, { key: 'douyin-2', platform: '抖音', root: r })).applied, 'already')
  assert.deepEqual(same.calls.map((x) => x[0]), ['Network.enable', 'Network.getAllCookies'], '已经是他就一条写都不该发')

  const drifted = jar([c('douyin.com', 'n_mh', '二·刷新后')])
  assert.equal((await useAccount(drifted, { key: 'douyin-2', platform: '抖音', root: r })).applied, 'already')
  assert.equal(readVault('douyin-2', r)[0].value, '二·刷新后', '同一个号的新值要存住，别拿旧值去换掉活会话')
  assert.deepEqual(drifted.calls.map((x) => x[0]), ['Network.enable', 'Network.getAllCookies'], '同一个号绝不发 delete/set')
})

test('没收过登录态的号不去动罐子，免得拿别人的会话冒充', async () => {
  const r = root()
  const page = jar([c('douyin.com', 'n_mh', '主')])
  const hit = await useAccount(page, { key: '三号', platform: '抖音', root: r })
  assert.equal(hit.applied, 'unstored')
  assert.deepEqual(page.live.map((x) => x.value), ['主'])
  await hit.restore()
  assert.deepEqual(page.live.map((x) => x.value), ['主'])
})

test('授权开始前先把罐里主人认下来：认不出就不动罐子', async () => {
  const r = root()
  const 主号 = [c('douyin.com', 'n_mh', '主')]
  let page = jar(主号)
  assert.equal((await seedCurrent(page, { platform: '抖音', keys: ['douyin'], root: r })).seeded, 'douyin')
  assert.deepEqual(readVault('douyin', r), 主号)
  assert.equal(readCurrent('抖音', r), 'douyin')

  // 同平台两个号都没库（给二号做首次授权）：罐里这位是谁认不出，一条命令都不发
  page = jar(主号)
  const 两个没库 = await seedCurrent(page, { platform: '抖音', keys: ['douyin', 'douyin-2'], root: root() })
  assert.equal(两个没库.seeded, null, '两个号都没库，罐里这位是谁认不出，别乱认')
  assert.deepEqual(page.live.map((x) => x.value), ['主'], '认不出就一条命令都不发')
})

test('罐里主人对得上库里哪一套就认回来（记录丢了也能接上）', async () => {
  const r = root()
  const 主号 = [c('douyin.com', 'n_mh', '主')]
  writeVault('douyin', 主号, r)
  writeVault('douyin-2', [c('douyin.com', 'n_mh', '二')], r)
  assert.equal(ownerOfCookies('抖音', 主号, ['douyin', 'douyin-2'], r), 'douyin')
  assert.equal(ownerOfCookies('抖音', [c('douyin.com', 'n_mh', '三')], ['douyin', 'douyin-2'], r), null, '对不上不认')
  // 主人栏是空的：seedCurrent 按值认回 douyin，把名字记回去
  assert.equal((await seedCurrent(jar(主号), { platform: '抖音', keys: ['douyin', 'douyin-2'], root: r })).seeded, 'douyin')
  assert.equal(readCurrent('抖音', r), 'douyin')
})

test('还罐：认得出主人就记名字，认不出宁可空着——顶着别人的名字是谎', async () => {
  const r = root()
  writeVault('douyin-2', [c('douyin.com', 'n_mh', '二')], r)
  set('抖音', 'douyin-2', r)
  const page = jar([c('douyin.com', 'n_mh', '二')])
  const 主号 = [c('douyin.com', 'n_mh', '主')]
  await restoreJar(page, { platform: '抖音', cookies: 主号, key: 'douyin', root: r })
  assert.deepEqual(page.live.map((x) => x.value), ['主'])
  assert.equal(readCurrent('抖音', r), 'douyin')
  await restoreJar(page, { platform: '抖音', cookies: 主号, key: null, root: r })
  assert.equal(readCurrent('抖音', r), null, '没有主人栏就等于没主人，别留上一个人的名字')
  assert.deepEqual((await restoreJar(page, { platform: '抖音', cookies: [], key: 'douyin', root: r })).restored, false, '空的不动罐子')
})

test('没建域名表的平台一律不碰罐子（公众号与视频号同属 weixin.qq.com，别互相清）', async () => {
  const page = jar([c('weixin.qq.com', 'n', 'v')])
  assert.equal((await useAccount(page, { key: 'x', platform: 'B站', root: root() })).applied, 'noop')
  assert.equal((await seedCurrent(page, { platform: 'B站', keys: ['x'], root: root() })).seeded, null)
  assert.equal((await clearJar(page, { platform: 'B站', root: root() })).dropped, 0)
  assert.equal(page.calls.length, 0)
  assert.ok(COOKIE_DOMAINS['公众号'].includes('weixin.qq.com') && COOKIE_DOMAINS['视频号'].includes('weixin.qq.com'))
})

test('扫第二个号前清罐：只清这个平台的域名，主人栏跟着空掉', async () => {
  const r = root()
  writeVault('douyin', [c('douyin.com', 'n_mh', '主')], r)
  set('抖音', 'douyin', r)
  set('小红书', 'xiaohongshu', r)
  const page = jar([c('douyin.com', 'n_mh', '主'), c('.iesdouyin.com', 'sid', '主'), c('xiaohongshu.com', 'sid', '别家')])
  assert.equal((await clearJar(page, { platform: '抖音', root: r })).dropped, 2)
  assert.deepEqual(page.live.map((x) => [x.domain, x.value]), [['xiaohongshu.com', '别家']], '别的平台一条都不许动')
  assert.equal(readCurrent('抖音', r), null, '罐子空了还写着主号的名字就是谎')
  assert.equal(readCurrent('小红书', r), 'xiaohongshu', '别家主人栏不跟着清')
  assert.deepEqual(readVault('douyin', r).map((x) => x.value), ['主'], '清罐不碰保险库')
})

test('本地存储只倒那一个域名，浏览器不给清就照实说清不掉', async () => {
  const page = jar([])
  assert.equal(await clearSiteData(page, 'https://creator.douyin.com'), true)
  assert.deepEqual(page.calls, [['Storage.clearDataForOrigin', { origin: 'https://creator.douyin.com', storageTypes: 'local_storage,indexeddb' }]])
  assert.equal(await clearSiteData({ async cdp() { throw new Error('这个 ego 版本不认') } }, 'https://creator.douyin.com'), false)
  assert.equal(await clearSiteData(page, ''), false, '没给 origin 就一条都不发')
})

/* ==================== 一套登录态 = cookie + 后台那一格 localStorage ====================
 * 依据是蚁小二 4.0 的本机实现：它收登录态连本地存储一起收（小红书要 b1），发布抖音时缺
 * security-sdk 那两把键直接报「账号信息缺失，请重新授权此账号再试」。只换 cookie 的第二个号
 * 顶着的还是主号的设备键，平台认出来仍是主号——2026-10-23「扫了二号打开的是主号后台」就是这么来的。
 * 所以这一格的四条路（收、换、还、清）都得有断言，缺哪条都要照实报，不许静默退化成只换 cookie。 */

test('收登录态连后台那一格一起收进库；那一格摸不到就明说 skipped', async () => {
  const r = root()
  const page = jar([c('douyin.com', 'n_mh', '二')], { [后台]: { 'security-sdk/s_sdk_crypt_sdk': '二的设备键' } })
  const got = await adoptLogin(page, { key: 'douyin-2', platform: '抖音', backend: 后台, root: r })
  assert.equal(got.storage, 'stored')
  assert.equal(readVaultFull('douyin-2', r).storage[后台]['security-sdk/s_sdk_crypt_sdk'], '二的设备键')
  assert.equal(hasStorage('douyin-2', r), true)

  const 摸不到 = jar([c('douyin.com', 'n_mh', '三')])
  delete 摸不到.evaluate
  assert.equal((await adoptLogin(摸不到, { key: 'douyin-3', platform: '抖音', backend: 后台, root: r })).storage, 'skipped')
  assert.equal(hasStorage('douyin-3', r), false, '摸不到就别拿一个空格当这号没有本地存储')
})

test('换罐把那一格一起换进来，restore 连它一起换回去', async () => {
  const r = root()
  writeVault('douyin', [c('douyin.com', 'n_mh', '主')], r, { [后台]: { dev: '主' } })
  writeVault('douyin-2', [c('douyin.com', 'n_mh', '二')], r, { [后台]: { dev: '二', extra: 'x' } })
  set('抖音', 'douyin', r)
  const page = jar([c('douyin.com', 'n_mh', '主')], { [后台]: { dev: '主' } })

  const hit = await useAccount(page, { key: 'douyin-2', platform: '抖音', backend: 后台, root: r })
  assert.equal(hit.storage, 'swapped')
  assert.deepEqual(page.live.map((x) => x.value), ['二'])
  assert.deepEqual(page.storage[后台], { dev: '二', extra: 'x' }, '设备键要跟着号走，不然平台还是认主号')

  await hit.restore()
  assert.deepEqual(page.live.map((x) => x.value), ['主'])
  assert.deepEqual(page.storage[后台], { dev: '主' }, '干完活那一格也得是动手前那个人')
  assert.equal(readVaultFull('douyin-2', r).storage[后台].dev, '二', '二号干完活这套要落回他的库')
})

test('读不通那一轮的还罐不落库：库里那套好会话不能被弹回登录页后的残值盖掉', async () => {
  const r = root()
  writeVault('douyin', [c('douyin.com', 'n_mh', '主')], r)
  writeVault('douyin-2', [c('douyin.com', 'n_mh', '二')], r)
  set('抖音', 'douyin', r)
  const page = jar([c('douyin.com', 'n_mh', '主')])
  const hit = await useAccount(page, { key: 'douyin-2', platform: '抖音', root: r })
  // 页面被平台弹回登录页，罐里只剩平台发的临时值
  for (const x of page.live) x.value = ''
  await hit.restore({ stashJar: false })
  assert.deepEqual(readVault('douyin-2', r).map((x) => x.value), ['二'], '二号库里那套一个字都不能改')
  assert.deepEqual(page.live.map((x) => x.value), ['主'], '浏览器照动手前还回去')
})

test('这一格的库是空的（只换 cookie 的年代收的）：报 missing，并把上一个号的键清掉', async () => {
  const r = root()
  writeVault('douyin', [c('douyin.com', 'n_mh', '主')], r, { [后台]: { dev: '主' } })
  writeVault('douyin-2', [c('douyin.com', 'n_mh', '二')], r)
  set('抖音', 'douyin', r)
  const page = jar([c('douyin.com', 'n_mh', '主')], { [后台]: { dev: '主' } })
  const hit = await useAccount(page, { key: 'douyin-2', platform: '抖音', backend: 后台, root: r })
  assert.equal(hit.storage, 'missing', '缺哪一格要写清楚，界面才能催他重扫那一次')
  assert.deepEqual(page.storage[后台], {}, '宁可空着让平台重长一套键，也不能拿主号的键认二号')
})

test('那一格写不进去（页面不给写）：照实报 skipped，但也别把上一个号的键留下', async () => {
  const r = root()
  writeVault('douyin', [c('douyin.com', 'n_mh', '主')], r, { [后台]: { dev: '主' } })
  writeVault('douyin-2', [c('douyin.com', 'n_mh', '二')], r, { [后台]: { dev: '二' } })
  set('抖音', 'douyin', r)
  const page = jar([c('douyin.com', 'n_mh', '主')], { [后台]: { dev: '主' } })
  const 真evaluate = page.evaluate
  page.evaluate = async (fn, arg) => {
    if (String(fn).includes('setItem')) throw new Error('这个页面不给写本地存储')
    return 真evaluate.call(page, fn, arg)
  }
  const hit = await useAccount(page, { key: 'douyin-2', platform: '抖音', backend: 后台, root: r })
  assert.equal(hit.applied, 'swapped', 'cookie 照样换，这一格换不进去是另一件事')
  assert.equal(hit.storage, 'skipped')
  assert.deepEqual(page.storage[后台], {}, '换不进自己的键就清掉，别顶着上一个号的设备键干活')
})

test('还罐：那一格跟着快照走；没拍到快照就报 missing 而不是假装换好了', async () => {
  const r = root()
  const page = jar([c('douyin.com', 'n_mh', '主')], { [后台]: { dev: '主' } })
  const snap = await snapshotJar(page, { platform: '抖音', backend: 后台, root: r })
  assert.equal(snap.storage[后台].dev, '主')
  assert.equal(snap.was, null)
  assert.equal((await restoreJar(page, { platform: '抖音', cookies: snap.cookies, storage: snap.storage, key: 'douyin', backend: 后台, root: r })).storage, 'restored')
  assert.deepEqual(page.storage[后台], { dev: '主' })
  assert.equal((await restoreJar(page, { platform: '抖音', cookies: snap.cookies, storage: null, key: 'douyin', backend: 后台, root: r })).storage, 'missing')
})

test('清罐连那一格一起倒掉——留着会话，登录页摆的还是主号那一屏', async () => {
  const r = root()
  writeVault('douyin', [c('douyin.com', 'n_mh', '主')], r, { [后台]: { dev: '主' } })
  set('抖音', 'douyin', r)
  const page = jar([c('douyin.com', 'n_mh', '主')], { [后台]: { dev: '主' }, 'https://www.xiaohongshu.com': { b1: '别家' } })
  assert.equal((await clearJar(page, { platform: '抖音', backend: 后台, root: r })).storage, 'cleared')
  assert.deepEqual(page.storage[后台], {})
  assert.deepEqual(page.storage['https://www.xiaohongshu.com'], { b1: '别家' }, '别家那一格一条都不许动')
})

test('授权前先把罐里这位落库时，那一格也一起落——他马上要被二号顶掉，就这一次机会', async () => {
  const r = root()
  const page = jar([c('douyin.com', 'n_mh', '主')], { [后台]: { dev: '主' } })
  assert.equal((await seedCurrent(page, { platform: '抖音', keys: ['douyin'], backend: 后台, root: r })).seeded, 'douyin')
  assert.equal(readVaultFull('douyin', r).storage[后台].dev, '主')
  assert.equal(readCurrent('抖音', r), 'douyin')
})
