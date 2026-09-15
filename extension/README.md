# 自媒体工作台采集（浏览器扩展）

在小红书笔记页点一下插件按钮，笔记自动写入本地自媒体工作台的灵感库（`content/参考资料/`）——复刻「飞书 AI 工作台」视频里的插件体验，数据落本地 md 而不是飞书表。

## 安装（一次性，30 秒）

1. 打开 Chrome（或任何 Chromium 浏览器，Ego Lite 如果开放了扩展入口也可以）
2. 地址栏输入 `chrome://extensions` 回车
3. 右上角打开「开发者模式」
4. 点「加载已解压的扩展程序」→ 选择本目录（仓库里的 `extension/`）
5. 建议点拼图图标 → 把「自媒体工作台采集」固定到工具栏

## 使用

1. 在小红书打开某条笔记详情页
2. 点工具栏插件图标 → 弹窗显示「✓ 当前是笔记页」
3. 点「↗ 采集当前笔记」→ 显示「已写入：content/参考资料/xxx.md」
4. 收尾两步：
   - `npm run gen:data`（灵感库刷新）
   - 对 AI 说「补拆解」→ 按规范把 `analysis:` 块写进刚采集的 md

## 原理

```
popup（识别页面+发按钮）
  → chrome.scripting 注入当前笔记页抓取（标题/正文/作者/赞藏评/标签/首图）
  → POST http://localhost:5173/__collect
  → Vite dev server middleware（vite.config.ts collectApi 插件）
  → scripts/collect-note-core.mjs 落盘（md + 首图）
  → 自动 gen:data 刷新工作台（1-2 秒后灵感库自己出现）
  → 【可选】阿里云百炼自动拆解（analysis 写进 frontmatter，再自动刷新一次）
```

### 开启 AI 自动拆解（可选，推荐）

1. 开通阿里云百炼（ bailian.console.aliyun.com ）→ API-KEY 管理 → 创建 key（`sk-` 开头）
2. 存到本机（不入 git）：
   ```bash
   mkdir -p ~/.config/media-hub && echo 'sk-你的key' > ~/.config/media-hub/dashscope.key
   ```
3. 完成。下次点采集后 5-10 秒，卡片自动亮「AI 拆解」徽章（模型 qwen-plus，单次约 0.001 元）
4. key 改动即时生效，不用重启；没配 key 时一切照常，卡片显示「待拆解」

### 手动命令行兜底

`echo '<链接>' > /tmp/note-url.txt && npm run collect:note`（与扩展共用 `collect-note-core.mjs`）

## 边界

只采集自己浏览、用于个人学习参考的单条笔记；不批量、不评论、不碰他人后台。
