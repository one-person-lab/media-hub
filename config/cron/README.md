# 定时采集任务定义

这四份文件是四个每日定时任务的**定义事实源**：触发时间、要跑的命令、成功判据、
失败时的铁律与报告格式，全部以本目录为准。

任务实际调度不住在仓库里。每天那五趟由**装机版桌面应用自己**排班跑（表在 `config/auto-run.json`，
见 `docs/ONBOARDING.md`），本机 crontab 为空，Qoder cron 里那四条已于 2026-10-23 关掉——
留着会和桌面版撞同一个点、互相占住浏览器。

本目录仍是判据事实源：跑什么命令、什么叫成功、失败时的铁律与报告格式，全部以这里为准。
不在桌面应用里跑、想让脚本自己定时（仓库开发态）时，照本目录文件在目标调度器里**原样重建**即可——
指令与调度器无关，任何能「定时把一段指令交给 Agent 执行」的工具都能承接
（crontab + 脚本只跑命令，跑不了判据与报告，建议交给 Agent）。

| 文件 | 时间 | 命令 |
|---|---|---|
| `viral-collect.md` | 每天 07:40 | `npm run viral` |
| `benchmark.md` | 每天 09:05 | `npm run benchmark`（**2026-09-30 起暂停**，见该文件顶部状态） |
| `daily-collect.md` | 每天 21:47 | `npm run collect` + `npm run publish-check` + `npm run favorites` |
| `publish-check-morning.md` | 每天 08:42 | `npm run publish-check` |

四个任务共有的前置（详见 `docs/ONBOARDING.md`）：

- Ego Lite 浏览器已装、已登录对应平台创作者/前台会话（登录态失效时任务只报告，不破解）
- 项目根目录 = 仓库根；`npm run gen:data` 是每轮的收尾硬步骤，挂了界面就是空数据
