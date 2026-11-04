import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** 桌面壳换版本时删哪些目录，写死在这份源码里，删错了就是删他的稿与采集图（10-25 封面全丢事故）。
 *  主进程是 CJS 且要 electron，跑不起来，所以这里钉源码：清单只准列代码目录，数据目录一律走「只补缺」。 */
const MAIN = readFileSync(join(import.meta.dirname, '..', 'electron', 'app-main.cjs'), 'utf8')
const CODE_ONLY = JSON.parse(MAIN.match(/const CODE_ONLY = (\[[^\]]*\])/)[1].replace(/'/g, '"'))

test('换包刷新的目录清单里只有代码，没有他的东西', () => {
  for (const data of ['public', 'config', 'content', 'metrics'])
    assert.ok(!CODE_ONLY.includes(data), `${data} 是数据，rmSync 掉就找不回来`)
  for (const code of ['scripts', 'dist'])
    assert.ok(CODE_ONLY.includes(code), `${code} 是构建产物，换版本必须刷`)
})

test('包内自带的 config 与 public 用「只补缺」落进数据目录，不覆盖已有的', () => {
  const dirs = MAIN.match(/for \(const dir of \[([^\]]*)\]/)
  assert.ok(dirs, '找不到 seed 补缺那一循环')
  for (const dir of ['config', 'public'])
    assert.ok(dirs[1].includes(`'${dir}'`), `补缺清单少了 ${dir}`)
  assert.match(MAIN, /if \(!existsSync\(to\)\) cpSync/, '补缺必须先判存在，否则盖掉他自己改的那份')
})
