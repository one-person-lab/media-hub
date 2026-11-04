/** 采集回来的互动计数有两种写法：抓取时已折成「56.6万」，也有的卡存的是裸数「102710」。
 *  界面上只许一种样子——5 位数以上的裸数折成万/亿，其余原样返回（空串、已带单位的串都不动它）。 */
export function countText(v?: string | number): string {
  const s = String(v ?? '')
  if (!/^\d{5,}$/.test(s)) return s
  const n = Number(s)
  return n >= 1e8 ? `${Math.round((n / 1e8) * 10) / 10}亿` : `${Math.round((n / 1e4) * 10) / 10}万`
}
