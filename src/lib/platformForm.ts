/** 五平台发布台的字段表：创作台中栏按这张表摆字段——选中哪个渠道，
 *  就用那个平台后台自己的顺序、自己的叫法、自己的字数上限。
 *  上限与推草稿脚本同源（scripts/collect-note-core.mjs 的 PUBLISH_TITLE_LIMIT 与正文 1000 字硬校验）；
 *  表里没有的键 = 那个平台后台没有这一栏，界面上也不出现。 */
export type FormKey = 'images' | 'title' | 'body' | 'tags' | 'music' | 'weapp' | 'firstComment'

export type FormBlock = { key: FormKey; label: string; max?: number }

export type PlatformForm = {
  blocks: FormBlock[]
  /** 右栏预览：phone=手机壳，card=公众号图文消息卡；tabs 是平台后台自己那组预览页签的名字 */
  preview: { shell: 'phone' | 'card'; tabs: string[] }
  /** 平台后台这一版最后那两个按钮叫什么（我们照着叫，不自己发明） */
  actions: { save: string; publish: string; schedule: string }
}

const BODY_MAX = 1000

export const PLATFORM_FORM: Record<string, PlatformForm> = {
  小红书: {
    blocks: [
      { key: 'images', label: '图片编辑', max: 18 },
      { key: 'title', label: '标题', max: 20 },
      { key: 'body', label: '正文', max: BODY_MAX },
      { key: 'tags', label: '话题' },
      { key: 'firstComment', label: '首评引导' },
    ],
    preview: { shell: 'phone', tabs: ['笔记预览', '封面预览'] },
    actions: { save: '暂存离开', publish: '发布', schedule: '定时发布' },
  },
  抖音: {
    blocks: [
      { key: 'title', label: '作品标题', max: 20 },
      { key: 'body', label: '作品描述', max: BODY_MAX },
      { key: 'tags', label: '话题' },
      { key: 'images', label: '编辑图片' },
      { key: 'music', label: '选择音乐' },
    ],
    preview: { shell: 'phone', tabs: ['预览图文'] },
    actions: { save: '暂存离开', publish: '发布', schedule: '定时发布' },
  },
  公众号: {
    blocks: [
      { key: 'images', label: '图片', max: 20 },
      { key: 'title', label: '标题', max: 20 },
      { key: 'body', label: '描述', max: BODY_MAX },
      { key: 'weapp', label: '小程序链接' },
    ],
    preview: { shell: 'card', tabs: ['图文预览'] },
    actions: { save: '保存为草稿', publish: '发布', schedule: '定时发送' },
  },
  快手: {
    blocks: [
      { key: 'images', label: '编辑图片', max: 31 },
      { key: 'body', label: '作品描述' },
      { key: 'tags', label: '话题' },
      { key: 'music', label: '添加音乐' },
    ],
    preview: { shell: 'phone', tabs: ['作品预览'] },
    actions: { save: '暂存离开', publish: '发布', schedule: '定时发布' },
  },
  视频号: {
    blocks: [
      { key: 'images', label: '图片', max: 18 },
      { key: 'title', label: '标题', max: 22 },
      { key: 'body', label: '描述', max: BODY_MAX },
      { key: 'tags', label: '话题' },
    ],
    preview: { shell: 'phone', tabs: ['动态预览'] },
    actions: { save: '保存草稿', publish: '发表', schedule: '定时发布' },
  },
}

/** 账号名不等于平台名（同平台多号），所以先按平台取，取不到再按账号取。 */
export function formOf(platform: string, account = ''): PlatformForm {
  return PLATFORM_FORM[platform] || PLATFORM_FORM[account] || {
    blocks: [
      { key: 'images', label: '图片' },
      { key: 'title', label: '标题' },
      { key: 'body', label: '正文' },
    ],
    preview: { shell: 'phone', tabs: ['预览'] },
    actions: { save: '存草稿', publish: '发布', schedule: '定时发布' },
  }
}
