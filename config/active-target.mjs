/**
 * 当前激活的推广对象（单一实例切换点）。
 *
 * 换产品 / 换用户，只需把这一行的 import 目标改掉，例如：
 *   export { default as activeTarget } from './targets/my-shop.mjs'
 *
 * 引擎其余代码一律读 activeTarget，不写死任何产品。
 */
export { default as activeTarget } from './targets/example.mjs'
