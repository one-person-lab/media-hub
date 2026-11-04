/**
 * ego 任务空间的统一入口：五个推草稿脚本、授权、登录态检测都从这里开浏览器。
 * 集中做两件散在各脚本迟早会漏一件事：
 *  1. 同名空间已存在一律先 claim、失败再 takeOver——上次 finish 交还后空间留在 user 名下，
 *     这种空间直接 taskSpace(同名) 在 ego 启动阶段就死，脚本 catch 不到。
 *  2. 替某个号干活前要把它那套登录态换进浏览器罐子，干完必须换回去（见 guardJar）。
 *     一个浏览器 profile 只有一个 cookie 罐子，同平台的第二个号不换气就会把第一个顶下线；
 *     Ego Lite 不给脚本建 profile（实测只列不建），所以隔离由 media-hub 自己做。
 *
 * 只能在 ego 内嵌 Node 里跑（taskSpace 等由 ego 注入）。
 */
import { readFileSync } from 'node:fs'
import { claimJarForFirstAccount, useAccount } from './cookie-vault.mjs'

export async function openSpace(name) {
  const hit = (await listTaskSpaces()).find((s) => s.name === name)
  if (hit) {
    console.log(`[ego-space] 认领已存在的空间「${name}」(id ${hit.id}, ownership ${hit.ownership})`)
    // 走哪条路拿到的空间要留在留痕里：认领成功但控制权还在人手里时，第一条浏览器命令会硬停，
    // 只有「claim 成功 / takeover 成功 / 新建」这句能分清那次卡死到底接手接到了什么。
    try {
      const t = await claimTaskSpace(hit.id)
      console.log(`[ego-space] 认领成功，ownership=${t.ownership}`)
      return await liveOrTakeover(t, hit)
    } catch (e) {
      try {
        const t = await takeOverTaskSpace(hit.id)
        console.log(`[ego-space] 接管成功，ownership=${t.ownership}`)
        return t
      } catch (e2) {
        // 两条接手路都走不通：把空间归属与两边原话报出去。脚本硬抢控制权是 ego 明令禁止的（见 ego skill），
        // 报「太慢，重试一次」会把人引进死胡同——2026-10-23 装机版点「去授权」卡死就是这个空间留在 user 名下。
        const one = (x) => String(x?.message || x).split('\n')[0].slice(0, 90)
        throw new Error(`浏览器里这个空间（id ${hit.id}）还挂在「${hit.ownership}」名下，脚本接不过来：认领说「${one(e)}」，接管说「${one(e2)}」`)
      }
    }
  }
  return await taskSpace(name)
}

/** 认领成功 ≠ 动得了：空间被浏览器那边接管时 claim 照样返回，硬停在第一条浏览器命令上
 *  （2026-10-23 实测：授权跑完之后 publish-check 回认就这么死掉，界面那一行永远停在「没测过」）。
 *  所以认领后先拿最便宜的一条只读命令试手，撞上接管那句就按 ego 的规矩改走接管再试一次。
 *  只认那句接管，别的错原样交回调用方——别把页面崩溃也当成归属问题盖掉。 */
async function liveOrTakeover(t, hit) {
  try {
    await t.pages()
    return t
  } catch (e) {
    if (!/Control of this task space is with the user/i.test(String(e?.message || e))) return t
    try {
      const t2 = await takeOverTaskSpace(hit.id)
      await t2.pages()
      console.log(`[ego-space] 认领下来发现控制权还在人手里，改接管成功，ownership=${t2.ownership}`)
      return t2
    } catch (e2) {
      throw new Error(`浏览器里这个空间（id ${hit.id}）正让人握着：脚本一动它就让交还，接管也没成（${String(e2?.message || e2).split('\n')[0].slice(0, 90)}）`)
    }
  }
}

/** 同平台登记了哪几个号（顺序即登记表顺序，第一个是最早登记的主号）。
 *  账号表读不到时返回空表——宁可不动罐子，别清错别人的登录态。 */
function rivals(platform, root) {
  try {
    const list = JSON.parse(readFileSync(`${root}/config/accounts.json`, 'utf8'))
    const rows = list.filter((a) => a.platform === platform)
    return { keys: rows.map((a) => a.key), backend: rows.find((a) => a.backend)?.backend || '', rows }
  } catch {
    return { keys: [], backend: '', rows: [] }
  }
}

/** 拿到 page 之后立刻调用：把罐子换成要干活的号，并把 finish/handOff 包一层——
 *  推草稿脚本的收尾分支多（存草稿、验证码交还、各种失败退出），漏一处就把别人的登录态留在罐子里。
 *  这个平台一套库都还没有（第一次分号）时，先把罐里这位认作主号，认下来才谈得上换。 */
export async function guardJar(task, page, { accountKey, platform, root = process.cwd() }) {
  if (!accountKey || !platform) return { applied: 'noop' }
  const { keys, backend, rows } = rivals(platform, root)
  if (keys.length < 2) return { applied: 'single' }
  const hit = await useAccount(page, { key: accountKey, platform, backend, root })
  if (hit.applied === 'unstored') {
    if (accountKey === keys[0] && await claimJarForFirstAccount(page, { key: accountKey, platform, keys, backend, root })) {
      return { applied: 'claimed' }
    }
    const row = rows.find((a) => a.key === accountKey)
    // 报错会直接摆在推草稿面板上，报 douyin-2 那种内部键人看不懂是哪一行
    throw new Error(`「${row?.nickname ? `${platform}·${row.nickname}` : (row?.id || accountKey)}」还没收过登录态：在授权页给它扫一次码`)
  }
  if (hit.applied !== 'swapped') return hit
  for (const method of ['finish', 'handOff']) {
    const orig = task[method]
    if (typeof orig !== 'function') continue
    task[method] = async (...args) => {
      await hit.restore().catch((e) => console.log(`[ego-space] 罐子没换回去（${String(e?.message || e)}），下次会按库里的重换`))
      return orig.apply(task, args)
    }
  }
  return hit
}
