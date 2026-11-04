/**
 * Electron 桌面壳：主进程 = 本地服务（复用 scripts/serve.mjs 的 createWorkbenchServer）+ 一个窗口。
 * 服务不另起子进程——就跑在主进程里，窗口只是浏览器；采集/推草稿照旧 spawn ego-browser。
 * 只有这一条路开实时构建（打包态走 app-main.cjs，不传 liveBuild）：改完代码窗口自己变。
 * 启动：npm run app
 */
import { app, BrowserWindow, shell } from 'electron'
import { createWorkbenchServer } from '../scripts/serve.mjs'

const PORT = Number(process.env.PORT) || 5173

app.setName('创作者增长平台')

// 只允许一个实例：重复启动时唤起已有窗口
if (!app.requestSingleInstanceLock()) app.quit()
app.on('second-instance', () => BrowserWindow.getAllWindows()[0]?.show())

function createWindow(url) {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    title: '创作者增长平台',
    autoHideMenuBar: true,
  })
  // 页面里的外链（平台后台、原文链接）交给系统浏览器，工作台窗口内只留工作台
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })
  win.loadURL(url)
}

app.whenReady().then(() => {
  const server = createWorkbenchServer({
    // 开发态实时：改 src 下的 .vue/.ts/.css/.svg 会重跑一次 vite build，产物一落地就重载窗口。
    // 用 reloadIgnoringCache：静态服务不给 index.html 带校验头，普通 reload 可能又端回旧的那份壳。
    liveBuild: {
      onRebuilt: () => BrowserWindow.getAllWindows().forEach((w) => w.webContents.reloadIgnoringCache()),
    },
  })
  let triedFallback = false
  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE' && !triedFallback) {
      triedFallback = true
      console.log(`[app] ${PORT} 被占用（dev server 在跑？），改用随机端口`)
      server.listen(0, '127.0.0.1')
    } else {
      console.error('[app] 本地服务启动失败：', e)
      app.quit()
    }
  })
  // listen 失败时回调也会带 err 触发，故只在真正 listening 时开窗
  server.listen(PORT, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${server.address().port}`
    console.log(`[app] 工作台已启动：${url}`)
    createWindow(url)
  })
})

app.on('window-all-closed', () => app.quit())
