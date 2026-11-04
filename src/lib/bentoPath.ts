export type Pt = [number, number]

/** catmull-rom → 三次贝塞尔：k 越小越贴真值，0.18 是参考件里既不折也不吞起伏的那一档 */
export function smooth(P: Pt[]): string {
  const n = P.length
  if (n < 2) return ''
  const g = (i: number) => P[Math.max(0, Math.min(n - 1, i))]
  let d = `M${P[0][0]},${P[0][1]}`
  for (let i = 0; i < n - 1; i++) {
    const p0 = g(i - 1)
    const p1 = g(i)
    const p2 = g(i + 1)
    const p3 = g(i + 2)
    const k = 0.18
    d += `C${(p1[0] + (p2[0] - p0[0]) * k).toFixed(2)},${(p1[1] + (p2[1] - p0[1]) * k).toFixed(2)} ` +
      `${(p2[0] - (p3[0] - p1[0]) * k).toFixed(2)},${(p2[1] - (p3[1] - p1[1]) * k).toFixed(2)} ` +
      `${p2[0].toFixed(2)},${p2[1].toFixed(2)}`
  }
  return d
}

export const easeOut = (t: number) => 1 - Math.pow(1 - t, 3)

/** 刻度步长：取 1/2/2.5/5/10 这一族里第一个 ≥ 平均间距的，轴上才是整数好读的数 */
export function niceStep(lo: number, hi: number, target = 4): number {
  const raw = (hi - lo) / target
  if (raw <= 0) return 1
  const mag = Math.pow(10, Math.floor(Math.log10(raw)))
  return [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw
}

/** 轴刻度标签：千位以上收成 12.5K，窄面板放不下六位数字 */
export function compactNumber(v: number, step: number): string {
  if (Math.abs(v) >= 1000) return `${(v / 1000).toFixed(step < 1000 ? 1 : 0)}K`
  return String(Math.round(v * 10) / 10)
}
