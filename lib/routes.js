/**
 * webServer 状态路由：GET <statusPath>（默认 /api/model-router/status）。
 *
 * 回环围栏与 @botton/dsh-guardian 同款（socket 回环 + Host 回环 + 浏览器同源）：
 * 状态只读，但仍仅限本机访问，X-Forwarded-For 永远不可信。
 *
 * v0.8.0 G1：新增报告接口（GET /api/model-router/reports[?l1=1|?day=YYYY-MM-DD]
 * + POST /api/model-router/reports/generate）。version 去硬编码（读 package.json，
 * 升级不再需要同步 routes.js）。
 */

import { createRequire } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { runBenchmark } from './probe.js';
import {
  persistReport as archivePersist,
  writeAtomic as archiveWriteAtomic,
  KIND_SCHEMA_VERSION,
  ARCHIVE_KINDS,
  archiveName,
  kindOfFilename,
  listArchives,
  safeArchivePath,
  resolveArchiveDir,
} from './archive.js';

/**
 * v0.9.9（方案 §6-1 第 6 条）：/status 回显 timeWindows + 现算 segment/nextBoundaryAt。
 *
 * - segment：当前所属段（peak/valley），现算；与 router.segmentOfNow 同源口径
 * - nextBoundaryAt：当前段下一个边界的 ISO 时间戳——可由面板显示「距下次切换还有 X 分钟」
 *
 * @param {object|null} tw timeWindows 字段
 * @param {string|null} tz IANA 时区
 * @returns {object|null}
 */
function serializeTimeWindows(tw, tz) {
  if (!tw || tw.enabled !== true) return null;
  // v0.9.21：改用 router 的**共享实现**（`localHHMM` + `segmentOfHHMM`）。
  // 此前这里是「独立小函数」——理由是「避免循环依赖」，但 `router.js` 是
  // **零 import 的叶子模块**，不存在环；重复实现反而带来两个风险：
  //   ① `hour12: false` 未钉 hourCycle → ICU 可能产 h24（"24:00"）破坏字符串比较
  //   ② 半开区间判定靠「与 router.segmentOf 实现对齐」的人工约定 → 漂移风险
  const HHMM = localHHMM(tz, new Date());
  const segment = segmentOfHHMM(HHMM, tw.peakStart, tw.valleyStart);
  // nextBoundaryAt：本段下一个边界 ISO 时间戳——「当前段结束」的时刻，
  // 也就是下一段的起点。
  // - 峰段 [peakStart, valleyStart) → 结束于 valleyStart（谷起）
  // - 谷段 [valleyStart, peakStart)（次日）→ 结束于次日 peakStart（峰起）
  //
  // 实现：对当前日期分别尝试「峰起/谷起」两个时刻，合并成两个候选，取
  //「未来最近」那个（边界必须 > now）。这样无论实机时间是峰段还是谷段，
  // 都给到正确的「下一个边界」，无需分别处理 +1 天。
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const [ph, pm] = peakStart.split(':').map(Number);
  const [vh, vm] = valleyStart.split(':').map(Number);
  const candidates = [];
  for (const dayOffset of [0, 1]) {
    const dayBase = new Date(today);
    dayBase.setDate(dayBase.getDate() + dayOffset);
    for (const [hh, mm] of [[ph, pm], [vh, vm]]) {
      const c = new Date(dayBase);
      c.setHours(hh, mm, 0, 0);
      if (c > now) candidates.push(c);
    }
  }
  candidates.sort((a, b) => a - b);
  const boundary = candidates[0];
  // 透传 peak/valley.route——面板需要读回保存的候选链。
  return {
    enabled: true,
    peakStart,
    valleyStart,
    segment,
    nextBoundaryAt: boundary ? boundary.toISOString() : null,
    tz,
    peak: Array.isArray(tw.peak?.route) ? tw.peak.route : [],
    valley: Array.isArray(tw.valley?.route) ? tw.valley.route : [],
  };
}
import { dayKeyOf } from './daily.js';
import { LOADTEST_PHASES, validateLoadtestOptions } from './loadtest.js';
import {
  ModelTestRunner,
  validateModelTestTargets,
  validateManualInput,
  validatePhases,
  manualWarnings,
  formatReportMarkdown as modelTestFormatMarkdown,
} from './model-test.js';
import { quotaGroupCount } from './config.js';
// v0.9.21：复用 router 的时间判定共享实现（消除重复的 Intl 选项 + 半开区间逻辑）。
// router.js 是零 import 的叶子模块，此处不会成环。
import { localHHMM, segmentOfHHMM } from './router.js';

const require = createRequire(import.meta.url);
let VERSION = '0.0.0';
try {
  VERSION = require('../package.json').version ?? VERSION;
} catch {
  // 读取失败保持 fallback（npm 安装后 package.json 恒在，此处仅为防御）
}

function isIPv4Loopback(v4) {
  const parts = v4.split('.');
  return (
    parts.length === 4 &&
    parts[0] === '127' &&
    parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
  );
}

function isLoopbackAddress(address) {
  if (address === undefined) return false;
  const normalized = address.toLowerCase();
  if (normalized === '::1') return true;
  if (normalized.startsWith('::ffff:')) return isIPv4Loopback(normalized.slice(7));
  return isIPv4Loopback(normalized);
}

function isLoopbackHostname(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]') return true;
  return isIPv4Loopback(hostname);
}

export function isTrustedRequest(req) {
  if (!isLoopbackAddress(req.socket.remoteAddress)) return false;
  const host = req.headers.host;
  if (typeof host !== 'string') return false;
  let hostUrl;
  try {
    hostUrl = new URL('http://' + host);
  } catch {
    return false;
  }
  if (!isLoopbackHostname(hostUrl.hostname)) return false;
  if (req.headers['sec-fetch-site'] === 'cross-site') return false;
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  try {
    return new URL(origin).host === hostUrl.host;
  } catch {
    return false;
  }
}

