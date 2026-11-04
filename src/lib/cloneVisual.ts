/** 候选模板的收尾动作：转正进在架，或连它独占的那层皮一起删掉。
 *  模板选择器和素材库都要这一刀，写两份就会漂移，所以只留这里。
 *  开窗 holdSelfWrite：这两个动作各引出一次数据重建，那一下整页刷会把人正对着的画廊刷没。 */
import { holdSelfWrite } from '../data/store'

export async function settleCloneVisual(mode: 'promote' | 'drop', template: string): Promise<string> {
  holdSelfWrite()
  const r = await fetch('/__clone-visual', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode, template }),
  }).then((x) => x.json())
  if (!r.ok) throw new Error(r.error || '没改动')
  return String(r.templateKey || template)
}
