/** 全项目只有一把日历日的尺。
 *
 * 为什么要有这一份：2026-10-28 之前写入侧（metrics/raw 的快照文件名、采集卡的采集日期）一律按
 * `new Date().toISOString().slice(0,10)` 截 UTC 日，读取侧（界面的「今天」、排班状态、发布判定）
 * 有的按本地日（auto-run 的 dayKey）有的按 UTC 日——东八区的凌晨 00:00–07:59 那几趟
 * （爆款采集 07:40、发布状态晨间补检 08:42 之前的一次补跑）落到前一天的桶里，
 * 界面上就表现为「今天没采到」，而文件其实写了，只是写在昨天那一格。
 *
 * 定死用本机日历日：读的人看的是自己墙上那天的日期，平台后台给的逐日序列（daily 里的 date）
 * 本来也是中国日——桶名跟序列同一把尺，才对得上。
 *
 * 改口径必须写入侧与读取侧一起换（src/data/store.ts 里那两行是同一语义的浏览器版）。
 */

/** Date 或毫秒 → 本机日历日 YYYY-MM-DD。
 *  不用 toISOString：UTC 截会把午夜前后算到前一天。 */
export const localDay = (d = new Date()) => {
  const x = d instanceof Date ? d : new Date(d)
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`
}

/** 日历日加减：跨月跨年交给他自己算，不碰时区也不受时区影响。
 *  旧写法 `new Date(`${iso}T00:00:00`).toISOString()` 在东八区会把结果退一天（本地零点 = UTC 前一天 16:00）。 */
export const shiftDay = (iso, n) => {
  const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10)
}
