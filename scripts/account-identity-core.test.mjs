import test from 'node:test'
import assert from 'node:assert/strict'
import {
  readIdentity, identityLabel, identityVerdict, identityMismatchError, hasIdentityReader, alreadyAuthorized,
} from './account-identity-core.mjs'

// 2026-10-23 实测原文：work_list 的 aweme_list[].author 与 user/info 的 user 同一套字段
const WORK_LIST = { status_code: 0, aweme_list: [{ item_title: '终于有空了', author: { nickname: '醒醒老己', uid: '61093770790', short_id: '981278053', unique_id: '', sec_uid: 'MS4wLjABAAA' } }] }
const USER_INFO = { status_code: 0, user: { nickname: '晓丸子君', uid: '61099999999', short_id: '777888999', unique_id: '' } }

test('抖音：从作品列表的 author 认出这是谁的号', () => {
  assert.deepEqual(readIdentity('抖音', WORK_LIST), { nickname: '醒醒老己', id: '981278053' })
})

test('抖音：user/info 的 user 也认得出来', () => {
  assert.deepEqual(readIdentity('抖音', USER_INFO), { nickname: '晓丸子君', id: '777888999' })
})

// 2026-10-23 实测原文：creator.xiaohongshu.com/api/galaxy/user/info
const XHS_INFO = {
  success: true, code: 0,
  data: { userId: '5cc32828000000001203745e', userName: '醒醒老己', redId: '510414382', phone: '18100000000', realNameVerifyLink: 'xhsdiscover://account/realName' },
}
test('小红书：只带昵称与小红书号，手机号和实名链接一概不往外传', () => {
  assert.deepEqual(readIdentity('小红书', XHS_INFO), { nickname: '醒醒老己', id: '510414382' })
})

test('认不出就返回 null，不替平台编一个号', () => {
  assert.equal(readIdentity('抖音', { status_code: 0, aweme_list: [] }), null)
  assert.equal(readIdentity('抖音', null), null)
  assert.equal(readIdentity('抖音', { user: { nickname: '   ' } }), null)
  assert.equal(readIdentity('公众号', { user: { nickname: '醒醒老己' } }), null)
  assert.equal(hasIdentityReader('公众号'), false)
})

/** 2026-10-24 实测：抖音 user.avatar_medium.url_list[0]（720）与 larger（1080）都在，
 *  小红书 data.userAvatar 是一张带 imageView2/2/w/80 参数的 xhscdn 直链 */
test('抖音：顺手把头像直链也带出来，没有这个字段时不硬塞空串', () => {
  const withAvatar = readIdentity('抖音', {
    user: { nickname: '醒醒老己', short_id: '981278053', avatar_medium: { url_list: ['https://p3.douyinpic.com/a.jpeg'] } },
  })
  assert.equal(withAvatar.avatar, 'https://p3.douyinpic.com/a.jpeg')
  assert.equal(readIdentity('抖音', WORK_LIST).avatar, undefined)
})

test('小红书：手机号和实名链接不往外传，但头像是传的那一个', () => {
  const who = readIdentity('小红书', { ...XHS_INFO, data: { ...XHS_INFO.data, userAvatar: 'https://sns-avatar-qc.xhscdn.com/avatar/x' } })
  assert.equal(who.avatar, 'https://sns-avatar-qc.xhscdn.com/avatar/x')
  assert.equal(who.phone, undefined)
})

test('小红书：默认那张 80px 缩略图换成 240，详情页摆 48px 圆图才不糊', () => {
  const who = readIdentity('小红书', {
    ...XHS_INFO,
    data: { ...XHS_INFO.data, userAvatar: 'https://sns-avatar-qc.xhscdn.com/avatar/x?imageView2/2/w/80/format/jpg' },
  })
  assert.equal(who.avatar, 'https://sns-avatar-qc.xhscdn.com/avatar/x?imageView2/2/w/240/format/jpg')
})

test('昵称对得上就是本人；对不上就是别人的号', () => {
  const who = readIdentity('抖音', WORK_LIST)
  assert.equal(identityVerdict({ platform: '抖音', nickname: '醒醒老己' }, who), 'match')
  assert.equal(identityVerdict({ platform: '抖音', nickname: '晓丸子君' }, who), 'mismatch')
})

test('判不出身份的平台一律 unknown：宁可判不出，不许拿「读到了数据」冒充「读对了人」', () => {
  assert.equal(identityVerdict({ platform: '快手', nickname: '醒醒老己' }, { nickname: '醒醒老己', id: '1' }), 'unknown')
  assert.equal(identityVerdict({ platform: '抖音', nickname: '晓丸子君' }, null), 'unknown')
})

test('报错点名登记表上另一个号，并带上平台账号 id', () => {
  const acct = { id: '抖音-晓丸子君', platform: '抖音', nickname: '晓丸子君' }
  const rivals = [{ id: '抖音', platform: '抖音', nickname: '醒醒老己' }]
  const msg = identityMismatchError(acct, readIdentity('抖音', WORK_LIST), rivals)
  assert.equal(msg, '后台读到的是「醒醒老己 · 981278053」，也就是登记表上同平台的另一个号「抖音」，登录态其实是别人的，不是「晓丸子君」')
  assert.match(msg, /登录态其实是别人的/)
})

test('读到的昵称不在登记表上时，只报读到的是谁', () => {
  const msg = identityMismatchError({ id: '抖音-晓丸子君', nickname: '晓丸子君' }, { nickname: '路人甲', id: '' }, [])
  assert.equal(identityLabel({ nickname: '路人甲', id: '' }), '路人甲')
  assert.equal(msg, '后台读到的是「路人甲」，登录态其实是别人的，不是「晓丸子君」')
})

/** 「授权账号」那一趟（先扫码后登记）的重复闸：只在同平台的行里认昵称——
 *  三个平台共用「醒醒老己」这一个品牌名，跨平台认名字会把别的平台的号判成已授权。 */
test('同一个号扫第二次认得出来：同名才算在册，跨平台不算', () => {
  const onFile = [{ id: '小红书', platform: '小红书', nickname: '醒醒老己' }]
  const who = readIdentity('抖音', WORK_LIST)
  assert.equal(alreadyAuthorized(onFile, who, '抖音'), null)
  assert.equal(alreadyAuthorized([...onFile, { id: '抖音', platform: '抖音', nickname: '醒醒老己' }], who, '抖音').id, '抖音')
  assert.equal(alreadyAuthorized(onFile, null, '小红书'), null)
})
