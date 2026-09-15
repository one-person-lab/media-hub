import { makeTarget } from '../promotion-target.mjs'

/**
 * 中性示例推广对象 —— 占位用，演示「引擎不写死任何产品」的接入方式。
 *
 * 接入你自己的产品：复制本文件、改下面这些字段即可，不用碰任何引擎代码。
 * 然后把 config/active-target.mjs 的 import 指向你的文件。
 */
export default makeTarget({
  type: 'app',
  brandName: '你的产品',
  accountPositioning: '一句话说清你的账号定位',
  productPerspective: [
    '卖点一：你的产品解决的核心问题',
    '卖点二：带来的关键改变',
    '卖点三：与同类的差异点',
  ],
  tone: '符合你品牌的语气',
  topics: ['主题一', '主题二', '主题三'],
  signature: '— 你的品牌',
  brandTag: '#你的品牌',
  handbookPath: 'content/自媒体运营/00-运营手册.md',

  // 转化落点：内容最终要把人送到哪。不配也能跑，只是发布时不带链接。
  landing: {
    primary: 'https://your-landing.example.com',
    byPlatform: {
      小红书: { url: 'https://your-landing.example.com', placement: '主页 / 评论区' },
      公众号: { url: 'https://your-landing.example.com', placement: '阅读原文' },
    },
    utm: true,
  },
})
