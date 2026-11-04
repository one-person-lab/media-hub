/** 同一条笔记在灵感库与爆款采集里可能各存一份，读的是不同卡片文件。
 *  把「已选题」按笔记身份传给所有副本，工作列表才不会漏出用过的内容。 */

const PLATFORM_ALIAS = {
  '小红书': 'xiaohongshu',
  xiaohongshu: 'xiaohongshu',
  '抖音': 'douyin',
  douyin: 'douyin',
}

/** 平台 + 笔记 id；认不出 id（短链等）退回 host + path。没有链接返回空串，不按标题猜。 */
export function noteKey(card) {
  const raw = String(card?.platform || '').trim()
  const platform = PLATFORM_ALIAS[raw.toLowerCase()] || raw.toLowerCase()
  const url = String(card?.url || '').trim()
  if (!platform || !url) return ''
  let u
  try {
    u = new URL(url)
  } catch {
    return ''
  }
  const xhs = u.pathname.match(/\/(?:explore|discovery\/item)\/([0-9a-f]{24})/i)
  if (xhs) return `${platform}:note:${xhs[1]}`
  const dy = u.pathname.match(/\/video\/(\d+)/) || u.search.match(/[?&]modal_id=(\d+)/)
  if (dy) return `${platform}:note:${dy[1]}`
  return `${platform}:url:${u.host}${u.pathname.replace(/\/+$/, '')}`
}

export function propagateUsedTopics(cards) {
  const used = new Map()
  for (const card of cards) {
    if (!card.convertedTopic) continue
    const key = noteKey(card)
    if (key && !used.has(key)) used.set(key, card.convertedTopic)
  }
  for (const card of cards) {
    if (!card.convertedTopic) {
      const topic = used.get(noteKey(card))
      if (!topic) continue
      card.convertedTopic = topic
    }
    // 旧标记 converted 另有读处（看板的新鲜卡），一起补齐
    if (!card.converted) card.converted = card.convertedTopic
  }
}
