/**
 * wrapper 薄桥文件（v0.9.5 §13 P1-6）。
 *
 * 真实实现已迁至 lib/wrapper/index.js（详见 §13 P1-6 拆分计划）。
 * 本文件保持为 re-export 薄桥（约 20 行），原因：
 * - 单测与 lib/index.js 的 `import ... from './wrapper.js'`（带 .js 后缀）路径
 *   不会被 Node 解析成 `./wrapper/index.js`（目录视图对带扩展名 import 无效）。
 * - 删除 wrapper.js 会让单测全部断 import。
 *
 * 拆分粒度（§13.2 P1-6）：
 * - 现阶段 wrapper/index.js 仍承载全部 667 行（按职责拆 4 文件属 P1-6 完整落地，
 *   v0.9.6 再按 failover/quota-cooldown/errors 三段外提）。
 * - 本文件即"薄桥"，把全部 export 从 ./wrapper/index.js 透传。
 */
export {
  throttleWait,
  resolveRequestMode,
  chunkSubstantive,
  createStreamWrapper,
} from './wrapper/index.js';
