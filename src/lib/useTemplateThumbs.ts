/** 图文模板小样的补渲：模板选择器与素材库共用这一份。
 *  服务端是串行的一把闩，一次点一批就行；成功后由调用方改本地状态并破图缓存，不整页刷——
 *  整页刷会把人正对着的那屏小样连同弹层一起刷没。两处各写一遍就会漂移，所以只留这里。 */
import { holdSelfWrite } from '../data/store'

export type ThumbRenderResult = { rendered: string[]; failed: { key: string; error: string }[] }

export async function renderTemplateThumbs(keys: string[]): Promise<ThumbRenderResult> {
  if (!keys.length) return { rendered: [], failed: [] }
  holdSelfWrite()
  const r = await fetch('/__template-thumb', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ templates: keys }),
  }).then((x) => x.json())
  if (!r.ok && !r.rendered?.length) throw new Error(r.error || '补渲失败')
  return { rendered: r.rendered || [], failed: r.failed || [] }
}
