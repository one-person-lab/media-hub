/**
 * 内置生成引擎：工作台直调的两类活在这里落地。
 *  - teardown（爆款拆解）：chat 模型直出五层 JSON → 写回采集卡 analysis: 块，零 Agent token；
 *  - create / video（图文·视频创作）：整段提示词交给本机 Agent CLI（claude -p 等）在仓库根执行——
 *    这类活要读写多文件、跑渲染，纯 chat 模型做不了。
 * 配置在 config/llm.json（apiKey 单独落 ~/.config/media-hub/dashscope.key，不进 git）。
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { loadAiContext, replaceSection } from './collect-note-core.mjs'
import { reviewEvidence, findTopic, ledgerDigest, topicSiblings } from './lesson-core.mjs'
import { localDay } from './day-core.mjs'

const ROOT = join(import.meta.dirname, '..')
const GEN = join(ROOT, 'src/data/generated.json')

/** 复盘结论的唯一来源：build-data 落好的那一份，不另起一次 md 解析。
 *  首轮 gen:data 前读不到就当没有——预答照跑，只是无史可比。 */
function readReviewData() {
  try {
    const d = JSON.parse(readFileSync(GEN, 'utf8'))
    return { articles: d.articles || [], topics: d.topics || [], lessons: d.lessons || [] }
  } catch {
    return { articles: [], topics: [], lessons: [] }
  }
}

/** 台账切片：喂 prompt 用的小份（条数与字数双封顶，随复盘结论增长不会把上下文吃满） */
const ledgerForPrompt = (lessons) => ledgerDigest(lessons, { limit: 20, maxChars: 4000 })
const CONFIG_FILE = join(ROOT, 'config/llm.json')
export const KEY_FILE = join(homedir(), '.config/media-hub/dashscope.key')

const DEFAULTS = {
  baseUrl: 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
  model: 'qwen3.8-flash',
  agent: {
    // 同一把 Key 走百炼 TokenPlan 的 Anthropic 协议端点，本机 claude CLI 直连它
    baseUrl: 'https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic',
    model: 'qwen3.8-flash',
    command: 'claude',
    // stream-json 是唯一能拿到逐事件进度的输出格式（写哪个文件、跑什么命令）；print 模式下它要求配 --verbose
    args: ['-p', '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions'],
  },
}

export function readLlmConfig() {
  let file = {}
  try { file = JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) } catch { /* 首次没有配置文件，用默认 */ }
  return {
    baseUrl: file.baseUrl || DEFAULTS.baseUrl,
    model: file.model || DEFAULTS.model,
    agent: { ...DEFAULTS.agent, ...(file.agent || {}) },
  }
}

export function writeLlmConfig(p) {
  const cur = readLlmConfig()
  const next = {
    baseUrl: (p.baseUrl || '').trim() || cur.baseUrl,
    model: (p.model || '').trim() || cur.model,
    agent: {
      baseUrl: (p.agentBaseUrl || '').trim() || cur.agent.baseUrl,
      model: (p.agentModel || '').trim() || cur.agent.model,
      command: (p.agentCommand || '').trim() || cur.agent.command,
      args: Array.isArray(p.agentArgs) && p.agentArgs.length ? p.agentArgs : cur.agent.args,
    },
  }
  writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2) + '\n')
  return next
}

export function readLlmKey() {
  try { return readFileSync(KEY_FILE, 'utf8').trim() } catch { return '' }
}

export function writeLlmKey(key) {
  mkdirSync(join(homedir(), '.config/media-hub'), { recursive: true })
  writeFileSync(KEY_FILE, key.trim() + '\n', { mode: 0o600 })
}

/** Agent 的鉴权与端点。本机 `claude` 会读 ~/.claude/settings.json 的 env（优先级高于进程环境），
 *  所以这里另起一个只含本次配置的 CLAUDE_CONFIG_DIR，避免改动用户自己的 Claude Code 设置。 */
const AGENT_HOME = join(homedir(), '.config/media-hub', 'agent')