function writeJson(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'referrer-policy': 'no-referrer',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

/** v0.9.10 Task 4：冲突判定的最小采样数——低于此值只给 info（防假阳性）。 */
const CONFLICT_MIN_SAMPLES = 10;
/** v0.9.10 Task 4：声明虚标阈值——观测速率 < 声明 × 此值 且被限流 → 视为冲突。 */
const CONFLICT_RATIO = 0.8;

/**
 * v0.9.10 Task 4：计算「声明 vs 实测」冲突（OQ1 决策：声明优先，实测仅提示）。
 *
 * **判定语义**（关键，避免误报）：不是「实测用量 < 声明限额」就算冲突——那是正常的
 * 「没跑满」。真正的冲突信号是：**已经被限流了，但速率仍低于声明**，说明上游实际
 * 限额低于声明（方向性方案 v1.3 §4.7「声明值虚标」）。
 *
 * 采样不足（< CONFLICT_MIN_SAMPLES）时只给 info，不给 warn——避免几次偶发错误
 * 就触发警告。
 *
 * @param {object} declared providerMeta[provider]（声明字段）
 * @param {object|null} observed metrics.observedOf 结果
 * @returns {Array<{field, declared, observed, severity, message}>} 空数组 = 无冲突
 */
function computeConflicts(declared, observed) {
  if (!observed || !declared) return [];
  const n = observed.sampleSize ?? 0;
  if (n < CONFLICT_MIN_SAMPLES) {
    return [{
      field: 'sampleSize',
      declared: null,
      observed: n,
      severity: 'info',
      message: `近 60s 仅 ${n} 次采样（< ${CONFLICT_MIN_SAMPLES}），暂不判定声明是否虚标`,
    }];
  }
  const out = [];
  const rl = observed.rateLimited429Count ?? 0;
  // 只有「被限流」时才可能虚标——没被限流说明声明至少不偏松
  if (rl > 0) {
    if (Number.isInteger(declared.rpmLimit) && Number.isFinite(observed.estimatedRpm) &&
        observed.estimatedRpm < declared.rpmLimit * CONFLICT_RATIO) {
      out.push({
        field: 'rpmLimit',
        declared: declared.rpmLimit,
        observed: observed.estimatedRpm,
        severity: 'warn',
        message: `近 60s 观测到 ${rl} 次速率限制，而请求速率约 ${observed.estimatedRpm}/min，` +
          `低于声明的 ${declared.rpmLimit}/min —— 实际限额可能低于声明`,
      });
    }
    if (Number.isInteger(declared.tpmLimit) && Number.isFinite(observed.estimatedTpm) &&
        observed.estimatedTpm < declared.tpmLimit * CONFLICT_RATIO) {
      out.push({
        field: 'tpmLimit',
        declared: declared.tpmLimit,
        observed: observed.estimatedTpm,
        severity: 'warn',
        message: `近 60s 观测到 ${rl} 次速率限制，而用量约 ${observed.estimatedTpm} tokens/min，` +
          `低于声明的 ${declared.tpmLimit}/min —— 实际限额可能低于声明`,
      });
    }
  }
  return out;
}

/**
 * v0.9.10 Task 4：/status 的 providerMeta 序列化——附加**派生**字段
 * `observed`（近 60s 实测，来自 metrics）与 `conflicts`（声明 vs 实测差异）。
 *
 * 派生字段**不写回 config**（每次 GET 现算，与 D8「conflicts 实时计算」一致）。
 * 回传安全性：normalizeConfig 只提取白名单字段，派生字段会被安全丢弃，无污染。
 *
 * @param {object} pm config.providerMeta
 * @param {object} metrics Metrics 实例（可为 stub）
 * @returns {object} 新对象（不修改入参）
 */
function serializeProviderMeta(pm, metrics) {
  if (!pm || typeof pm !== 'object') return pm;
  const out = {};
  for (const [provider, m] of Object.entries(pm)) {
    if (!m || typeof m !== 'object') { out[provider] = m; continue; }
    const observed = metrics?.observedOf?.(provider) ?? null;
    const entry = { ...m };
    if (observed) entry.observed = observed;
    const conflicts = computeConflicts(m, observed);
    if (conflicts.length) entry.conflicts = conflicts;
    out[provider] = entry;
  }
  return out;
}

/**
 * @param {{ config: object, router: object, cooldown: object, metrics: object,
 *           quota: object, registry: object, probe: object, llm: object,
 *           wrapperStats: object, startedAt: number,
 *           resolveSessions?: Function,
 *           saveStateFn: Function, log: object,
 *           daily?: object, reporter?: object }} deps
 *   daily/reporter：v0.8.0 G1 日账本与聚合器（reports.enabled=false 时为空，
 *   报告接口返回 503 明确提示，接口存在性稳定）。
 *   loadtest：v0.8.0 B-2 负载测试执行器（LoadTestRunner，GET/POST/DELETE 端点）。
 * @returns {{ kind: 'exact', path: string, handler: Function }[]}
 */
export function makeStatusRoutes({
  config,
  router,
  cooldown,
  metrics,
  quota,
  registry,
  probe,
  llm,
  wrapperStats,
  startedAt,
  resolveSessions,
  saveStateFn,
  log,
  daily,
  reporter,
  loadtest,
  modelTest,
  pkgRegistered,
}) {
  // v0.9.9.4 Task 5/6：档案目录（三类 kind 共用）。
  // 不依赖 reports.enabled —— 那是「每日报告」开关，与档案落盘是两回事。
  const archiveDir = resolveArchiveDir(config);

  const guard = (handler) => async (req, res) => {
    if (!isTrustedRequest(req)) {
      writeJson(res, 403, { ok: false, error: 'forbidden: loopback-only' });
      return;
    }
    try {
      await handler(req, res);
    } catch (error) {
      writeJson(res, 500, {
        ok: false,
        error: `插件内部错误：${error instanceof Error ? error.message : String(error)}`,
      });
    }
  };

  return [
    {
      kind: 'exact',
      path: config.statusPath,
      handler: guard(async (req, res) => {
        if (req.method !== 'GET') {
          writeJson(res, 405, { ok: false, error: 'method not allowed: use GET' });
          return;
        }
        // provider 骨架为纯同步无 IO 镜像：dsh adapter 是懒注册的（apply 时刻可能
        // 只有部分路由已注册），每次查询顺手重刷，保证面板看到的就是当前注册表
        try {
          registry?.refreshProviders?.();
        } catch {
          // 刷新失败不影响响应（保留旧快照）
        }
        // v0.5.1/v0.6.0：最近活跃会话附标题（两级解析：live 折叠 + sessionQuery 持久化兜底；
        // 解析失败/无标题时 title=null，客户端回退显示 id）
        const ms = metrics.snapshot();
        if (Array.isArray(ms.sessions) && ms.sessions.length > 0 && typeof resolveSessions === 'function') {
          try {
            const resolved = await resolveSessions(ms.sessions.map((s) => s.id));
            const byId = new Map(resolved.map((t) => [t.id, t.title]));
            ms.sessions = ms.sessions.map((s) => ({ ...s, title: byId.has(s.id) ? byId.get(s.id) : null }));
          } catch {
            // 标题解析失败不影响状态响应（保持无 title 字段）
          }
        }
        writeJson(res, 200, {
          ok: true,
          plugin: '@botton/dsh-model-router',
          version: VERSION, // v0.8.0 G1：去硬编码（读 package.json）
          uptimeSec: Math.round((Date.now() - startedAt) / 1000),
          checkedAt: new Date().toISOString(),
          config: {
            propose: config.propose,
            rules: config.rules,
            // v0.8.0 修复：status 须回显（此前漏列，面板/API 看不到热更新结果）
            // v0.9.10 Task 4：附加派生字段 observed/conflicts（现算，不写回 config）
            providerMeta: serializeProviderMeta(config.providerMeta, metrics),
            fallbackPolicy: {
              ...config.fallbackPolicy,
              // v0.9.3 P1-9：maxRetries 来源标注 + 自动调优公式诊断（配置透明）
              maxRetriesSource: config._hasExplicitMaxRetries ? 'explicit' : 'auto',
              autoTuneFormula: 'max(quotaGroupCount*2, 5)',
              quotaGroupCount: quotaGroupCount(config),
            },
            adapterRegistered: pkgRegistered === true,
            firstTokenTimeoutMs: config.firstTokenTimeoutMs,
            failoverBudgetMs: config.failoverBudgetMs,
            exhaustionWindowSec: config.exhaustionWindowSec,
            probe: config.probe,
            timeZone: config.timeZone,
            sessionsDir: config.sessionsDir,
            mode: config.mode,
            // v0.9.9（方案 §6-1 第 6 条）：timeWindows + 现算 segment/nextBoundaryAt。
            // segment 与 nextBoundaryAt 由 routes 侧现算，不写回 config。
            // nextBoundaryAt 格式：当前段的下一个边界 ISO 字符串；未启用时为 null。
            timeWindows: serializeTimeWindows(config.timeWindows, config.timeZone),
            // v0.9.4（A-5）：回显 allowLegacyMatch（诊断开关状态）
            allowLegacyMatch: config.allowLegacyMatch,
            storePath: config.storePath,
          },
          router: router.snapshot(),
          cooldown: cooldown.snapshot(),
          metrics: ms,
          quota: quota.snapshot(),
          // v0.9.5 §11：窗口上限仓快照（providerMeta 已知 provider → quotaSnapshot）。
          // 未声明窗口 / 从未触碰的 provider 不出现 → 面板「窗口限额」段只展示已声明项。
          // v0.9.6：传 meta 做声明对齐——已删除的窗口即时从快照消失（否则残留项仍显示）。
          quotaWindows: (() => {
            const snap = {};
            const pms = config.providerMeta || {};
            if (quota && typeof quota.quotaSnapshot === 'function') {
              for (const p of Object.keys(pms)) {
                const s = quota.quotaSnapshot(p, pms[p]);
                if (s && (s.fiveHour || s.weekly || (Array.isArray(s.customWindows) && s.customWindows.length))) {
                  snap[p] = s;
                }
              }
            }
            return snap;
          })(),
          probe: probe ? probe.snapshot() : null,
          registry: registry ? registry.snapshotOut() : null,
          wrapper: wrapperStats,
          // v0.9.4：每日报告状态回显——enabled 与 reportDir，让面板与运维侧无需开启就能
          // 看到「当前 daily 是否装配、报告文件落在哪」。解决 v0.9.3 「不知报告放哪」痛点。
          reports: {
            enabled: Boolean(daily && reporter),
            reportDir: daily?.reportDir ?? null,
            hour: config.reports?.hour ?? null,
          },
        });
      }),
    },
    {
      kind: 'exact',
      path: '/api/model-router/state',
      handler: guard(async (req, res) => {
        if (req.method !== 'POST') {
          writeJson(res, 405, { ok: false, error: 'method not allowed: use POST' });
          return;
        }
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        let body;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        } catch {
          writeJson(res, 400, { ok: false, error: '请求体须为合法 JSON' });
          return;
        }
        const { normalizeState } = await import('./config.js');
        let state;
        try {
          // v0.9.4（A-4）：透传 patch 现值 allowLegacyMatch，避免面板保存把
          // legacy 语义强制归 false（normalizeState 复用 config.allowLegacyMatch）。
          state = normalizeState(body, config.allowLegacyMatch === true, { log });
        } catch (error) {
          writeJson(res, 400, { ok: false, error: error.message });
          return;
        }
        // v0.9 纯选择驱动：优先模式迁移到每个规则包（rule.mode/rule.custom），
        // 面板不再热切换全局 mode/cooldown。仅更新规则（applyRuntime）与 providerMeta。
        router.applyRuntime(state); // 热更新（立即生效，无需重启）
        // v0.8.0 修复：providerMeta 热生效（registry._profileMeta 每次现读
        // config 引用，替换引用即对 registeredPairs/metaSnapshot/loadtest 生效）；
        // 未提交时 state.providerMeta 为 undefined → 保留 patch 值。
        if (state.providerMeta !== undefined) config.providerMeta = state.providerMeta;
        // v0.9.4 UX 补丁：reports 段热生效——同 config.reports 引用替换（与 providerMeta 同模型）。
        // 注意：daily 实例本身在启动期根据 reports.enabled 一次性装配（index.js:147），
        // 运行时切换 enabled 不会重新装配 DailyLedger；下一段处理「启用后需重启」提示。
        const reportsChanged = state.reports !== undefined && state.reports.enabled !== config.reports?.enabled;
        if (state.reports !== undefined) config.reports = state.reports;
        // v0.9.9（方案 §6-1 第 5 条）：timeWindows 热生效。引用替换即时生效（router 链路
        // 直接读 config.timeWindows，未提交时 state.timeWindows 为 undefined → 保留 patch 值）。
        // 注意：patch config 里的 timeWindows **第一次**就被 normalizeConfig 规范化进 merged
        // （timeZone 同步），无需额外热处理。状态接口 / /status 立即回显新段。
        if (state.timeWindows !== undefined) config.timeWindows = state.timeWindows;
        const saved = saveStateFn(state);
        // v0.9.4 UX 补丁：构造响应消息——reports 切换涉及 daily 实例重启，必须告知用户
        const responseBody = {
          ok: saved,
          state,
        };
        if (reportsChanged) {
          responseBody.requiresReload = true;
          responseBody.reloadHint = state.reports.enabled
            ? '每日报告设置已启用。daily 实例需重启 dsh 才生效（macOS: launchctl kickstart -k gui/$(id -u)/com.deepseek.dsh）'
            : '每日报告设置已关闭。daily 实例需重启 dsh 才停止记账（macOS: launchctl kickstart -k gui/$(id -u)/com.deepseek.dsh）';
          if (saved) {
            responseBody.message = '已保存到 patch，但需重启 dsh 让 daily 实例生效';
          } else {
            responseBody.message = 'patch 持久化失败——重启前不会生效（重启后回落 patch config）';
          }
        } else if (saved) {
          responseBody.message = '已保存并即时生效';
        } else {
          responseBody.message = '已即时生效，但持久化失败（重启后回落 patch config）';
        }
        writeJson(res, saved ? 200 : 500, responseBody);
        log.info(`state updated via panel: rules=${state.rules.length} reports=${state.reports ? JSON.stringify(state.reports) : 'unchanged'}`);
      }),
    },
    {
      kind: 'exact',
      path: '/api/model-router/quota/windows',
      handler: guard(async (req, res) => {
        if (req.method !== 'GET') {
          writeJson(res, 405, { ok: false, error: 'method not allowed: use GET' });
          return;
        }
        const url = new URL(req.url, 'http://localhost');
        const provider = url.searchParams.get('provider');
        if (!provider) {
          writeJson(res, 400, { ok: false, error: 'missing ?provider=' });
          return;
        }
        // v0.9.6：传 meta 做声明对齐——已删除的窗口即时消失，避免抽屉显示残留项。
        const snap =
          quota && typeof quota.quotaSnapshot === 'function'
            ? quota.quotaSnapshot(provider, (config.providerMeta || {})[provider])
            : null;
        writeJson(res, 200, {
          ok: true,
          provider,
          ...(snap || { undeclared: true, fiveHour: null, weekly: null, customWindows: [] }),
        });
      }),
    },
    {
      kind: 'exact',
      path: '/api/model-router/quota/reset',
      handler: guard(async (req, res) => {
        if (req.method !== 'POST') {
          writeJson(res, 405, { ok: false, error: 'method not allowed: use POST' });
          return;
        }
        if (!quota || typeof quota.markReset !== 'function') {
          writeJson(res, 503, { ok: false, error: 'quota 未装配' });
          return;
        }
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        let body;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        } catch {
          writeJson(res, 400, { ok: false, error: '请求体须为合法 JSON' });
          return;
        }
        const { provider, windowId, resetAt } = body || {};
        if (!provider || !windowId) {
          writeJson(res, 400, { ok: false, error: 'missing provider / windowId' });
          return;
        }
        const meta = (config.providerMeta && config.providerMeta[provider]) || {};
        const r = quota.markReset(provider, windowId, meta, resetAt);
        writeJson(res, r.ok ? 200 : 400, r.ok ? { ok: true, provider, windowId, used: r.used, resetAt: r.resetAt } : { ok: false, error: r.error });
      }),
    },
    {
      kind: 'exact',
      path: '/api/model-router/quota/sync',
      handler: guard(async (req, res) => {
        if (req.method !== 'POST') {
          writeJson(res, 405, { ok: false, error: 'method not allowed: use POST' });
          return;
        }
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        let body;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        } catch {
          writeJson(res, 400, { ok: false, error: '请求体须为合法 JSON' });
          return;
        }
        const provider = body && body.provider;
        const windows = body && body.windows;
        if (typeof provider !== 'string' || !provider) {
          writeJson(res, 400, { ok: false, error: 'missing provider' });
          return;
        }
        // windows: { fiveHour?, weekly?, customWindows? } → providerMeta.quotaWindows/customWindows
        const cur = (config.providerMeta && config.providerMeta[provider]) || {};
        const curQW = cur.quotaWindows || {};
        const newQW = { ...curQW };
        if (windows && windows.fiveHour !== undefined) {
          if (windows.fiveHour === null) delete newQW.fiveHour;
          else newQW.fiveHour = windows.fiveHour;
        }
        if (windows && windows.weekly !== undefined) {
          if (windows.weekly === null) delete newQW.weekly;
          else newQW.weekly = windows.weekly;
        }
        const newCW = windows && windows.customWindows !== undefined ? windows.customWindows : cur.customWindows;
        const newMeta = { ...cur };
        delete newMeta.quotaWindows;
        delete newMeta.customWindows;
        if (Object.keys(newQW).length) newMeta.quotaWindows = newQW;
        if (Array.isArray(newCW) && newCW.length) newMeta.customWindows = newCW;
        // §14 #3-b：走完整 normalizeState 链路（复用 patch allowLegacyMatch），不绕开校验，
        // 与 /state 共享同一份 providerMeta 引用，避免互相覆盖。
        const { normalizeState } = await import('./config.js');
        let state;
        try {
          state = normalizeState(
            {
              rules: config.rules,
              providerMeta: { ...(config.providerMeta || {}), [provider]: newMeta },
            },
            config.allowLegacyMatch === true,
            { log },
          );
        } catch (error) {
          writeJson(res, 400, { ok: false, error: error.message });
          return;
        }
        if (state.providerMeta !== undefined) config.providerMeta = state.providerMeta;
        if (quota && typeof quota.syncWindows === 'function') quota.syncWindows(provider, {
          fiveHour: newQW.fiveHour,
          weekly: newQW.weekly,
          customWindows: newCW,
        });
        const saved = saveStateFn(state);
        log.info(`quota/sync: provider=${provider} windows=${JSON.stringify({ fiveHour: newQW.fiveHour, weekly: newQW.weekly, customDone: Array.isArray(newCW) })}`);
        writeJson(res, saved ? 200 : 500, {
          ok: saved,
          provider,
          windows: newQW,
          customWindows: newCW,
          message: saved ? '窗口限额已保存并即时生效' : '已即时生效，但持久化失败（重启后回落 patch config）',
        });
      }),
    },
    {
      // 立即健康探测（v0.4.0）：指定 provider+model → 同步探测并返回该 hop 结果；
      // 不指定 → 对注册表全部 (provider,model) 异步批量探测（202，结果看下次 GET status）
      kind: 'exact',
      path: '/api/model-router/probe',
      handler: guard(async (req, res) => {
        if (req.method !== 'POST') {
          writeJson(res, 405, { ok: false, error: 'method not allowed: use POST' });
          return;
        }
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        let body = {};
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        } catch {
          body = {};
        }
        const targets = [];
        if (typeof body.provider === 'string' && body.provider) {
          targets.push({ provider: body.provider, model: typeof body.model === 'string' ? body.model : null });
        }
        if (targets.length === 1 && targets[0].model) {
          try {
            const result = await probe.runProbe(llm, targets[0].provider, targets[0].model);
            writeJson(res, 200, { ok: true, result });
          } catch (error) {
            writeJson(res, 500, { ok: false, error: `probe failed: ${error?.message ?? error}` });
          }
          return;
        }
        // 批量：注册表全部非休眠 (provider,model)
        const all = (registry?.registeredPairs?.() ?? [])
          .filter((p) => p.model !== null)
          .map((p) => ({ provider: p.provider, model: p.model }));
        if (!probe.enabled && all.length > 0) {
          probe.enabled = true; // 手动触发时临时开启（记录生效）
        }
        void probe.runAll(llm, all); // 异步跑，不阻塞响应
        writeJson(res, 202, {
          ok: true,
          message: `已触发 ${all.length} 个 (provider,model) 的批量探测，结果请稍后从 GET status 查看`,
          targets: all.length,
        });
        log.info(`probe-all triggered via API: ${all.length} targets`);
      }),
    },
    {
      // TRM 压测（v0.4.0，手动触发）：QPS 阶梯找 RPM 边界（方法论源自 trm-test，安全系数 0.6）
      kind: 'exact',
      path: '/api/model-router/benchmark',
      handler: guard(async (req, res) => {
        if (req.method !== 'POST') {
          writeJson(res, 405, { ok: false, error: 'method not allowed: use POST' });
          return;
        }
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        let body;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        } catch {
          body = {};
        }
        if (typeof body.provider !== 'string' || !body.provider || typeof body.model !== 'string' || !body.model) {
          writeJson(res, 400, { ok: false, error: '须提供 provider 与 model 字符串' });
          return;
        }
        const opts = {};
        if (Array.isArray(body.qpsLadder)) {
          const ladder = body.qpsLadder.filter((n) => typeof n === 'number' && n > 0).slice(0, 8);
          if (ladder.length) opts.qpsLadder = ladder;
        }
        if (Number.isInteger(body.samplesPerStep) && body.samplesPerStep >= 1 && body.samplesPerStep <= 10) {
          opts.samplesPerStep = body.samplesPerStep;
        }
        try {
          const report = await runBenchmark(llm, body.provider, body.model, log, opts);
          probe.benchmarks.set(probe.keyOf(body.provider, body.model), report);
          writeJson(res, 200, { ok: true, report });
        } catch (error) {
          writeJson(res, 500, { ok: false, error: `benchmark failed: ${error?.message ?? error}` });
        }
      }),
    },
    {
      // v0.8.0 G1 每日报告：
      // GET /reports            → 最近 days 天摘要列表 + 当日实时快照（同 l1 结构）
      // GET /reports?l1=1       → 轻量摘要（面板概览卡 5s 轮询专用，字段对齐摘要卡）
      // GET /reports?day=YYYY-MM-DD → 指定日报告（已生成读文件；未生成实时聚合 raw）
      // reports.enabled=false 时返回 503 明确提示（接口存在性稳定，G2 面板据此显示）
      kind: 'exact',
      path: '/api/model-router/reports',
      handler: guard(async (req, res) => {
        if (req.method !== 'GET') {
          writeJson(res, 405, { ok: false, error: 'method not allowed: use GET' });
          return;
        }
        if (!daily || !reporter) {
          writeJson(res, 503, {
            ok: false,
            error: 'reports disabled: 配置 reports.enabled=true 后启用每日报告',
          });
          return;
        }
        const url = new URL(req.url, 'http://localhost');
        const day = url.searchParams.get('day');
        if (day) {
          if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
            writeJson(res, 400, { ok: false, error: 'day 须为 YYYY-MM-DD（如 2026-09-06）' });
            return;
          }
          // v0.9.5：readReport 返 { generated, generatedAt, report }；report 字段为实时聚合 NDJSON
          const { generated, generatedAt, report } = reporter.readReport(day);
          if (!report) {
            writeJson(res, 404, { ok: false, error: `no data for ${day}` });
            return;
          }
          // v0.9.5：附带 markdown 全文（仅已生成才返，未生成 null）
          let markdown = null;
          if (generated) {
            const mdPath = join(daily.reportDir, `${day}.report.md`);
            try {
              markdown = readFileSync(mdPath, 'utf8');
            } catch {
              markdown = null;
            }
          }
          writeJson(res, 200, { ok: true, report: { ok: true, day, generatedAt, ...report }, generated, markdown });
          return;
        }
        const l1 = reporter.l1Summary();
        writeJson(res, 200, { ok: true, days: l1.days, today: l1.today });
      }),
    },
    {
      // v0.8.0 G1：立即生成昨日报告（手动触发，供实战验收与补生成）
      kind: 'exact',
      path: '/api/model-router/reports/generate',
      handler: guard(async (req, res) => {
        if (req.method !== 'POST') {
          writeJson(res, 405, { ok: false, error: 'method not allowed: use POST' });
          return;
        }
        if (!daily || !reporter) {
          writeJson(res, 503, {
            ok: false,
            error: 'reports disabled: 配置 reports.enabled=true 后启用每日报告',
          });
          return;
        }
        const today = dayKeyOf(Date.now(), daily.timeZone);
        const yesterday = dayKeyOf(Date.now() - 86400_000, daily.timeZone);
        // v0.9.5：磁盘只有 md，但 hasReport 仍先判存在；若有 md 则「已生成」分支返 readReport 新形态
        if (daily.hasReport(yesterday)) {
          const r = reporter.readReport(yesterday);
          const mdPath = join(daily.reportDir, `${yesterday}.report.md`);
          let markdown = null;
          try { markdown = readFileSync(mdPath, 'utf8'); } catch { markdown = null; }
          writeJson(res, 200, {
            ok: true,
            report: { ok: true, day: yesterday, generatedAt: r.generatedAt, ...(r.report || {}) },
            generated: true,
            markdown,
            day: yesterday,
            already: true,
          });
          return;
        }
        if (!daily.hasData(yesterday)) {
          writeJson(res, 404, { ok: false, error: `no data for ${yesterday}` });
          return;
        }
        // v0.9.4：generate 写盘失败 throw → 显式 500 + error；v0.9.5 generate 始终重写（不早返）
        let report;
        try {
          report = reporter.generate(yesterday);
        } catch (error) {
          writeJson(res, 500, {
            ok: false,
            day: yesterday,
            error: `report write failed: ${error?.message ?? String(error)}`,
          });
          log.error(`reports/generate write failed for ${yesterday}: ${error?.message ?? error}`);
          return;
        }
        const mdPath = join(daily.reportDir, `${yesterday}.report.md`);
        let markdown = null;
        try { markdown = readFileSync(mdPath, 'utf8'); } catch { markdown = null; }
        writeJson(res, 200, { ok: true, report, generated: true, markdown, day: yesterday });
        log.info(`reports/generate triggered: ${yesterday} (calls=${report.summary.calls}) today=${today}`);
      }),
    },
    {
      // v0.8.0 B-2 按需负载测试（手动触发，复用 probe 原语；默认只测 free tier）：
      // GET    → 运行快照（running/last/results）
      // POST   → 启动 phase（202 异步；已在跑 409；非法 phase 400）
      // DELETE → 请求中止（置 aborted 标志，当前请求完成后停止调度）
      kind: 'exact',
      path: '/api/model-router/loadtest',
      handler: guard(async (req, res) => {
        if (!loadtest) {
          writeJson(res, 503, { ok: false, error: 'loadtest 未装配' });
          return;
        }
        if (req.method === 'GET') {
          writeJson(res, 200, { ok: true, ...loadtest.snapshot() });
          return;
        }
        if (req.method === 'DELETE') {
          loadtest.abortAll();
          writeJson(res, 200, { ok: true, message: '已请求中止（当前请求完成后停止调度新请求）' });
          return;
        }
        if (req.method !== 'POST') {
          writeJson(res, 405, { ok: false, error: 'method not allowed: use GET/POST/DELETE' });
          return;
        }
        if (loadtest.running) {
          writeJson(res, 409, { ok: false, error: 'loadtest already running（DELETE 中止或等待完成）' });
          return;
        }
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        let body = {};
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        } catch {
          body = {};
        }
        const phase = typeof body.phase === 'string' ? body.phase : null;
        if (!phase || !LOADTEST_PHASES.includes(phase)) {
          writeJson(res, 400, { ok: false, error: `phase 须为 ${LOADTEST_PHASES.join('/')} 之一` });
          return;
        }
        let opts;
        try {
          opts = validateLoadtestOptions(body);
        } catch (error) {
          writeJson(res, 400, { ok: false, error: error.message });
          return;
        }
        if (typeof body.provider === 'string' && body.provider) opts.provider = body.provider;
        if (typeof body.model === 'string' && body.model) opts.model = body.model;
        if (Array.isArray(body.sizes)) {
          const sizes = body.sizes.filter((n) => Number.isInteger(n) && n > 0).slice(0, 6);
          if (sizes.length) opts.sizes = sizes;
        }
        if (Array.isArray(body.qpsLadder)) {
          const ladder = body.qpsLadder.filter((n) => typeof n === 'number' && n > 0).slice(0, 8);
          if (ladder.length) opts.qpsLadder = ladder;
        }
        if (Number.isInteger(body.samplesPerStep) && body.samplesPerStep >= 1 && body.samplesPerStep <= 10) {
          opts.samplesPerStep = body.samplesPerStep;
        }
        void loadtest.run(phase, opts).catch((error) => log.warn?.(`loadtest ${phase} crashed: ${error?.message ?? error}`));
        writeJson(res, 202, {
          ok: true,
          phase,
          message: `loadtest ${phase} 已启动（默认只测 free tier；结果 GET 本端点查询）`,
        });
        log.info(`loadtest ${phase} triggered via API (tiers=${opts.tiers?.join(',') ?? 'free'})`);
      }),
    },
    {
      // v0.9.5 §9：模型全自动测试（指定清单串行跑 4 相 → 报告落盘 json+md → verdict）
      // GET    → 运行快照 + last + 落盘列表
      // POST   → 启动跑批（202 异步；已在跑 409；入参非法 400；daily 未启用 503）
      // DELETE → 请求中止
      kind: 'exact',
      path: '/api/model-router/model-test',
      handler: guard(async (req, res) => {
        if (!daily || !reporter) {
          writeJson(res, 503, {
            ok: false,
            error: 'reports disabled: 需先在「每日报告」面板启用 reports.enabled=true（model-test 共享报告目录）',
          });
          return;
        }
        if (!modelTest) {
          writeJson(res, 503, { ok: false, error: 'model-test 未装配' });
          return;
        }
        if (req.method === 'GET') {
          const snap = modelTest.snapshot();
          const dir = modelTest.reportDir;
          const list = listRunJson(dir, log);
          writeJson(res, 200, { ok: true, running: snap.running, aborted: snap.aborted, last: snap.last, list, reportDir: dir });
          return;
        }
        if (req.method === 'DELETE') {
          modelTest.abortAll();
          writeJson(res, 200, { ok: true, message: '已请求中止（当前请求完成后停止调度新请求）' });
          return;
        }
        if (req.method !== 'POST') {
          writeJson(res, 405, { ok: false, error: 'method not allowed: use GET/POST/DELETE' });
          return;
        }
        if (modelTest.running) {
          writeJson(res, 409, { ok: false, error: 'model-test already running（DELETE 中止或等待完成）' });
          return;
        }
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        let body = {};
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        } catch {
          body = {};
        }
        // 归一化 targets（数组或 {targets:[...]} 均可）
        const rawTargets = Array.isArray(body.targets) ? body.targets : (Array.isArray(body) ? body : null);
        let targets;
        try {
          targets = validateModelTestTargets(rawTargets, body.confirmPaidBurn);
        } catch (error) {
          writeJson(res, 400, { ok: false, error: error.message });
          return;
        }
        // v0.9.8 phases 入参：非法 → 400（与 targets 校验并列）
        let phases;
        try { phases = validatePhases(body.phases); }
        catch (error) { writeJson(res, 400, { ok: false, error: error.message }); return; }
        // 生成 runId 并在完成回调中落盘（共享 reportDir）
        const runId = body.runId ?? newRunId();
        const opts = {
          runId,
          targets,
          recoveryMs: typeof body.recoveryMs === 'number' ? body.recoveryMs : undefined,
          confirmPaidBurn: body.confirmPaidBurn,
          phases,
          // v0.9.8：删除 prompt/timeoutMs 死代码——routes.js:748 之前透传给 ModelTester.run
          // 但 ModelTester.run 从未读取；保留会字段会误导 caller。改用默认 prompt/'ping'。
        };
        void modelTest.run(targets, { recoveryMs: opts.recoveryMs, runId, phases: opts.phases })
          .then((report) => {
            persistModelTestDir(report, modelTest.reportDir, log);
            // 逐 target 附加人工字段 warnings（便于面板展示）
            (report.targets || []).forEach((tr) => { tr.verdict.warnings = manualWarnings(tr); });
            log.info(`model-test finished: ${runId} targets=${report.targets?.length ?? 0} aborted=${report.aborted}`);
          })
          .catch((error) => log.warn?.(`model-test crashed: ${error?.message ?? error}`));
        writeJson(res, 202, {
          ok: true,
          runId,
          accepted: targets.length,
          willRun: true,
          message: `model-test 已启动（${targets.length} 个模型，${phases.length} 相：${phases.join('/')}；结果 GET 本端点或落盘报告目录）`,
        });
      }),
    },
    {
      // v0.9.5 §9：人工字段补填（覆盖同一份落盘 json，不改自动测试结果）
      kind: 'exact',
      path: '/api/model-router/model-test/manual',
      handler: guard(async (req, res) => {
        if (!modelTest || !modelTest.reportDir) {
          writeJson(res, 503, { ok: false, error: 'model-test 未装配或报告目录不可用' });
          return;
        }
        if (req.method !== 'POST') {
          writeJson(res, 405, { ok: false, error: 'method not allowed: use POST' });
          return;
        }
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        let body = {};
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        } catch {
          body = {};
        }
        let parsed;
        try {
          parsed = validateManualInput(body);
        } catch (error) {
          writeJson(res, 400, { ok: false, error: error.message });
          return;
        }
        // v0.9.9.4 安全加固：原实现直接 `join(reportDir, `${runId}.model-test.json`)`，
        // 而 runId 来自 POST body（validateManualInput 只校验非空字符串，**不校验格式**）
        // → `runId="../../../tmp/evil"` 可逃出档案目录，造成**任意文件写**（后缀限
        // `.model-test.json`）。改用 safeArchivePath 双校验（格式白名单 + 路径前缀确认）。
        let file;
        try {
          file = safeArchivePath(modelTest.reportDir, 'model-test', parsed.runId);
        } catch (error) {
          writeJson(res, 400, { ok: false, error: error.message });
          return;
        }
        let report;
        try {
          report = JSON.parse(readFileSync(file, 'utf8'));
        } catch {
          writeJson(res, 404, { ok: false, error: `找不到报告 ${parsed.runId}` });
          return;
        }
        const t = (report.targets || []).find((x) => `${x.provider}\u0000${x.model}` === parsed.targetKey);
        if (!t) {
          writeJson(res, 404, { ok: false, error: `报告中无 target ${parsed.targetKey}` });
          return;
        }
        if (parsed.manualTpm !== undefined) t.manualTpm = parsed.manualTpm;
        if (parsed.manualMaxContext !== undefined) t.manualMaxContext = parsed.manualMaxContext;
        if (parsed.label !== undefined) t.label = parsed.label;
        if (parsed.notes !== undefined) t.notes = parsed.notes;
        t.verdict.warnings = manualWarnings(t);
        try {
          archiveWriteAtomic(file, JSON.stringify(report, null, 2), log);
        } catch (error) {
          writeJson(res, 500, { ok: false, error: `落盘失败: ${error?.message ?? error}` });
          return;
        }
        writeJson(res, 200, { ok: true, targetKey: parsed.targetKey, warnings: t.verdict.warnings });
      }),
    },
    {
      // v0.9.5 §9：历史落盘报告列表（**兼容别名** —— v0.9.9.4 起转调统一 lister 语义，
      // 但**保持既有响应结构** `{ok, list, reportDir}` 不变：面板历史报告依赖
      // `list[].targets`（client.js:2379），故这里仍走「读全文 + targets 摘要」的 listRunJson）。
      kind: 'exact',
      path: '/api/model-router/model-test/list',
      handler: guard(async (req, res) => {
        if (!modelTest || !modelTest.reportDir) {
          writeJson(res, 503, { ok: false, error: 'model-test 未装配或报告目录不可用' });
          return;
        }
        const list = listRunJson(modelTest.reportDir, log);
        writeJson(res, 200, { ok: true, list, reportDir: modelTest.reportDir });
      }),
    },
    {
      // v0.9.9.4（方案 §6-2 Task 5）：统一测试档案列表（三类 kind）。
      // **轻量**：只 stat 文件名 + mtime + size，**不读档案内容**（实测读全文 466ms）。
      kind: 'exact',
      path: '/api/model-router/test-archives',
      handler: guard(async (req, res) => {
        const dir = archiveDir;
        if (!dir) {
          writeJson(res, 503, { ok: false, error: '档案目录不可用' });
          return;
        }
        const items = listArchives(dir);
        writeJson(res, 200, { ok: true, items, archiveDir: dir });
      }),
    },
    {
      // v0.9.9.4（方案 §6-2 Task 6）：档案详情（回 { report, markdown }）。
      // **安全关键**：kind / runId 均来自 query → 双校验（白名单 + 路径前缀确认）。
      kind: 'exact',
      path: '/api/model-router/test-archives/detail',
      handler: guard(async (req, res) => {
        const dir = archiveDir;
        if (!dir) {
          writeJson(res, 503, { ok: false, error: '档案目录不可用' });
          return;
        }
        const u = new URL(req.url, 'http://localhost');
        const kind = u.searchParams.get('kind');
        const runId = u.searchParams.get('runId');
        if (!kind || !runId) {
          writeJson(res, 400, { ok: false, error: 'kind 与 runId 均为必填' });
          return;
        }
        let file;
        try {
          file = safeArchivePath(dir, kind, runId);
        } catch (error) {
          // 非法 kind / runId / 路径越界 → 400（不泄露具体路径）
          writeJson(res, 400, { ok: false, error: error.message });
          return;
        }
        let report;
        try {
          report = JSON.parse(readFileSync(file, 'utf8'));
        } catch {
          writeJson(res, 404, { ok: false, error: '找不到该档案' });
          return;
        }
        // markdown 仅 model-test 有（loadtest/probe 只落 json）
        let markdown = null;
        if (kind === 'model-test') {
          try {
            markdown = readFileSync(join(dir, archiveName(runId, kind, 'md')), 'utf8');
          } catch {
            markdown = null;
          }
        }
        writeJson(res, 200, { ok: true, kind, runId, report, markdown });
      }),
    },
  ];
}

