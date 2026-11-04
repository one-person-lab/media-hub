import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { readProducts, writeProduct, planProduct, listShotImages, normalizeProduct } from './products-core.mjs'

/** 一个装了品牌档案与两张截图的临时仓库根 */
function fixture(products) {
  const root = join(tmpdir(), `products-${Math.random().toString(36).slice(2)}`)
  const w = (rel, text) => {
    mkdirSync(join(root, rel, '..'), { recursive: true })
    writeFileSync(join(root, rel), text)
  }
  w('config/products.json', JSON.stringify({ _说明: '规矩别丢', products: products ?? [] }, null, 2))
  w('public/shots/a.png', 'png')
  w('public/shots/huohua/b.jpg', 'jpg')
  return root
}

test('新建品牌：追加到清单末尾，_说明 原样留着', () => {
  const root = fixture([{ name: 'BuildHub' }])
  const saved = writeProduct({ name: '醒醒老己小程序', entry: '微信搜「醒醒老己」', facts: ['24 道题', ' 24 道题 ', '约 5 分钟'] }, { root })
  assert.equal(saved.name, '醒醒老己小程序')
  assert.deepEqual(saved.facts, ['24 道题', '约 5 分钟'])
  const j = JSON.parse(readFileSync(join(root, 'config/products.json'), 'utf8'))
  assert.equal(j._说明, '规矩别丢')
  assert.deepEqual(j.products.map((p) => p.name), ['BuildHub', '醒醒老己小程序'])
})

test('改名走 originalName：位置不变，重名拦住', () => {
  const root = fixture([{ name: '醒醒老己' }, { name: 'BuildHub' }])
  const saved = writeProduct({ name: '醒醒老己小程序' }, { originalName: '醒醒老己', root })
  assert.equal(saved.name, '醒醒老己小程序')
  assert.deepEqual(readProducts(root).products.map((p) => p.name), ['醒醒老己小程序', 'BuildHub'])
  assert.throws(() => planProduct({ name: 'BuildHub' }, { originalName: '醒醒老己小程序', root }), /已经有叫/)
})

test('品牌名空就拦住；入口与口径留空允许（没登记的品牌该在向导里被拦住）', () => {
  const root = fixture([])
  assert.throws(() => planProduct({ name: '   ' }, { root }), /品牌名不能空/)
  const { product } = planProduct({ name: '地球 Online' }, { root })
  assert.equal(product.entry, '')
  assert.deepEqual(product.facts, [])
  assert.deepEqual(product.screens, [])
})

test('截图只收 public/ 下真存在的文件，路径与标签都去掉首尾空白', () => {
  const root = fixture([])
  const { product } = planProduct(
    { name: 'X', screens: [{ path: ' public/shots/a.png ', label: ' 答题页 ' }, { path: '' }] },
    { root },
  )
  assert.deepEqual(product.screens, [{ path: 'public/shots/a.png', label: '答题页' }])
  // 文件不存在 / 不在 public/ 下都要当场说破：静默丢掉等于放行一张永远渲染不出来的图
  assert.throws(() => planProduct({ name: 'X', screens: [{ path: 'public/shots/没了.png' }] }, { root }), /截图文件不存在/)
  assert.throws(() => planProduct({ name: 'X', screens: [{ path: 'outside/a.png' }] }, { root }), /要在 public\/ 下/)
})

test('可选截图清单只列真图片，含子目录，路径以 public/ 开头', () => {
  assert.deepEqual(listShotImages(fixture([])), ['public/shots/a.png', 'public/shots/huohua/b.jpg'])
})

test('「归属品牌」的空值写法统一归一成空串，真品牌名原样留着', () => {
  for (const raw of ['无', ' 无 ', '没有', '人格内容', 'none', 'NULL', '-', '—', '', undefined, null]) {
    assert.equal(normalizeProduct(raw), '', `${String(raw)} 应该归一成空`)
  }
  assert.equal(normalizeProduct(' 地球 Online '), '地球 Online')
  assert.equal(normalizeProduct('醒醒老己小程序'), '醒醒老己小程序')
  // 像打错的品牌名不能悄悄抹掉，要留给闸门拦住
  assert.equal(normalizeProduct('地球online'), '地球online')
  // 下一行的项目符号被吃进这一行：那是排版残迹，不是品牌名
  assert.equal(normalizeProduct('- 立项平台：'), '')
})

test('类型留空按应用归一，写了不认识的类型当场拦住', () => {
  const root = fixture([])
  assert.equal(planProduct({ name: '地球 Online' }, { root }).product.type, 'app')
  assert.equal(planProduct({ name: '甲·工作室', type: ' store ' }, { root }).product.type, 'store')
  assert.throws(() => planProduct({ name: 'X', type: '餐饮' }, { root }), /没有这种类型/)
})

test('类型存进去能读回来，_说明 与其余字段不丢', () => {
  const root = fixture([{ name: '老己整装服务', type: 'service', entry: '加微信「laoji-home」' }])
  const saved = writeProduct({ name: '老己整装服务', type: 'service', facts: ['先出报价单再签合同'] }, { root })
  assert.equal(saved.type, 'service')
  assert.equal(saved.entry, '加微信「laoji-home」')
  assert.deepEqual(readProducts(root).products[0].facts, ['先出报价单再签合同'])
})

test('磁盘上没有 type 的老档案：planProduct 从磁盘带出缺键后归一成 app', () => {
  const root = fixture([{ name: '老己记账', entry: '微信搜「老己记账」' }])
  const { product } = planProduct({ name: '老己记账' }, { root })
  assert.equal(product.type, 'app')
  assert.equal(product.entry, '微信搜「老己记账」')
})

test('类型只认注册表自有的键：原型链上的键（constructor / toString）不算类型，当场拦住', () => {
  const root = fixture([])
  // /__product 收任意 POST 体：不拦住的话 type=constructor 会静默落盘，
  // 页签与素材槽拿到一个 TARGET_TYPES 里根本没有的类型
  assert.throws(() => planProduct({ name: 'X', type: 'constructor' }, { root }), /没有这种类型/)
  assert.throws(() => planProduct({ name: 'X', type: 'toString' }, { root }), /没有这种类型/)
})
