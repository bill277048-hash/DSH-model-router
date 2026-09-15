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
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runBenchmark } from './probe.js';
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
            providerMeta: config.providerMeta, // v0.8.0 修复：status 须回显（此前漏列，面板/API 看不到热更新结果）
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
        const file = join(modelTest.reportDir, `${parsed.runId}.model-test.json`);
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
          writeFileSyncAtomic(file, JSON.stringify(report, null, 2));
        } catch (error) {
          writeJson(res, 500, { ok: false, error: `落盘失败: ${error?.message ?? error}` });
          return;
        }
        writeJson(res, 200, { ok: true, targetKey: parsed.targetKey, warnings: t.verdict.warnings });
      }),
    },
    {
      // v0.9.5 §9：历史落盘报告列表
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
  ];
}

// ===== model-test 落盘/列表辅助 =====

/**
 * 列出 reportDir 下所有 *.model-test.json，返回元信息列表（回环围栏）。
 */
function listRunJson(dir, log) {
  if (!dir) return [];
  const { readdirSync } = require('node:fs');
  const { basename } = require('node:path');
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

/** 把 model-test 报告落盘（json + md 原子写）。 */
function persistModelTestDir(report, reportDir, log) {
  if (!reportDir) return;
  try {
    const { mkdirSync } = require('node:fs');
    mkdirSync(reportDir, { recursive: true });
    const jf = join(reportDir, `${report.runId}.model-test.json`);
    const mf = join(reportDir, `${report.runId}.model-test.md`);
    writeFileSyncAtomic(jf, JSON.stringify(report, null, 2));
    writeFileSyncAtomic(mf, modelTestFormatMarkdown(report));
    report.file = jf;
    report.md = mf;
    log?.info?.(`model-test 落盘 ${jf}`);
  } catch (error) {
    log?.warn?.(`model-test 落盘失败: ${error?.message ?? error}`);
  }
}

function writeFileSyncAtomic(file, content) {
  const { writeFileSync, renameSync } = require('node:fs');
  const tmp = `${file}.tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  writeFileSync(tmp, content, { encoding: 'utf8', flag: 'wx' });
  renameSync(tmp, file);
}

function newRunId() {
  const now = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const suffix = Math.random().toString(36).slice(2, 6);
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}T${p(now.getHours())}-${p(now.getMinutes())}-${p(now.getSeconds())}-${suffix}`;
}
