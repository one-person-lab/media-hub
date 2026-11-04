<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import {
  accounts, loginOf, holdSelfWrite, setHoldAutoRefresh, accountLabel, isRemote, stopRunningJob,
  type Account, type LoginEntry,
} from '../data/store'
import PageHeader from '../components/PageHeader.vue'
import PlatformLogo from '../components/PlatformLogo.vue'
import AccountAvatar from '../components/AccountAvatar.vue'
import ClientOnly from '../components/ClientOnly.vue'
import { useToast } from '../lib/useToast'
import {
  ArrowRight as IconArrowRight, Check as IconCheck, ExternalLink as IconExternalLink,
  LayoutGrid as IconLayoutGrid, LoaderCircle as IconLoaderCircle,
  Plus as IconPlus, QrCode as IconQrCode, RefreshCw as IconRefreshCw, Square as IconSquare,
  X as IconX,
} from 'lucide-vue-next'

const { toast } = useToast()

/* ==================== 状态读数 ==================== */
/** 没检测 = 这台机器上还没人测过，别拿别的平台的读数冒充。
 *  按账号 id 读（不是 platform）：同平台两个号各有各的登录态 */
const stateOf = (a: Account): LoginEntry['state'] | 'none' => loginOf(a.id)?.state ?? 'none'

const LOGIN_TEXT: Record<string, string> = {
  ok: '已登录', out: '已失效', error: '没测出来', none: '还没测',
}
const LOGIN_CLS: Record<string, string> = {
  ok: 'status-published', out: 'status-failed', error: 'status-creating', none: 'status-not-start',
}

/** 要处理的排前面：进页面第一眼看到的就是需要动作的号 */
const URGENCY: Record<string, number> = { out: 0, error: 1, none: 2, ok: 3 }

/* ---- 后台自报的身份 ---- */
const readOf = (a: Account) => loginOf(a.id)?.account || ''
const readWrong = (a: Account) => {
  const who = readOf(a)
  return !!who && !!a.nickname && !who.startsWith(a.nickname)
}

/* ---- 账号头像：抖音/小红书回认出本人的那一刻顺带搬下来的（publish-check → public/accounts/）。
 *  没有读数就没有图，行首回落平台 logo；图片文件本身丢了（换机/手动清过）也当没读到，不留破图。 */
const avatarOf = (a: Account) => loginOf(a.id)?.avatar || ''

/** 这一轮读到多少条已发布：evidence 是发布回认写的「10 条已发布」，抠那个数。
 *  没有读数回空串，别拿 0 冒充「读到 0 条」 */
const publishedOf = (a: Account) => (loginOf(a.id)?.evidence || '').match(/(\d+)\s*条/)?.[1] ?? ''

/** 行内那一句红字只说状态点说不出的话：本机登的是别人的号——接口返回了数据只证明「有个号登着」，不证明是这个号。 */
const whyOf = (a: Account) => (readWrong(a) ? `本机登的是「${readOf(a)}」` : '')

/* ---- 读数年龄：体检时间是几小时前的，就不能顶着一句「已登录」不撒口 ---- */
/** 超过 2 小时的读数一律当过期：进页面先替这些号复检一遍 */
const STALE_MS = 2 * 60 * 60 * 1000
/** 每分钟推一次，悬浮读数才不会停在进页面那一刻 */
const nowTick = ref(Date.now())
/** 复检中的号：读数还是旧的，但已经知道它旧并在补，所以先报「复检中」而不是「已登录」。
 *  按 key 记账 —— 重采可以只点几个号，不能把没在跑的行也标成复检中 */
const recheckingKeys = ref<string[]>([])
const rechecking = computed(() => recheckingKeys.value.length > 0)
/** 这一行正在重采吗：按 key 判，只标真在跑的那几行 */
const inCheck = (a: Account) => recheckingKeys.value.includes(a.key)

const isStale = (a: Account) => {
  const iso = loginOf(a.id)?.checkedAt
  return !iso || nowTick.value - new Date(iso).getTime() > STALE_MS
}

