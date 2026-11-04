import test from 'node:test'
import assert from 'node:assert/strict'
import { classify, nextOf, labelOf, loginEvidenceOf, humanize, humanError, egoCrash, egoResult } from './error-catalog.mjs'

/** 2026-10-24 公众号推草稿的真实崩溃（/tmp/media-hub-push-raw.log）：
 *  ego 把接管说明整段打出来，堆栈前最后一行是「Offer the user choices like "Continue" or "Finish task"…」 */
const TAKEOVER_CRASH = [
  "Error: Control of this task space is with the user, either through task.handOff() or a takeover in the browser, so browser commands are paused.",
  'This is a hard stop, not an obstacle to route around — do not retry and do not take control back on your own.',
  'Wait until the user explicitly asks you to continue, then take control back and resume:',
  '  const task = await takeOverTaskSpace(spaceId)',
  '',
  'Offer the user choices like "Continue" or "Finish task" if your harness supports it; otherwise tell them: "You now control this task space. Reply \'continue\' when ready and I will resume."',
  '    at buildEgoError (file:///Users/ethan/workspace/code/one-person-hub/media-hub/[eval1]:449:19)',
  '    at stopForUserControl (file:///Users/ethan/workspace/code/one-person-hub/media-hub/[eval1]:8940:28)',
  '',
  "ego's nodejs process exited with code 1.",
].join('\n')

/** 用例全部取自脚本里真实出现的措辞（publish-*.mjs、server-core.mjs），不自己编句子 */
const CASES = [
  // 登录一类：设备超限要在「未登录」之前认，否则会被泛化成去扫码
  ['设备登录超限，请腾出登录位', 'login_device_limit'],
  ['小红书未登录，请先在 Ego Lite 登录 creator.xiaohongshu.com', 'login_expired'],
  ['公众号未登录或拿不到 token：请在 Ego Lite 里扫码登录 mp.weixin.qq.com', 'login_expired'],
  // 体检报「已失效」只在页面真被弹回登录页时（publish-check 2026-11-04 改的口）
  ['未登录：后台摆着扫码墙（请使用微信扫码）', 'login_expired'],
  ['未登录：视频号助手把人弹回了登录页（https://channels.weixin.qq.com/login.html）', 'login_expired'],
  // 同一轮里接口没出现只是「这一次没测出来」，文案带着「登录」两个字也不能归到登录过期
  ['笔记列表接口未出现（这一次没测出来，不代表登录掉了）', 'page_changed'],
  // 「等待风控解除超时」同时含风控与超时，必须认风控
  ['等待风控解除超时。发布页已在 Ego Lite 打开，请手动关闭弹窗/完成验证', 'risk_verify'],
  ['等待验证超时。页面已在 Ego Lite 打开，请人工完成后重试。', 'risk_verify'],
  // 内容不齐 vs 页面改版：两类下一步完全不同
  ['填写不完整（标题/正文/图缺一项），不保存草稿', 'content_incomplete'],
  ['这篇没有配图（coverImage / 卡片数据），小红书图文必须有图', 'content_incomplete'],
  ['「保存草稿」仍是禁用态（平台认为内容没就绪，多半是图还在上）', 'content_incomplete'],
  ['找不到「保存草稿」按钮，页面可能改版；表单已填好，交人工点', 'page_changed'],
  ['没能切到「上传图文」tab，页面可能改版', 'page_changed'],
  // 互斥与执行器
  ['「抖音」正在推草稿，一次只能推一个（共用浏览器和参数文件）', 'browser_busy'],
  ['collect 正在跑（共用浏览器登录态），等它结束再推草稿', 'browser_busy'],
  ['spawn ego-browser ENOENT', 'browser_missing'],
  // Ego 的接管原文（2026-10-23 视频号实测）：浏览器被人手接管的报错是纯英文且很长，
  // 不归一类界面就只能把这一整段摆上授权页
  ['Control of this task space is with the user, either through task.handOff() or a takeover in the browser, so browser commands are paused.', 'browser_takeover'],
  // 同平台第二个号还没扫过码：换罐那一层拦在前面时报的是「平台·昵称」，要单独归一类（2026-10-23）
  ['「抖音·成长号」还没收过登录态：在授权页给它扫一次码', 'account_unauthorized'],
  // ego 抛完还追一段栈，最后一行永远是「exited with code 1」；归类必须扫整段，
  // 只看最后两行会把「未登录」判成「太慢，重试一次」（2026-10-23 授权闪退实测）
  ['开不出浏览器：小红书未登录，请先在 Ego Lite 登录 creator.xiaohongshu.com\n    at taskSpace (file:///x/run-ego.mjs:1:1)\n    at async openBackend (file:///x/open-login.mjs:2:2)\nego\'s nodejs process exited with code 1.', 'login_expired'],
  // 账号未登记要在「未登录」之前认到 account 类
  ['账号「抖音-成长号」未登记发布脚本（config/accounts.json 的 script 字段）', 'account_unregistered'],
  // 跑太久与数据层
  ['脚本没跑起来，请看服务端日志（ego 退出码 1）', 'script_crashed'],
  ['等待视频号后台响应超时', 'too_slow'],
  ['generated.json 不存在', 'data_read_failed'],
]

test('真实失败措辞都归到对应的类', () => {
  for (const [text, code] of CASES) assert.equal(classify(text), code, text)
})

test('「退出码」不再冒充「平台侧超时」', () => {
  // 旧 too_slow 的正则里含「退出码」，任何崩掉的脚本都会收到「重试一次」这句错建议
  assert.equal(classify('ego\'s nodejs process exited with code 1.'), 'script_crashed')
  assert.match(nextOf('script_crashed'), /不是平台挡的/)
  assert.doesNotMatch(nextOf('script_crashed'), /重试一次；连着两次/)
})