// ===== model-test 落盘/列表辅助 =====

/**
 * 列出 reportDir 下所有 `*.model-test.json`，返回**含 targets 摘要**的元信息列表。
 *
 * ⚠ **本仓库有第二个列表器**（`archive.listArchives`，只 `stat` 不读内容，三类 kind 通用）。
 * 两者**刻意并存**，不是遗漏：
 *
 * | | `listRunJson`（本函数） | `archive.listArchives` |
 * | --- | --- | --- |
 * | 读内容 | ✅ 全文 + `JSON.parse` | ❌ 只 `stat` |
 * | 提供字段 | runId / startedAt / elapsedMs / targetCount / aborted / **targets 摘要** | kind / runId / size / mtime |
 * | 消费方 | `/model-test`（面板「模型测试」页签的历史表 + 点行看 verdict） | `/test-archives`（「测试档案」页签，三类通用） |
 *
 * 无法合并的原因：面板历史表需要 `elapsedMs` / `targetCount` / `aborted`，点行后还要
 * `targets`（verdict 表）—— 这些都是**内容字段**，`stat` 拿不到。若强行改为轻量列表，
 * 历史表会丢 3 列（UX 回归），或需要新增「点行再取详情」的二次请求（面板流程改动）。
 *
 * **实测开销**（v0.9.21 在实机 dsh 上直接计时，10 份档案 / 173KB）：
 * - `/model-test`：首次 84ms（冷缓存），其后 **12–17ms**
 * - `/test-archives`（轻量对照）：1.5–2.4ms
 *
 * 注：v0.9.9.4 方案里记的「读全文 466ms」是在带 I/O 拦截的环境测的，**虚高约 35 倍**；
 * 真实代价约 15ms。且本端点**仅在面板挂载/用户操作时调用**（非轮询），故可接受。
 *
 * **何时该重访**：档案数增长到 **~200 份**时线性外推约 300ms，届时应改为
 * 「轻量列表 + 点行惰性取详情」（或加 targets 摘要缓存）。
 *
 * @param {string} dir 档案目录
 * @param {object} log
 * @returns {object[]} 按 startedAt 倒序
 */
