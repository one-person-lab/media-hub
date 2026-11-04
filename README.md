# Loop · 一个人的创作者增长平台

把「**灵感 → 选题 → 创作 → 排期 → 发布 → 复盘**」做成一条本地流水线。
机器把重复的活干完、自己回头核对一遍结果，最后那一下永远由你点。
英文名 Loop，中文界面叫「创作者增长平台」；仓库和包名仍叫 `media-hub`。

面向**一个人做一条账号**的场景——不是矩阵，不是团队协作，不是 SaaS。

**想先看长什么样**：clone 下来 `npm install && npm run dev` —— 本机那一份不设登录也不设墙，每一站都是完整的，看到的都是你自己机器上的东西。
[media.buildhub.cn](https://media.buildhub.cn) 是我自己那条线在跑的那一份：真数据，要邮箱验证码，且只放名单里的邮箱；采集、改稿、推草稿这些要动本机浏览器的动作，网页版会直接指回桌面客户端。

---

## 设计立场

这几条决定了它长什么样，也是它和「自媒体 SaaS」最大的区别：

| 立场 | 具体做法 |
|------|----------|
| **一条流水线，不是十个工具** | 五个阶段共用同一份数据和同一条队列：采回来的直接进选题、立项的一次建齐各平台稿、推进草稿箱后自动出现在日历、日历回检的结论又喂给下一个选题。不用在文档、表格、各平台后台之间来回搬内容 |
| **一个人一条线** | 不做多账号矩阵、不做团队权限、不做多人协作。就一个账号，一条内容流水线 |
| **推广对象可插拔** | 引擎里**不写死**任何产品或品牌。推广什么由 `config/` 决定，可换 App / 网站 / 店铺 / 课程 / 服务 |
| **发布保持人在环** | 平台风控（验证码）绕不开，也合规。工具把内容推进草稿箱，最后一下由你点 |
| **本地优先** | 默认只用本地文件 + 你自己的模型 key。不上传任何内容到第三方 |

---

## 一条流水线

侧边栏就是流程阶段，不是随便排的菜单：

```
            总览                 内容看板 · 一眼看清流水线各列
              │
   ┌──────────┴──────────┐
   ▼                     ▼
① 收集                 灵感库 / 爆款采集 / 对标账号  手动采整篇，自动采日报
   │
   ▼
② 立项                 选题库              选题池卡片过判据才立项
   │
   ▼
③ 创作                 创作台               按账号分组的创作稿
   │
   ▼
④ 发布                 发布日历            一篇内容一条，点日期展开平台泳道
   │
   ▼
⑤ 复盘                 数据复盘            按账号回填数据，好结构反哺选题
```

收集有两条线。**灵感库**（手动）：刷到好内容，浏览器扩展一键入库（整篇笔记 + 逐页源图），
或 `npm run capture -- '<url>'` 链接捕获。**爆款采集**（自动）：`npm run viral` 按
`config/viral.json` 里的定位关键词去搜最热，每天取 Top 5 条卡片（封面/标题/作者/点赞/链接），
收尾当场本机 OCR 把完整脚本扒进卡里。
两条线都**没有封面的不收**——封面是这条内容值不值得看的第一道判断。

选题在 `content/Projects/选题池/`（一张卡 = 一个决定「要做」的选题）；
正文在 `content/Projects/发布排期/<账号>/`。状态由**文件位置 + 字段**推导，不需要手动维护：

- 在 `发布排期/<账号>/待发布/` → 待排期
- 移到 `已排期/YYYY-MM/` → 已排期 / 已发布
- 填了「发布链接」→ 必为已发布

---

## 数据流

```
content/**/*.md          ← 你写的内容（唯一事实源）
      │  scripts/build-data.mjs 解析
      ▼
src/data/generated.json  ← 中间产物（已在 .gitignore，构建时自动生成）
      │
      ▼
src/data/store.ts → 各 View 渲染
```

改内容不用改代码：**新增/编辑 md → 界面刷新**。
想换个数据底座（比如以后接飞书/Notion），只替换解析脚本，界面层不用动。

---

## 快速开始

```bash
npm install
npm run dev          # 会自动先跑 gen:data，然后起 dev server
```

打开后先看 `content/Knowledge/`——`00-定位.md` 是**唯一定位源**，`创作规范.md` 是写稿口径基准。开源版里这两份是随导出注入的模板，把它们改成你自己的规范。

### 采集和发布这条线要先把浏览器接上

界面、`gen:data`、渲图卡 clone 完就能跑；但**所有平台侧的动作（采集、发布状态检测、推草稿、收藏搬运、授权）都走 ego-browser 里你已登录的会话**，本机零凭证落地（不做云授权 / OAuth）。换一台机器要人工完成这四步，无法脚本化：

```bash
# 1) 装 ego-browser CLI，启动 Ego Lite，在它的界面里建一个干净 profile
#    （浏览器扩展自动建的那种 profile 会撞平台风控）

# 2) 登记你自己的号：账号页、发布泳道、推草稿用的脚本都读这一份
cp config/accounts.example.json config/accounts.json   # 改 nickname，这文件不进 git
#    之后加号（包括同一个平台的第二个号）都在工作台「授权」页点「新增账号」：选平台、填昵称即可。
#    账号身份、快照桶名、独立浏览器 profile 由工作台按 config/platforms.json 补齐，不用手改 JSON

# 3) 在 Ego Lite 里逐平台扫码登录（小红书 / 抖音 / …）
#    入口在工作台「账号」页：未登录的卡片上是「去授权」，二维码直接摆在弹层里

# 4) 回认登录态并采一次数，通了才算接上
npm run publish-check
```

`ffmpeg` / `ffprobe` 不用往机器上装：打开「设置 · 环境」页，这两张卡上点「安装」就落到包内 `bin/`（等价命令 `npm run fetch:bin`）。同一页会逐条给出本机环境的已装 / 未装读数，缺哪条一眼看得见。

### 可选的 AI 能力

创作脚本要调模型，key 放在仓库外：

```bash
mkdir -p ~/.config/media-hub
echo '你的KEY' > ~/.config/media-hub/dashscope.key
```

任何**兼容 OpenAI Chat Completions 协议**的服务都能接（默认指向阿里云百炼）：

```bash
LLM_BASE_URL=https://api.openai.com/v1 LLM_MODEL=gpt-4o-mini npm run dev
```

### 登录：邮箱验证码、GitHub 与 Google（可选）

数据都在本机，本机开发不登也进得去。这道门是给**部署到公网那份**准备的：没会话的人打开只看得到空位。

```bash
cp .env.example .env      # .env 不进 git，也不进公开快照
```

- **邮箱验证码**：填 `SMTP_*` 五项。没配发件箱也能登——验证码打进 dev server 日志，去日志里抄。
- **GitHub**：到 https://github.com/settings/applications/new 建一个 OAuth App，回调地址填 `http://<你的域名>/__auth/github/callback`，把 Client ID 与 Secret 填进 `.env`。
- **Google**：到 https://console.cloud.google.com/apis/credentials 建一个「Web 应用」型凭据，已获授权的重定向 URI 填 `http://<你的域名>/__auth/google/callback`（本机开发用 `http://127.0.0.1:5173/__auth/google/callback`），OAuth 同意屏幕只勾 openid / email / profile，把 Client ID 与 Secret 填进 `.env`。这一条走授权码 + PKCE，服务端只问一次「这个人是谁」，不经手 Google 的 token 之外的任何权限。
  换 token 与问身份这两步由服务端发请求，所以**这台机器要能连上 Google**：浏览器打得开 accounts.google.com 不等于进程也打得开。`npm run dev` / `serve` / `app` 会先读一次 macOS 系统代理再启动，配了代理的机器不用管；只有 SOCKS 或在 Linux/Windows 上，就自己带上 `HTTPS_PROXY` 与 `NODE_USE_ENV_PROXY=1`。境内的云主机多半直连不通，那种机器就别填这两行——填了界面上只会多一颗点了报错的按钮（没填凭据时按钮根本不出现）。
- **开放名单**：挂公网的那份再填 `WORKBENCH_ALLOW_EMAILS`（逗号分隔的邮箱）。只有名单里的邮箱发得出验证码，GitHub 与 Google 回来时也过同一道名单；没配就是名单为空，一个都不放。本机那份不看这一项。

三条都没配时，登录弹层只剩一句说明——那种机器本来也不需要有这道门。同一个邮箱不管是验证码、GitHub 还是 Google 进来的，都并到同一个号，不会多出几个分身。

---

## 接入你自己的产品

引擎不认品牌，只认 `config/` 里的一份配置。复制一份改字段即可：

```bash
cp config/targets/example.mjs config/targets/my-product.mjs
```

然后改 `config/active-target.mjs` 里的那一行 import，指向你的文件。

| 字段 | 作用 |
|------|------|
| `type` | `app` / `website` / `shop` / `course` / `service` |
| `brandName` | 品牌名，写稿时注入 |
| `productPerspective` | 产品视角要点，写作时的落点 |
| `signature` | 平台签名 |
| `brandTag` | 品牌话题标签 |
| `landing` | **转化落点**：内容把人送到哪。自动拼 UTM，可按条归因 |

详见 `config/README.md`。

### 关联：内容从哪来、把人送到哪

工作台和你的产品之间有三个接口，目前实现了**出口**：

| 接口 | 做什么 | 状态 |
|------|--------|------|
| 出口 | `landing` 生成带 UTM 的落地链接，复制到配文 / 评论区 / 阅读原文 | ✅ 已实现 |
| 入口 | 从产品侧取料（GitHub release / changelog）自动变选题 | ⬜ 待做 |
| 回流 | 转化数据（下载量 / Stars / 访问）采集，与内容数据并列复盘 | ⬜ 半成品（可手填） |

转化数据现在填在文章 md 的「## 转化数据」段（一行一个「指标：数值」），在「数据复盘」里看。

---

## AI 部分能做什么

| 环节 | 做什么 | 依赖 |
|------|--------|------|
| 采集 | 从创作者后台抓数据 → `metrics/`，正则按「中文标签 + 数值」提取，不依赖 CSS 类名 | 浏览器自动化（如 ego-browser）+ 已登录的创作者后台 |
| 拆解 | 读一篇爆款笔记，输出标题句式/钩子/骨架/可偷手法（YAML） | LLM |
| 创作 | 按选题 + 知识库方法论 + 拆解结论，生成原创正文/配文/标签/首评 | LLM |
| 复盘 | 回填数据，比对不同结构的表现 | 无 |

**原创铁律**：拆解只产出「结构结论」，创作只读结论、不读原文。
具体内容必须结合你自己的产品视角和生活场景重写。

---

## 目录结构

```
├── config/              推广对象配置（可插拔）
│   ├── promotion-target.mjs   类型注册表 + makeTarget()
│   ├── targets/               每个产品一份
│   ├── accounts.example.json  账号登记模板（复制成 accounts.json，不进 git）
│   ├── platforms.json         平台模板表：授权页「新增账号」照它补齐一个号
│   └── active-target.mjs      ← 切换点，改这一行
├── content/             内容库（你的数据，见 content/README.md）
├── src/                 Vue 3 界面
│   ├── views/           14 个视图
│   ├── components/
│   └── data/store.ts
├── scripts/
│   ├── build-data.mjs   content → generated.json
│   ├── collect-*.mjs    采集（浏览器侧）
│   └── publish-*.mjs    推草稿（浏览器侧，只到草稿箱为止）
└── extension/           浏览器扩展（采集入口）
```

技术栈：Vue 3（`<script setup>`）+ TypeScript + Vite + Tailwind CSS 4，
视觉走 **Neo-Brutalism**（粗描边、硬投影、高饱和撞色），图标用 Phosphor。

---

## 这个仓库不包含什么

诚实说明，免得你找：

- **不包含原作者的方法论**。`content/Knowledge/` 两份是随导出注入的**模板**。
  运营方法属于个人 know-how，不在开源范围。
- **不包含原作者的赛道关键词与目标值**。`config/viral.json`、`config/benchmarks.json`、`config/goals.json`
  随导出换成中性示例（字段一致，脚本照跑）——关键词等于把「你在哪个赛道、目标多大」公开。
- **不包含采集到的第三方内容**（他人笔记原文、封面图、对标账号头像）。那有版权问题，且与「只取结构不抄原文」的原则冲突。
- **不包含任何真实账号数据**（粉丝/曝光/点击率）与账号登记（`config/accounts.json` 只出模板）。
- **不含一键全自动发布**。平台验证码是风控，必须人点最后一下。

---

## 贡献

欢迎 issue / PR。有两点请先对齐：

1. **不要把引擎和具体产品耦合起来**。新增能力应该是通用的，产品差异走 `config/`。
2. **不要提交真实运营数据和第三方内容**。

---

## License

[MIT](LICENSE)
