/**
 * 词级差异：把「整段重写」的前后两版比成 same/del/ins 片段，供界面把改动点标出来。
 * 段级替换是局部优化的落盘方式（改一处要顺带捋顺承接句），但整段摊出来看不出动了哪，
 * 所以先掐头去尾再做 LCS——中文按字切、英文按词切，合并同类片段后就是可读的行内 diff。
 */
export interface DiffSeg { t: 'same' | 'del' | 'ins'; s: string }

/** 英文数字成词、中文单字、其余标点成词、空白成段——切得越粗 diff 越像人眼看到的「改动」 */
function tokenize(s: string): string[] {
  return s.match(/[A-Za-z0-9À-ÿ_]+(?:['’\-][A-Za-z0-9À-ÿ_]+)*|[\uD800-\uDBFF][\uDC00-\uDFFF]|[^\s\uD800-\uDBFF\uDC00-\uDFFF]|\s+/g) || []
}

/** LCS 回溯；规模超阈值就退成「整块删 + 整块加」，不为一次 diff 卡住界面 */
function middle(a: string[], b: string[]): DiffSeg[] {
  if (!a.length || !b.length) {
    const out: DiffSeg[] = []
    if (a.length) out.push({ t: 'del', s: a.join('') })
    if (b.length) out.push({ t: 'ins', s: b.join('') })
    return out
  }
  if (a.length * b.length > 4_000_000) {
    return [{ t: 'del', s: a.join('') }, { t: 'ins', s: b.join('') }]
  }
  const n = a.length
  const m = b.length
  const dp = new Uint32Array((n + 1) * (m + 1))
  const at = (i: number, j: number) => i * (m + 1) + j
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[at(i, j)] = a[i] === b[j] ? dp[at(i + 1, j + 1)] + 1 : Math.max(dp[at(i + 1, j)], dp[at(i, j + 1)])
    }
  }
  const out: DiffSeg[] = []
  const push = (t: DiffSeg['t'], s: string) => {
    const last = out[out.length - 1]
    if (last && last.t === t) last.s += s
    else out.push({ t, s })
  }
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) { push('same', a[i]); i++; j++ }
    else if (dp[at(i + 1, j)] >= dp[at(i, j + 1)]) { push('del', a[i]); i++ }
    else { push('ins', b[j]); j++ }
  }
  while (i < n) push('del', a[i++])
  while (j < m) push('ins', b[j++])
  return out
}

export function diffWords(before: string, after: string): DiffSeg[] {
  const a = tokenize(before)
  const b = tokenize(after)
  let p = 0
  while (p < a.length && p < b.length && a[p] === b[p]) p++
  let s = 0
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++
  const out: DiffSeg[] = []
  const push = (t: DiffSeg['t'], v: string) => {
    const last = out[out.length - 1]
    if (last && last.t === t) last.s += v
    else out.push({ t, s: v })
  }
  if (p) push('same', a.slice(0, p).join(''))
  for (const seg of middle(a.slice(p, a.length - s), b.slice(p, b.length - s))) push(seg.t, seg.s)
  if (s) push('same', a.slice(a.length - s).join(''))
  return out
}

/** 改动占比：新增字数 / 段落字数。删和加取大者而不是相加——换掉一个词只算动了一个词，别报成 200% */
export function diffRatio(before: string, after: string): number {
  const segs = diffWords(before, after)
  const len = (t: DiffSeg['t']) => segs.filter((x) => x.t === t).reduce((n, x) => n + x.s.length, 0)
  const changed = Math.max(len('del'), len('ins'))
  return Math.round((changed / Math.max(before.length, after.length, 1)) * 100)
}
