import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { targetForDraft, targetForProduct } from './target-registry.mjs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/* 这几条认的是本机在用的那几份推广对象档案（config/targets/*.mjs）与一篇真稿。
   开源副本不带它们：里面是自家品牌、账号名与小程序 ID，所以那边整组跳过，本机照跑。 */
const LOCAL_TARGETS = existsSync(join(ROOT, 'config/targets/xingxing.mjs'))
const TARGET_SKIP = LOCAL_TARGETS ? {} : { skip: '需要本机推广对象档案与真稿，开源副本不带' }

test('稿上写谁就挂谁的落地链接：醒醒的稿不会沾上别家的口令', TARGET_SKIP, () => {
  const { target, product } = targetForDraft('- 归属品牌：醒醒老己小程序\n', { root: ROOT })
  assert.equal(product, '醒醒老己小程序')
  assert.equal(target.brandName, '醒醒老己')
  assert.match(target.landing.byPlatform['公众号'].url, /^#小程序:\/\/醒醒老己\//)
})

test('换 BuildHub 的稿就是另一套：它没有小程序口令，公众号那一栏就是空', TARGET_SKIP, () => {
  const { target } = targetForDraft('- 归属品牌：BuildHub\n', { root: ROOT })
  assert.equal(target.brandName, '技能资产库 BuildHub')
  assert.equal(target.landing.byPlatform['公众号'].url, '')
})

test('一稿一品牌：归属品牌写了两个就拦住，不替人挑一个挂上', () => {
  assert.throws(
    () => targetForDraft('- 归属品牌：醒醒老己小程序 / 醒醒 App\n', { root: ROOT }),
    /一稿一品牌/,
  )
  assert.throws(() => targetForDraft('- 归属品牌：没登记过的产品\n', { root: ROOT }), /对不上品牌档案/)
})

test('老稿没写归属品牌才回落到全局切换点', () => {
  const { target, product } = targetForDraft('# 一篇没标产品的旧稿\n', { root: ROOT })
  assert.equal(product, '')
  assert.ok(target?.brandName, '兜底要拿得到当前 active-target')
})

test('「归属品牌：无」就是不挂品牌：照人格内容放行，不拦推送', () => {
  for (const line of ['- 归属品牌：无\n', '- 归属品牌：  无  \n', '- 归属品牌：人格内容\n', '- 归属品牌：—\n']) {
    const { target, product } = targetForDraft(`# 一篇人格内容的稿\n\n${line}`, { root: ROOT })
    assert.equal(product, '', `${line.trim()} 应该被当成不挂产品`)
    assert.ok(target?.brandName, '兜底要拿得到当前 active-target')
  }
})

test('那篇生命力测试稿现在挂的是醒醒自己的口令', TARGET_SKIP, () => {
  const md = readFileSync(join(ROOT, 'content/Projects/发布排期/公众号/待发布/你现在的生命力，是哪一种？.md'), 'utf8')
  const { target } = targetForDraft(md, { root: ROOT })
  assert.match(target.landing.byPlatform['公众号'].url, /^#小程序:\/\/醒醒老己\//)
})

test('按产品名直接取：没登记 target 的产品返回 null，不抛', () => {
  assert.equal(targetForProduct('创作者增长平台', { root: ROOT }), null)
  assert.equal(targetForProduct('不存在的产品', { root: ROOT }), null)
})