test('只有「号本身不行」的类才写回登录态', () => {
  // 推草稿的成败就是最硬的登录证据，砸一次要能写进 login-state，下次起串前才拦得住
  assert.equal(loginEvidenceOf('login_expired'), 'out')
  assert.equal(loginEvidenceOf('account_unauthorized'), 'out')
  assert.equal(loginEvidenceOf('wrong_account'), 'out')
  // 这几类是一次的事：写回会把一次抖动记成号不行
  for (const code of ['risk_verify', 'too_slow', 'page_changed', 'browser_takeover', 'browser_busy', 'script_crashed']) {
    assert.equal(loginEvidenceOf(code), '', code)
  }
})

test('一行式失败体也要认：视频号那句「未登录」以前被整个跳过', () => {
  // 旧 parseLastJson 只认独立成行的「{」「}」，这种一行体取不到，界面只剩「脚本崩了」
  const out = [
    '[ego-browser:notice] Ego Lite update is available.',
    '[sph-publish] 基线：草稿箱条数没读出来（页面可能改版）',
    '[sph-publish] 编辑页到位: true',
    '{"ok":false,"error":"视频号助手未登录，请先在 Ego Lite 扫码登录 channels.weixin.qq.com"}',
    '',
    "ego's nodejs process exited with code 1.",
  ].join('\n')
  const r = egoResult(out)
  assert.equal(r.ok, false)
  assert.equal(classify(r.error), 'login_expired')
})

test('多行结果仍然取最后一个，中途日志里的碎 JSON 不裹进来', () => {
  const out = [
    '[ks-publish] 配乐: {"want":"III (Find Yourself)","applied":true,"note":"III(Find Yourself)"}',
    '{',
    '  "ok": true,',
    '  "filled": true,',
    '  "images": {',
    '    "want": 7,',
    '    "got": 7',
    '  }',
    '}',
  ].join('\n')
  assert.deepEqual(egoResult(out), { ok: true, filled: true, images: { want: 7, got: 7 } })
})

test('崩溃原文里混着正常日志时，只认 Error 段', () => {
  // 「风控遮罩已自动移除」是脚本的进度日志，不是失败原因；它排在 Error 段之前
  const out = [
    '[xhs-publish] 传图后：风控遮罩已自动移除（纯前端 DOM），继续',
    'Error: TypeError: Cannot read properties of undefined',
    '    at fill (file:///x/publish.mjs:10:1)',
    "ego's nodejs process exited with code 1.",
  ].join('\n')
  assert.equal(egoCrash(out).code, 'script_crashed')
})

test('接管崩溃：界面说中文，建议是「结束接管」而不是「重试一次」', () => {
  const r = egoCrash(TAKEOVER_CRASH)
  assert.equal(r.code, 'browser_takeover')
  assert.equal(r.error, '浏览器被接管（ego 退出码 1）')
  assert.equal(nextOf(r.code), '那个浏览器窗口在你手上，脚本动不了：回到浏览器结束接管（或关掉那一屏）再重推这一版；重试本身解不开')
  assert.doesNotMatch(r.error, /Finish task/)
})

test('摘要本身已经认得出类时，原样留着那句人话', () => {
  const out = [
    'Error: 视频号助手未登录，请先在 Ego Lite 扫码登录 channels.weixin.qq.com',
    '    at openBackend (file:///x/sph-publish.mjs:88:1)',
    "ego's nodejs process exited with code 1.",
  ].join('\n')
  const r = egoCrash(out)
  assert.equal(r.code, 'login_expired')
  assert.match(r.error, /^视频号助手未登录/)
})

test('认不出类的崩溃不硬编猜测，保留原摘要', () => {
  const out = 'Error: 一个没人见过的报错\n    at x (file:///y/z.mjs:1:1)\nego\'s nodejs process exited with code 1.'
  const r = egoCrash(out)
  assert.equal(r.code, 'script_crashed')
  assert.match(r.error, /一个没人见过的报错/)
  assert.equal(labelOf('nope'), '')
})

test('认不出来的不硬编猜测', () => {
  assert.equal(classify('今天没有过门槛'), null)
  assert.equal(classify(''), null)
  assert.equal(classify(null), null)
})

test('每一类都有该做的一步，措辞不空', () => {
  for (const [, code] of CASES) {
    const next = nextOf(code)
    assert.ok(next.length >= 10, `${code} 缺下一步措辞`)
    assert.doesNotMatch(next, /npm run|scripts\/|\.mjs/, `${code} 的措辞里不该出现命令或路径`)
  }
})

test('响应体补 code 与 action，原文不动', () => {
  const out = humanize({ ok: false, error: '小红书未登录，请先在 Ego Lite 登录 creator.xiaohongshu.com' })
  assert.equal(out.code, 'login_expired')
  assert.equal(out.error, '小红书未登录，请先在 Ego Lite 登录 creator.xiaohongshu.com')
  assert.ok(out.action)
})

test('认不出的类不带 action（界面就不渲染这一行）', () => {
  const out = humanize({ ok: false, error: '一个没人见过的报错' })
  assert.equal(out.code, null)
  assert.equal(out.action, undefined)
})

test('成功体不插手（服务里每个响应都过这道，加字段只能限于失败）', () => {
  const ok = { ok: true, articles: [1, 2] }
  assert.deepEqual(humanize(ok), ok)
})

test('异常对象也能直接变成人话响应', () => {
  const out = humanError(new Error('collect 正在跑（共用浏览器登录态），等它结束再推草稿'), { busy: true })
  assert.equal(out.ok, false)
  assert.equal(out.busy, true)
  assert.equal(out.code, 'browser_busy')
})
