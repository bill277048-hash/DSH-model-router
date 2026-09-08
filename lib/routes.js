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
import { runBenchmark } from './probe.js';
import { dayKeyOf } from './daily.js';
import { LOADTEST_PHASES } from './loadtest.js';

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
            fallbackPolicy: config.fallbackPolicy,
            firstTokenTimeoutMs: config.firstTokenTimeoutMs,
            failoverBudgetMs: config.failoverBudgetMs,
            exhaustionWindowSec: config.exhaustionWindowSec,
            probe: config.probe,
            timeZone: config.timeZone,
            sessionsDir: config.sessionsDir,
            mode: config.mode,
            storePath: config.storePath,
          },
          router: router.snapshot(),
          cooldown: cooldown.snapshot(),
          metrics: ms,
          quota: quota.snapshot(),
          probe: probe ? probe.snapshot() : null,
          registry: registry ? registry.snapshotOut() : null,
          wrapper: wrapperStats,
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
        const { applyModeOverrides } = await import('./modes.js');
        let state;
        try {
          state = normalizeState(body);
        } catch (error) {
          writeJson(res, 400, { ok: false, error: error.message });
          return;
        }
        // v0.7.0 优先模式热切换：预设覆盖参数 → config 原地更新（wrapper 每请求现读）
        // → cooldown 参数热更新（applyPolicy）；全部候选熔断状态保留不重置。
        const modeChanged = state.mode !== config.mode;
        applyModeOverrides(config, state.mode);
        if (modeChanged && typeof cooldown.applyPolicy === 'function') {
          cooldown.applyPolicy(config.fallbackPolicy);
          log.info(`mode switched: ${state.mode}（firstToken=${config.firstTokenTimeoutMs}ms budget=${config.failoverBudgetMs}ms cooldown=${config.fallbackPolicy.cooldownSec}s quotaCooldown=${config.fallbackPolicy.quotaCooldownSec}s）`);
        }
        router.applyRuntime(state); // 热更新（立即生效，无需重启）
        const saved = saveStateFn(state);
        writeJson(res, saved ? 200 : 500, {
          ok: saved,
          message: saved ? '已保存并即时生效' : '已即时生效，但持久化失败（重启后回落 patch config）',
          state,
        });
        log.info(`state updated via panel: propose=${state.propose} rules=${state.rules.length} mode=${state.mode}`);
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
          let report = reporter.readReport(day);
          if (!report) {
            // 未到生成点/启动补生成前：实时聚合原始记录（不落文件）
            const records = daily.readDayRecords(day);
            if (records.length) {
              report = { ok: true, day, generatedAt: null, ...reporter.aggregate(records) };
            } else {
              writeJson(res, 404, { ok: false, error: `no data for ${day}` });
              return;
            }
          }
          writeJson(res, 200, { ok: true, report });
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
        if (daily.hasReport(yesterday)) {
          writeJson(res, 200, { ok: true, report: reporter.readReport(yesterday), day: yesterday, already: true });
          return;
        }
        if (!daily.hasData(yesterday)) {
          writeJson(res, 404, { ok: false, error: `no data for ${yesterday}` });
          return;
        }
        const report = reporter.generate(yesterday);
        writeJson(res, 200, { ok: true, report, day: yesterday });
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
        const opts = {};
        if (Array.isArray(body.tiers)) {
          const tiers = body.tiers.filter((t) => typeof t === 'string' && t);
          if (tiers.length) opts.tiers = tiers;
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
  ];
}
