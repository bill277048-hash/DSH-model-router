/**
 * @botton/dsh-model-router — DSH 多供应商模型路由插件 host 入口。
 *
 * 能力（v0.2.0）：
 * 1. 路由规则：rules 声明候选链，支持四种扩展策略（explicit / same-model /
 *    same-provider / exclude-current，源自 dsh 模型注册表）；rules/propose 支持
 *    面板热更新（store JSON 持久化，免改 patch 免重启）。
 * 2. 无感故障切换：llm/stream 包装层，finish 分片驱动 + commit-on-first-chunk +
 *    TTFT 看门狗 + cooldown 熔断 + 候选耗尽合成 error finish（详见 lib/wrapper.js）。
 * 3. 用量记账：usage 分片按 provider 记滚动 5h/1w 窗口（仅可视）。
 * 4. WebUI 面板 + 状态/状态写回接口（回环围栏）。
 *
 * 本插件不注册新 adapter、不读取任何 API key——只在既有 ctx.llm provider 路由
 * 之间切换（provider 路由排他性，方案 §7.3）。注册表数据全部来自 dsh「设置-模型」
 * 同源的 llm 服务目录。
 */

import { normalizeConfig } from './config.js';
import { CooldownBoard } from './cooldown.js';
import { Router } from './router.js';
import { createStreamWrapper } from './wrapper.js';
import { Metrics } from './metrics.js';
import { QuotaLedger } from './quota.js';
import { Registry } from './registry.js';
import { ProbeBoard } from './probe.js';
import { makeSessionTitleResolver } from './titles.js';
import { applyModeOverrides } from './modes.js';
import { loadState, saveState } from './store.js';
import { makeStatusRoutes } from './routes.js';

const PACKAGE_NAME = '@botton/dsh-model-router';

function makeLog(ctx, level) {
  const enabled = (l) =>
    level === 'debug' ||
    (level === 'info' && l !== 'debug') ||
    (level === 'warn' && (l === 'warn' || l === 'error')) ||
    (level === 'error' && l === 'error');
  const emit = (l) => (...args) => {
    if (!enabled(l)) return;
    const line = `[model-router] ${args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}`;
    try {
      ctx.logger?.[l]?.(line);
    } catch {
      // 日志不可用不影响主流程
    }
  };
  return { debug: emit('debug'), info: emit('info'), warn: emit('warn'), error: emit('error') };
}

/** cordis 插件名（与 insert 行 id 一致）。 */
export const name = 'model-router';
/** llm：注册表镜像数据源；agents：agent/request 事件冒泡；webServer：面板与接口。 */
export const inject = ['llm', 'agents', 'webServer'];

/**
 * 插件 apply：装配 registry/router/cooldown/metrics/quota → 挂 llm/stream 包装层 +
 * agent/request 提议 + 面板接口 → 返回清理。
 * @param {object} ctx cordis 上下文
 * @param {object|undefined} config insert 条目的 config 块
 */
