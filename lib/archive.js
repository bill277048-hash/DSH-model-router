/**
 * 档案公共模块（v0.9.9.1 引入）
 *
 * 三类档案（model-test / loadtest / probe）共用：
 * - 顶层 `kind` 与 `schemaVersion`（D3：旧文件无 kind → 读取端默认 'model-test'）
 * - 命名规则 `<runId>.<kind>.<ext>`（`archiveName`）
 * - 原子写 `writeAtomic`（v0.9.9 在 `lib/model-test.js` 私有 + routes.js 另写一份；本模块统一）
 * - 持久化 `persistReport`（取代两套重复实现）
 *
 * 设计取舍：
 * - **不引入 meta 索引**（v1.0 复核 R2 撤销）：面板历史报告依赖 `list[].targets`，meta 无法同时满足
 *   「按 kind 分组 + 时间倒序」与「保留 targets 摘要」两个需求；引入只增复杂度不增价值。
 * - **lister 走 `stat`**（实测 0ms）：新端点 `/test-archives` 不读档案内容（详见方案 §3 D4）。
 * - **保持原失败语义**：落盘失败 → warn + 不阻塞跑批（与 v0.9.9 `persistReport` 一致）。
 */

import { writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

/** 档案 schema 版本。`schemaVersion` 字段升级时此值自增（迁移钩子）。 */
export const KIND_SCHEMA_VERSION = 1;

/** 合法 kind 白名单。Task 5 lister 复用此白名单。 */
export const ARCHIVE_KINDS = ['model-test', 'loadtest', 'probe'];

/** 默认档案目录（与 `lib/daily.js:77` 保持一致）。 */
export function defaultArchiveDir() {
  return join(homedir(), 'Documents', 'dsh-model-router-reports');
}

/**
 * 解析档案目录。
 *
 * **不依赖 `reports.enabled`**——那是「每日报告」的开关，与档案落盘是两回事：
 * 用户可能不开每日报告，但仍希望跑批结果落盘可见。
 *
 * @param {object} [cfg] 运行时配置（读 `reports.dir`）
 * @returns {string} 档案目录绝对路径
 */
export function resolveArchiveDir(cfg) {
  const fromCfg = cfg?.reports?.dir;
  if (typeof fromCfg === 'string' && fromCfg) return fromCfg;
  return defaultArchiveDir();
}

/** 给定 kind + ext 生成 `<runId>.<kind>.<ext>`。 */
export function archiveName(runId, kind, ext) {
  if (!ARCHIVE_KINDS.includes(kind)) {
    throw new Error(`archive: kind 须为 ${ARCHIVE_KINDS.join('/')} 之一（实际 ${JSON.stringify(kind)}）`);
  }
  return `${runId}.${kind}.${ext}`;
}

/** 原子写：写 .tmp 后 rename。失败抛错，由调用方决定是否吞。 */
export function writeAtomic(target, content, log) {
  const tmp = `${target}.tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    writeFileSync(tmp, content, { encoding: 'utf8', flag: 'wx' });
    renameSync(tmp, target);
  } catch (error) {
    log?.warn?.(`archive 写盘失败 ${target}: ${error?.message ?? error}`);
    throw error;
  }
}

/**
 * 统一档案落盘。
 *
 * @param {string} reportDir 档案目录（不存在则递归创建）
 * @param {object} report 报告对象（运行时调用方构造）
 * @param {string} report.runId 必填
 * @param {string} report.kind 必填，ARCHIVE_KINDS 之一
 * @param {string} report.jsonBody JSON 字符串（已 stringify）
 * @param {string} [report.mdBody] Markdown 字符串（probe 类通常不生成）
 * @param {object} [log]
 * @returns {{jsonTarget:string, mdTarget?:string}|null} 落盘成功时返回绝对路径，失败/参数不全返回 null
 */
export function persistReport(reportDir, report, log) {
  if (!reportDir) return null;
  if (!report || !report.runId || !report.kind) {
    log?.warn?.(`archive: report 缺关键字段（runId/kind）`);
    return null;
  }
  if (!ARCHIVE_KINDS.includes(report.kind)) {
    log?.warn?.(`archive: kind "${report.kind}" 不在白名单 ${ARCHIVE_KINDS.join('/')}`);
    return null;
  }
  try {
    mkdirSync(reportDir, { recursive: true });
    const jsonTarget = join(reportDir, archiveName(report.runId, report.kind, 'json'));
    writeAtomic(jsonTarget, report.jsonBody, log);
    let mdTarget;
    if (report.mdBody) {
      mdTarget = join(reportDir, archiveName(report.runId, report.kind, 'md'));
      writeAtomic(mdTarget, report.mdBody, log);
    }
    return { jsonTarget, mdTarget };
  } catch (error) {
    log?.warn?.(`archive 落盘失败 (kind=${report.kind}): ${error?.message ?? error}`);
    return null;
  }
}

/** 从文件名解析 kind（用于 lister 后缀扫描）。 */
export function kindOfFilename(name) {
  for (const k of ARCHIVE_KINDS) {
    if (name.endsWith(`.${k}.json`)) return k;
  }
  return null;
}
