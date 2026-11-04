/**
 * 视频爆款结构收编的界面这一半：挑出能收的抖音/小红书视频爆款，整批发给 /__video-harvest。
 *
 * 与图文那条（harvestTemplates.ts）的分工是真实的：图文要取像素，只能在浏览器里逐条读图再存；
 * 视频搬的是逐字稿上量出来的节奏，纯文本计算，交给服务端一次算完、一次写盘，界面只管挑和报数。
 *
 * 这里只做一个粗筛——带 ≥3 行「[Ns]」时间码的稿子才值得发过去，判重与量结构的准头在
 * scripts/video-harvest-core.mjs，界面不另立一套标准。
 */
import { candidateVideoTemplates, holdSelfWrite, selectableVideoTemplates, type ViralItem } from '../data/store'

/** 收过的判据：候选与在架条目的 source.noteId，同一条笔记再点不会重复入库 */
export function harvestedVideoNoteIds(): Set<string> {
  return new Set(
    [...selectableVideoTemplates(), ...candidateVideoTemplates()]
      .map((t) => t.source?.noteId || '')
      .filter(Boolean),
  )
}

/** 粗筛：这稿子是不是带时间码的逐字稿（服务端会再判一次，量不出结构照样拒收） */
export function hasTimecodedScript(script: string): boolean {
  let n = 0
  for (const line of String(script || '').split('\n')) {
    if (/^\s*\[\d+(?:\.\d+)?s\]\s*\S/.test(line)) n++
    if (n >= 3) return true
  }
  return false
}

/** 能收的池子：视频形态、有逐字稿、时长在能照着拍的短片区间里、还没收过，按互动分从高到低。
 *  15 秒到 5 分钟这道闸与服务端 video-harvest-core 的 MIN_DUR/MAX_DUR 同口径，
 *  在这里先挡住是为了别把直播切片摆进列表让人白勾一次。 */
export function videoHarvestPool(items: ViralItem[]): ViralItem[] {
  const done = harvestedVideoNoteIds()
  return items
    .filter(
      (v) =>
        v.format !== 'image' &&
        hasTimecodedScript(v.script) &&
        v.durationSec >= 15 &&
        v.durationSec <= 300 &&
        !done.has(v.id),
    )
    .slice()
    .sort((a, b) => (b.heat || 0) - (a.heat || 0) || b.publishedAt.localeCompare(a.publishedAt))
}

export interface VideoHarvestResult {
  saved: { key: string; label: string }[]
  skipped: { id: string; why: string }[]
}

/** 一次发一批：服务端逐条量节奏、判重、落盘，回来给「收进几条、跳了哪几条为什么」 */
export async function harvestVideos(items: ViralItem[]): Promise<VideoHarvestResult> {
  holdSelfWrite()
  const r = await fetch('/__video-harvest', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      mode: 'save',
      items: items.map((v) => ({
        id: v.id,
        platform: v.platform,
        title: v.title,
        url: v.url,
        likes: v.likes,
        collects: v.collects,
        comments: v.comments,
        heat: v.heat || 0,
        script: v.script,
      })),
    }),
  }).then((x) => x.json())
  if (!r.ok) throw new Error(r.error || '这批没收进来')
  holdSelfWrite()
  return { saved: r.saved || [], skipped: r.skipped || [] }
}

/** 候选的去处：转正进可选列表，或删掉。走的是同一个端点的另两个 mode。 */
export async function settleVideoCandidate(mode: 'promote' | 'drop', key: string): Promise<{ templateKey: string; label: string }> {
  holdSelfWrite()
  const r = await fetch('/__video-harvest', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode, template: key }),
  }).then((x) => x.json())
  if (!r.ok) throw new Error(r.error || '没办成')
  holdSelfWrite()
  return { templateKey: String(r.templateKey), label: String(r.label || '') }
}
