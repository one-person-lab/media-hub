import test from 'node:test'
import assert from 'node:assert/strict'
import { noteKey, propagateUsedTopics } from './note-identity.mjs'

const xhs = (id, query = '') => ({
  platform: '小红书',
  url: `https://www.xiaohongshu.com/explore/${id}${query}`,
})

test('小红书同一篇笔记带不同参数也算同一篇', () => {
  assert.equal(
    noteKey(xhs('6aa0e50f000000002b001162', '?xsec_token=abc&xsec_source=pc_user')),
    noteKey({ platform: 'xiaohongshu', url: 'https://www.xiaohongshu.com/explore/6aa0e50f000000002b001162' }),
  )
})

test('抖音 /video/ 与 modal_id 指向同一支视频', () => {
  assert.equal(
    noteKey({ platform: '抖音', url: 'https://www.douyin.com/video/7681650682813762831' }),
    noteKey({ platform: 'douyin', url: 'https://www.douyin.com/user/abc?modal_id=7681650682813762831' }),
  )
})

test('不同笔记即使标题一样也不互相影响', () => {
  const used = { ...xhs('6aa0e50f000000002b001162'), title: '不改就会重复当前生活', convertedTopic: '选题A' }
  const other = { ...xhs('ffffffffffffffffffffffff'), title: '不改就会重复当前生活', convertedTopic: '' }
  propagateUsedTopics([used, other])
  assert.equal(other.convertedTopic, '')
})

test('已选题传到同一条笔记的另一份副本，并补齐旧标记', () => {
  const used = { ...xhs('6aa0e50f000000002b001162'), file: '爆款采集/原卡.md', convertedTopic: '不改就会重复当前生活', converted: '' }
  const dup = { ...xhs('6aa0e50f000000002b001162', '?xsec_token=xyz'), file: '采集笔记/副本.md', convertedTopic: '', converted: '' }
  propagateUsedTopics([used, dup])
  assert.equal(dup.convertedTopic, '不改就会重复当前生活')
  assert.equal(dup.converted, '不改就会重复当前生活')
  assert.equal(used.converted, '不改就会重复当前生活')
})

test('认不出笔记 id 的短链按完整路径相认', () => {
  const a = { platform: '小红书', url: 'https://xhslink.cn/a/ABCdef' }
  const b = { platform: '小红书', url: 'https://xhslink.cn/a/ABCdef' }
  const c = { platform: '小红书', url: 'https://xhslink.cn/a/OTHER' }
  assert.equal(noteKey(a), noteKey(b))
  assert.notEqual(noteKey(a), noteKey(c))
})

test('没有链接的卡不乱猜，不传已选题', () => {
  const used = { ...xhs('6aa0e50f000000002b001162'), title: '同一标题', convertedTopic: '选题A' }
  const noUrl = { platform: '小红书', title: '同一标题', convertedTopic: '' }
  propagateUsedTopics([used, noUrl])
  assert.equal(noUrl.convertedTopic, '')
})
