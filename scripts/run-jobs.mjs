/** 跑着的活儿统一登记处。
 *
 *  立这条规矩的原话：所有跑脚本都要支持可以手动止。
 *  界面上凡是有「正在跑」那一格的地方，都必须有一条能按停的路——所以要停的活儿一律登记在这里，
 *  一个 GET 列全、一个 POST 按停，新增一类活儿只要登记时就交一条 stop 出来，界面自动有得点。
 *
 *  id 是活儿种类，不是任务名：采集那一类（爆款/收藏/对标/授权/装组件…）再多也只占 sync 一格，
 *  具体在跑哪个任务由 label 说给人听，停止动作按种类路由到各自的收尾方式。 */

const jobs = new Map()

/** 界面按停之后，各处对人说的那一句 */
export const STOPPED_TEXT = '人在界面上按了停止'
/** 被 AbortSignal 掐断的中断：人按的抛 AbortError，看门狗超时抛 TimeoutError，两句话不能混 */
export const isUserStop = (e) => e?.name === 'AbortError' || e?.code === 'ABORT_ERR'

/** 开跑时登记、跑完必须松手。返回的 release 是幂等的：重复调用不会误删下一轮那一格。
 *  key 是这一格里「具体哪条任务」（采集种类下是 viral / favorites…）：界面按停要把它递回服务端核对。 */
export function holdJob(id, { label, key = '', startedAt = Date.now(), limitMs = 0, stop }) {
  const entry = { id, key, label, startedAt, limitMs, stop }
  jobs.set(id, entry)
  return () => {
    if (jobs.get(id) === entry) jobs.delete(id)
  }
}

/** 现在在跑什么：给界面列表用，不带 stop 函数（那是服务端内部的）。
 *  stopping = 这一格已被按过停止但还没退干净（采集等当前平台、推草稿等当前版）；界面据此说「已按停」，不假装立刻停了。 */
export function runningJobs(now = Date.now()) {
  return [...jobs.values()].map((j) => ({
    id: j.id, key: j.key, label: j.label, startedAt: j.startedAt, limitMs: j.limitMs,
    elapsed: Math.max(0, now - j.startedAt), stopping: !!j.reason,
  }))
}

/** 按停：只认登记在册的活儿。没人在跑就直说，不假装停成功了。
 *  停法由这条活儿登记时交出来的 stop 决定（采集写信号文件、推草稿打旗、Agent 收 SIGTERM）；
 *  落停的原因同时记在这一格上，随格子一起消失——正在温和退场的那一路要照这句人话收尾。 */
export function stopJob(id, reason = STOPPED_TEXT) {
  const job = jobs.get(id)
  if (!job) return { ok: false, error: '现在没有在跑的活儿' }
  try {
    job.stop(reason)
  } catch (e) {
    return { ok: false, error: e?.message || String(e) }
  }
  job.reason = reason
  return { ok: true, id: job.id, label: job.label }
}

export const __test = { clear: () => jobs.clear() }
