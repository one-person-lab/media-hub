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

/* ==================== 采集落盘 ==================== */

export declare function downloadImage(imageUrl: string, noteId: string, root?: string): Promise<string>

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
  keptAnalysis: boolean
}>

/* ==================== AI 拆解 / 创作 ==================== */

export declare function autoAnalyze(
  rel: string,
  root?: string,
): Promise<{ ok: boolean; analyzed?: boolean; skip?: string; error?: string }>

export declare function writeDailyNote(rel: string, root?: string): Promise<{ ok: boolean; error?: string }>

/* ==================== 发布 ==================== */

export declare function prepareXhsPublish(
  rel: string,
  root?: string,
): { title: string; lines: number; tags: number; coverAbs: string }

export declare function publishNote(
  rel: string,
  link: string,
  platform?: string,
  root?: string,
): { ok: boolean; error?: string }

/* ==================== 草稿与排期 ==================== */

export declare function safeTitleName(title: string): string

export declare function writeDraftMd(
  spec: { title: string; fromKind?: string; from?: string },
  root?: string,
): { file: string; rel: string }

export declare function deleteDraftMd(rel: string, root?: string): { ok: boolean }

export declare function scheduleNote(rel: string, date: string, root?: string): { ok: boolean; rel: string }
