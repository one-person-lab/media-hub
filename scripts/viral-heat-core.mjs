#!/usr/bin/env node
/**
 * 爆款热度：一条采集卡「有多爆」的唯一算法。
 *
 * 为什么要有独立一份：采集线按它排序取 Top、build-data 把它算成卡上的读数、素材库收编时按它挑模板、
 * 界面只显示它。四处各写一遍「赞+藏+评」迟早对不上，界面上的排序就会和当天真正入库的那批不是一回事。
 *
 * 权重口径：赞 1、藏 2、评 3。
 *  评论最贵——愿意打字的人比愿意点一下的少一个量级，评论区吵起来的东西才是「有人在跟你聊」；
 *  收藏居中——干货类笔记靠「先存着」活着；赞是地板，情绪类爆款主要靠它。
 *  三个读数缺一个就按 0 计：平台没给不等于 0 分，但排序需要一个可比的数，缺的少算就是保守估计。
 */

/** 「1.2万」/「3.5千」/「123」/123 → 数字；认不出来给 0 */
export function toCount(s) {
  const t = String(s ?? '').trim()
  if (/^\d+$/.test(t)) return Number(t)
  const m = t.match(/([\d.]+)\s*([万千wW]?)/)
  if (!m) return 0
  const n = parseFloat(m[1])
  if (!Number.isFinite(n)) return 0
  const u = m[2]
  return Math.round(n * (u === '万' || u.toLowerCase() === 'w' ? 10000 : u === '千' ? 1000 : 1))
}

/** 互动分：三个读数都缺就是 0（等于「这条没热度证据」，不是「热度低」——界面要能分辨） */
export function heatScore(item = {}) {
  return toCount(item.likes) + toCount(item.collects) * 2 + toCount(item.comments) * 3
}

/** 三个读数一个都没采到：热度这一档就不参与排序，别把「没读到」当成「不火」 */
export function hasHeatData(item = {}) {
  return [item.likes, item.collects, item.comments].some((v) => toCount(v) > 0)
}
