# 推广对象配置（PromotionTarget）

本目录是「解耦底座」：**引擎不写死任何具体产品**，推广什么由这里的配置决定。

## 文件

- `promotion-target.mjs` —— 类型注册表 `TARGET_TYPES`（app / website / shop / course / service）+ `makeTarget()` 工厂。每种类型带默认「转化目标」和「变现 / 复盘指标口径」。
- `targets/<名>.mjs` —— 一个具体的推广对象实例。目前只有 `example.mjs`（中性示例，APP 型）。
- `active-target.mjs` —— 当前激活的实例（切换点）。

## 如何新增一个推广对象（比如推广自己的店铺）

1. 复制 `targets/example.mjs` 为 `targets/my-shop.mjs`
2. 改字段：`type` 改 `'shop'`、`brandName` / `accountPositioning` / `productPerspective` / `topics` / `signature` / `brandTag` / `handbookPath` / `landing` 换成你自己的
3. 把 `active-target.mjs` 的 import 改成 `./targets/my-shop.mjs`

**引擎零改动** —— 拆解、创作、复盘指标口径会自动跟着类型走。

## 字段说明

| 字段 | 作用 |
|---|---|
| `type` | 内置类型之一，决定转化目标与指标口径 |
| `brandName` | 署名 / 品牌标签用的名字 |
| `accountPositioning` | 一句话账号定位，喂给 AI 拆解 / 创作 |
| `productPerspective` | 产品视角（创作必须结合的视角），3 条左右 |
| `tone` | 语气基调 |
| `topics` | 长期主题 / 品牌标签词 |
| `signature` | 正文署名（如 `— 你的品牌`） |
| `brandTag` | 品牌话题标签（如 `#你的品牌`） |
| `handbookPath` | 运营手册 md 相对仓库根的路径 |
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
在「选题库详情」和「发布中心」都能一键复制 —— 有了 UTM 才能在统计后台按条归因。

**campaign 想短一点**，就在文章 md 的「创作信息」里填一行 `- 活动标识：xxs-0901`；
留空则用文章文件名（中文会被 URL 编码成长串）。

> `TARGET_TYPES` 里每种类型声明的复盘指标（app 的 downloads / website 的 visits …）
> 目前是**口径说明**，数据靠手填在文章 md 的「## 转化数据」段，在「数据复盘」里看。