function setupAgentEnv(agent, key) {
  if (!agent.baseUrl || !agent.model) return {}
  mkdirSync(AGENT_HOME, { recursive: true, mode: 0o700 })
  const env = {
    ANTHROPIC_BASE_URL: agent.baseUrl.replace(/\/$/, ''),
    ANTHROPIC_AUTH_TOKEN: key,
    ANTHROPIC_MODEL: agent.model,
    ANTHROPIC_DEFAULT_SONNET_MODEL: agent.model,
    ANTHROPIC_DEFAULT_OPUS_MODEL: agent.model,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: agent.model,
  }
  writeFileSync(join(AGENT_HOME, 'settings.json'), JSON.stringify({ env }, null, 2), { mode: 0o600 })
  const onboarding = join(AGENT_HOME, '.claude.json')
  let conf = {}
  try { conf = JSON.parse(readFileSync(onboarding, 'utf8')) } catch { /* 首次没有 */ }
  conf.hasCompletedOnboarding = true
  writeFileSync(onboarding, JSON.stringify(conf), { mode: 0o600 })
  return {
    CLAUDE_CONFIG_DIR: AGENT_HOME,
    // 百炼的模型名 Claude Code 不认识，关掉它的 200k 上下文强制，否则每次请求前多一段告警
    CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT: '1',
  }
}

