import type { Component } from 'vue'
import { ChartLine as IconChartLine, Images as IconImages, LayoutDashboard as IconLayoutDashboard, Lightbulb as IconLightbulb, MessageCircleMore as IconMessageCircleMore, PenLine as IconPenLine, Puzzle as IconPuzzle, ScrollText as IconScrollText, Tag as IconTag } from 'lucide-vue-next'

export interface NavChild {
  id: string
  label: string
}

export interface NavItem extends NavChild {
  icon: Component
  tone: string
  children?: NavChild[]
  /** 侧栏分组标签；不写 = 独立在首个分组之上（AI 助手是入口，不属于流程也不属于资产） */
  group?: string
}

/** 侧栏只到「站」这一层：一站一项。站内的页（灵感库/爆款采集/对标账号…）由页顶页签切，
 *  hash 仍是子页 id（#/viral），旧深链、前进后退、各页自己的 #/studio-image/<key> 都不受影响。 */
export const navItems: NavItem[] = [
  { id: 'chat', label: 'AI 助手', icon: IconMessageCircleMore, tone: 'bg-neo-yellow' },
  { id: 'board', label: '看板', icon: IconLayoutDashboard, tone: 'bg-neo-yellow', group: '流程' },
  {
    // 收集与选题是同一条线的上下游：收进来顺手判一条，中间不该有一次换站（2026-10-28）
    id: 'inspiration',
    label: '收集',
    icon: IconLightbulb,
    tone: 'bg-neo-green',
    group: '流程',
    children: [
      { id: 'inspiration', label: '灵感库' },
      { id: 'viral', label: '爆款采集' },
      { id: 'benchmarks', label: '对标账号' },
      { id: 'topics', label: '选题' },
      { id: 'history', label: '历史' },
    ],
  },
  {
    // 写稿与推箱是同一条链路的上下游，拆成两站等于把人从创作台踢回侧栏再找发布（2026-10-28）
    // id 用第一档页签的（点侧栏「创作」先落图文那一屏）
    id: 'studio-image',
    label: '创作',
    icon: IconPenLine,
    tone: 'bg-neo-purple',
    group: '流程',
    // 图文与视频是两种形态、两套素材、两条渲染链，混在一屏里等于两边都做不好（2026-11-04）。
    // 照抖音/小红书发布页那样在最上面分档，不再拿一个下拉藏在标题后面。
    children: [
      { id: 'studio-image', label: '图文创作' },
      { id: 'studio-video', label: '视频创作' },
      { id: 'calendar', label: '发布日历' },
    ],
  },
  { id: 'analytics', label: '复盘', icon: IconChartLine, tone: 'bg-neo-green', group: '流程' },
  // 品牌档案：入口、口径、真素材的唯一登记处，创作与发布都回这里取数（2026-10-26 开，2026-11-04 由「产品」改「品牌」）
  { id: 'products', label: '品牌', icon: IconTag, tone: 'bg-neo-blue', group: '资产' },
  {
    // 模板库：图文与视频各自一屏，创作时从这里挑（2026-11-04）。
    // 以前模板只住在创作台那个弹层里，看不见全貌、也说不出这条凭什么算被验证过。
    id: 'material-image',
    label: '素材库',
    icon: IconImages,
    tone: 'bg-neo-purple',
    group: '资产',
    children: [
      { id: 'material-image', label: '图文模板' },
      { id: 'material-video', label: '视频模板' },
    ],
  },
  { id: 'knowledge', label: '知识库', icon: IconScrollText, tone: 'bg-neo-green', group: '资产' },
  {
    // 装进本机 Agent 的技能，与装进浏览器的采集插件，都是「往外接」的东西，合成一站（2026-11-01）
    id: 'plugin',
    label: '插件',
    icon: IconPuzzle,
    tone: 'bg-neo-blue',
    group: '资产',
    children: [
      { id: 'plugin', label: 'Agent 插件' },
      { id: 'collect-guide', label: '采集插件' },
    ],
  },
]

/** 当前视图落在哪个站上（子页归给父站，侧栏才知道该亮哪一项） */
export const navOf = (view: string): NavItem | null =>
  navItems.find((n) => n.id === view || n.children?.some((c) => c.id === view)) || null

/** 站内页签：只有一站多页时才出签 */
export const tabsOf = (view: string): NavChild[] | null => {
  const n = navOf(view)
  return n?.children && n.children.length > 1 ? n.children : null
}
