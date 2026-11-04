/** 云端同步备份的判定：一次改动里，哪些是「内容事实源」该进自动快照，哪些是人手写代码不该被机器提交。
 *
 * 单独成模块是为了能被测试直接喂一份假清单，不用碰盘也不起子进程（跑真动作的那半在 backup-push.mjs）。
 * 方向只有一条：本机 → 云端。这一层永远只推，不拉、不 merge——本地是事实源，云端只是镜像。
 */

/** 内容事实源在哪几个目录：稿子与灵感（content）、口径与排班（config）、渲染出来的图卡与截图（public）。
 *  真凭据（config/accounts.json、metrics/account-cookies/）早就被 .gitignore 挡在仓外，这里不用重复设防。 */
export const BACKUP_PREFIXES = ['content/', 'config/', 'public/']

/** 新文件超过这个字节数不进备份：git 不是视频仓库。
 *  采集源片那种由 .gitignore 先挡住，这条兜的是「今天突然往 public 里塞了一部成片」。 */
export const MAX_NEW_FILE_BYTES = 8 * 1024 * 1024

/** 能收自动快照的远端，写死在这里而不是「所有远端」：
 *  本仓另有一个 `oss-public` 指向开源那一个公开仓，一次误推就等于把号主的稿子和采集记录全公开。 */
export const PUSH_REMOTES = ['origin', 'cloud']

/** 无论如何都不许推的远端：名单里出现过就直接拒，连命令行参数也拦。 */
export const FORBIDDEN_REMOTES = ['oss-public']

export const isBackupPath = (path) => {
  const p = String(path || '').replace(/\\/g, '/')
  return BACKUP_PREFIXES.some((prefix) => p.startsWith(prefix))
}

/** 一份改动清单 → 这次备份该怎么动。
 *  `tracked` 是相对 HEAD 已改/已删的入库文件（删除的没有字节数，照收——记的就是那次删除）；
 *  `untracked` 是还没入库的新文件，带本机大小。
 *  新文件里那些既不在内容目录、又本来就没入过库的（别的工程落地的渲染产物）不报——
 *  它们本来就跟这台机器的备份无关，报出来只会把 1200 行垃圾摆在人面前。 */
export function planBackup({ tracked = [], untracked = [] } = {}) {
  const stage = []
  const skip = []
  const code = []
  for (const f of tracked) {
    if (isBackupPath(f.path)) stage.push(f.path)
    else code.push(f.path)
  }
  for (const f of untracked) {
    if (!isBackupPath(f.path)) continue
    if (Number(f.bytes) > MAX_NEW_FILE_BYTES) { skip.push(f.path); continue }
    stage.push(f.path)
  }
  return { stage, skip, code, changed: stage.length > 0 }
}

/** 提交标题：一眼能看出这是机器拍的快照、哪一天的、动了几个文件。
 *  带「自动」两个字是给人看的——以后翻历史想找自己那次改动，这条得能一跳就跳过。 */
export const commitTitle = ({ day, clock, files }) =>
  `chore(backup): ${day} ${clock} 内容快照（${files} 个文件·自动）`

/** 远端名单过一遍闸：不在可推名单里的（含公开仓）一律拒，报错要说清去哪改。 */
export function pickRemotes(requested, available) {
  const want = (requested || []).filter((r) => String(r || '').trim())
  if (!want.length) return { ok: false, error: `没定出要推哪个远端：可推的名单是 ${PUSH_REMOTES.join('、')}，本机一个都没配上` }
  const bad = want.filter((r) => FORBIDDEN_REMOTES.includes(r) || !PUSH_REMOTES.includes(r))
  if (bad.length) return { ok: false, error: `这些远端不在自动备份的名单里：${bad.join('、')}（可推的只有 ${PUSH_REMOTES.join('、')}）` }
  const missing = want.filter((r) => !available.includes(r))
  if (missing.length) return { ok: false, error: `本机还没有这些远端：${missing.join('、')}——先按脚本头上那几行加一条` }
  return { ok: true, remotes: want }
}
