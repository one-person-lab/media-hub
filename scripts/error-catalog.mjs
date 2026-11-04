#!/usr/bin/env node
/**
 * 失败归类：一条失败 → 你该做的下一步。
 *
 * 采集与推草稿的脚本本来就写成人话（「小红书未登录，请先在 Ego Lite 登录…」），
 * 这里不重写它们，只补一句「所以现在该点哪」——界面原样渲染 error + action 两个字段，
 * 分类与措辞只有这一份，别再在视图里各写一套。
 *
 * 规则从具体到宽泛：「等待风控解除超时」同时含风控与超时，必须先认风控。
 * 认不出来的照旧只回原文，不硬编一句猜测。
 *
 * `zh` 是界面上那句短的失败摘要。脚本崩在 ego 的堆栈里时，能抓到的往往只剩英文残句
 * （2026-10-24 公众号那条被压成「Finish task」），这种残句自证不了归类，改用 `zh`。
 */

/** 每类的判据（认原文子串）、界面短标签与该做的下一步；数组顺序即优先级 */
const RULES = [
  {
    code: 'login_device_limit',
    zh: '登录设备位满',
    when: /设备登录超限|登录设备.*(满|上限)/,
    next: '先去那个平台的登录设备列表里退出一个旧设备，再回来重新扫码',
  },
  {
    code: 'risk_verify',
    zh: '平台要验证',
    when: /风控|验证码|验证超时|安全验证|滑块|完成验证|关闭弹窗/,
    next: '到那个浏览器里手动把验证做完，再回来重推这一版；平台不会放过机器代填，重试第三次只会更伤号',
  },
  {
    // 比「还没收过登录态」「未登录」都具体：这套 cookie 是真实有效的，只是它根本不属于这一行
    code: 'wrong_account',
    zh: '登的是别人的号',
    when: /登录态其实是别人的|读到的是「/,
    next: '重新扫一次：在平台登录页先点「使用其他头像、昵称或账号」，再用这个号自己的 App 扫；扫完界面会核对后台读到的是不是这个号',
  },
  {
    code: 'account_unauthorized',
    zh: '还没扫码',
    when: /还没收过登录态|没收过这个号的登录态|还没扫过码/,
    next: '到「授权」页点这一行的「去授权」，扫一次码；登录态存到本机后，采集和推草稿才认这个号',
  },
  {
    code: 'login_expired',
    zh: '登录过期',
    when: /未登录|需要扫码|扫码登录|拿不到 token|不在登录页|登录已?失效|掉线/,
    next: '在工作台「授权」页重新扫码，登录回来再推',
  },
  {
    code: 'content_incomplete',
    zh: '内容没齐',
    when: /填写不完整|缺少配图|没有配图|图没传齐|内容没就绪|禁用态/,
    next: '回创作台把缺的图或文字补齐再推；脚本不会把半截内容塞进草稿箱',
  },
  {
    code: 'account_unregistered',
    zh: '号没登记',
    when: /未登记发布脚本|未在 config\/accounts\.json 登记|账号「.+」未/,
    next: '到「授权」页点「授权账号」把这个号登记上，再推',
  },
  {
    // 远程模式（服务器上对外那一份）挡下的执行类请求。重试一万次也不会通：这台机器上没有本机浏览器桥
    code: 'client_only',
    zh: '网页版做不了',
    when: /网页版做不了|桌面客户端|client-only/,
    next: '采集、推草稿、扫码授权都要用你自己电脑上那个已登录的浏览器，网页版这台机器上没有；装桌面客户端再做这一条',
  },
  {
    code: 'browser_missing',
    zh: '执行器没装',
    when: /ego-browser|ENOENT.*ego|command not found.*ego|启动器没装|执行器没装/,
    next: '装上浏览器执行器（Ego Lite 的命令行工具），装完重启工作台',
  },
  {
    code: 'browser_takeover',
    // Ego 接管原文（"Control of this task space is with the user, either through task.handOff() or a
    // takeover in the browser..."）：那一屏被人手接过去了，脚本的命令全 paused。重试没用，得先放手
    zh: '浏览器被接管',
    when: /Control of this task space|task\.handOff|takeover in the browser|handOff\(\)/i,
    next: '那个浏览器窗口在你手上，脚本动不了：回到浏览器结束接管（或关掉那一屏）再重推这一版；重试本身解不开',
  },
  {
    code: 'browser_busy',
    zh: '浏览器正忙',
    when: /正在推草稿|正在跑|一次只能|已有.*在跑|先等它|先等它完成|撞车/,
    next: '等手上那件跑完再点；采集、检测、推草稿共用同一个浏览器，同一时刻只能干一件',
  },
  {
    code: 'page_changed',
    zh: '页面改版了',
    when: /可能改版|找不到|没能切到|没进到|未出现|定位不到/,
    next: '这一版改你在平台后台手动建草稿；把这条报错留着，改脚本要按它对齐新的页面',
  },
  {
    code: 'too_slow',
    zh: '平台响应超时',
    when: /超时|没读到后台/,
    next: '重试一次；连着两次就是平台侧卡住了，先去平台后台看一眼实际到哪一步',
  },
  {
    code: 'data_read_failed',
    zh: '文件读不到',
    when: /generated\.json|gen:data|解析中断|数据.*读不到|R4 违规/,
    next: '照上面那句改好它点名的那份文件（改不动就把它移出内容库），存好后点重试',
  },
  {
    // 兜底，必须排最后：进程崩了这件事本身说明不了原因，「退出码」不是「平台慢」的证据
    // （2026-10-24 公众号被人手接管，原文带 exited with code 1，被旧 too_slow 认成「重试一次」）
    code: 'script_crashed',
    zh: '脚本崩了',
    when: /退出码|exited with code|脚本没跑起来|被掐|SIGKILL/,
    next: '这一版没跑成，但不是平台挡的：展开下面的日志尾巴看崩在哪，再单独重试这一版',
  },
]

