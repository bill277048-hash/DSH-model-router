/**
 * `@deepseek-ai/dsh-llm` 的 **CI 专用测试替身（test double）**
 *
 * ## 为什么存在
 *
 * 本插件是 DSH 宿主的插件，运行期依赖宿主提供的 `@deepseek-ai/dsh-llm`
 * （`peerDependencies`）。该包**不在公共 npm 源上**，因此 GitHub Actions 的
 * `npm install` 装不到它 —— 而 `lib/probe.js` 与 `lib/wrapper/index.js` 都在
 * **模块顶层** import 它，导致测试文件**加载即崩**：
 *
 * ```
 * Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@deepseek-ai/dsh-llm'
 *   imported from lib/probe.js
 * ```
 *
 * 实测：`test` workflow 自 2026-09-08 起**从未通过**（6/6 次全失败）。
 *
 * ## 用法
 *
 * **只在 CI 里**把本目录拷进 `node_modules/@deepseek-ai/dsh-llm/`
 * （见 `.github/workflows/test.yml` 的 "Provide host package test double" 步骤）。
 *
 * 刻意**不**写进 `devDependencies`：那样会让开发机上的 `pnpm install`
 * 用替身**顶掉真实的包**，破坏本地开发（本地靠 `pnpm-lock.yaml` 从私有源装真包）。
 *
 * ## 忠实度
 *
 * 只实现本插件实际用到的 3 个符号，语义对齐真实实现
 * （`@deepseek-ai/dsh-llm@0.0.1-rc.1` 的 `lib/types/message.js` 与 `lib/index.js`）：
 *
 * | 符号 | 真实实现 | 本替身 |
 * |---|---|---|
 * | `createUserMessage` | `createMessage({...input, role:'user'})` → 加 `id` + 深冻结 | 同（`id` 用同前缀的随机串） |
 * | `markAgentLoopRequest` | `AGENT_LOOP_REQUESTS.add(req); return req` | 同（WeakSet） |
 * | `isAgentLoopRequest` | `AGENT_LOOP_REQUESTS.has(req)` | 同（WeakSet） |
 *
 * ⚠ **局限**：本替身**不**复刻真实包的消息规范化/校验逻辑（如 content 分片合法性）。
 * 它存在的目的只是让「插件自身的逻辑」可在 CI 中被测；**凡涉及真实消息语义的断言
 * 都不应依赖本替身**，而应在装有真实包的实机上验证（见 `test/manual-suite-automated.mjs`）。
 */

/** 与真实实现同构：进程内 WeakSet 品牌标记 */
const AGENT_LOOP_REQUESTS = new WeakSet();

/** 生成带前缀的消息 id（真实实现用 branded `MessageId(crypto.randomUUID())`） */
function newMessageId() {
  const uuid = globalThis.crypto?.randomUUID?.()
    ?? `fallback-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `msg_${uuid}`;
}

/** 浅冻结（真实实现是**深**冻结；替身只做浅层，够本插件的用途） */
function freezeMessage(message) {
  return Object.freeze(message);
}

/**
 * 创建一条 user 角色消息。
 * 真实实现：`createMessage({ ...input, role: 'user' })`
 */
export function createUserMessage(input) {
  return freezeMessage({
    ...input,
    role: 'user',
    id: newMessageId(),
  });
}

/**
 * 把 request 标记为「由 agent loop 组装」。
 * 真实实现：`AGENT_LOOP_REQUESTS.add(request); return request;`
 */
export function markAgentLoopRequest(request) {
  AGENT_LOOP_REQUESTS.add(request);
  return request;
}

/**
 * 判断某个 request 是否被 `markAgentLoopRequest` 标记过。
 * 真实实现：`AGENT_LOOP_REQUESTS.has(request)`
 */
export function isAgentLoopRequest(request) {
  return AGENT_LOOP_REQUESTS.has(request);
}
