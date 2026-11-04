/**
 * 复制到剪贴板：writeText 在部分内核（CDP 驱动 / Electron）下会永久挂起，
 * 因此限时 1.5s 后退回 execCommand。失败抛错，由调用方提示。
 */
export async function copyToClipboard(text: string): Promise<void> {
  try {
    await Promise.race([
      navigator.clipboard.writeText(text),
      new Promise((_, rej) => setTimeout(() => rej(new Error('剪贴板写入超时')), 1500)),
    ])
    return
  } catch {
    /* 走同步兜底 */
  }
  const ta = document.createElement('textarea')
  ta.value = text
  ta.style.position = 'fixed'
  ta.style.opacity = '0'
  document.body.appendChild(ta)
  ta.select()
  const ok = document.execCommand('copy')
  ta.remove()
  if (!ok) throw new Error('浏览器拒绝写入剪贴板')
}
