/** 账号头像落盘：平台给的是会过期、且防盗链的 CDN 直链，界面不能直接引，
 *  所以搬到 public/accounts/ 下再按站内路径引用（对标账号头像同一套路）。
 *
 * 只有一处写：publish-check 回认到「这一行确实是本人」那一刻（scripts/publish-check.mjs 的 assertIdentity）。
 * 拿不到一律返回空串——界面回落平台 logo，不许留一张破图。 */
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const EXT_BY_TYPE = (type) => (type.includes('png') ? 'png' : type.includes('webp') ? 'webp' : 'jpg')

/** 落一张头像，返回站内路径（拿不到返回空串）。key 是账号在本仓的桶名，挡一遍非法字符再当文件名。 */
export async function saveAvatar(url, key, root) {
  const name = String(key || '').replace(/[^a-zA-Z0-9._-]/g, '')
  if (!url || !name) return ''
  try {
    const res = await fetch(url)
    if (!res.ok) return ''
    const ext = EXT_BY_TYPE(res.headers.get('content-type') || '')
    const dir = join(root, 'public/accounts')
    mkdirSync(dir, { recursive: true })
    // 换过一次头像、这次扩展名也变了：旧的那张要清掉，不然界面上还是老照片
    for (const e of ['jpg', 'jpeg', 'png', 'webp']) if (e !== ext) rmSync(join(dir, `${name}.${e}`), { force: true })
    const file = join(dir, `${name}.${ext}`)
    writeFileSync(`${file}.tmp`, Buffer.from(await res.arrayBuffer()))
    renameSync(`${file}.tmp`, file)
    return `/accounts/${name}.${ext}`
  } catch {
    return ''
  }
}
