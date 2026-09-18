/**
 * 运行时状态持久化（v0.2 需求 1：面板可改排序/开关，免改 patch 免重启）。
 *
 * 文件落在 dsh home（本地 APFS）——绝对不放 SMB NAS（SQLite/原子写约束同方案 §八.1）。
 * 写入走 temp + rename 原子替换。存在时 rules/propose 覆盖 patch config 初值。
 */

import { readFileSync, writeFileSync, renameSync, mkdirSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * 当前 store schema 版本。
 *
 * **新增字段或改结构时**：① 递增本常量 ② 在 `MIGRATIONS` 登记 `旧版本 → 旧版本+1` 的迁移。
 * 这样旧版本的用户升级后**配置不丢失**（v1.0 验收判据：配置迁移链可用）。
 */
export const STORE_VERSION = 1;

/**
 * 迁移链：`MIGRATIONS[n]` 把 **version `n`** 的原始对象升级为 **version `n+1`**。
 *
 * 约定：
 * - 必须返回**新对象**（不得原地改传入对象——`raw` 来自 `JSON.parse`，原地改虽可行但易埋坑）
 * - 迁移函数**只做结构变换**，不做校验（校验由 `loadState` 统一负责）
 * - 当前 `STORE_VERSION = 1` 且无历史版本 → 链为空。**机制已就位**，供后续登记。
 *
 * @example 未来新增 `foo` 字段时的登记方式
 * ```js
 * export const MIGRATIONS = {
 *   1: (s) => ({ ...s, foo: DEFAULT_FOO }),   // v1 → v2
 * };
 * ```
 */
export const MIGRATIONS = {
  // （当前无待迁移版本）
};

/**
 * 把任意版本的 store 原始对象迁移到 `target` 版本。
 *
 * @param {object} raw `JSON.parse` 后的原始对象
 * @param {object} [log]
 * @param {Record<number, Function>} [migrations] 迁移链（**默认生产链**；测试可注入合成链）
 * @param {number} [target] 目标版本（默认 `STORE_VERSION`）
 * @returns {object|null} 迁移后的对象；无法迁移（缺步骤/版本过高/迁移抛错）→ `null`
 */
export function migrateState(raw, log, migrations = MIGRATIONS, target = STORE_VERSION) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    log?.warn?.('store 内容非对象，忽略并沿用 patch config');
    return null;
  }
  const from = Number.isInteger(raw.version) ? raw.version : null;
  if (from === null) {
    log?.warn?.(`store 缺少合法 version（实际 ${JSON.stringify(raw.version)}），忽略并沿用 patch config`);
    return null;
  }
  // 版本高于当前支持 → **不能降级**（未来版本可能含本版不认识的字段，强行读会丢数据）
  if (from > target) {
    log?.warn?.(`store 版本 ${from} 高于当前支持的 ${target}（不支持降级），忽略并沿用 patch config`);
    return null;
  }
  if (from === target) return raw;
  let cur = raw;
  for (let v = from; v < target; v++) {
    const step = migrations[v];
    if (typeof step !== 'function') {
      log?.warn?.(`store 缺少 v${v} → v${v + 1} 的迁移步骤，忽略并沿用 patch config`);
      return null;
    }
    try {
      cur = step(cur);
    } catch (error) {
      log?.warn?.(`store v${v} → v${v + 1} 迁移失败: ${error?.message ?? error}`);
      return null;
    }
    if (!cur || typeof cur !== 'object') {
      log?.warn?.(`store v${v} → v${v + 1} 迁移返回非对象，忽略并沿用 patch config`);
      return null;
    }
    cur = { ...cur, version: v + 1 };
  }
  log?.info?.(`store 已迁移 v${from} → v${target}`);
  return cur;
}

