/**
 * 图卡文字字段：把一页卡片数据摊成「可编辑的文本行」，只认字符串叶子。
 * 版式参数（layout/zh/en/gap/色块类名）不在名单里——编辑文字不该把排版改坏，
 * 要调版式仍走 Agent 改 json。
 */
export interface CardField {
  /** 在该页对象里的取值路径，如 ['items', 2, 'zh'] */
  path: (string | number)[]
  label: string
  value: string
}

/** 数组字段按序号分组展示的名字 */
const GROUPS: Record<string, string> = { title: '标题', head: '页眉', items: '条目', lines: '行' }
/** 单个文本字段的中文名 */
const FIELDS: Record<string, string> = {
  zh: '中文',
  en: '英文',
  src: '出处',
  srcEn: '英文出处',
  echo: '引子',
  quote: '引文',
  hl: '高亮词',
  quoteEn: '引文英文',
  who: '人物',
  role: '身份',
  kicker: '小标',
  cta: '收尾号召',
  title: '标题',
  head: '页眉',
}

const isText = (k: string) => k in FIELDS || k in GROUPS

/** 摊平一页的可编辑文字（顺序 = json 里的字段顺序，与页面阅读顺序一致） */
export function pageTextFields(page: Record<string, any>): CardField[] {
  const out: CardField[] = []
  const add = (path: (string | number)[], label: string, value: string) => out.push({ path, label, value })

  for (const [key, val] of Object.entries(page || {})) {
    if (!isText(key)) continue
    if (typeof val === 'string') {
      add([key], FIELDS[key], val)
    } else if (Array.isArray(val)) {
      val.forEach((row, i) => {
        const ctx = `${GROUPS[key]}${i + 1}`
        if (Array.isArray(row)) {
          // 标题行是 [文字, 色块类名]：只给文字，色块留给版式
          if (typeof row[0] === 'string') add([key, i, 0], ctx, row[0])
        } else if (row && typeof row === 'object') {
          for (const [k, v] of Object.entries(row)) {
            if (!isText(k)) continue
            if (typeof v === 'string') add([key, i, k], `${ctx}·${FIELDS[k]}`, v)
            else if (Array.isArray(v)) v.forEach((s, j) => typeof s === 'string' && add([key, i, k, j], `${ctx}·${FIELDS[k]}${j + 1}`, s))
          }
        } else if (typeof row === 'string') {
          add([key, i], ctx, row)
        }
      })
    }
  }
  return out
}

/** 按路径写回一份拷贝，返回新对象（原对象不动，便于「放弃修改」）。
 *  用 JSON 往返而不是 structuredClone：传进来的可能是 Vue 的 reactive Proxy，
 *  后者 clone 会直接抛 DataCloneError（改动看着没生效就是这个坑）。 */
export function applyField(
  page: Record<string, any>,
  path: (string | number)[],
  value: string,
): Record<string, any> {
  const clone = JSON.parse(JSON.stringify(page))
  let node: any = clone
  for (let i = 0; i < path.length - 1; i++) node = node[path[i]]
  node[path[path.length - 1]] = value
  return clone
}
