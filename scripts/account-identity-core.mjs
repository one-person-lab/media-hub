/** 本机存的这套登录态，到底是哪个号的
 *
 * 为什么要有这一份：cookie 在不在只证明「有个号登着」，证明不了「是哪一位」。
 * 2026-10-23 实测踩过：给同平台的第二个号（晓丸子君·抖音）授权时，浏览器一直登着主号醒醒老己，
 * 后台一打开就不是登录页，脚本据此判「扫完了」，把主号那套 cookie 存成了第二个号的号库；
 * 回认又只数条数，于是主号的 42 条作品被写成「晓丸子君 · 42 条已发布」。
 * 判身份得有出处：平台后台自己说这是谁的号。抖音的读数在 work_list 的 author 与 user/info 的 user 里。
 *
 * 纯函数——读页面的活由 open-login / publish-check 各自做，判词与措辞只有这一份。
 */

/** 各平台「这台浏览器现在登着谁」的读数地址（与创作者后台同域，带 cookie 即可）。
 *  只列实测过的：2026-10-23 抖音取 creator.douyin.com/web/api/media/user/info 的 user，
 *  小红书取 creator.xiaohongshu.com/api/galaxy/user/info 的 data。
 *  没列进来的平台判不出身份，授权与回认照旧只判登录态在不在——宁可判不出，不许判错。 */
export const IDENTITY_URL = {
  抖音: 'https://creator.douyin.com/web/api/media/user/info/',
  小红书: 'https://creator.xiaohongshu.com/api/galaxy/user/info',
}

export const hasIdentityReader = (platform) => !!IDENTITY_URL[platform]

/** 抖音：user/info 的 user 与 work_list 的 aweme_list[0].author 是同一套字段。
 *  头像取 medium（720）——larger 是 1080 的原图，本机只当 36px 圆图摆，没必要搬那么大一张。 */
function douyinIdentity(json) {
  const u = json?.user ?? json?.aweme_list?.[0]?.author
  const nickname = String(u?.nickname || '').trim()
  const id = String(u?.short_id || u?.unique_id || u?.uid || '').trim()
  const avatar = String(u?.avatar_medium?.url_list?.[0] || u?.avatar_larger?.url_list?.[0] || '').trim()
  return nickname ? { nickname, id, ...(avatar ? { avatar } : {}) } : null
}

/** 小红书：只取昵称、小红书号与头像——这个接口连手机号与实名链接一起返回，别的那些一律不带走。
 *  头像默认给的是 80px 缩略图，详情页要摆 48px 圆图（视网膜 96px）会糊，
 *  按同一套 xhscdn 参数换成 240（实测 240×240 / 14KB）；URL 没带这个参数时原样不动。 */
function xhsIdentity(json) {
  const d = json?.data
  const nickname = String(d?.userName || '').trim()
  const id = String(d?.redId || d?.userId || '').trim()
  const avatar = String(d?.userAvatar || '').replace(/\/w\/\d+\//, '/w/240/').trim()
  return nickname ? { nickname, id, ...(avatar ? { avatar } : {}) } : null
}

const PARSERS = { 抖音: douyinIdentity, 小红书: xhsIdentity }

/** 从平台返回的 JSON 里认出这是谁；认不出返回 null（没登录、改版、字段改名都算认不出） */
export function readIdentity(platform, json) {
  try {
    return PARSERS[platform]?.(json) ?? null
  } catch {
    return null
  }
}

/** 摆给人看的写法：昵称 · 平台账号 id */
export const identityLabel = (who) => (who?.nickname ? [who.nickname, who.id].filter(Boolean).join(' · ') : '')

/** 读到的身份和登记表对得上吗：match = 就是它；mismatch = 是别人；unknown = 判不了 */
export function identityVerdict(acct, who) {
  if (!hasIdentityReader(acct?.platform)) return 'unknown'
  if (!who?.nickname) return 'unknown'
  return who.nickname === String(acct?.nickname || '').trim() ? 'match' : 'mismatch'
}

/** 扫上来的这位是不是已经在册（蚁小二式「扫码即登记」的重复闸）：
 *  只在同一个平台里认名字——三个平台共用「醒醒老己」这一个品牌名，跨平台认名字会把别的平台的号判成已授权。 */
export function alreadyAuthorized(accts, who, platform) {
  const n = String(who?.nickname || '').trim()
  if (!n) return null
  return (accts || []).find((a) => a?.platform === platform && String(a?.nickname || '').trim() === n) || null
}

/** 那句报错。rivals 传同平台的其它号——读到的是登记表上另一个号时直接点名，
 *  让人自己猜「刚才扫的是哪个 App」没有意义。 */
export function identityMismatchError(acct, who, rivals = []) {
  const hit = rivals.find((r) => r.nickname && r.nickname === who?.nickname)
  const whose = hit ? `，也就是登记表上同平台的另一个号「${hit.id}」` : ''
  return `后台读到的是「${identityLabel(who)}」${whose}，登录态其实是别人的，不是「${acct?.nickname || acct?.id}」`
}