function listRunJson(dir, log) {
  if (!dir) return [];
  // v0.9.21（S2）：改用顶部 import —— 此前在函数内 `require('node:fs'/'node:path')`，
  // 依赖 `createRequire` shim（那是为读 package.json 而设），与文件顶部既有
  // `import { readFileSync } from 'node:fs'` / `import { join } from 'node:path'`
  // 风格不一致，且无必要。
  try {
    const names = readdirSync(dir).filter((n) => /\.model-test\.json$/.test(n));
    return names.map((n) => {
      let meta = { runId: null, startedAt: null, finishedAt: null, targetCount: null };
      const file = join(dir, n);
      try {
        const raw = JSON.parse(readFileSync(file, 'utf8'));
        meta = {
          runId: raw.runId ?? basename(n, '.model-test.json'),
          startedAt: raw.startedAt ?? null,
          finishedAt: raw.finishedAt ?? null,
          elapsedMs: Number.isFinite(raw.elapsedMs) ? raw.elapsedMs : null,
          phases: Array.isArray(raw.phases) ? raw.phases : null,
          phaseOrder: Array.isArray(raw.phaseOrder) ? raw.phaseOrder : null,
          targetCount: Array.isArray(raw.targets) ? raw.targets.length : null,
          aborted: raw.aborted === true,
          // 轻量 targets 摘要（供面板历史报告渲染 verdict，不含完整 ladder）
          targets: Array.isArray(raw.targets) ? raw.targets.map((t) => ({
            provider: t.provider,
            model: t.model,
            label: t.label ?? null,
            tier: t.tier ?? 'free',
            phases: Array.isArray(t.phases) ? t.phases : null,
            notSelected: Array.isArray(t.notSelected) ? t.notSelected : [],
            skipped: Array.isArray(t.skipped) ? t.skipped : [],
            phaseErrors: t.phaseErrors ?? {},
            probe: t.probe ? { ok: t.probe.ok, errorCode: t.probe.errorCode ?? null, errorMessage: t.probe.errorMessage ?? null } : null,
            rpm: t.rpm ? { lastOkRpm: t.rpm.lastOkRpm ?? null, first429Rpm: t.rpm.first429Rpm ?? null, firstError: t.rpm.firstError ?? null } : null,
            context: t.context ? { maxAccepted: t.context.maxAccepted ?? null, firstError: t.context.firstError ?? null } : null,
            quotaGroup: t.quotaGroup ? { quotaGroup: t.quotaGroup.quotaGroup ?? null, firstError: t.quotaGroup.firstError ?? null } : null,
            verdict: t.verdict ?? null,
          })) : [],
          file,
        };
      } catch {
        // 读取失败仅回退文件名
        meta.runId = basename(n, '.model-test.json');
      }
      return meta;
    }).sort((a, b) => String(b.startedAt ?? '').localeCompare(String(a.startedAt ?? '')));
  } catch {
    return [];
  }
}

/**
 * 把 model-test 报告落盘（json + md 原子写）。
 *
 * v0.9.9.1：改为复用 `lib/archive.js`（与 `lib/model-test.js:persistReport` 统一实现，
 * 消除两套重复）；顶层加 `kind: 'model-test'` 与 `schemaVersion: 1`。
 */
function persistModelTestDir(report, reportDir, log) {
  if (!reportDir) return;
  report.kind = 'model-test';
  report.schemaVersion = KIND_SCHEMA_VERSION;
  const result = archivePersist(reportDir, {
    runId: report.runId,
    kind: 'model-test',
    jsonBody: JSON.stringify(report, null, 2),
    mdBody: modelTestFormatMarkdown(report),
  }, log);
  if (!result) return;
  report.file = result.jsonTarget;
  report.md = result.mdTarget;
  log?.info?.(`model-test 落盘 ${result.jsonTarget}`);
}

function newRunId() {
  const now = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const suffix = Math.random().toString(36).slice(2, 6);
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}T${p(now.getHours())}-${p(now.getMinutes())}-${p(now.getSeconds())}-${suffix}`;
}