/** Agent 端点连通性：一次 Anthropic 协议 messages 调用 */
export async function pingAgent({ timeoutMs = 30_000 } = {}) {
  const { agent } = readLlmConfig()
  const key = readLlmKey()
  if (!key) throw new Error('未配置模型 Key：到工作台「配置」里填一次 API Key')
  const resp = await fetch(`${agent.baseUrl.replace(/\/$/, '')}/v1/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      // thinking 块先吃预算，16 会被截成空文本
      model: agent.model, max_tokens: 200,
      messages: [{ role: 'user', content: '回复：正常' }],
    }),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const out = await resp.json().catch(() => ({}))
  if (!resp.ok) throw new Error(out.message || out.error?.message || `HTTP ${resp.status}`)
  const text = (out.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim()
  if (!text) throw new Error('模型返回空内容')
  return text
}

/** 一次 chat 调用（OpenAI 协议），返回文本内容 */
export async function chatCompletion({ system, user, temperature = 0.5, maxTokens = 6000, timeoutMs = 300_000, signal = null }) {
  const key = readLlmKey()
  if (!key) throw new Error('未配置模型 Key：到工作台「配置」里填一次 API Key')
  const { baseUrl, model } = readLlmConfig()
  const resp = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
    body: JSON.stringify({
      model, temperature, max_tokens: maxTokens, enable_thinking: false,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    }),
    // 超时之外再叠一根「人按了停止」的线：界面按停时请求要立刻断，不能等它自己超时
    signal: signal ? AbortSignal.any([AbortSignal.timeout(timeoutMs), signal]) : AbortSignal.timeout(timeoutMs),
  })
  const out = await resp.json().catch(() => ({}))
  if (!resp.ok) throw new Error(out.error?.message || `HTTP ${resp.status}`)
  const text = out.choices?.[0]?.message?.content?.trim() || ''
  if (!text) throw new Error('模型返回空内容')
  return text
}

/** 取「## 脚本」段（段名容得下括号补充，如「## 脚本（拆解与创作的唯一材料）」，与 build-data cardScript 同口径）。
 *  逐行扫描：正则在 m 标志 + 前瞻裸 `$` 的组合下会在行首提前收口，不如行扫描直白可靠。 */
function extractScript(md) {
  const lines = md.split('\n')
  const start = lines.findIndex((l) => /^## 脚本/.test(l))
  if (start < 0) return ''
  const body = []
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i]
    if (/^## /.test(l) || /^---\s*$/.test(l)) break
    if (!l.startsWith('>')) body.push(l)
  }
  return body.join('\n').trim()
}
export { extractScript }

/** 内置拆解：读采集卡脚本 → chat 模型出五层 JSON → 写回 analysis: 块。返回 { ok, layers?|error? } */
export async function runTeardown(rel, log = () => {}, signal = null) {
  const abs = join(ROOT, rel)
  if (!existsSync(abs)) return { ok: false, error: '采集卡文件不存在：' + rel }
  const md = readFileSync(abs, 'utf8')
  const script = extractScript(md)
  if (!script) return { ok: false, error: '这条还没有「## 脚本」段——先点「补扒脚本」，拆解只认完整脚本' }

  const title = (md.match(/^title:\s*(.+)$/m) || md.match(/^# (.+)$/m) || [])[1] || rel.split('/').pop()
  log(`调用模型（脚本 ${script.length} 字）…`)
  const text = await chatCompletion({
    system: [
      `你是这个自媒体仓库的爆款拆解助手。严格按「爆款拆解」知识文件里的框架拆解，五层缺一不可。`,
      `只输出一个 JSON（不带围栏、不带解释），字段：`,
      `{"why":"这条为什么火","subject":"①主题","hook":"②钩子","structure":"③结构","emotion":"④情绪","mechanism":"⑤机制"}`,
      `硬性字数线：why 40 字内，其余五层每层 30 字内，一层就一句话，不许分号串好几句、不许换行。`,
      `这一层只写「我们下次怎么用它」的结论，不许复述原文讲了什么：`,
      `③结构只写页序怎么切的规律（如「一页一条、观点+动作」），禁止逐页罗列第几页讲什么；`,
      `⑤机制只写赞藏评说明了哪类内容、我们该做成哪一类，禁止抄具体数字；`,
      `不许写"内容不错""有共鸣""干货满满"这种没动作的话。`,
      `账号视角以 00-定位.md 为准；结论只能从脚本内容推出，不许凭标题猜；原文未标注出处就不猜出处。`,
      `【知识库】\n${loadAiContext(ROOT)}`,
    ].join('\n'),

    user: `【选题】${title}\n\n【完整脚本】\n${script}`,
    signal,
  })
  const raw = text.replace(/^```(json)?\n?/m, '').replace(/```\s*$/m, '').trim()
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end < 0) return { ok: false, error: '模型输出不含 JSON：' + text.slice(0, 120) }
  let parsed
  try { parsed = JSON.parse(raw.slice(start, end + 1)) } catch { return { ok: false, error: 'JSON 解析失败：' + raw.slice(0, 120) } }

  const today = localDay()
  const block = 'analysis:\n'
    + ['why', 'subject', 'hook', 'structure', 'emotion', 'mechanism']
      .map((k) => `  ${k}: ${JSON.stringify(String(parsed[k] || '').trim())}\n`)
      .join('')
    + `analyzedAt: ${today}\n`
  let updated = md
  if (/^analysis:\n(?:  .*\n)+analyzedAt: [^\n]*\n/m.test(updated)) {
    updated = updated.replace(/^analysis:\n(?:  .*\n)+analyzedAt: [^\n]*\n/m, block)
  } else if (/^---\n/.test(updated)) {
    updated = updated.replace(/^---\n/, '---\n' + block)
  } else {
    return { ok: false, error: '采集卡没有 frontmatter，无法写回拆解' }
  }
  writeFileSync(abs, updated)
  return { ok: true, layers: ['subject', 'hook', 'structure', 'emotion', 'mechanism'].filter((k) => parsed[k]) }
}

/** 拟判据：机器按 00-定位 五段预答判据四问 + 一条依据经验，写回选题卡对应字段。
 *  四问口径（00-定位 导出）：①挂得上 ②人群认 ③答得出 ④能解释。
 *  只拟不判：产出是草稿，人点开确认或改；不拦任何动作，runGate 本身也不是门。 */
export async function runGate(rel, log = () => {}, signal = null) {
  const abs = join(ROOT, rel)
  if (!existsSync(abs)) return { ok: false, error: '选题卡文件不存在：' + rel }
  const md = readFileSync(abs, 'utf8')
  const title = (md.match(/^# (.+)$/m) || [])[1] || rel.split('/').pop()
  const srcFile = (md.match(/^- 来源文件：(.+)$/m) || [])[1]?.trim() || ''
  // 原料：来源采集卡的脚本与拆解（有才喂；原创题面只按定位拟）
  let material = ''
  if (srcFile) {
    const srcAbs = join(ROOT, srcFile)
    if (existsSync(srcAbs)) {
      const srcMd = readFileSync(srcAbs, 'utf8')
      const script = extractScript(srcMd)
      if (script) material += `【来源脚本（截断）】\n${script.slice(0, 4000)}\n\n`
      const analysis = srcMd.match(/^analysis:\n(?:  .*\n)+analyzedAt: [^\n]*\n/m)
      if (analysis) material += `【来源拆解】\n${analysis[0].trim()}\n`
    }
  }

  log('调用模型（按 00-定位 拟判据四问）…')
  const text = await chatCompletion({
    system: [
      '你是这个自媒体仓库的选题预审助手。给你一个候选选题，按账号定位预答「判据四问」并给一条依据经验。',
      '只输出一个 JSON（不带围栏、不带解释）：',
      '{"judge":"判据四问各一句","basis":"依据经验：相对路径＋一句话结论，引不出就空字符串"}',
      '判据四问逐条各答一句，句首标序号：',
      '①挂得上：这个内容和账号定位什么关系（养信任/带产品/纯流量），别硬挂；',
      '②人群认：00-定位 里圈的人群，对这个痛点认不认；',
      '③答得出：用户看完能带走的一个具体动作或结论；',
      '④能解释：这个题和「我相信什么」冲不冲突，冲突就别硬做。',
      '硬约束：',
      '- 账号视角、人群、口径以【知识库】里的 00-定位 为准；',
      // 依据经验必须是真发生过的复盘结论，不是模型按定位现编的一句话——那正是「飞轮没转」的形态：
      // ② 引的「经验」和 ⑤ 产出的结论之间从来没有过连接。
      '- basis 优先引【复盘结论台账】里的真实结论（写成「<稿名> · 教会了我们什么：<一句话>」）；台账里没有对得上的，才退回来源拆解或知识库口径；都没有就留空，不许自己造经验；',
      '- 这是草稿不是判决：不确定的地方照实写，人来改。',
      `【复盘结论台账】\n${ledgerForPrompt(readReviewData().lessons)}`,
      `【知识库】\n${loadAiContext(ROOT)}`,
    ].join('\n'),
    user: `【选题】${title}\n${material || '【无来源材料】原创题面，只按定位拟。'}`,
    signal,
  })
  const raw = text.replace(/^```(json)?\n?/m, '').replace(/```\s*$/m, '').trim()
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end < 0) return { ok: false, error: '模型输出不含 JSON：' + text.slice(0, 120) }
  let parsed
  try {
    parsed = JSON.parse(raw.slice(start, end + 1))
  } catch {
    return { ok: false, error: 'JSON 解析失败：' + raw.slice(0, 120) }
  }
  const judge = String(parsed.judge || '').trim()
  const basis = String(parsed.basis || '').trim()
  if (!judge) return { ok: false, error: '模型没给出判据草稿' }

  // 写回选题卡：替换「判据自评」「依据经验」两行（有旧值就覆盖——重拟）
  let updated = md.replace(/^- 判据自评：.*$/m, `- 判据自评：${judge}`)
  if (updated === md) return { ok: false, error: '选题卡没有「判据自评」字段行，无法写回' }
  if (/^- 依据经验：.*$/m.test(updated)) {
    updated = updated.replace(/^- 依据经验：.*$/m, `- 依据经验：${basis}`)
  } else {
    updated = updated.replace(/^(- 判据自评：.*)$/m, `$1\n- 依据经验：${basis}`)
  }
  writeFileSync(abs, updated)
  return { ok: true, judge, basis }
}

/**
 * 复盘预答：把这篇的读数、当初立项写的判据与依据经验、账号已有结论摆给模型，
 * 让它先答「这篇教会了我们什么」的三件套草稿——人只拍板不改口径（产品原则：机器预答人只拍板）。
 * 故意不落盘：结论是要人认账的东西，写进稿里再让人改等于替人认了账。返回草稿给界面填进输入框。
 */
export async function runReviewDraft({ rel, dataScore, scoreNote } = {}, log = () => {}) {
  if (!rel) return { ok: false, error: '缺少 rel' }
  const clean = String(rel).replace(/^\.?\//, '').replace(/^content\//, '')
  const d = readReviewData()
  const article = d.articles.find((a) => a.file === clean)
  if (!article) return { ok: false, error: `稿件不在数据里（${clean}）——先跑一次 gen:data` }
  if (article.status !== 'published') return { ok: false, error: '这篇还没标记为已发布，复盘只评发出去的稿' }

  const baselineText = dataScore == null
    ? ''
    : `A 段（数据表现 60 分）机器折算 ${dataScore}/60${scoreNote ? `｜${scoreNote}` : ''}`
  // 同题各平台的稿一起看：结论是对这个题说的，只对一版成立的结论写回五份稿会把别的版带沟里
  const siblings = topicSiblings(d.articles, article)
  const evidence = reviewEvidence({
    article,
    topic: findTopic(d.topics, article),
    lessons: d.lessons,
    baseline: { text: baselineText },
    siblings,
  })
  const copy = String(article.copy || article.body || '').replace(/<!--[\s\S]*?-->/g, '').trim().slice(0, 1500)

  log('调用模型（按本篇读数与当初判据预答复盘结论）…')
  const text = await chatCompletion({
    temperature: 0.3,
    maxTokens: 1200,
    system: [
      '你是这个自媒体仓库的复盘助手。给你一篇已发布稿的实测读数、当初立项时写下的判据与依据经验、以及账号已有的复盘结论台账，答「这篇教会了我们什么」。',
      '只输出三行（不带围栏、不带小标题、不带多余解释），每行以「- 」开头：',
      '- 一句话：<这篇换来的新信息，要能改变下一篇的选题或写法>',
      '- 证据：<只引给到的读数、判据、台账原文里的数字或句子，逐条带上具体值>',
      '- 下次：<下一条内容直接执行的一个动作，动作不是心得>',
      '硬约束：',
      '- 必须和当初的判据/预期对照：兑现了没有，一句话点出来（口径见 Knowledge/评分体系.md §二 写回要求）；',
      '- 台账里有同向结论时说明「第 2 次验证，可升进 Knowledge」，有反向证据时点出该撤回台账里的哪一条；',
      '- 数据不足就承认：读数只有一两项时，结论落在「这篇没能验证什么」，并给出要补哪个读数；',
      '- 不许引外部基准、不许推测平台机制、不许写「值得深思」这类没有动作的句子；',
      '- 内容质量的问题要从给的正文片段里指得出具体一句，指不出就不评内容只评数据。',
      `【知识库】\n${loadAiContext(ROOT)}`,
    ].join('\n'),
    user: `${evidence}\n\n【这篇发出去的文字（截断）】\n${copy || '（读不到正文）'}`,
  })
  const draft = text.replace(/^```[a-z]*\n?/m, '').replace(/```\s*$/m, '').trim()
  if (!draft) return { ok: false, error: '模型没给出草稿' }
  // files 是给界面的写回清单：这一题在各平台的那几版稿，保存时一次写全，省得人抄五遍
  return { ok: true, draft, title: article.title, files: [article, ...siblings].map((x) => `content/${x.file}`) }
}

/** stream-json 的 tool_use 事件 → 一行给界面的话（认不出的返回 ''，不拿英文工具名糊界面） */
function agentProgressLine(ev, root) {
  if (ev?.type !== 'assistant') return ''
  const parts = Array.isArray(ev.message?.content) ? ev.message.content : []
  for (const p of parts) {
    if (p?.type !== 'tool_use') continue
    const file = String(p.input?.file_path || p.input?.path || p.input?.notebook_path || '').replace(`${root}/`, '')
    if (file) return `${p.name === 'Read' ? '在看' : '正在写'} ${file.split('/').pop()}`
    if (p.name === 'Bash' && p.input?.command) return `在跑命令 ${String(p.input.command).split('\n')[0].replace(root + '/', '').slice(0, 30)}`
    if (p.name === 'TodoWrite') return '在核对清单…'
  }
  return ''
}

/** Agent CLI 任务：整段提示词喂给本机 agent，在仓库根自主执行（创作/视频/对话线）。
 *  返回 { ok, tail, answer?, sessionId?, error? }
 *  answer = result 事件全文（对话要把原话落进会话）；sessionId 留着给多轮 --resume 用。
 *  进度：Agent 按 `--output-format stream-json` 逐事件吐，每次工具调用（写哪个文件、跑什么命令）实时回灌界面；
 *  配置被改回普通文本输出时退回「最近一行非空输出」。Agent 沉默时界面也不能停表——
 *  跑多久由 genJob.startedAt 现算，见 useGenerate.elapsed。 */
export async function runAgentJob(prompt, { timeoutMs = 20 * 60_000, label = 'agent', log = () => {}, signal = null } = {}) {
  const { agent } = readLlmConfig()
  const extraEnv = setupAgentEnv(agent, readLlmKey())
  log(`交给本机 Agent（${agent.command} · ${agent.model || '默认模型'}）执行…`)
  const limitMin = Math.round(timeoutMs / 60_000)
  let readable = ''
  let lastLine = ''
  let sessionId = ''
  let answer = ''
  const { code, out, timedOut, aborted } = await new Promise((done) => {
    const child = spawn(agent.command, agent.args, {
      cwd: ROOT,
      env: { ...process.env, ...extraEnv },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let rest = ''
    let lastAt = 0
    const say = (line) => {
      if (!line || line === lastLine || Date.now() - lastAt < 800) return
      lastLine = line
      lastAt = Date.now()
      log(line.slice(0, 90))
    }
    const feed = (chunk) => {
      const lines = (rest + chunk).split('\n')
      rest = lines.pop() ?? ''
      for (const raw of lines) {
        const line = raw.trim()
        if (!line) continue
        if (!line.startsWith('{')) {
          // 非 stream-json 的输出（自定义 Agent 命令）：整行既是尾巴也是进度
          readable += `${line}\n`
          say(line.replace(/^[\s\-*·>|]+/, ''))
          continue
        }
        let ev
        try {
          ev = JSON.parse(line)
        } catch {
          continue
        }
        if (ev.session_id) sessionId = String(ev.session_id)
        if (ev.type === 'result') {
          const r = String(ev.result || '').trim()
          if (r) {
            readable += `${r}\n`
            answer = r
          }
          continue
        }
        const text = (ev?.message?.content || []).filter((p) => p?.type === 'text').map((p) => p.text).join(' ').trim()
        say(agentProgressLine(ev, ROOT) || text.split('\n')[0])
      }
    }
    let timedOut = false
    const killer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, timeoutMs)
    /* 人在界面上按了停止：先 SIGTERM 让 CLI 自己收尾（它可能正在写稿），10 秒还没走再 SIGKILL。
     * 与超时的区别要留在返回值里——超时是「这条跑不动」，停止是「人不要它了」，界面说的话不一样。 */
    let aborted = false
    const stop = () => {
      if (aborted || child.exitCode !== null) return
      aborted = true
      say(`${label} 收到停止：先礼后兵`)
      child.kill('SIGTERM')
      setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL') }, 10_000).unref()
    }
    if (signal) {
      if (signal.aborted) stop()
      else signal.addEventListener('abort', stop, { once: true })
    }
    child.stdout.on('data', (c) => feed(String(c)))
    // 报错只出现在 stderr（比如 CLI 不认某个参数），留着当尾巴
    child.stderr.on('data', (c) => (readable += c))
    child.on('error', (e) => {
      clearTimeout(killer)
      signal?.removeEventListener('abort', stop)
      readable += `\n启动失败：${e.message}（可在「配置」里改 Agent 命令）`
      done({ code: -1, out: readable, timedOut, aborted })
    })
    child.on('close', (c) => { clearTimeout(killer); signal?.removeEventListener('abort', stop); done({ code: c, out: readable, timedOut, aborted }) })
    child.stdin.write(prompt)
    child.stdin.end()
  })
  const tail = out.slice(-800)
  if (aborted) return { ok: false, aborted: true, tail, sessionId, error: `${label} 已停止（人在界面上按了停止）` }
  if (timedOut) {
    return { ok: false, tail, sessionId, error: `${label} 超时：${limitMin} 分钟没跑完，已中止（最后进度：${lastLine || '无输出'}）` }
  }
  if (code !== 0) {
    const last = tail.split('\n').filter(Boolean).pop() || '无输出'
    return { ok: false, tail, sessionId, error: `${label} 失败（退出码 ${code}）：${last}${tail.length > 200 ? ' ｜' + tail.slice(-200) : ''}` }
  }
  return { ok: true, tail, answer, sessionId }
}
