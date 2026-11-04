# 配置目录 config/

这里放两类东西：**推广什么**（PromotionTarget，可插拔）和**用哪些号发**（账号登记与采集口径）。

## 推广对象（PromotionTarget）

「解耦底座」：**引擎不写死任何具体产品**，推广什么由这里的配置决定。

- `promotion-target.mjs` —— 类型注册表 `TARGET_TYPES`（app / website / shop / store / service / course / other）+ `makeTarget()` 工厂 + `targetUi()` 界面投影。每种类型带默认「转化目标」「变现 / 复盘指标口径」，外加一组界面描述符（素材槽 `slots`、「那一行怎么问」`entryLabel`、状态词 `statuses`），品牌页与新建弹层只从 `targetUi()` 取。
- `targets/<名>.mjs` —— 一个具体的推广对象实例。目前只有 `example.mjs`（中性示例，APP 型）。
- `active-target.mjs` —— 当前激活的实例（切换点）。

## 如何新增一个推广对象（比如推广自己的店铺）

1. 复制 `targets/example.mjs` 为 `targets/my-shop.mjs`
2. 改字段：`type` 改 `'shop'`、`brandName` / `productPerspective` / `signature` / `brandTag` / `landing` 换成你自己的
3. 把 `active-target.mjs` 的 import 改成 `./targets/my-shop.mjs`

**引擎零改动** —— 拆解、创作、复盘指标口径会自动跟着类型走。

## 字段说明

| 字段 | 作用 |
|---|---|
| `type` | 内置类型之一，决定转化目标与指标口径 |
| `brandName` | 署名 / 品牌标签用的名字 |
| `productPerspective` | 产品视角（创作必须结合的视角），3 条左右 |
| `signature` | 正文署名（如 `— 你的品牌`） |
| `brandTag` | 品牌话题标签（如 `#你的品牌`） |
| `landing` | **转化落点**：内容最终把人送到哪（见下） |

## landing —— 内容把人送到哪

没有它，内容发出去就没有引流路径，转化全靠用户自己搜；也没法回答「这条内容有没有用」。

```js
landing: {
  primary: 'https://apps.apple.com/app/idXXXX',   // 主落地链接
  byPlatform: {
    // 小红书正文放外链会被限流 → 走主页 / 评论区
    小红书: { url: '...', placement: '主页 / 评论区' },
    公众号: { url: '...', placement: '阅读原文' },
  },
  utm: true,   // 默认开
}
```

工作台会自动给每条内容生成**带 UTM 的落地链接**（`utm_source=<平台>&utm_medium=social&utm_campaign=<活动标识>`），
在「选题库详情」和「发布日历」都能一键复制 —— 有了 UTM 才能在统计后台按条归因。

**campaign 想短一点**，就在文章 md 的「创作信息」里填一行 `- 活动标识：xxs-0901`；
留空则用文章文件名（中文会被 URL 编码成长串）。

> `TARGET_TYPES` 里每种类型声明的复盘指标（app 的 downloads / website 的 visits …）
> 目前是**口径说明**，数据靠手填在文章 md 的「## 转化数据」段，在「数据复盘」里看。

---

## 账号登记（accounts.json）

一条 = 一个号，**同一个平台可以挂多个号**。账号页、发布日历的泳道、创作台「能不能推」、数据复盘的分平台，全都读这一份。
它和 `favorites.json`、`capabilities.json` 一样说的是「这台机器上有哪些号、登没登录」，所以**不进 git**：`cp accounts.example.json accounts.json` 填自己的。

