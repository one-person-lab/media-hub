/** 装没装插件的唯一判据：在 <html> 上留一个版本号标记，工作台读它决定那颗按钮的态。
 *  用属性而不是 window 变量：content script 跑在隔离世界，页面上的 JS 读不到它的变量，
 *  但 DOM 属性两边都看得见。 */
document.documentElement.dataset.mediahubClipper = chrome.runtime.getManifest().version
