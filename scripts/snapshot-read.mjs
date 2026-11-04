import { readFileSync } from 'node:fs'

/** 快照式扫描的安全读：build-data 是「先列目录、再逐个读」，列与读之间文件会被搬走。
 *  2026-10-25 实测：推送队列的排期把 md 从 待发布/ rename 进 已排期/，同一轮重建正好读到旧路径，
 *  整个 gen:data 崩在 `ENOENT … 快手/待发布/【建立个人SOP…】.md`，界面弹「界面数据断了」。
 *  本轮快照里没有的文件不是数据坏了，跳过即可；但只认 ENOENT —— 权限、编码这类真故障要照常抛出来，
 *  否则就是拿静默漏稿换一个不报错的界面。 */
export function readIfThere(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch (e) {
    if (e?.code === 'ENOENT') return null
    throw e
  }
}
