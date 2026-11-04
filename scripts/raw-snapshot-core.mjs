/**
 * metrics/raw/<日期>.json 的合并规则。
 *
 * 一天一份文件，两个写入方各写各的：collect 写读数（daily/metrics/notes/粉丝数），
 * publish-check 写发布列表（publishedList）。逐平台合并是必须的——整表覆盖会把对方那一半冲掉；
 * 而合并时一旦让结果别名到任一输入，就会把旧块写回本轮采集结果里，新读数当场白采
 * （10-24 至 10-27 那四天小红书/抖音整块为空，就是这么来的）。
 */

/** 本轮没拿到：null、undefined、空数组、空对象。0 和空字符串是真实读数，不算空 */
export const isBlank = (v) =>
  v === null ||
  v === undefined ||
  (Array.isArray(v) && v.length === 0) ||
  (typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0)

const clone = (v) => structuredClone(v)
const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v)

/**
 * 把本轮采集结果合进当天已有快照，返回全新对象，两份输入都不改、也不与结果共用内部对象。
 * 规则：当天文件打底，本轮「真拿到」的字段覆盖；本轮没涉及的字段（含别家写入方写的）原样留着；
 * 本轮某平台全空（挂了或被停止）时保留旧读数，错误记录按平台名合并。
 */
export function mergeSnapshot(prev, fresh) {
  const base = isPlainObject(prev) ? prev : {}
  const next = isPlainObject(fresh) ? fresh : {}
  const out = {}
  for (const [k, v] of Object.entries(base)) if (k !== 'platforms' && k !== 'errors') out[k] = clone(v)
  for (const [k, v] of Object.entries(next)) if (k !== 'platforms' && k !== 'errors' && !isBlank(v)) out[k] = clone(v)

  const prevPlatforms = isPlainObject(base.platforms) ? base.platforms : {}
  const nextPlatforms = isPlainObject(next.platforms) ? next.platforms : {}
  const platforms = {}
  for (const key of new Set([...Object.keys(prevPlatforms), ...Object.keys(nextPlatforms)])) {
    const b = prevPlatforms[key]
    const f = nextPlatforms[key]
    if (f === undefined) {
      platforms[key] = clone(b)
      continue
    }
    if (b === undefined) {
      platforms[key] = clone(f)
      continue
    }
    if (!isPlainObject(b) || !isPlainObject(f)) {
      platforms[key] = clone(isBlank(f) ? b : f)
      continue
    }
    const block = clone(b)
    for (const [field, v] of Object.entries(f)) if (!isBlank(v)) block[field] = clone(v)
    platforms[key] = block
  }
  out.platforms = platforms
  out.errors = { ...(isPlainObject(base.errors) ? base.errors : {}), ...(isPlainObject(next.errors) ? next.errors : {}) }
  if (isBlank(out.errors)) delete out.errors
  return out
}
