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

import { writeFileSync, mkdirSync, renameSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
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

/**
 * runId 白名单正则：字母/数字/下划线/点/连字符。
 * **不含 `/` 与 `\`** —— 这是防路径穿越的第一道防线。
 */
const RUN_ID_RE = /^[\w.-]+$/;

/** runId 长度上限（防御超长文件名 / DoS）。 */
const RUN_ID_MAX = 200;

/**
 * 校验 runId 合法性（防路径穿越第一道防线）。
 *
 * 攻击场景：`runId = "../../../../tmp/evil"` → `join(dir, runId + '.model-test.json')`
 * 会逃出档案目录，造成**任意文件写**（后缀限 `.model-test.json`）。
 *
 * 注意：`[\w.-]` 允许 `.`，故 `..` 需**显式拒绝**（两个点可组成上跳路径）。
 *
 * @param {string} runId
 * @returns {string} 原样返回（便于链式调用）
 * @throws {Error} 非法时抛错（调用方映射为 400）
 */
export function assertSafeRunId(runId) {
  if (typeof runId !== 'string' || !runId) {
    throw new Error('archive: runId 须为非空字符串');
  }
  if (runId.length > RUN_ID_MAX) {
    throw new Error(`archive: runId 过长（上限 ${RUN_ID_MAX}）`);
  }
  if (!RUN_ID_RE.test(runId)) {
    throw new Error('archive: runId 含非法字符（仅允许字母/数字/下划线/点/连字符）');
  }
  if (runId.includes('..')) {
    throw new Error('archive: runId 不得含 ".."');
  }
  return runId;
}

/**
 * 构造**受围栏约束**的档案绝对路径（防路径穿越第二道防线）。
 *
 * 双校验：
 * 1. `assertSafeRunId` —— 格式白名单
 * 2. **路径前缀确认** —— `resolve()` 归一化后必须仍在 `dir` 内
 *
 * 第 2 道防线即使第 1 道被绕过（如未来放宽正则）也能兜住。
 *
 * @param {string} dir 档案目录
 * @param {string} kind ARCHIVE_KINDS 之一
 * @param {string} runId
 * @returns {string} 档案 json 绝对路径
 * @throws {Error} 非法 runId / kind，或路径越界
 */
export function safeArchivePath(dir, kind, runId) {
  assertSafeRunId(runId);
  const name = archiveName(runId, kind, 'json');
  const base = resolve(dir);
  const full = resolve(base, name);
  // 归一化后必须仍在 base 下（且不是 base 本身）
  if (!full.startsWith(base + sep)) {
    throw new Error('archive: 路径越界（拒绝访问档案目录之外）');
  }
  return full;
}

/**
 * 列出档案目录下的所有档案（轻量：只 `stat`，**不读内容**）。
 *
 * **实测依据**：读 9 个 `.model-test.json`（168KB）全文需 **466ms**，
 * 而只 `statSync` 为 **0ms**（见方案 §5 Task 5 前置测量）。
 *
 * 只扫 `ARCHIVE_KINDS` 白名单后缀，忽略同目录下的 `.ndjson`（日账本）/
 * `.report.md`（每日报告）等其他文件。
 *
 * @param {string} dir 档案目录
 * @returns {Array<{kind:string, runId:string, size:number, startedAt:string}>} 按时间倒序
 */
export function listArchives(dir) {
  if (!dir) return [];
  try {
    const out = [];
    for (const n of readdirSync(dir)) {
      const kind = kindOfFilename(n);
      if (!kind) continue;
      try {
        const st = statSync(join(dir, n));
        out.push({
          kind,
          runId: n.slice(0, -(kind.length + '.json'.length + 1)), // 去掉 ".kind.json"
          size: st.size,
          // 用 mtime 作「时间」——不读内容即可排序（落盘后 mtime = 最后写入时刻）
          startedAt: st.mtime.toISOString(),
        });
      } catch {
        // 单个文件 stat 失败（权限/竞态删除）→ 跳过，不影响整体
      }
    }
    return out.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
  } catch {
    // 目录不存在 / 不可读 → 空列表（不抛错）
    return [];
  }
}
