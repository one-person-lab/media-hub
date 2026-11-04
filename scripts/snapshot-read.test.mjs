import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { readIfThere } from './snapshot-read.mjs'

/** 每次新建一个随机目录：竞态测试要真把文件删掉，不能共用夹具 */
const dir = () => {
  const root = join(tmpdir(), `snapshot-read-${Math.random().toString(36).slice(2)}`)
  mkdirSync(root, { recursive: true })
  return root
}

test('文件在就读得到原文', () => {
  const root = dir()
  const p = join(root, 'a.md')
  writeFileSync(p, '# 标题\n')
  assert.equal(readIfThere(p), '# 标题\n')
  rmSync(root, { recursive: true, force: true })
})

test('列完之后文件被搬走 → 返回 null，不把整轮重建炸掉', () => {
  // 这就是排期改名那一刻：build-data 先 walk 到 待发布/x.md，
  // 推送队列把它 rename 进 已排期/，等 .map 读它时已经是 ENOENT
  const root = dir()
  const p = join(root, '待发布', 'x.md')
  mkdirSync(join(root, '待发布'), { recursive: true })
  writeFileSync(p, '# x\n')
  rmSync(p)
  assert.equal(readIfThere(p), null)
  rmSync(root, { recursive: true, force: true })
})

test('只吞「文件没了」：目录、坏路径这类真故障照常抛', () => {
  const root = dir()
  // 对目录 readFileSync 抛 EISDIR——这类问题必须让人看见，不许咽成静默漏稿
  assert.throws(() => readIfThere(root), (e) => e.code === 'EISDIR')
  rmSync(root, { recursive: true, force: true })
})
