/**
 * 推广对象（PromotionTarget）类型注册表 + 默认配置。
 *
 * 设计原则：引擎不写死任何具体产品；「推广什么」是用户配置进来的。
 * - TARGET_TYPES：内置推广对象类型（app / website / shop / course / service），
 *   每种带默认「转化目标」与「变现 / 复盘指标口径」。
 * - makeTarget(spec)：用类型默认项补全一个具体实例。
 * - 换推广对象（比如从 APP 换成网站 / 店铺）：只改 config/active-target.mjs 的 import，引擎零改动。
 *
 * 这是「解耦底座」的核心：example.mjs 是内置的中性示例实例（见 targets/example.mjs）。
 */

/** 内置推广对象类型：每种带默认「转化目标」与「变现 / 复盘指标口径」 */
export const TARGET_TYPES = {
  app: {
    label: 'APP / 应用',
    conversionGoal: 'download',
    conversionGoalLabel: '下载 / 激活 / 留存',
    metrics: [
      { key: 'downloads', label: '下载量' },
      { key: 'activation', label: '激活率' },
      { key: 'retention', label: '留存率' },
      { key: 'storeRating', label: '应用商店评分' },
    ],
  },
  website: {
    label: '网站 / 落地页',
    conversionGoal: 'visit',
    conversionGoalLabel: '访问 / 停留 / 留资',
    metrics: [
      { key: 'visits', label: '访问量' },
      { key: 'avgDuration', label: '平均停留' },
      { key: 'leads', label: '留资数' },
      { key: 'bounce', label: '跳出率' },
    ],
  },
  shop: {
    label: '店铺 / 电商',
    conversionGoal: 'purchase',
    conversionGoalLabel: '下单 / GMV / 复购',
    metrics: [
      { key: 'orders', label: '下单量' },
      { key: 'gmv', label: 'GMV' },
      { key: 'aov', label: '客单价' },
      { key: 'repurchase', label: '复购率' },
    ],
  },
  course: {
    label: '课程 / 知识付费',
    conversionGoal: 'enroll',
    conversionGoalLabel: '报名 / 完课 / 续费',
    metrics: [
      { key: 'enrolls', label: '报名数' },
      { key: 'completion', label: '完课率' },
      { key: 'renewal', label: '续费率' },
      { key: 'nps', label: 'NPS' },
    ],
  },
  service: {
    label: '服务 / 私域',
    conversionGoal: 'lead',
    conversionGoalLabel: '咨询 / 线索 / 成交',
    metrics: [
      { key: 'inquiries', label: '咨询数' },
      { key: 'leads', label: '线索量' },
      { key: 'dealRate', label: '成交率' },
      { key: 'aov', label: '客单价' },
    ],
  },
}

/**
 * @typedef {Object} PromotionTarget
 * @property {string} type              内置类型之一（见 TARGET_TYPES）
 * @property {string} brandName         推广对象的名字（署名 / 品牌标签用）
 * @property {string} accountPositioning 一句话账号定位（喂给拆解 / 创作 prompt）
 * @property {string[]} productPerspective 产品视角（创作必须结合的视角，3 条左右）
 * @property {string} tone              语气基调
 * @property {string[]} topics          长期主题 / 品牌标签词
 * @property {string} signature         正文署名（如 "— 你的品牌"）
 * @property {string} brandTag          品牌话题标签（如 "#你的品牌"）
 * @property {string} handbookPath      运营手册 md 相对仓库根的路径
 * @property {object} landing           转化落点：内容最终把人送到哪
 * @property {string} landing.primary   主落地链接（官网 / 应用商店 / 仓库地址）
 * @property {Object<string,{url:string,placement:string}>} landing.byPlatform
 *          平台变体。placement 说明该平台怎么放（小红书正文放链接会限流 → 走主页；公众号可放「阅读原文」）
 * @property {boolean} landing.utm      是否自动拼 UTM（默认 true）
 * @property {string} conversionGoal    来自类型的默认项
 * @property {string} conversionGoalLabel 来自类型的默认项
 * @property {Array<{key:string,label:string}>} metrics 来自类型的默认项
 */

/** 用内置类型默认项补全实例，缺字段给合理默认值 */
export function makeTarget(spec) {
  const t = TARGET_TYPES[spec.type]
  if (!t) {
    throw new Error(`未知的推广对象类型：${spec.type}（可选：${Object.keys(TARGET_TYPES).join('/')}）`)
  }
  return {
    type: spec.type,
    brandName: spec.brandName || '',
    accountPositioning: spec.accountPositioning || '',
    productPerspective: spec.productPerspective || [],
    tone: spec.tone || '',
    topics: spec.topics || [],
    signature: spec.signature || '',
    brandTag: spec.brandTag || '',
    handbookPath: spec.handbookPath || '',
    // 转化落点——没配也能跑，只是发布时不带链接
    landing: {
      primary: spec.landing?.primary || '',
      byPlatform: spec.landing?.byPlatform || {},
      utm: spec.landing?.utm !== false,
    },
    // 来自类型默认
    conversionGoal: t.conversionGoal,
    conversionGoalLabel: t.conversionGoalLabel,
    metrics: t.metrics,
  }
}

/**
 * 给落地链接拼 UTM —— 没有它就算不清「这条内容带来了多少转化」。
 * 纯函数，node 侧（build-data）与浏览器侧共用同一套规则。
 *
 * @param {string} baseUrl  落地链接
 * @param {string} platform 平台名（小红书 / 公众号 / 抖音 / 视频号 …）
 * @param {string} campaign 内容标识（一般用文章 id 或选题标题）
 * @param {boolean} enabled 是否启用（对应 landing.utm）
 */
export function withUtm(baseUrl, platform, campaign, enabled = true) {
  if (!baseUrl || !enabled) return baseUrl || ''
  try {
    const u = new URL(baseUrl)
    u.searchParams.set('utm_source', platform || 'unknown')
    u.searchParams.set('utm_medium', 'social')
    if (campaign) u.searchParams.set('utm_campaign', campaign)
    return u.toString()
  } catch {
    // 不是合法 URL（比如「主页链接」这类人工说明）就原样返回
    return baseUrl
  }
}
