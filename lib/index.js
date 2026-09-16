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

import { normalizeConfig, stripLegacyMatch, quotaGroupCount, autoTuneMaxRetries, applyDefaultNames, isPlainObject, normalizeTimeWindows } from './config.js';
import { CooldownBoard } from './cooldown.js';
import { Router, PKG_PROVIDER } from './router.js';
import { createPackagesAdapter } from './packages-adapter.js';
import { createStreamWrapper } from './wrapper.js';
import { Metrics } from './metrics.js';
import { QuotaLedger } from './quota.js';
import { Registry } from './registry.js';
import { ProbeBoard } from './probe.js';
import { makeSessionTitleResolver } from './titles.js';
import { applyModeOverrides } from './modes.js';
import { loadState, saveState } from './store.js';
import { makeStatusRoutes } from './routes.js';
// v0.8.0 G1：每日报告数据层（日账本 + 聚合器 + 调度）
import { DailyLedger, DailyReporter, DailyScheduler } from './daily.js';
// v0.8.0 B-1：按需负载测试执行器（4-phase，复用 probe 原语，手动触发）
import { LoadTestRunner } from './loadtest.js';
import { ModelTestRunner } from './model-test.js';

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
  // v0.9.4：先将 makeLog 前置（用了函数提升），使 normalizeConfig 能携带 log
  // 供 stripLegacyMatch 在 patch 入口产出丢弃警告。
  const preLogLevel =
    config && typeof config.logLevel === 'string' ? config.logLevel : 'info';
  const log = makeLog(ctx, preLogLevel);
  const cfg = normalizeConfig(config, { log });
  const llm = ctx.llm;

  // 注册表镜像（数据源 = dsh 设置-模型 同源的 llm 服务目录）
  // v0.8.0 修复：必须传入 cfg——registry._profileMeta 读 config.providerMeta/rules
  // 作为元数据源（C-2），此前漏传导致实机 route 内联 + providerMeta 兜底全失效
  // （单测显式传参所以全绿，装配遗漏未暴露）。
  const registry = new Registry(llm, log, cfg.registryRefreshSec, cfg);
  registry.refreshProviders();

  // 运行时状态：store JSON 存在时覆盖 patch config 初值（面板改动的持久化）
  const stored = loadState(cfg.storePath, log);
  if (stored) {
    cfg.propose = stored.propose;
    // v0.9.4（漏洞 1 修复，A-3）：store 加载点剥离残留 match——这是 ISS-01 真正根因
    //（仅改 normalizeConfig/normalizeState 无法覆盖此「整体替换」路径）。
    cfg.rules = stripLegacyMatch(stored.rules, cfg.allowLegacyMatch, log);
    if (typeof stored.timeZone === 'string' || stored.timeZone === null) cfg.timeZone = stored.timeZone;
    if (typeof stored.mode === 'string') cfg.mode = stored.mode;
    // v0.8.0 修复：providerMeta 随 store 持久化（面板热更新后重启不回落 patch）
    if (stored.providerMeta !== undefined) cfg.providerMeta = stored.providerMeta;
    // v0.9.9（顺手修 v0.9.8 §十三-9）：timeZone / mode 持久化断链修复。
    if (stored.timeZone !== undefined) cfg.timeZone = stored.timeZone;
    if (stored.mode !== undefined) cfg.mode = stored.mode;
    // v0.9.4 UX 补丁（R-3 配套）：reports 段随 store 持久化恢复到 cfg——否则
    // 「面板开启 → 重启 → 回落 patch 默认 → daily 不装配」。与 routes.js 热更新、
    // normalizeState 持久化三方齐平。
    if (stored.reports !== undefined && isPlainObject(stored.reports)) {
      cfg.reports = {
        enabled: Boolean(stored.reports.enabled),
        hour: stored.reports.hour ?? null,
        // v0.9.4 UX 清理：dir 透传——用户曾在面板选过的目录跨重启保留
        dir: typeof stored.reports.dir === 'string' ? stored.reports.dir : undefined,
      };
    }
    // v0.9.9（方案 §6-1 第 8 条）：timeWindows 持久化恢复——面板提交后跨重启保留。
    // 与 providerMeta / reports 同模型：未持久化字段 → undefined（保留 patch 初值）；
    // 已持久化但非对象 → 忽略。复用 normalizeTimeWindows 强制规范化。
    if (stored.timeWindows !== undefined && isPlainObject(stored.timeWindows)) {
      try {
        cfg.timeWindows = normalizeTimeWindows(stored.timeWindows);
      } catch (e) {
        log.warn(`store.timeWindows 规范化失败，忽略并沿用 patch config: ${e.message}`);
      }
    }
    log.info(
      `runtime state loaded from store（覆盖 patch 初值）: propose=${cfg.propose} rules=${cfg.rules.length} timeZone=${cfg.timeZone ?? '(系统)'} mode=${cfg.mode} providerMeta=${Object.keys(cfg.providerMeta ?? {}).length}`,
    );
  }
  // F-4 实机修复：applyDefaultNames 在 normalizeConfig 末尾对 patch 初值命名，但
  // 上方 store 覆盖用「旧版/未命名」rules 整段替换掉已命名的 patch rules，命名被绕过，
  // 导致实机状态规则 name=null → F-1(matchName null)/F-3(listModels 只暴露命名规则)/F-5(
  // resolvePackage 按名解析) 全部失效。此处对最终生效 rules 重跑默认命名（已命名规则
  // 幂等保留，仅填充未命名规则为最小未占用 rule-{N}；重名 fail-fast 兜底）。
  applyDefaultNames(cfg.rules);
  // v0.8.0 A-3：maxRetries 自动调优。仅在用户未显式声明时回填
  // max(quotaGroupCount*2, 5)；显式声明（含显式 2）一律尊重不覆盖。
  // 位置在 store 加载后：面板改写的 rules 可能带 quotaGroup 内联，需按最终生效
  // 配置统计。mode 预设不覆盖 maxRetries（见 modes.js），顺序无冲突。
  if (!cfg._hasExplicitMaxRetries) {
    const before = cfg.fallbackPolicy.maxRetries;
    autoTuneMaxRetries(cfg);
    if (cfg.fallbackPolicy.maxRetries !== before) {
      log.info(`maxRetries auto-tuned: ${before} → ${cfg.fallbackPolicy.maxRetries} (quotaGroupCount=${quotaGroupCount(cfg)})`);
    }
  }
  // v0.7.0 优先模式：预设覆盖对应参数（面板所见即所得；未覆盖键保持 patch 配置）
  applyModeOverrides(cfg, cfg.mode);

  // 健康探测板（v0.4.0）：探测结果作为候选排序的健康度参考数据（router.healthReorder 消费）
  const probe = new ProbeBoard(log, cfg.probe);
  const router = new Router(cfg, registry, probe);
  const cooldown = new CooldownBoard(cfg.fallbackPolicy);
  const metrics = new Metrics();
  const quota = new QuotaLedger(cfg);
  // §11：窗口上限仓持久化——启动读回 + 30s 周期 flush + 进程退出同步兜底（§14 #12）。
  quota.loadFromDisk?.();
  const quotaFlush = setInterval(() => {
    try {
      quota.saveToDisk?.();
    } catch {
      // 周期落盘失败不致命（下次再试；exit 兜底仍在）
    }
  }, 30_000);
  if (typeof quotaFlush.unref === 'function') quotaFlush.unref();
  process.once('exit', () => {
    try {
      quota.saveToDiskSync?.();
    } catch {
      // 退出兜底失败不再抛（进程已在退出）
    }
  });
  const startedAt = Date.now();

  // F-3（批 5）：注册虚拟模型包 provider（纯展示层溴壳）。listModels 暴露所有命名
  // 规则为 `__pkg:*` 虚拟模型，供 dsh UI 模型选择器展示「插件模型包」分组；真正的
  // 选包路由由 agent/request（F-5）接管。registry 已排除该虚拟 provider，不进入候选展开。
  let pkgHandle = null;
  try {
    pkgHandle = llm.registerAdapter([PKG_PROVIDER], createPackagesAdapter({ router, log }));
    // 注册时 registerAdapter 内部 commitRoutes 已自动 emitAdaptersUpdated（一次，
    // 见 dsh-llm）。此处只补 refreshProviders，把新 provider fold 进快照（随后被排除）。
    registry.refreshProviders();
    log.info(`packages adapter registered: provider=${PKG_PROVIDER}`);
  } catch (error) {
    // 注册失败不致命：退化为无虚拟分组（选包/路由逻辑不依赖本 adapter 的存在）
    log.warn(`packages adapter register failed: ${error?.message ?? error}`);
  }

  // v0.8.0 G1 每日报告：默认关闭（reports.enabled=false，零记账零调度，
  // 与旧版行为完全一致，独立可回退）。开启后装配日账本 + 聚合器 + 调度，
  // wrapper 注入 daily（可选参数，未开启时跳过记账）。
  let daily = null;
  let reporter = null;
  let dailyScheduler = null;
  if (cfg.reports.enabled) {
    daily = new DailyLedger({
      storePath: cfg.storePath,
      timeZone: cfg.timeZone,
      log,
      // v0.9.4 UX 清理：cfg.reports.dir 是 patch / store 显式配置（默认 undefined
      // 时 DailyLedger 走 homedir()/Documents/dsh-model-router-reports）。
      reportDir: cfg.reports.dir,
    });
    reporter = new DailyReporter({ ledger: daily, log });
    // v0.9.5：注入聚合函数给 ledger（用于 l1Summary 当日内存缓存）
    daily.setAggregator((records) => reporter.aggregate(records));
    dailyScheduler = new DailyScheduler({
      ledger: daily,
      reporter,
      timeZone: cfg.timeZone,
      log,
      hour: cfg.reports.hour,
    });
    dailyScheduler.start(); // 启动即检查补生成
    log.info(`daily reports enabled: hour=${cfg.reports.hour} dir=${daily.reportDir}`);
  }

  log.info(
    `loaded: propose=${cfg.propose} rules=${cfg.rules.length} ` +
      `strategies=[${cfg.rules.map((r) => r.strategy ?? 'explicit').join(',')}] ` +
      `maxRetries=${cfg.fallbackPolicy.maxRetries} cooldown=${cfg.fallbackPolicy.cooldownSec}s ` +
      `watchdog=${cfg.firstTokenTimeoutMs}ms probe=${cfg.probe.enabled ? `on/${cfg.probe.intervalSec}s` : 'off'}`,
  );

  const wrapper = createStreamWrapper({ config: cfg, router, cooldown, metrics, quota, daily, log });

  // llm/stream 包装层：global 监听（不加 prepend，落 invariant 内侧正是所需层位）。
  // this = 派发方 LlmRuntime。
  const disposeStream = ctx.on('llm/stream', wrapper, { global: true });

  // agent/request 会话级提议（waterfall，常驻监听）。v0.9 纯选择驱动：
  // 仅当用户在对话模型选择器中选中「命名规则包」虚拟模型（`dsh-model-router/__pkg:<name>`）
  // 时，才按该包 route[0] 改派真实 provider/model 并附加 `__mr_rule`，使 wrapper
  // 按绑定规则走完整 failover 链（含该包 mode/custom 参数）。否则原样放行 seed（直连透传）。
  const disposeRequest = ctx.on('agent/request', async (payload, next) => {
    const seed = await next();
    if (!seed) return seed;
    const pkg = router.resolvePackage({ provider: seed.provider, model: seed.model });
    if (!pkg) return seed; // 非虚拟包 → 直连
    const pick = pkg.primary;
    log.info(
      `agent/request [选包]: ${seed.provider}/${seed.model} → ${pick.provider}/${pick.model}` +
        ` (bind rule=${pkg.ruleName})`,
    );
    return { ...seed, provider: pick.provider, model: pick.model, __mr_rule: pkg.ruleName };
  });

  // v0.8.0 B-1/B-2 负载测试执行器：手动触发（POST 端点），默认只测 free tier；
  // 请求经 singleRaw 带 PROBE_MARK 直透，不污染生产状态（零成本挂载）。
  const loadtest = new LoadTestRunner({ llm, registry, log });

  // v0.9.5 §9 模型全自动测试：与 loadtest 定位不同（指定清单定向跑 + 报告落盘 +
  // verdict 路由桥接），共享 daily 报告目录。daily 未启用时 modelTest 仍有实例但
  // 端点返回 503（见 routes.js），保持接口存在性稳定。
  const modelTest = new ModelTestRunner({
    llm,
    registry,
    daily,
    log,
    prompt: 'ping',
    timeoutMs: 20000,
    threshold: cfg.reports?.modelTestThreshold,
  });
  if (daily) log.info(`model-test ready: shared reportDir=${daily.reportDir}`);

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
    daily,
    reporter,
    loadtest,
    modelTest,
    pkgRegistered: pkgHandle != null,
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
    if (dailyScheduler) {
      try {
        dailyScheduler.dispose();
      } catch {
        // ignore
      }
    }
    // v0.9.3 P1-4：daily 账本异步缓冲 —— 清理时同步落盘剩余缓冲行
    if (daily) {
      try {
        daily.dispose();
      } catch {
        // ignore
      }
    }
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
    // F-3（批 5）：卸载插件时移除虚拟 provider 注册
    try {
      if (pkgHandle) (typeof pkgHandle === 'function' ? pkgHandle : pkgHandle.dispose?.())();
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
