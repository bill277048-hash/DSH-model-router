/**
 * 路由规则引擎（v0.2：静态链 + 四种候选扩展策略 + 链耗尽收敛 + 运行时热更新）。
 *
 * 扩展策略（v0.2 需求 4，候选一律排除种子自身）：
 * - explicit        按 rule.route 手工列表顺序（默认；"排除模式"的手工版）
 * - same-model      注册表中与种子同 model id 的其他 provider 路由（跨供应商同模型）
 * - same-provider   注册表中种子 provider 下的其他 model（同供应商换模型）
 * - exclude-current 注册表中除种子外的全部 (provider, model) 对（按注册顺序，上限 6）
 *
 * 收敛机制（复审 R-2/R-8 落点）：汇聚点在 candidates() 内部——链耗尽后
 * exhaustionWindowSec 秒内，任何调用方取到的候选链收敛为单候选，使 retry
 * 重入主循环时自然只试 1 次，防乘法爆炸。
 *
 * 运行时热更新（v0.2 需求 1）：rules/propose 可经 applyRuntime() 由面板改写，
 * 存 store JSON，免改 patch 免重启；patch config 仅为初始值。
 */

const EXCLUDE_CAP = 6;

/**
 * 取指定 IANA 时区的当前 HH:MM（24 小时制）。
 * Intl 走 ICU 时区库做确定性换算，不看 IP 地理位置——VPN 本身不影响；
 * 只有系统时区被自动定位改掉时才会连带变化，因此时间窗规则支持显式
 * 指定 timeZone（config.timeZone）把口径钉死（v0.5.0，峰谷定价）。
 * @param {string|null} timeZone IANA 名；null/undefined = 系统时区
 * @param {Date} [now]
 * @returns {string} "HH:MM"
 */
export function localHHMM(timeZone, now = new Date()) {
  const opts = { hour: '2-digit', minute: '2-digit', hour12: false };
  if (timeZone) opts.timeZone = timeZone;
  return new Intl.DateTimeFormat('en-GB', opts).format(now);
}

/**
 * 当前时间是否落在时间窗内（字符串比较依赖 HH:MM 零填充有序）。
 * start > end 视为跨零点窗（如 22:00→08:00：t>=start 或 t<=end）。
 */
export function inTimeWindow(hours, timeZone, now = new Date()) {
  const t = localHHMM(timeZone, now);
  if (hours.start <= hours.end) return t >= hours.start && t <= hours.end;
  return t >= hours.start || t <= hours.end;
}

export class Router {
  constructor(config, registry = null, probe = null) {
    this.config = config;
    this.registry = registry;
    /** 健康探测板（v0.4.0）：探测结果作为候选排序的健康度参考数据；未接入时为 null。 */
    this.probe = probe;
    /** 最近一次链耗尽时间戳（毫秒）；0 = 从未耗尽。 */
    this.lastExhaustedAt = 0;
    this.lastExhaustedFailure = null;
    /** 时间窗判定的「当前时间」注入钩子（仅单测用；null = 真实时钟）。 */
    this._now = null;
  }

  /** 面板热更新（rules/propose/timeZone），不改 fallbackPolicy 等宿主级配置。 */
  applyRuntime({ propose, rules, timeZone }) {
    if (propose !== undefined) this.config.propose = propose === true;
    if (Array.isArray(rules)) this.config.rules = rules;
    if (timeZone !== undefined) this.config.timeZone = timeZone; // null = 系统时区
    // 耗尽状态不重置（时间窗语义保持）
  }

  /**
   * 自上而下取首个 match 的规则（两阶段）：
   * ① 限定规则（provider/model/sessionIds/hours）按声明顺序，条件 AND 全满足才命中；
   * ② 都不中 → 首个 default 规则兜底（无论其声明位置——否则排在前面的
   *    default 会短路遮蔽面板后加的作用域规则，使其沦为死规则）。
   * 时间窗条件（v0.5.0）对限定规则与 default 兜底都生效：窗口外的规则
   * （含带窗口的 default）视为不命中，继续向后找（峰谷定价的双 default 场景：
   * 「default+谷时窗」+「纯 default」）。
   * sessionIds 条件要求 seed 带 sessionId（llm/stream 层有；agent/request
   * 提议路径没有 → 带会话限定的规则不参与会话级提议，落回 default）。
   */
  matchRule({ provider, model, sessionId } = {}) {
    let fallback = null;
    for (const rule of this.config.rules) {
      const m = rule.match;
      // 时间窗判定（对 default 与限定规则一致；_now 仅为单测注入钩子）
      if (m.hours !== undefined && !inTimeWindow(m.hours, this.config.timeZone, this._now ?? undefined)) {
        continue;
      }
      if (m.default) {
        if (fallback === null) fallback = rule;
        continue;
      }
      if (m.provider !== undefined && m.provider !== provider) continue;
      if (m.model !== undefined && m.model !== model) continue;
      if (m.sessionIds !== undefined) {
        if (sessionId === undefined || !m.sessionIds.includes(sessionId)) continue;
      }
      return rule;
    }
    return fallback;
  }