const BY_CODE = new Map(RULES.map((r) => [r.code, r]))

/** 原文 → 类；认不出回 null */
export function classify(text) {
  const s = String(text || '')
  if (!s) return null
  return RULES.find((r) => r.when.test(s))?.code ?? null
}

/** 类 → 界面上那句短摘要；没有这一类回空串 */
export function labelOf(code) {
  return BY_CODE.get(code)?.zh ?? ''
}

/** 这一类失败说的是「这个号的登录证据」本身，值得写回 login-state 让下一次起串前的预检认得。
 *  风控、超时、页面改版只是这一次的事，写进去会把一次抖动记成号不行。 */
const LOGIN_EVIDENCE = new Set([
  'login_expired', 'account_unauthorized', 'wrong_account', 'login_device_limit', 'account_unregistered',
])

/** 类 → 该写进 login-state 的登录态（'out'）；不是号本身的问题回空串 */
export function loginEvidenceOf(code) {
  return LOGIN_EVIDENCE.has(code) ? 'out' : ''
}

/** 类 → 该做的下一步；没有这一类回空串，界面据此不渲染这一行 */
export function nextOf(code) {
  return BY_CODE.get(code)?.next ?? ''
}

/** 「脚本崩了」这件事本身说明不了原因，等于没认出来 */
const WEAK = (code) => !code || code === 'script_crashed'

/** ego 脚本崩在启动阶段（没有 JSON 输出）时，stdout 是「<消息>" at fn (file:…) at …」的堆栈。
 *  界面只要那句消息：旧写法 out.slice(-400) 会把堆栈尾巴截半句灌进横幅（2026-09-27 task space 被占即如此）。 */
