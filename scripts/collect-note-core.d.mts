/**
 * collect-note-core.mjs 的类型声明（该文件为 JS，构建时 vue-tsc 需要类型入口）。
 *
 * ⚠️ 签名以 scripts/collect-note-core.mjs 为准。**改动 JS 侧导出时必须同步这里**，
 *    否则 vue-tsc 会报 "has no exported member" 而 vite dev 不报错——两类报错只在
 *    npm run build 时暴露，容易长期潜伏（本项目已经踩过一次）。
 */

export declare const MEDIA_HUB_ROOT: string

/** LLM 端点 / 模型（可用 LLM_BASE_URL / LLM_MODEL 环境变量覆盖） */
export declare const LLM_BASE_URL: string
export declare const LLM_MODEL: string
/** API key 的存放路径（展示用） */
export declare const LLM_KEY_PATH: string

/* ==================== 平台注册表（accounts.json 唯一事实源） ==================== */

export declare function listAccounts(root?: string): Array<{
  platform: string
  key: string
  script: string
  nickname: string
  note?: string
}>

/** 从 rel 反查账号目录名（支持 content/… 与 Projects/… 两种前缀），不匹配返回 null */
export declare function accountFromRel(rel: string): string | null

export declare function pendingDirFor(account: string): string

export declare function scheduledDirFor(account: string, month: string): string

/* ==================== 采集落盘 ==================== */

/** 小红书笔记 ID → 发布日期 `YYYY-MM-DD`（ID 前 8 位是 16 进制时间戳）；解不出返回空串 */
export declare function notePublishedAt(noteId: string): string

/** 笔记标题 → 安全文件名（采集笔记 md 文件名） */
export declare function safeNoteName(title: string): string

export declare function downloadImage(imageUrl: string, noteId: string, root?: string): Promise<string>

/** 下载轮播全部源图 → public/inspiration/<noteId>/page-NN.<ext>（复刻爆款的前提；content/ 下浏览器拿不到） */
export declare function downloadSourceImages(
  imageUrls: string[],
  noteId: string,
  root?: string,
): Promise<{ dir: string; count: number }>

export declare function writeNoteMd(
  data: Record<string, unknown>,
  url: string,
  imagePath: string,
  root?: string,
): { file: string; rel: string; keptAnalysis: boolean }

export declare function handleCollect(payload: Record<string, unknown>): Promise<{
  ok: boolean
  file: string
  image: string
  sourceImages: { dir: string; count: number }
  keptAnalysis: boolean
}>

/* ==================== AI 知识源（R1/R3） ==================== */

/** R1：AI 唯一知识源 = content/Knowledge/ 拼接（00- 定位页排最前，`_` 前缀页跳过，剥离 HTML 注释） */
export declare function loadAiContext(root?: string): string

/** R3：管线读写命中 content/Archive/ 即抛错 */
export declare function guardNotArchive(rel: string): void

/* ==================== 发布 ==================== */

/** 推送草稿的默认配乐（config/publish-music.json）；文件缺失或 enabled=false 返回 null */
export declare function publishMusic(root?: string): { query: string; title: string; author: string } | null

/** 发布页标题框的硬上限（字/字符）：快手图文没有标题框，所以不在表内 */
export declare const PUBLISH_TITLE_LIMIT: Record<string, number>

/** 话题最终进不进草稿：公众号编辑器的正文里不写话题 */
export declare const PUBLISH_TAGS_PUSHED: Record<string, boolean>

/** 哪些平台的草稿挂得上默认配乐 */
export declare const PUBLISH_MUSIC: Record<string, boolean>

/** 发布 payload 本体（纯函数：不写 /tmp、不开浏览器）。推草稿与界面预览共用它，不许各说各话 */
export declare function buildPublishPayload(
  rel: string,
  root?: string,
  account?: string,
): { payload: Record<string, any>; warnings: string[] }

/** 推草稿入口：buildPublishPayload 的同一份 payload 写 /tmp 供发布脚本读 */
export declare function prepareXhsPublish(
  rel: string,
  root?: string,
  account?: string,
): {
  title: string
  lines: number
  tags: number
  coverAbs: string
  images: number
  music: string
  product: string
  weapp: string
}

/** 发布预览：payload 的只读投影——标题按脚本的截断规则先切好，图换成本机能访问的路径，
 *  缺文件的单独标 exists:false，缺段回退这类异常带在 warnings 里，界面不许假装没事 */
export declare function buildPublishPreview(
  rel: string,
  root?: string,
  account?: string,
): {
  platform: string
  account: string
  title: string
  titleChars: number
  titleLimit: number
  titlePushed: boolean
  body: string
  bodyChars: number
  tags: string[]
  tagsPushed: boolean
  images: { url: string; exists: boolean }[]
  music: { query: string; title: string; author: string } | null
  weapp: string
  warnings: string[]
}

export declare function markDraftPushed(
  rel: string,
  platform: string,
  root?: string,
): { ok: boolean; error?: string }

/* ==================== 草稿与排期 ==================== */

export declare function safeTitleName(title: string): string

/** 稿的卡片数据（与 md 同名 .json）→ 图卡清单，图在 public/cards/<slug>/；纯文字稿返回 null */
export declare function readCardSidecar(
  mdRel: string,
  root?: string,
): {
  slug: string
  title: string
  /** 卡片 json 相对仓库根（保存文字改动时按它落盘） */
  jsonRel: string
  /** 卡片 json 本体（逐页文字 + 版式参数）：创作台「编辑文字」的表单源 */
  data: Record<string, any>
  pageCount: number
  video: string
  /** 素材在 public/ 下时的可播地址，否则空串 */
  videoUrl: string
  images: string[]
  urls: string[]
} | null

/** 卡片数据的唯一事实源目录 */
export declare const CARD_DIR_REL: string

/** 写回卡片 json（slug 不可改），返回 changedPages（0 基页号）供调用方只重渲改动页 */
export declare function writeCardJson(
  jsonRel: string,
  data: Record<string, any>,
  root?: string,
): { ok: true; rel: string; changedPages: number[] }

export declare function writeDraftMd(
  spec: { title: string; fromKind?: string; from?: string; account: string },
  root?: string,
): { file: string; rel: string }

export declare function deleteDraftMd(rel: string, root?: string): { ok: boolean }

export declare function scheduleNote(rel: string, date: string, root?: string): { ok: boolean; rel: string }

/* ==================== 选题池（立项闸门） ==================== */

/** 选题卡标题：去 #话题 尾巴 + 长句裁短，用于 选题池/ 文件名与 H1 */
export declare function topicTitleName(title: string): string

export declare function writeTopicMd(
  spec: { title: string; fromKind?: string; from?: string; sourceRel?: string },
  root?: string,
): { file: string; rel: string }

/** 立项：写入平台清单（默认 = accounts.json 全部已授权平台），并按平台各建一份稿骨架 */
export declare function promoteTopic(
  rel: string,
  platforms?: string | string[],
  root?: string,
): {
  ok: boolean
  rel: string
  platforms: string[]
  drafts: Array<{ platform: string; rel: string; skipped?: string }>
}

export declare function markTopicConverted(rel: string, root?: string): { ok: boolean; already?: boolean }

/** 选题淘汰＝归档：移进 选题池/归档/，判据留痕供复盘 */
export declare function archiveTopicMd(rel: string, root?: string): { ok: boolean; archived: string }

/** 灵感卡淘汰＝归档：移进 采集笔记/归档/，源图不动 */
export declare function archiveNoteMd(rel: string, root?: string): { ok: boolean; archived: string }