export function apply(ctx, config) {
  const cfg = normalizeConfig(config);
  const log = makeLog(ctx, cfg.logLevel ?? 'info');
  const llm = ctx.llm;

  // 注册表镜像（数据源 = dsh 设置-模型 同源的 llm 服务目录）
  const registry = new Registry(llm, log, cfg.registryRefreshSec);
  registry.refreshProviders();

  // 运行时状态：store JSON 存在时覆盖 patch config 初值（面板改动的持久化）
  const stored = loadState(cfg.storePath, log);
  if (stored) {
    cfg.propose = stored.propose;
    cfg.rules = stored.rules;
    if (typeof stored.timeZone === 'string' || stored.timeZone === null) cfg.timeZone = stored.timeZone;
    if (typeof stored.mode === 'string') cfg.mode = stored.mode;
    log.info(
      `runtime state loaded from store（覆盖 patch 初值）: propose=${cfg.propose} rules=${cfg.rules.length} timeZone=${cfg.timeZone ?? '(系统)'} mode=${cfg.mode}`,
    );
  }
  // v0.7.0 优先模式：预设覆盖对应参数（面板所见即所得；未覆盖键保持 patch 配置）
  applyModeOverrides(cfg, cfg.mode);

  // 健康探测板（v0.4.0）：探测结果作为候选排序的健康度参考数据（router.healthReorder 消费）
  const probe = new ProbeBoard(log, cfg.probe);
  const router = new Router(cfg, registry, probe);
  const cooldown = new CooldownBoard(cfg.fallbackPolicy);
  const metrics = new Metrics();
  const quota = new QuotaLedger(cfg);
  const startedAt = Date.now();

  log.info(
    `loaded: propose=${cfg.propose} rules=${cfg.rules.length} ` +
      `strategies=[${cfg.rules.map((r) => r.strategy ?? 'explicit').join(',')}] ` +
      `maxRetries=${cfg.fallbackPolicy.maxRetries} cooldown=${cfg.fallbackPolicy.cooldownSec}s ` +
      `watchdog=${cfg.firstTokenTimeoutMs}ms probe=${cfg.probe.enabled ? `on/${cfg.probe.intervalSec}s` : 'off'}`,
  );

  const wrapper = createStreamWrapper({ config: cfg, router, cooldown, metrics, quota, log });

  // llm/stream 包装层：global 监听（不加 prepend，落 invariant 内侧正是所需层位）。
  // this = 派发方 LlmRuntime。
  const disposeStream = ctx.on('llm/stream', wrapper, { global: true });

  // agent/request 会话级提议（waterfall，常驻监听；propose 开关由面板热切换，
  // 运行时读取 router.config.propose，关闭时直接放行种子）
  const disposeRequest = ctx.on('agent/request', async (payload, next) => {
    if (!router.config.propose) return next();
    const seed = await next();
    if (!seed) return seed;
    const pick = router.pickPrimary({ provider: seed.provider, model: seed.model });
    if (pick) {
      log.info(
        `agent/request: ${seed.provider ?? '?'}/${seed.model ?? '?'} → ${pick.provider}/${pick.model}`,
      );
      return { ...seed, provider: pick.provider, model: pick.model };
    }
    return seed;
  });

  const routeDisposers = makeStatusRoutes({
    config: cfg,
    router,
    cooldown,
    metrics,
    quota,
    registry,
    probe,
    llm,
    wrapperStats: wrapper.stats,
    startedAt,
    // v0.5.1/v0.6.0：会话标题解析（面板「指定会话」显示标题）。三级：live 折叠 +
    // sessionQuery（live-preferred + 持久化兜底）+ 持久化日志直读（zstd 容器，
    // 覆盖服务未挂载/会话已卸载场景）。均惰性读取、失败降级 title=null（面板回退
    // 显示 id），不加入 inject 硬依赖。
    resolveSessions: makeSessionTitleResolver(
      () => ctx.sessions,
      () => (ctx.get ? ctx.get('sessionQuery') : ctx.sessionQuery),
      cfg.sessionsDir,
      log,
    ),
    saveStateFn: (state) => saveState(cfg.storePath, state, log),
    log,
  }).map((route) => ctx.webServer.register(route));

  // 注册表周期刷新：骨架同步刷（无 IO），模型目录异步刷（网络 IO，容错）
  const refreshTimer = setInterval(() => {
    registry.refreshProviders();
    void registry.refreshModels();
  }, Math.max(30, cfg.registryRefreshSec) * 1000);
  void registry.refreshModels();
  // dsh adapter 为懒注册、模型目录按 provider 配置惰性装配：
  // 30s 后补刷一次骨架 + 模型目录，缩短面板可见空目录的窗口
  const earlyRefresh = setTimeout(() => {
    registry.refreshProviders();
    void registry.refreshModels();
  }, 30_000);

  // 健康探测周期（v0.4.0）：默认关闭（probe.enabled=false）；开启后对注册表每个
  // (provider,model) 发极短请求，结果供 router.healthReorder 与面板健康列消费。
  let probeTimer = null;
  if (cfg.probe.enabled) {
    const probeTargets = () =>
      registry
        .registeredPairs()
        .filter((p) => p.model !== null)
        .map((p) => ({ provider: p.provider, model: p.model }));
    probeTimer = setInterval(() => {
      void probe.runAll(llm, probeTargets());
    }, Math.max(30, cfg.probe.intervalSec) * 1000);
  }

  return ctx.effect(() => () => {
    clearInterval(refreshTimer);
    clearTimeout(earlyRefresh);
    if (probeTimer !== null) clearInterval(probeTimer);
    try {
      wrapper.dispose?.();
    } catch {
      // ignore
    }
    try {
      disposeStream?.();
    } catch {
      // ignore
    }
    try {
      disposeRequest?.();
    } catch {
      // ignore
    }
    for (const dispose of routeDisposers) {
      try {
        dispose();
      } catch {
        // 反注册失败不影响其余清理
      }
    }
    log.info('disposed');
  });
}