/** 这一行读数自己的时间——账号页可以只回认一个号，别拿全局时间冒充 */
function ageOf(iso?: string) {
  if (!iso) return '没检测过'
  const min = Math.max(0, Math.floor((nowTick.value - new Date(iso).getTime()) / 60_000))
  if (min < 1) return '刚刚'
  if (min < 60) return `${min} 分钟前`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h} 小时前`
  return `${Math.floor(h / 24)} 天前`
}

/** 状态点悬浮那句：登录态是什么、什么时候测的，都收在这里，不摊在版面上 */
const statusTip = (a: Account) => {
  const iso = loginOf(a.id)?.checkedAt
  const age = !iso ? '这台机器上还没检测过' : `${ageOf(iso)}测的`
  return `${inCheck(a) ? '复检中' : LOGIN_TEXT[stateOf(a)]} · ${age}`
}

/** 要处理的号：不在「已登录」上就得有人去点它，重采只点这几个 */
const needItems = computed(() => accounts.filter((a) => stateOf(a) !== 'ok'))

/* ==================== 同步任务：起一个、等它跑完 ==================== */
/** /__run-script 回的那一笔 */
type RunJob = {
  task?: string
  startedAt?: number
  running?: boolean
  tail?: string
  action?: string
  error?: string
  code?: string
}
const timers: ReturnType<typeof setInterval>[] = []
onBeforeUnmount(() => {
  timers.forEach(clearInterval)
  window.removeEventListener('keydown', closeAddOnEsc)
})
onMounted(() => {
  timers.push(setInterval(() => (nowTick.value = Date.now()), 60_000))
  window.addEventListener('keydown', closeAddOnEsc)
  loadCatalog()
})

async function startTask(task: string, arg?: string) {
  const r = await fetch('/__run-script', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ task, arg }),
  }).then((x) => x.json())
  if (!r.ok) throw new Error(r.error || '启动失败')
  return r.startedAt as number
}

/** 轮到这次任务结束为止，把它的收尾输出交回去（授权要看 logged）。
 *  问的时候带上自己那一笔的 startedAt：服务端内存只留最近一笔，跑完还早了一步的读数就得从「最近跑完」里取，
 *  不然报错会被下一笔顶掉，界面只能说「脚本没回话」（2026-10-23 实测）。 */
function waitTask(task: string, startedAt: number) {
  return new Promise<RunJob>((done) => {
    let seen = false
    const t0 = Date.now()
    const timer = setInterval(async () => {
      try {
        const { job } = await (await fetch(`/__run-script?startedAt=${startedAt}`)).json()
        if (job && job.task === task && job.startedAt === startedAt) {
          seen = true
          if (!job.running) { clearInterval(timer); done(job) }
          return
        }
        // 见过它又查无此人 = 本地服务中途重启；到点还没见过 = 重启发生在第一次轮询之前。
        // 两种都按「没登录」收尾，别把按钮卡死
        if (seen || Date.now() - t0 > 8 * 60_000) { clearInterval(timer); done({ tail: '' }) }
      } catch { /* 本地服务在重建，下一轮再问 */ }
    }, 2000)
    timers.push(timer)
  })
}

/* ==================== 授权：点一下弹出浏览器，界面只摆一张实时登录屏，扫码即自己收工 ==================== */
const detail = ref<Account | null>(null)
/** 正在走授权的账号（行内那颗动作键读它） */
const busy = ref('')
/** 弹层与「授权还在跑」那句 toast 只报名字，不报内部键；授权新号那一趟还没有名字，报平台 */
const busyNick = computed(() => bind.value?.nick || accountLabel(busy.value))

type BindState = {
  platform: string
  nick: string
  /** scan = 等人扫码；check = 码扫过了，正在把登录态收进本机 */
  phase: 'scan' | 'check'
  /** 这一屏是「头像 + 微信快捷登录」：界面上给一颗按钮替人点那一下 */
  quick: boolean
  /** 这一趟的目标，失败时「再试一次」照原样重跑 */
  a: Account
  run?: { task: string; arg: string }
  err: string
}
const bind = ref<BindState | null>(null)

/** 弹层里直接摆登录屏：open-login 每轮把码搬到 /tmp，这里 3 秒换一次带时间戳的 src 跟着刷新（页面自己会过期换码） */
const qrSrc = ref('')
const qrReady = ref(false)
let qrTimer: ReturnType<typeof setInterval> | undefined
function startQr() {
  qrSrc.value = ''
  qrReady.value = false
  const poll = () => { qrSrc.value = `/__login-qr?t=${Date.now()}` }
  poll()
  qrTimer = setInterval(poll, 3000)
}
function stopQr() {
  if (qrTimer) clearInterval(qrTimer)
  qrTimer = undefined
  qrSrc.value = ''
  qrReady.value = false
}

async function loginSignal(action: 'raise' | 'cancel' | 'quick' | 'swap') {
  // 点了「改用其他微信扫码」：这一屏之后摆的是二维码，快捷登录那颗按钮就该收起来
  if (action === 'swap' && bind.value) bind.value.quick = false
  try {
    await fetch('/__login-signal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action }),
    })
  } catch (e) {
    toast(`浏览器没收到：${(e as Error).message}`)
  }
}

/** 脚本最后一行是 JSON，reason 那句给人看的报错直接抠出来（措辞只住在校本里，界面不翻第二套） */
const reasonOf = (tail: string) => (tail.match(/"reason":"([^"]*)"/) || [])[1] || ''
/** 脚本没能走到底时那句人话（开不出浏览器、循环里断了、空间被人接管） */
const errorOf = (tail: string) => (tail.match(/"error":"([^"]*)"/) || [])[1] || ''

/** 已登录的号：只把这个号的后台打开给他看，几秒完事，不进等扫码那一趟。
 *  脚本认出这个号其实停在登录页（本机那份登录态掉了）就自动改走授权，不让他再点一次。 */
async function openOnly(a: Account) {
  detail.value = null
  busy.value = a.id
  try {
    const at = await startTask('open-backend', a.key)
    const job = (await waitTask('open-backend', at)) || {}
    const tail = job.tail || ''
    if (/"outcome":"need-scan"/.test(tail)) { await bindLogin(a); return }
    // 换进去的那套登录态其实是同平台另一个号的：照实报一句，顺手让回认把这一行改判
    if (/"outcome":"(wrong-account|identity-unknown)"/.test(tail)) { await checkOne(a, reasonOf(tail)); return }
    if (!/"ok":true/.test(tail)) {
      failWith(job.action || `${a.platform}：后台没打开 · ${tail.split('\n').filter(Boolean).pop() || '脚本没回话'}`)
    }
  } catch (e) {
    failWith(`后台没打开：${(e as Error).message}`)
  } finally {
    busy.value = ''
  }
}

async function openBackend(a: Account) {
  if (busy.value) { toast(`${busyNick.value} 的授权还在跑，先等它结束`); return }
  if (stateOf(a) === 'ok') { await openOnly(a); return }
  await bindLogin(a)
}

/** 没登录的号：开登录页、界面摆那一屏、等人扫完。
 *  run 传 `{task:'login-new', arg:平台名}` 时是「授权账号」那一趟：登记表上还没有这一行，
 *  扫进去的号由平台后台报名字，脚本自己登记完把 id 回给我们（a 只是给弹层和报错用的草稿）。 */
async function bindLogin(a: Account, run?: { task: string; arg: string }) {
  const me = run ? `new:${run.arg}` : a.id
  if (busy.value && busy.value !== me) { toast(`${busyNick.value} 的授权还在跑，先等它结束`); return }
  detail.value = null
  busy.value = me
  startQr()
  bind.value = { platform: a.platform, nick: run ? a.platform : accountLabel(a.id), phase: 'scan', quick: !!a.quickLogin, a, run, err: '' }
  // 扫码这一趟要等两三分钟，期间服务端每次重建数据都会广播整页刷：刷一次就把这张弹层冲掉，
  // 人正扫到一半的码也没了（2026-10-23 装机版实测：点完「去授权」约 5 秒弹层自己消失，任务还在跑）。
  // 挂起自动刷新，收尾再放开——新登录态由 checkOne / waitForAccount 就地换回界面，不靠整页刷。
  setHoldAutoRefresh(true)
  const task = run?.task || 'login'
  try {
    const at = await startTask(task, run?.arg || a.key)
    const job = (await waitTask(task, at)) || {}
    const tail = job.tail || ''
    if (/"logged":true/.test(tail)) {
      if (bind.value) bind.value.phase = 'check'
      // 扫码确认后的登录重定向还在浏览器里跑，给它几秒把 cookie 落定，回认别抢跑（2026-10-01 实测抢跑判失败）
      await new Promise((r) => setTimeout(r, 5000))
      const boundId = (tail.match(/"bound":\{"id":"([^"]+)"/) || [])[1] || ''
      const who = boundId ? await waitForAccount(boundId) : (run ? null : a)
      if (who) await checkOne(who)
      else failBind(`${a.platform}：账号信息未更新`)
      // 那颗对勾要让人看见，收尾多留一会儿
      await new Promise((r) => setTimeout(r, 900))
    } else if (!/"ok":true/.test(tail)) {
      // 脚本自己报的那句人话优先（ok:false 也带 error），其次服务端认得出的那一步，最后才是尾巴行
      failBind(errorOf(tail) || job.action || `${a.platform}：后台没打开 · ${tail.split('\n').filter(Boolean).pop() || '脚本没回话'}`)
    } else if (/"outcome":"closed"/.test(tail)) {
      failBind(`${a.platform}：登录页被关掉了`)
    } else if (/"outcome":"cancelled"/.test(tail)) {
      // 人自己在浏览器里撤的：弹层早关了，那句「取消了」没什么可报
    } else if (/"outcome":"blocked-by-dialog"/.test(tail)) {
      // 平台在登录页上反复弹提示框（小红书风控那句「浏览器异常…」）：脚本插不进去，得人去看那一屏
      failBind(reasonOf(tail) || `${a.platform}：请在登录窗口完成验证`)
    } else if (/"outcome":"crashed"/.test(tail)) {
      failBind(errorOf(tail) || `${a.platform}：这一趟中途断了 · 已经退回原来的样子，再点一次就行`)
    } else if (/"outcome":"(wrong-account|identity-unknown|already-authorized|register-failed)"/.test(tail)) {
      // 扫是扫进去了，可后台报的是别人家的号（或读不出是谁、这号早就在册）：那套 cookie 没进库。
      // 已有的一行让回认顺手改判；「授权账号」那一趟还没有行，没什么可改判，把脚本那句话报完就走。
      const why = reasonOf(tail) || `${a.platform}：这次扫码没存进这台机器`
      if (run) failBind(why)
      else { await checkOne(a, why); failBind(why) }
    } else {
      failBind(`${a.platform}：没等到登录 · 页面还开着，登好后再点一次`)
    }
  } catch (e) {
    // 服务端那句「已有同步在跑：发布回认」是人话，直接摆出来；只有真起不来才说「没弹出来」
    const why = (e as Error).message || ''
    failBind(/在跑|正在跑/.test(why) ? `${why} · 等它跑完再点` : `没弹出来：${why}`)
  } finally {
    stopQr()
    busy.value = ''
    // 那句原因还摆在弹层上时先不放开：收尾会重建数据并广播，刷一下就把「授权没成」这种话冲没了
    // （2026-10-23 实测：点完取消 2 秒整页重刷，人只看见页面回到列表）
    if (!bind.value?.err) {
      bind.value = null
      setHoldAutoRefresh(false)
    }
  }
}

/** 授权这一趟没走成：原因留在弹层里，人点头关闭才收（toast 一闪而过，人正盯着那一屏）；
 *  弹层已经被自己关掉了就改报 toast，别让那句话没人看见 */
function failBind(msg: string) {
  if (bind.value) bind.value.err = msg
  else toast(msg)
}

function closeBind() {
  bind.value = null
  setHoldAutoRefresh(false)
}

/** 弹层右上角那颗 X：还在等扫码就是取消这一趟（顺手把界面收了，不等脚本回话），
 *  已经走到确认或报错就只是关掉。 */
async function closeOrCancel() {
  const b = bind.value
  if (b && !b.err && b.phase === 'scan') await loginSignal('cancel')
  closeBind()
}

function retryBind() {
  const b = bind.value
  if (!b) return
  closeBind()
  bindLogin(b.a, b.run)
}

/** 报一句就走 */
function failWith(msg: string) {
  toast(msg)
}

/** 确认登录态：让 publish-check 只查这一个平台，读得到后台列表才算登上。
 *  why 是脚本已经给出的那句报错（如「登录态其实是别人的」）——比状态名有用，优先摆它。 */
async function checkOne(a: Account, why?: string) {
  holdSelfWrite()
  try {
    const at = await startTask('publish-check', a.key)
    await waitTask('publish-check', at)
    holdSelfWrite()
    toast(why || `${a.platform}：${LOGIN_TEXT[stateOf(a)]}`)
  } catch (e) {
    toast(`这一趟没检测成：${(e as Error).message}`)
  }
}

/* ==================== 授权账号：一颗加号 → 选平台 → 直接扫码 ====================
 * 平台级的固定信息（后台地址、推草稿脚本、形态说明）住在 config/platforms.json，
 * 账号身份（id / key）由服务端现推：同平台的第二个号各有各的登录态（本机按号存 cookie，干活时换进浏览器），
 * 不这样后扫码的那个会把前一个顶下线。
 * 后台读得出账号名的平台（抖音/小红书）不问昵称——扫进去是谁就是谁，脚本当场登记那一行；
 * 读不出的平台（公众号/快手/视频号）在选完那一格下面补一行名字，回车就走。 */
type PlatformTpl = { platform: string; quickLogin: string; hasScript: boolean; accounts: number; identity: boolean }
const catalog = ref<PlatformTpl[]>([])
const showAdd = ref(false)
/** 选中的这个平台的后台读不出账号名时，才把名字那一格露出来 */
const addPick = ref<PlatformTpl | null>(null)
const addNick = ref('')
const nickInput = ref<HTMLInputElement | null>(null)

/* ==================== 左栏过滤：一个平台一行 ====================
 * 平台模板表里有的平台一律列出（还没号的那个点进去是空态，授权入口在那儿）；
 * 拿不到模板的那一份（远程托管）退化成只列已登记过号的平台。 */
const plat = ref('')
const railItems = computed(() => {
  const names = catalog.value.map((p) => p.platform)
  for (const a of accounts) if (!names.includes(a.platform)) names.push(a.platform)
  return names.map((platform) => ({ platform, total: accounts.filter((a) => a.platform === platform).length }))
})
/** 右栏：要处理的号排最前，同紧迫度按登记表顺序（sort 稳定，复检中途不跳位） */
const shown = computed(() => {
  const list = plat.value ? accounts.filter((a) => a.platform === plat.value) : [...accounts]
  return list.sort((x, y) => URGENCY[stateOf(x)] - URGENCY[stateOf(y)])
})

async function loadCatalog() {
  try {
    const o = await (await fetch('/__accounts')).json()
    if (o?.ok) catalog.value = o.platforms as PlatformTpl[]
  } catch { /* 静态托管没有本地服务：入口点了拿不到模板，不给它开 */ }
}

function openAdd() {
  if (!catalog.value.length) { toast('平台模板没读到，先刷新页面'); return }
  addPick.value = null
  addNick.value = ''
  showAdd.value = true
}

async function pickPlatform(p: PlatformTpl) {
  if (p.identity) {
    showAdd.value = false
    // 先扫码后登记：这一行还不存在，脚本扫成了才把它长出来（名字出自平台后台）
    await bindLogin({ id: '', platform: p.platform, key: '', nickname: '', quickLogin: p.quickLogin }, { task: 'login-new', arg: p.platform })
    return
  }
  addPick.value = p
  await nextTick()
  nickInput.value?.focus()
}

function closeAddOnEsc(e: KeyboardEvent) {
  if (e.key === 'Escape') showAdd.value = false
}

/** 等这一行长进 accounts：落盘 → gen:data 重建 → resync 换列表，中间有一小段窗口 */
function waitForAccount(id: string) {
  return new Promise<Account | null>((done) => {
    const t0 = Date.now()
    const timer = setInterval(() => {
      const hit = accounts.find((a) => a.id === id)
      if (hit) { clearInterval(timer); done(hit) }
      else if (Date.now() - t0 > 30_000) { clearInterval(timer); done(null) }
    }, 500)
    timers.push(timer)
  })
}

async function confirmAdd() {
  const tpl = addPick.value
  const nickname = addNick.value.trim()
  if (!tpl || !nickname) return
  showAdd.value = false
  try {
    const r = await (await fetch('/__accounts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'add', platform: tpl.platform, nickname }),
    })).json()
    if (!r.ok) throw new Error(r.error || '账号没加上')
    holdSelfWrite()
    const added = await waitForAccount(r.account.id)
    if (!added) { toast('登记好了，但界面没等到这一行，刷新一下'); return }
    openBackend(added)
  } catch (e) {
    toast(`加不了：${(e as Error).message}`)
  }
}

/* ==================== 进页面先补一次过期体检 / 只重采点名的几个 ====================
 * 登录态是 publish-check 上次跑成功时留下的读数：号在半路退出了登录，页面不会自己知道，
 * 于是会出现「15:22 测的已登录」挂在你已经掉线的号上。
 * 重采走 --only（传 key 列表）：整轮七个号要好几分钟，而页面上要动手的常常就一两个。
 * 本地服务正忙会被拒，那就安静放弃——状态点悬浮那句「几小时前」已经把读数多旧说清楚了。 */
async function runCheck(list: Account[]) {
  const runnable = list.filter((a) => !!a.key)
  if (!runnable.length || rechecking.value || busy.value) return
  recheckingKeys.value = runnable.map((a) => a.key)
  holdSelfWrite()
  try {
    const at = await startTask('publish-check', recheckingKeys.value.join(','))
    await waitTask('publish-check', at)
    holdSelfWrite()
    const left = accounts.filter((a) => stateOf(a) !== 'ok').length
    toast(left ? `重采完了：还有 ${left} 个号要处理` : '重采完了：全部已登录')
  } catch (e) {
    toast(`重采没跑成：${(e as Error).message}`)
  } finally {
    recheckingKeys.value = []
  }
}

/** 重采中那颗按钮点下去就是停：整轮七个号要好几分钟，人想收手得有个出口。
 *  停了不重开支票——读数还停在上一轮，悬浮那句「几小时前」会继续说清楚它是旧的。 */
async function stopCheck() {
  const r = await stopRunningJob('sync', 'publish-check')
  if (!r.ok) toast(r.error || '停止请求没送到本地服务', 'fail')
}

onMounted(async () => {
  const stale = accounts.filter((a) => isStale(a))
  if (stale.length) await runCheck(stale)
})
</script>

<template>
  <div class="flex flex-col gap-4">
    <PageHeader title="授权">
      <template #actions>
        <button
          v-if="accounts.length && !isRemote"
          class="btn-ghost shrink-0 !px-2"
          :disabled="!!busy"
          :aria-label="rechecking ? '停止检测' : '重新检测'"
          :title="rechecking ? '停止检测' : '重新检测'"
          @click="rechecking ? stopCheck() : runCheck(needItems.length ? needItems : accounts)"
        >
          <IconSquare v-if="rechecking" :size="15" />
          <IconRefreshCw v-else :size="15" />
        </button>
        <!-- 远程那份没有本机浏览器：码搬不过来，也不该让人空等一张转圈的二维码 -->
        <button
          v-if="!isRemote"
          class="btn-ghost shrink-0 !px-2"
          aria-label="授权账号"
          title="授权账号"
          @click="openAdd()"
        >
          <IconPlus :size="15" />
        </button>
        <ClientOnly v-else what="扫码授权" />
      </template>
    </PageHeader>

    <div class="flex flex-col items-start gap-4 md:flex-row md:gap-8">
      <!-- 左栏（即创菜单列的语言）：一个平台一行，行高 40、圆角 10、图标 18，
           选中只换底色和字重，不画线；靠 sticky 钉在页头下沿，右栏从它底下滚过去。
           窄屏上这一列横过来当筛选条，右栏仍是一列。 -->
      <nav class="-mx-2 flex w-[calc(100%+1rem)] shrink-0 gap-1 overflow-x-auto px-2 pb-1 md:mx-0 md:sticky md:top-[var(--page-header-h,0px)] md:w-[216px] md:max-w-none md:flex-col md:overflow-visible md:px-0 md:pb-0">
        <button
          class="flex h-10 shrink-0 w-auto items-center gap-2.5 rounded-[10px] px-3 text-left text-sm transition-colors duration-150 md:w-full"
          :class="!plat ? 'is-selected' : 'text-ink-2 hover:bg-surface-2 hover:text-ink'"
          @click="plat = ''"
        >
          <IconLayoutGrid :size="18" class="shrink-0" />
          <span class="truncate">全部</span>
          <span class="ml-1 shrink-0 text-[13px] tabular-nums text-ink-3 md:ml-auto">{{ accounts.length }}</span>
        </button>

        <div class="hidden h-3 shrink-0 md:block" />
        <button
          v-for="r in railItems"
          :key="r.platform"
          class="flex h-10 shrink-0 w-auto items-center gap-2.5 rounded-[10px] px-3 text-left text-sm transition-colors duration-150 md:w-full"
          :class="plat === r.platform ? 'is-selected' : 'text-ink-2 hover:bg-surface-2 hover:text-ink'"
          @click="plat = r.platform"
        >
          <PlatformLogo :platform="r.platform" :size="18" />
          <span class="truncate">{{ r.platform }}</span>
          <span class="ml-1 shrink-0 text-[13px] tabular-nums text-ink-3 md:ml-auto">{{ r.total }}</span>
        </button>
      </nav>

      <div class="min-w-0 flex-1">
        <div v-if="!shown.length" class="flex flex-col items-center gap-3 py-20">
          <p class="text-sm text-ink-2">{{ plat ? `${plat}还没有号` : '还没有授权账号' }}</p>
          <button v-if="!isRemote" class="btn-ghost !px-2" aria-label="授权账号" title="授权账号" @click="openAdd()">
            <IconPlus :size="15" />
          </button>
          <ClientOnly v-else what="扫码授权" />
        </div>

        <!-- 右栏：一行一号，要处理的排最前。
             正常号不报平安（绿点已经说完这件事了），不正常才多一句红字 -->
        <div v-else class="grid grid-cols-1 gap-2 xl:grid-cols-2">
          <article
            v-for="a in shown"
            :key="a.id"
            class="flex cursor-pointer items-center gap-3 rounded-xl border border-line bg-surface px-3.5 py-3 transition-colors duration-200 hover:border-line-strong"
            @click="detail = a"
          >
            <AccountAvatar :src="avatarOf(a)" :platform="a.platform" :size="36" />

            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-2">
                <span class="truncate text-sm leading-5 text-ink">{{ a.nickname || '未登记昵称' }}</span>
                <IconLoaderCircle v-if="inCheck(a)" :size="13" class="shrink-0 animate-spin text-ink-3" :title="statusTip(a)" />
                <span
                  v-else-if="stateOf(a) !== 'ok'"
                  class="h-1.5 w-1.5 shrink-0 rounded-full"
                  :class="LOGIN_CLS[stateOf(a)]"
                  :title="statusTip(a)"
                />
                <span v-else class="h-1.5 w-1.5 shrink-0 rounded-full status-published" :title="statusTip(a)" />
              </div>
              <p v-if="whyOf(a)" class="mt-0.5 truncate text-aux text-red-600">{{ whyOf(a) }}</p>
            </div>

            <!-- 远程那份：登录态不在这台机器上，扫码只能回客户端做；后台是公网地址，链过去照常能看 -->
            <a
              v-if="isRemote && stateOf(a) === 'ok' && a.backend"
              class="btn-ghost shrink-0 !px-2"
              :href="a.backend"
              target="_blank"
              rel="noopener"
              aria-label="打开后台"
              title="打开后台"
              @click.stop
            >
              <IconExternalLink :size="15" />
            </a>
            <ClientOnly v-else-if="isRemote" what="扫码授权" />
            <button
              v-else
              class="btn-ghost shrink-0 !px-2"
              :disabled="!!busy && busy !== a.id"
              :aria-label="stateOf(a) === 'ok' ? '打开后台' : '去授权'"
              :title="stateOf(a) === 'ok' ? '打开后台' : '去授权'"
              @click.stop="openBackend(a)"
            >
              <IconLoaderCircle v-if="busy === a.id" :size="15" class="animate-spin" />
              <IconExternalLink v-else-if="stateOf(a) === 'ok'" :size="15" />
              <IconQrCode v-else :size="15" />
            </button>
          </article>
        </div>
      </div>
    </div>

    <!-- 授权进行中：这一屏只有实时登录页 + 一颗动作键，别的字都不摆 -->
    <div v-if="bind" v-dialog="`正在绑定 ${bind.nick}`" class="modal modal--center">
      <div class="bind-shell card w-[336px] p-4">
        <div class="flex items-center gap-2.5">
          <span class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-surface-2">
            <PlatformLogo :platform="bind.platform" :size="18" />
          </span>
          <div class="min-w-0 flex-1 truncate text-sm text-ink-2">{{ bind.nick }}</div>
          <button
            class="btn-ghost shrink-0 !px-1.5"
            :aria-label="bind.err || bind.phase === 'check' ? '关闭' : '取消'"
            :title="bind.err || bind.phase === 'check' ? '关闭' : '取消'"
            @click="closeOrCancel"
          >
            <IconX :size="15" />
          </button>
        </div>

        <!-- 没走成：那句原因留在弹层里，等人点头才收（toast 一闪而过，人正盯着那一屏） -->
        <template v-if="bind.err">
          <p class="mt-4 text-sm leading-6 text-red-600">{{ bind.err }}</p>
          <button class="btn btn-primary mt-4 w-full !py-1.5 text-sm" @click="retryBind">再试一次</button>
        </template>

        <div v-else-if="bind.phase === 'check'" class="mt-4">
          <div class="bind-stage">
            <span class="done-tile"><IconCheck :size="26" /></span>
          </div>
          <div class="mt-3 flex items-center justify-center gap-1.5 text-aux text-ink-3">
            <IconLoaderCircle :size="13" class="shrink-0 animate-spin" />
            正在确认
          </div>
        </div>

        <template v-else>
          <div class="bind-stage mt-4">
            <!-- 先挂载后点亮：load 成功才露图，404 继续铺微光等下一次轮询 -->
            <img v-show="qrReady" :src="qrSrc" :alt="bind.platform" class="relative z-10">
            <div v-if="!qrReady" class="bind-skeleton" />
            <IconLoaderCircle v-if="!qrReady" :size="20" class="relative z-10 animate-spin text-ink-3" />
          </div>

          <div v-if="qrReady" class="mt-3 flex items-center justify-center gap-1.5 text-aux text-ink-3">
            <IconLoaderCircle :size="13" class="shrink-0 animate-spin" />
            等待扫码
          </div>
          <p v-else class="mt-3 text-center text-aux text-ink-3">正在打开登录页</p>

          <div class="mt-3 flex items-center gap-2">
            <button v-if="bind.quick" class="btn btn-primary !py-1.5 text-sm" @click="loginSignal('quick')">
              <PlatformLogo platform="微信" :size="15" />
              微信快捷登录
            </button>
            <button v-else class="btn btn-primary !py-1.5 text-sm" @click="loginSignal('raise')">
              <IconExternalLink :size="15" />
              打开浏览器
            </button>
            <button
              v-if="bind.quick"
              class="btn-ghost !px-2"
              aria-label="改用其他微信扫码"
              title="改用其他微信扫码"
              @click="loginSignal('swap')"
            >
              <IconQrCode :size="15" />
            </button>
          </div>
        </template>
      </div>
    </div>

    <!-- 账号详情：一屏只有「哪个号 + 一个动作」，状态收在那颗点上 -->
    <div v-if="detail" v-dialog="detail.nickname || detail.platform" class="modal modal--center" @click.self="detail = null">
      <div class="bind-shell card w-[336px] p-4">
        <div class="flex items-center gap-2.5">
          <AccountAvatar :src="avatarOf(detail)" :platform="detail.platform" :size="40" />
          <div class="min-w-0 flex-1">
            <div class="truncate text-sm text-ink">{{ detail.nickname || detail.platform }}</div>
            <div class="mt-1 flex items-center gap-1.5 text-aux text-ink-3">
              <span class="h-1.5 w-1.5 shrink-0 rounded-full" :class="LOGIN_CLS[stateOf(detail)]" :title="statusTip(detail)" />
              <span v-if="publishedOf(detail)" class="tabular-nums">已发布 {{ publishedOf(detail) }} 条</span>
              <span v-else>{{ detail.platform }}</span>
            </div>
          </div>
          <button class="btn-ghost shrink-0 !px-1.5" aria-label="关闭" title="关闭" @click="detail = null">
            <IconX :size="15" />
          </button>
        </div>

        <button
          v-if="!isRemote"
          class="btn btn-primary mt-4 w-full !py-1.5 text-sm"
          :disabled="!!busy"
          @click="openBackend(detail)"
        >
          <IconLoaderCircle v-if="busy === detail.id" :size="15" class="animate-spin" />
          <IconQrCode v-else-if="stateOf(detail) !== 'ok'" :size="15" />
          <IconExternalLink v-else :size="15" />
          {{ stateOf(detail) === 'ok' ? '打开后台' : '去授权' }}
        </button>
        <ClientOnly v-else what="扫码授权" />
      </div>
    </div>

    <!-- 授权账号：一排平台 logo，点一下就开扫；后台报不出名字的平台才补一行昵称 -->
    <div v-if="showAdd" v-dialog="'授权账号'" class="modal modal--center" @click.self="showAdd = false">
      <div class="bind-shell card w-[300px] p-4">
        <div class="flex flex-wrap gap-2">
          <button
            v-for="p in catalog"
            :key="p.platform"
            type="button"
            class="flex h-11 w-11 items-center justify-center rounded-lg border border-line bg-surface transition-colors hover:border-line-strong"
            :class="addPick?.platform === p.platform && 'is-selected'"
            :aria-label="p.platform"
            :title="p.accounts ? `${p.platform} · 已有 ${p.accounts} 个号` : p.platform"
            @click="pickPlatform(p)"
          >
            <PlatformLogo :platform="p.platform" :size="22" />
          </button>
        </div>

        <form v-if="addPick" class="mt-3 flex items-center gap-2" @submit.prevent="confirmAdd">
          <input
            ref="nickInput"
            v-model="addNick"
            required
            maxlength="24"
            class="input min-w-0 flex-1"
            placeholder="这个号显示的名字"
          />
          <button type="submit" class="btn btn-primary shrink-0 !px-2.5" aria-label="下一步" title="下一步">
            <IconArrowRight :size="15" />
          </button>
        </form>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 弹层进/出：只给一层极短的位移和淡入，扫码那一屏不能跳 */
.bind-shell {
  animation: bind-in 0.2s cubic-bezier(0.2, 0.9, 0.25, 1) both;
}

@keyframes bind-in {
  from {
    opacity: 0;
    transform: translateY(6px) scale(0.985);
  }
  to {
    opacity: 1;
    transform: none;
  }
}

/* 实时登录屏那一格：正方形凹槽，图在里面等比缩放，不裁不变形 */
.bind-stage {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  aspect-ratio: 1;
  overflow: hidden;
  border: var(--app-border-w) solid var(--app-line);
  border-radius: var(--app-radius-md);
  background: var(--app-surface-2);
}

.bind-stage img {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
}

/* 还没搬进画面时铺一层微光，人看得出这一格在等东西，而不是一张空框 */
.bind-skeleton {
  position: absolute;
  inset: 0;
  background: linear-gradient(
    100deg,
    transparent 25%,
    color-mix(in oklab, var(--app-ink) 7%, transparent) 50%,
    transparent 75%
  );
  background-size: 220% 100%;
  animation: bind-sweep 1.5s ease-in-out infinite;
}

@keyframes bind-sweep {
  from {
    background-position: 120% 0;
  }
  to {
    background-position: -120% 0;
  }
}

/* 扫完码那一下：一颗对勾弹出来，随后自动收工 */
.done-tile {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 72px;
  height: 72px;
  border-radius: 9999px;
  color: var(--app-ink);
  background: var(--app-tone-published);
  animation: bind-pop 0.32s cubic-bezier(0.2, 0.9, 0.25, 1) both;
}

@keyframes bind-pop {
  from {
    opacity: 0;
    transform: scale(0.6);
  }
  to {
    opacity: 1;
    transform: scale(1);
  }
}
</style>
