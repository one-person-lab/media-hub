/**
 * server-core.mjs 的类型声明（该文件为 JS，vite.config.ts 的 vue-tsc 检查需要类型入口）。
 * ⚠️ 签名以 scripts/server-core.mjs 为准，改 JS 侧导出时必须同步这里。
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

export interface WorkbenchLogger {
  info: (msg: string) => void
}

export interface WorkbenchApi {
  /** 中间件形态入口：未命中 /__xxx 路由时交给 next */
  handle: (req: IncomingMessage, res: ServerResponse, next?: () => void) => void
  /** 触发一次 gen:data 防抖重建 */
  refresh: () => void
}

export declare function createApiHandler(opts: { logger: WorkbenchLogger }): WorkbenchApi

/** 监听 content/ config/ metrics/ 变动（fs.watch，不吃 .gitignore） */
export declare function watchDataDirs(onChange: () => void, logger?: WorkbenchLogger): void

/** generated.json 缺失时同步补跑一次 gen:data（serve/Electron 冷启动兜底） */
export declare function ensureGeneratedData(logger: WorkbenchLogger): void
