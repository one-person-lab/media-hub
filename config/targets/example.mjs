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
  productPerspective: [
    '卖点一：你的产品解决的核心问题',
    '卖点二：带来的关键改变',
    '卖点三：与同类的差异点',
  ],
  signature: '— 你的品牌',
  brandTag: '#你的品牌',
  // 自家各平台账号名与统一署名：采集靠它挡「把签名当标题」（见 collect-note-core 的 sanitizeTitle）
  accountNames: ['你的账号名', '你的统一署名'],

  // 转化落点：内容最终要把人送到哪。不配也能跑，只是发布时不带链接。
  landing: {
    primary: 'https://your-landing.example.com',
    byPlatform: {
      小红书: { url: 'https://your-landing.example.com', placement: '主页 / 评论区' },
      // 贴图的「链接」栏可插入小程序卡片（推草稿时自动挂进 链接→小程序 弹窗，不放描述里）
      公众号: { url: '#小程序://你的小程序名/APPID', placement: '贴图「链接」栏（自动挂）' },
      // 视频号的「链接」只能挂公众号文章，挂不了小程序：引流路径是 动态 → 公众号文章 → 文章里的小程序
      视频号: { url: '', placement: '动态挂链（只能挂公众号文章）' },
    },
    utm: true,
  },
})