| 字段 | 作用 |
|---|---|
| `platform` | 平台中文名，决定发什么形态（图文 / 贴图 / 动态） |
| `key` | 平台机读名，图表配色按它取（`xiaohongshu` / `douyin` / …）；同时是本机存这个号登录态的文件名，同平台两个号必须各有各的 `key` |
| `id` | 这个号在本仓的身份：**发布排期目录名**、md 里「草稿已推-x」的后缀、登录态缓存的键。老登记不写 `id`，默认取 `platform` |
| `script` | 一键推草稿的脚本路径；文件不存在 = 这个号推不了（创作台会灰掉） |
| `backend` | 该平台创作者后台地址，「去授权」和登录态检测直达这里 |
| `nickname` | 号主昵称，收藏搬运靠它滤掉「自己的笔记」 |
| `quickLogin` | 登录页上那枚「不用扫码」的按钮名（视频号 = 微信快捷登录），授权弹层据此多给一个按钮 |
| `note` | 人话备忘（各平台的坑写这里） |

**加号走界面，不手改这份**：工作台「授权」页右上「新增账号」→ 选平台 + 填昵称。
平台级的 `script` / `backend` / `quickLogin` / `note` 从 `platforms.json` 抄，`id` / `key` 现推，
落盘后自动接上扫码。改名在账号详情里做，只动 `nickname`（`id` 是目录名与登录态键，动了会断链）。

**同平台多号怎么隔开**：扫完码那一次，这个号的登录态单独存进 `metrics/account-cookies/<key>.json`（本机、不入库）。
采集、检测、推草稿替哪个号干活，就先把浏览器里的登录态换成那个号那套，干完换回去。
一个平台只有一个号时整套流程都不碰登录态。以前那种「去 Ego Lite 里再建一只浏览器 profile」已经不要了。

`platforms.json` 是**平台模板表**：一个平台一条，`platforms` 数组。加一个新平台要同时给 `scripts/publish-check.mjs` 的 `CHECKS` 补采集器，光在这里加一条是加不出来的。

**硬约束**：稿子必须躺在 `content/Projects/发布排期/<id>/待发布/` 或 `已排期/YYYY-MM/` 下，目录名要和这里登记的 `id` 对上，否则 `gen:data` 直接报 R4 违规停下。

## 其余三份口径文件

改口径只动这几个文件，脚本里不硬编码：

- `viral.json` —— 爆款采集：按哪些关键词搜最热、点赞门槛、时间窗口、每平台留几条
- `benchmarks.json` —— 对标账号：同样一批关键词去找「发过这个题材的作者」，再按 粉丝量 × 近期爆款 × 活跃度 打分建档
- `goals.json` —— 「今日」页的三读数（播放 / 涨粉 / 变现）：目标值、统计窗口、从哪个平台的哪个指标取
- `favorites.json` —— 收藏搬运：自己主页的 user id（用来判断哪些是「自己的笔记」）与翻页上限

## 桌面版排班（auto-run.json）

定时那五趟由装好的桌面版自己叫本地服务那条单飞队列，不往 macOS 加登录启动项——队列跟人在界面上点的是同一只浏览器，同一时刻只干一件事。

| 字段 | 作用 |
|---|---|
| `name` | 这一趟在账上的名字 |
| `task` | 叫哪一趟，只能填队列登记过的键：`viral` / `publish-check` / `benchmark` / `collect` / `favorites`（填错的话每天到点只会撞回一句未登记） |
| `at` | 本机时刻 `HH:MM`；到点后加 0~`jitterMin` 的抖动，同一天不挪点 |
| `graceMin` | 浏览器被别的任务占着时允许重试多久，超了如实记「今天没排进去」 |
| `cooldownMin` | 写在顶层：两趟之间至少歇这么久（默认 12 分钟）。晚上才开 app 时欠下的几趟不会连着撞同一批后台 |

- 跑没跑成记在 `metrics/auto-run.json`（本机、不入库）：一天一趟；跑挂的当天不自动重试，人在界面上重新点那趟。
- app 没开着就不跑，欠的那趟在下次启动时补一次（按当天该跑的时刻先后补）。
- 删掉 `jobs` 里的一行 = 关掉那趟定时；整份文件删掉 = 桌面版不开定时。