/**
 * 把「本次提交的 patch」合并到「已有持久化状态」上。
 *
 * **为什么需要**（v1.0.1 修复的 Critical 数据丢失缺陷）：
 * `/state` 端点此前直接用「请求派生的 state」整体覆写磁盘。`normalizeState` 对
 * **未提交的字段**返回 `undefined`，而 `JSON.stringify` 会**丢弃 undefined** ——
 * 于是磁盘上已有的值被**静默擦除**。
 *
 * 真实触发：面板「一键启用每日报告」只发 `{reports}`，结果用户的
 * `rules` / `providerMeta` / `timeZone` 全部丢失（且返回 `200 已保存并即时生效`）。
 *
 * 本函数把磁盘侧语义对齐到**内存侧**（`routes.js` 对 providerMeta/reports/timeWindows
 * 一律 `!== undefined` 才覆盖，否则保留）：
 * - `patch[k] === undefined` → **保留** `prev[k]`（本次未提交）
 * - `patch[k] === null`      → **覆盖为 null**（显式清空，如 `timeZone: null` = 系统时区）
 * - 其余值                    → 覆盖
 *
 * ⚠ **`submittedKeys` 是必需的，不能省略**：`normalizeState` 会给**未提交**的字段填
 * 默认值（如 body 里没有 `rules` 时仍返回 `rules: []`），因此**无法**从 `patch` 本身
 * 区分「未提交」与「提交了空数组」。必须由调用方传入**原始请求体的键集**。
 *
 * @param {object} prev 已有状态（`loadState` 的返回值，可含内部字段）
 * @param {object} patch 本次提交（`normalizeState` 的返回值）
 * @param {string[]} submittedKeys **原始请求体**的键集（哪些字段是本次真正提交的）
 * @returns {object} 合并结果（新对象；已剥离 `prev` 的内部字段）
 */
export function mergeState(prev, patch, submittedKeys) {
  const out = { ...(prev ?? {}) };
  delete out.storePath; // loadState 的返回值含此内部字段，不应落盘
  const keys = Array.isArray(submittedKeys) ? submittedKeys : Object.keys(patch ?? {});
  for (const k of keys) {
    const v = patch?.[k];
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/**
 * 构造 `/state` 端点用的保存函数（**读-合并-写**）。
 *
 * 抽成工厂而非在 `index.js` 里内联，是为了**可测**：接线一旦写错（如漏传
 * `submittedKeys`、忘记 `mergeState`），行为测试就能抓到——内联闭包测不到。
 *
 * @param {string} storePath
 * @param {object} log
 * @returns {(state: object, submittedKeys?: string[]) => boolean}
 */
export function makeSaveStateFn(storePath, log) {
  return (state, submittedKeys) =>
    saveState(storePath, mergeState(loadState(storePath, log), state, submittedKeys), log);
}

export function loadState(storePath, log) {
  if (!storePath) return null;
  try {
    const parsed = JSON.parse(readFileSync(storePath, 'utf8'));
    // v1.0：先走迁移链（旧版本 → 当前版本），再统一校验。
    // 此前是 `version !== 1 → 整份丢弃`，导致**版本升级后配置全丢**（回落 patch config）。
    const raw = migrateState(parsed, log);
    if (!raw || !Array.isArray(raw.rules)) {
      log.warn(`store 文件格式不符（version=${parsed?.version}），忽略并沿用 patch config`);
      return null;
    }
    return {
      propose: raw.propose === true,
      rules: raw.rules,
      storePath,
      // v0.9.9（顺手修 v0.9.8 已知问题 §十三-9）：读回 timeZone / mode。
      // 旧 store 文件无此键 → undefined，调用方（index.js store 合并点）跳过。
      timeZone: raw.timeZone,
      mode: raw.mode,
      // v0.8.0 修复：读回 providerMeta（旧 store 文件无此键 → undefined，调用方跳过）
      providerMeta: raw.providerMeta,
      // v0.9.4 UX 补丁：读回 reports（面板开启后重启不回落 patch 默认）。
      // 旧 store 文件无此键 → undefined，调用方（index.js store 合并点）跳过。
      reports: raw.reports,
      // v0.9.9（方案 §6-1 第 7 条）：读回 timeWindows。旧 store 文件无此键 → undefined。
      timeWindows: raw.timeWindows,
    };
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      log.warn(`store 读取失败（沿用 patch config）: ${error?.message ?? error}`);
    }
    return null;
  }
}

export function saveState(storePath, state, log) {
  const payload = JSON.stringify({ version: STORE_VERSION, ...state, savedAt: new Date().toISOString() }, null, 2);
  const tmp = `${storePath}.tmp-${process.pid}`;
  try {
    mkdirSync(dirname(storePath), { recursive: true });
    writeFileSync(tmp, payload, { encoding: 'utf8', flag: 'wx' });
    renameSync(tmp, storePath); // 原子替换
    log.info(`state saved → ${storePath}`);
    return true;
  } catch (error) {
    log.error(`state 保存失败: ${error?.message ?? error}`);
    try {
      unlinkSync(tmp); // 清理残留 tmp（best-effort）
    } catch {
      // ignore
    }
    return false;
  }
}
