/**
 * auto-run.mjs 的类型声明（该文件为 JS，vite.config.ts 的 vue-tsc 检查需要类型入口）。
 * ⚠️ 签名以 scripts/auto-run.mjs 为准，改 JS 侧导出时必须同步这里。
 */

export interface AutoRunLogger {
  info: (msg: string) => void
}

/** 抢到锁并挂上定时器后的句柄；没抢到锁或没配置文件时为 null */
export interface AutoRunHandle {
  timer: ReturnType<typeof setInterval>
  tick: () => Promise<void>
  ready: Promise<void>
  stop: () => void
}

export declare function startScheduled(opts: {
  root?: string
  port: number
  logger?: AutoRunLogger
  run?: (job: { task: string; arg?: string | null }) => Promise<unknown>
}): AutoRunHandle | null
