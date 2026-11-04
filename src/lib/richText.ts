/**
 * 稿面 Markdown 的极小子集解析：只认空行分段、`#` 标题、`- `／`* ` 列表、`**加粗**`。
 * 出结构不出 HTML 字符串——渲染层用模板画，不给稿面里的尖括号变成标签的机会。
 */
export interface Seg {
  text: string
  bold: boolean
}

export interface Block {
  kind: 'p' | 'ul' | 'h'
  /** kind === 'p' 时的行内片段 */
  segs: Seg[]
  /** kind === 'ul' 时的各条目 */
  items: Seg[][]
  /** kind === 'h' 时的井号级数（1=大节，3+=小节） */
  level?: number
}

function segs(line: string): Seg[] {
  return line
    .split(/\*\*(.+?)\*\*/g)
    .map((text, i) => ({ text, bold: i % 2 === 1 }))
    .filter((s) => s.text !== '')
}

export function parseRichText(text: string): Block[] {
  const out: Block[] = []
  let list: Seg[][] | null = null
  const flushList = () => {
    if (list?.length) out.push({ kind: 'ul', segs: [], items: list })
    list = null
  }
  for (const raw of (text || '').split('\n')) {
    const line = raw.trim()
    if (!line) {
      flushList()
      continue
    }
    const head = line.match(/^(#{1,6})\s+(.*)$/)
    if (head) {
      flushList()
      out.push({ kind: 'h', segs: segs(head[2]), items: [], level: head[1].length })
      continue
    }
    const item = line.match(/^[-*]\s+(.*)$/)
    if (item) {
      ;(list ||= []).push(segs(item[1]))
      continue
    }
    flushList()
    out.push({ kind: 'p', segs: segs(line), items: [] })
  }
  flushList()
  return out
}
