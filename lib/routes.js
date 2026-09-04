/**
 * webServer 状态路由：GET <statusPath>（默认 /api/model-router/status）。
 *
 * 回环围栏与 @botton/dsh-guardian 同款（socket 回环 + Host 回环 + 浏览器同源）：
 * 状态只读，但仍仅限本机访问，X-Forwarded-For 永远不可信。
 */

import { runBenchmark } from './probe.js';

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
 *           saveStateFn: Function, log: object }} deps
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
          version: '0.7.0',
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
  ];
}