  /**
   * 按策略从 dsh 模型注册表展开候选（排除种子自身）。
   * 注册表不可用/展开为空 → 回退 explicit route 列表。
   */
  expandByStrategy(rule, seed) {
    const strategy = rule.strategy ?? 'explicit';
    if (strategy === 'explicit' || !this.registry) {
      // 排除种子 + 去重（重复 hop 会让 failover 对同一候选重试两次）
      const seen = new Set();
      return rule.route.filter((hop) => {
        if (sameHop(hop, seed)) return false;
        const k = `${hop.provider}/${hop.model}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
    }
    const pairs = this.registry.registeredPairs();
    let out = [];
    if (strategy === 'same-model') {
      out = pairs.filter((p) => p.model !== null && p.model === seed.model && p.provider !== seed.provider);
      // 手工 route 作为优先顺序提示（在前的 provider 排前）
      out = orderHint(out, rule.route);
    } else if (strategy === 'same-provider') {
      out = pairs.filter((p) => p.provider === seed.provider && p.model !== null && p.model !== seed.model);
    } else if (strategy === 'exclude-current') {
      out = pairs.filter((p) => !(p.provider === seed.provider && p.model === seed.model));
    }
    out = out
      .filter((p) => p.model !== null)
      .slice(0, EXCLUDE_CAP)
      .map((p) => ({ provider: p.provider, model: p.model }));
    // 注册表无可用扩展（如模型目录未就绪）→ 回退手工列表
    if (out.length === 0) {
      return rule.route.filter((hop) => !sameHop(hop, seed));
    }
    return out;
  }

  /**
   * 候选链（有序、按策略展开、按「链耗尽」状态收敛）。
   * @returns {{provider: string, model: string, key?: string}[]}
   */
  candidates(seed = {}) {
    const rule = this.matchRule(seed);
    if (!rule) return [];
    let chain = this.expandByStrategy(rule, seed);
    // 健康感知排序（v0.4.0）：探测结果驱动——down/degraded 排后、延迟低优先。
    // 仅当接入了探测板且已产出过健康数据时才重排；否则保序（冷启动/degraded 未知时不瞎排）。
    chain = this.healthReorder(chain);
    if (this.converged()) {
      chain = chain.slice(0, 1);
    }
    return chain.map((hop) => ({ ...hop }));
  }

  /**
   * 健康感知重排（v0.4.0）：以探测板 `probe.healthOf` 为健康度参考数据。
   * - 状态 down → 排最末；degraded → 降权（连续失败数也计入轻微降权）；
   * - 同档内按 P95 TTFT 升序（延迟低优先）。
   * 仅当探测板存在且有该候选的健康记录时才重排；否则原样返回（冷启动不瞎排）。
   * 注意：本层只决定"顺序"，真正的 cooldown 排除仍在 wrapper 层（usable 过滤）。
   * @param {{provider:string, model:string, key?:string}[]} chain
   * @returns {{provider:string, model:string, key?:string}[]}
   */
  healthReorder(chain) {
    if (!this.probe || !Array.isArray(chain) || chain.length <= 1) return chain;
    const scored = chain.map((hop) => {
      const h = this.probe.healthOf(hop.provider, hop.model);
      let rank = 0; // 0=健康；越大越靠后
      if (h) {
        if (h.status === 'down') rank = 100;
        else if (h.status === 'degraded') rank = 10;
        rank += (h.consecutiveFails || 0) * 0.5;
      }
      const ttft = h?.p95TtftMs ?? h?.ttftMs ?? Infinity;
      return { hop, rank, ttft };
    });
    scored.sort((a, b) => {
      if (a.rank !== b.rank) return a.rank - b.rank;
      return (a.ttft ?? Infinity) - (b.ttft ?? Infinity);
    });
    return scored.map((s) => s.hop);
  }

  /**
   * agent/request 会话级提议：返回建议的会话主选 hop（无建议返回 null）。
   * v0.2 语义：仅 explicit 策略提议 route[0]（种子已等于首选时不提议）；
   * 其余策略的会话主选就是 dsh 自己选的种子（插件只负责其后的备用链）。
   */
  pickPrimary(seed = {}) {
    const rule = this.matchRule(seed);
    if (!rule) return null;
    if ((rule.strategy ?? 'explicit') !== 'explicit') return null;
    const first = rule.route[0];
    if (!first) return null;
    if (first.provider === seed.provider && first.model === seed.model) return null;
    return { ...first };
  }

  /** 是否处于「链耗尽收敛」时间窗内。 */
  converged() {
    return (
      this.lastExhaustedAt > 0 &&
      Date.now() - this.lastExhaustedAt < this.config.exhaustionWindowSec * 1000
    );
  }

  /** 包装层候选链耗尽时调用：触发时间窗收敛。 */
  recordExhausted(failure = null) {
    this.lastExhaustedAt = Date.now();
    this.lastExhaustedFailure = failure
      ? { code: failure.code ?? null, message: failure.message ?? null }
      : null;
  }

  snapshot() {
    return {
      rules: this.config.rules,
      propose: this.config.propose,
      lastExhaustedAt: this.lastExhaustedAt || undefined,
      lastExhaustedFailure: this.lastExhaustedFailure ?? undefined,
      converged: this.converged(),
    };
  }
}

function sameHop(hop, seed) {
  return hop.provider === seed.provider && hop.model === seed.model;
}

/** explicit route 列表作为排序提示：命中的 provider 排前，其余保持注册顺序。 */
function orderHint(pairs, route) {
  if (!route?.length) return pairs;
  const rank = new Map();
  route.forEach((hop, i) => rank.set(hop.provider, i));
  return [...pairs].sort((a, b) => {
    const ra = rank.has(a.provider) ? rank.get(a.provider) : Number.MAX_SAFE_INTEGER;
    const rb = rank.has(b.provider) ? rank.get(b.provider) : Number.MAX_SAFE_INTEGER;
    return ra - rb;
  });
}