function egoErrorText(out) {
  const cut = out.search(/\n?\s+at\s+(?:async\s+)?[\w#$][\w.$]*\s*[(/]/)
  const head = cut < 0 ? out : out.slice(0, cut)
  let line = (head.split('\n').map((l) => l.trim()).filter(Boolean).pop() || '').replace(/^Error:\s*/i, '')
  const quoted = line.match(/"([^"]{10,})"/)
  if (quoted) line = quoted[1]
  line = line.replace(/^["']|["']$/g, '')
  const code = (out.match(/exited with code (\d+)/) || [])[1]
  // 带一帧调用栈：TypeError 这种「一句话说不清在哪」的错，帧上那行（文件:行:列）才是关键；
  // 整段堆栈仍留在 /tmp/media-hub-push-raw.log，界面只带第一帧，够定位又不糊一屏。
  const frame = (out.slice(cut < 0 ? 0 : cut).match(/at\s+(?:async\s+)?([^\n]+)/) || [])[1]
  const tail = frame && /TypeError|ReferenceError|SyntaxError|RangeError/.test(line)
    ? ` · ${frame.replace(/^file:\/\//, '').trim().slice(0, 110)}`
    : ''
  const msg = ((line || '脚本没跑起来，请看服务端日志') + tail).slice(0, 300)
  return code && !/exited with code/.test(msg) ? `${msg}（ego 退出码 ${code}）` : msg
}

/** 崩因只在最后一段「Error: …」到第一帧堆栈之间。脚本自己的进度日志排在这段之前，
 *  拿整段 stdout 归类会把「风控遮罩已自动移除」这类正常日志当成风控失败。 */
function egoErrorBlock(out) {
  const at = Math.max(out.lastIndexOf('\nError:'), out.startsWith('Error:') ? 0 : -1)
  if (at < 0) return ''
  const rest = out.slice(at).replace(/^\s*Error:/, '')
  const cut = rest.search(/\n\s+at\s+(?:async\s+)?[\w#$][\w.$]*\s*[(/]/)
  return (cut < 0 ? rest : rest.slice(0, cut)).trim()
}

/** 一次 ego 崩溃 → { error, code }：error 是界面上那句，code 是这一类的归类。
 *  2026-10-24 公众号那条真因是「任务空间被人手接管」，但摘要被 egoErrorText 压成
 *  「Finish task（ego 退出码 1）」，归类只看这句就一路掉进兜底、给出「重试一次」的错误建议。
 *  所以摘要认不出类时改吃 Error 段原文，界面那句换成这一类的中文名。 */
export function egoCrash(out) {
  const s = String(out || '')
  const summary = egoErrorText(s)
  const fromSummary = classify(summary)
  const code = WEAK(fromSummary) ? (classify(egoErrorBlock(s)) || fromSummary) : fromSummary
  const exit = (s.match(/exited with code (\d+)/) || [])[1]
  const error = code && fromSummary !== code
    ? `${labelOf(code)}${exit ? `（ego 退出码 ${exit}）` : ''}`
    : summary
  return { error, code: code || '' }
}

/**
 * 给一个失败响应补上 code 与 action。
 * 成功体原样通过；已有的 code 不覆盖（脚本自己报的类最准），error 一律留原文。
 */
export function humanize(obj) {
  if (obj?.ok) return obj
  const code = obj.code || classify(obj.error)
  const action = code ? nextOf(code) : ''
  return action ? { ...obj, code, action } : { ...obj, code }
}

/** 从 ego 脚本的混合输出里取**最后一个**完整 JSON 对象——发布脚本先打日志、最后 console.log(JSON.stringify(obj, null, 2))。
 *  旧写法 /\{[\s\S]*\}/ 贪婪匹配会把中途日志里的碎 JSON 一并裹进来，2026-09-25 视频号成功被解析成假失败。
 *  一行式 JSON 也要认：视频号脚本的失败体就是一行 {"ok":false,"error":"…"}，
 *  旧写法只认独立成行的「{」「}」，这种一行体被整个跳过，那句「未登录」从没到过界面（2026-10-24 实测）。 */
function parseLastJson(text) {
  const lines = String(text || '').split('\n')
  for (let end = lines.length - 1; end >= 0; end--) {
    const t = lines[end].trim()
    if (t.startsWith('{') && t.endsWith('}')) {
      try { return JSON.parse(t) } catch { /* 不是完整对象，继续往上找 */ }
    }
    if (t !== '}') continue
    for (let start = end - 1; start >= 0; start--) {
      if (lines[start].trim() !== '{') continue
      try { return JSON.parse(lines.slice(start, end + 1).join('\n')) } catch { /* 不是配对的花括号，继续往上找 */ }
    }
  }
  return null
}

/** 一次 ego 推草稿的输出 → 脚本自报的结果；没 JSON 时按崩溃原文归类。
 *  界面上那句与这一类的归类（code）都由这里定，队列与单版端点拿的是同一份成品。 */
export function egoResult(out) {
  const s = String(out || '')
  return parseLastJson(s) ?? { ok: false, ...egoCrash(s) }
}

/** 兜底：抛出来的异常直接变成人话响应体 */
export function humanError(err, extra = {}) {
  return humanize({ ok: false, error: String(err?.message || err || '失败'), ...extra })
}
