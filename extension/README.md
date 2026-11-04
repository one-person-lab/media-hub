# 创作者增长平台采集（浏览器扩展）

在小红书笔记页或抖音作品页点一下插件按钮，内容自动写入本地创作者增长平台的「灵感库」（`content/Inbox/采集笔记/`）——整篇正文、互动数据、标签，图文类还会把**轮播的每一页原图**存下来，在工作台里可以逐页看原帖。数据落本地 md 而不是飞书表。

支持范围：
- **小红书**笔记详情页（`xiaohongshu.com/explore/...`）：正文 + 逐页源图
- **抖音**图文帖（`douyin.com/note/...`）：正文 + 逐页源图
- **抖音**视频（`douyin.com/video/...`）：封面 + 文案 + 互动数据，另存 `videoSrc`；服务端入库时把源片搬进 `public/inspiration/<笔记id>/source.mp4`，供本机抽帧扒口播脚本与工作台就地播
- **抖音沉浸弹窗**（在搜索页/精选页点卡片打开、URL 带 `?modal_id=<id>`、页面不跳转的那种形态）同样支持；落盘时统一换成规范作品链接，不存会过期的搜索页 URL

## 安装（一次性，30 秒）

工作台侧栏「采集插件」那一屏有颗「安装插件至 Chrome」按钮，点一下把插件目录路径复制走，剩下三步照着做即可。装好后回到那一屏，按钮自己会变成「插件已安装」——判据是插件在本机页面上留的版本号（`clipper-flag.js`）。手动装：

1. 打开 Chrome（或任何 Chromium 浏览器，Ego Lite 如果开放了扩展入口也可以）
2. 地址栏输入 `chrome://extensions` 回车
3. 右上角打开「开发者模式」
4. 点「加载已解压的扩展程序」→ 选择本目录（仓库里的 `extension/`）
5. 建议点拼图图标 → 把「创作者增长平台采集」固定到工具栏

## 使用

1. 在小红书/抖音打开某条笔记（作品）详情页
2. 点工具栏插件图标 → 弹窗顶上一行绿点报「小红书笔记页已识别 / 抖音作品页已识别」
3. 点「采集当前笔记」→ 按钮转「已采集」，下面绿框显示「已写入：content/Inbox/采集笔记/xxx.md」+ 源图页数；若这条已有选题卡，会直接告知选题名
4. 收尾不用你动手：工作台自动扒脚本 → 自动按五层框架拆解写回 `analysis:`（缺源料时卡上留「待拆解」，详情页点「补扒脚本」后会自动重拆）

## 原理

```
popup（识别页面+发按钮）
  → chrome.scripting 注入当前笔记页抓取（标题/正文/作者/赞藏评/标签/轮播全部图）
  → POST http://localhost:5173/__collect
  → Vite dev server middleware（vite.config.ts workbenchServer 插件）
  → scripts/collect-note-core.mjs 落盘（md → content/Inbox/采集笔记/，源图 → public/inspiration/<笔记id>/page-NN.<ext>）
  → 自动 gen:data 刷新工作台（1-2 秒后灵感库里自己出现）
```

采集即出稿再即拆解：新卡入库后工作台立刻自动扒「## 脚本」，全程在本机做、不花 token 也不外发——图文用 macOS Vision 逐页认图内文字（`tools/ocr.swift`），视频用入库时搬回的源片（`public/inspiration/<笔记id>/source.mp4`，直链是签名地址、几小时就 403，不落盘过两天就播不了也扒不了）抽帧认硬字幕，画面没烧字幕才退到 whisper.cpp 本地语音转写（约 1-5 分钟，扒完页面自己刷新）。

**视频帖的直链是脚本的唯一入口**，插件按三条来源依次找：播放器 `currentSrc` 的 https 直链 → 资源计时里播放器真正拉的 `media-video`/mp4 → 页面自带作品数据（`_ROUTER_DATA`）里的 `playApi`；一条都没有时插件会先把播放器叫醒（静音 `play()`）再等 1.5 秒重找，最多三轮。抓取跑在页面主世界（`world: 'MAIN'`），否则读不到这些页面自带的数据。三条都拿不到才留空，并在弹窗上明说「没拿到视频源片：等画面开始播再采一次」——缺直链就是缺脚本，事后补不回来；拿到了弹窗会报「源片已存：工作台详情里能直接播」。脚本一出稿，服务端接着用内置引擎按五层框架拆解、把 `analysis:` 块写回卡里（框架见 `content/Knowledge/爆款拆解.md`），拆完自动刷新；没配 API key 时这一步跳过，卡保持「待拆解」。

图标：与工作台 `public/favicon.svg` 同一品牌符号，母版在 `extension/icons/icon.svg`；改图形后需重导 16/32/48/128 PNG。

### API key（创作台「AI 写这一版」用）

1. 开通阿里云百炼（ bailian.console.aliyun.com ）→ API-KEY 管理 → 创建 key（`sk-` 开头）
2. 存到本机（不入 git）：
   ```bash
   mkdir -p ~/.config/media-hub && echo 'sk-你的key' > ~/.config/media-hub/dashscope.key
   ```
3. key 改动即时生效，不用重启；没配 key 时采集与拆解照常，只有创作台的 AI 写稿会报「未配置 API key」

### 手动命令行兜底

`echo '<链接>' > /tmp/note-url.txt && npm run collect:note`（与扩展共用 `collect-note-core.mjs`）

## 边界

只采集自己浏览、用于个人学习参考的单条笔记；不批量、不评论、不碰他人后台。
