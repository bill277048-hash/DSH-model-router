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
/** F-5（批 4）：选包路由的虚拟 provider id（packages-adapter.js 暴露的虚拟分组 id）。 */
export const PKG_PROVIDER = 'dsh-model-router';
/** F-5（批 4）：选包虚拟模型 id 前缀 `__pkg:<ruleName>`。 */
export const PKG_PREFIX = '__pkg:';

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
  constructor(config, registry = null, probe = null, metrics = null) {
    this.config = config;
    this.registry = registry;
    /** 健康探测板（v0.4.0）：探测结果作为候选排序的健康度参考数据；未接入时为 null。 */
    this.probe = probe;
    /**
     * v0.9.10 Task 2：metrics 实例（可选，节流判定需要近 60s 请求计数）。
     * 未注入时 = 不节流（与 null 声明同语义）。wrapper 与 index.js 都已注入。
     */
    this.metrics = metrics;
    /** 最近一次链耗尽时间戳（毫秒）；0 = 从未耗尽。 */
    this.lastExhaustedAt = 0;
    this.lastExhaustedFailure = null;
    /** v0.9.4 B-B：最近一次 context 类失败时间戳（毫秒）；0 = 从未触发。 */
    this._lastContextFailAt = 0;
    /** 时间窗判定的「当前时间」注入钩子（仅单测用；null = 真实时钟）。 */
    this._now = null;
    /** F-4：规则名索引（rule.name → rule），F-1/F-5 绑定传递依赖。 */
    this._nameIndex = new Map();
    this.rebuildNameIndex();
  }

  /** F-4：重建 byName 索引（构造 + 热更新后调用）。规则名不重复由 config 层保证。 */
  rebuildNameIndex() {
    const idx = new Map();
    for (const rule of this.config.rules) {
      if (rule.name !== undefined) idx.set(rule.name, rule);
    }
    this._nameIndex = idx;
  }

  /** F-4/F-1/F-5：按名取规则（未命名规则经 applyDefaultNames 已补 `rule-{N}`）。 */
  byName(name) {
    return this._nameIndex.get(name) ?? null;
  }

  /** 面板热更新（rules/propose/timeZone），不改 fallbackPolicy 等宿主级配置。 */
  applyRuntime({ propose, rules, timeZone }) {
    if (propose !== undefined) this.config.propose = propose === true;
    if (Array.isArray(rules)) {
      this.config.rules = rules;
      this.rebuildNameIndex();
    }
    if (timeZone !== undefined) this.config.timeZone = timeZone; // null = 系统时区
    // 耗尽状态不重置（时间窗语义保持）
  }

  /**
   * v0.9.9 极简峰谷定价：根据 timeWindows 与时区，判定当前时刻属于哪个段。
   *
   * 设计要点：
   * - **半开区间 [start, end)**——peakStart 与 valleyStart 不能相等（config 层校验抛错），
   *   两段拼接成完整 24 小时，无重叠无缝隙；
   * - **跨零点**：start > end 的窗按 `t >= start || t < end` 处理（与既有
   *   `inTimeWindow`（行 43，`<=` 闭区间）是**两个独立函数**，互不影响；
   * - **未启用 / 缺字段 → null**，零行为变化；
   * - 时区取 `config.timeZone`（null = 系统，与既有时间窗同口径）。
   *
   * @param {object|null} tw timeWindows 字段；null/undefined/未启用 → null
   * @param {string|null} tz IANA 时区；null = 系统时区
   * @param {Date} [now] 单测注入钩子
   * @returns {'peak'|'valley'|null}
   */
  segmentOf(tw, tz, now = new Date()) {
    if (!tw || tw.enabled !== true) return null;
    const peakStart = tw.peakStart;
    const valleyStart = tw.valleyStart;
    if (typeof peakStart !== 'string' || typeof valleyStart !== 'string') return null;
    const t = localHHMM(tz, now);
    // 半开区间 [peakStart, valleyStart)，跨零点按「(>= peak 且 < 24:00) 或 (>= 00:00 且 < valley)」
    // 拼接成完整 24 小时，无重叠无缝隙。peakStart == valleyStart 已由 config 层校验抛错，
    // 此处不重复防御。
    const inPeak =
      (peakStart <= valleyStart)
        ? (t >= peakStart && t < valleyStart)
        : (t >= peakStart || t < valleyStart);
    return inPeak ? 'peak' : 'valley';
  }

  /** 当前实例的段判定（复用 config 与可选 _now 注入钩子）。 */
  segmentOfNow(now = this._now ?? undefined) {
    return this.segmentOf(this.config.timeWindows, this.config.timeZone, now);
  }

  /**
   * 当前段声明的完整候选链；未启用/该段无 route → null。
   * 注：段链路**仅在内存合成**，绝不写回 config/store（v0.9.9 §6-1 第 4 条）。
   * @returns {Array<{provider:string, model:string}>|null}
   */
  segmentChain() {
    const seg = this.segmentOfNow();
    if (!seg) return null;
    const r = this.config.timeWindows[seg];
    if (!r || !Array.isArray(r.route) || r.route.length === 0) return null;
    return r.route;
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
      // v0.9 纯选择驱动：无 match 的命名「规则包」不参与自动匹配，仅由对话中
      // 选中（resolvePackage→__mr_rule 绑定）启用；普通模型种子恒不命中 → 直连透传。
      if (!m) continue;
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
    if (fallback) return fallback;
    // v0.9.9 极简峰谷定价：未命中规则（含无 default）但段有 route → 合成规则
    // 一处收口，覆盖 match / matchName / candidates / pickPrimary 四个消费者。
    // __segment 仅内存，绝不写回 config / store。
    const chain = this.segmentChain();
    if (chain) {
      const seg = this.segmentOfNow();
      return { name: '__segment', strategy: 'explicit', route: chain, __segment: seg };
    }
    return null;
  }

  /**
   * F-2（台阶②）：暴露命中 rule 的 public 读数，供 wrapper 做 per-request
   * mode 参数解析（读 `rule.mode` 查 MODE_PRESETS）与 F-1 绑定传递。只读，
   * 不展开候选链（区别于 candidates）。
   * @param {{provider?: string, model?: string, sessionId?: string}} seed 请求种子
   * @returns {object|null} 命中的规则对象（含 match/strategy/route/mode/name），无命中返回 null
   */
  match(seed) {
    return this.matchRule(seed);
  }

  /**
   * F-1（批 3）：返回「seed 命中的规则名」。供 agent/request 层在会话级提议替换
   * provider/model 时，把命中的规则名附加到 payload（`__mr_rule`），让 wrapper 能
   * 用 `router.byName(__mr_rule)` 取回**绑定规则**（而非被替换后的真实 provider 重新
   * match 命中 default）。无命中/未命名返回 null。
   * @param {{provider?: string, model?: string, sessionId?: string}} seed 原始（提议前）种子
   * @returns {string|null} 命中规则的 name（applyDefaultNames 已保证非空）
   */
  matchName(seed) {
    const rule = this.matchRule(seed);
    return rule?.name ?? null;
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
      .map((p) => ({
        provider: p.provider,
        model: p.model,
        // v0.8.0 C-1：携带 quotaGroup（registeredPairs 已并入 C-2 元数据），
        // 供 candidates() 去重使用；无组时不带该字段。
        ...(p.quotaGroup !== undefined ? { quotaGroup: p.quotaGroup } : {}),
        // v0.9.4 B-B：携带 contextWindow（registeredPairs 透传），供 contextReorder 重排。
        ...(typeof p.contextWindow === 'number' ? { contextWindow: p.contextWindow } : {}),
      }));
    // 注册表无可用扩展（如模型目录未就绪）→ 回退手工列表
    if (out.length === 0) {
      return rule.route.filter((hop) => !sameHop(hop, seed));
    }
    return out;
  }

  /**
   * 候选链（有序、按策略展开、按「链耗尽」状态收敛）。
   * v0.8.0 C-1：quotaGroup 去重在收敛之后（顺序决策见计划 §2.6：
   * healthReorder → converged 收敛 → quotaGroup 去重；healthReorder 在前
   * 避免保留同组不健康项）。
   * @returns {{provider: string, model: string, key?: string, quotaGroup?: string}[]}
   */
  candidates(seed = {}) {
    const rule = this.matchRule(seed);
    if (!rule) return [];
    return this.candidatesForRule(rule, seed);
  }

  /**
   * F-1（批 3）：按**给定规则**生成候选链（供 wrapper 在 `__mr_rule` 绑定场景使用，
   * 复用 candidates 的展开 → 健康排序 → 收敛 → 配额去重全链路）。绑定规则来自
   * `router.byName(__mr_rule)`，避免被替换后的真实 provider 重新 match 命中 default。
   * @param {object|null} rule 绑定规则（byName 结果）；null 时返回空链
   * @param {{provider?: string, model?: string}} seed 当前（替换后）种子，用于排除自身
   */
  candidatesForRule(rule, seed = {}) {
    if (!rule) return [];
    let chain = this.expandByStrategy(rule, seed);
    chain = this.healthReorder(chain);
    // v0.9.4 B-B：context 失败后窗口感知重排（大窗口候选前移）；收敛前做，
    // 使 O-2 场景（converged=true）slice(0,1) 取到被排前的大窗口候选。
    chain = this.contextReorder(chain);
    if (this.converged()) {
      chain = chain.slice(0, 1);
    }
    chain = this.dedupeByQuotaGroup(chain);
    // v0.9.10 Task 2：按声明限速过滤（末尾一道；不读 observed）。
    chain = this.throttleByDeclared(chain);
    return chain.map((hop) => ({ ...hop }));
  }

  /**
   * v0.8.0 C-1：按 quotaGroup 去重——同一共享配额组（共享限流池）的候选只保留
   * 链序第一个，避免同组内反复尝试相同限流（如同账号多 model 同组）。无
   * quotaGroup 的候选不参与去重（视为独立路由，各自保留）。
   * @param {{provider:string, model:string, quotaGroup?:string}[]} chain
   * @returns {{provider:string, model:string, quotaGroup?:string}[]}
   */
  dedupeByQuotaGroup(chain) {
    const seen = new Set();
    return chain.filter((hop) => {
      const g = hop.quotaGroup;
      if (g === undefined || g === null) return true;
      if (seen.has(g)) return false;
      seen.add(g);
      return true;
    });
  }

  /**
   * v0.9.10 Task 2 + v0.9.18：按**声明**限速过滤候选 hop（OQ1 决策：声明优先，不读 observed）。
   *
   * v0.9.18 起**同时**判定 RPM 和 TPM（两者各自独立——任一超限即跳过，
   * 避免「RPM 没超但 TPM 超了仍放行」的盲点）。
   *
   * 判定规则（过去 60s 滚动窗口）：
   *   - `providerMeta[provider].{rpmLimit,tpmLimit}`（或 hop 内联）未声明 → 不节流该项
   *   - `recentCount >= rpmLimit * 0.9`（90% 软上限，OQ7 默认）→ 跳过该 hop
   *   - `recentTokenSum >= tpmLimit * 0.9`（同样 90% 软上限）→ 跳过该 hop
   *   - `metrics` 未注入 → 不节流（与未声明同语义）
   *
   * **关键**：这是**末尾一道过滤**（在 healthReorder / contextReorder / dedupeByQuotaGroup
   * 之后），保证上游已被清理的链不会被重新插入。
   *
   * @param {{provider:string, model:string, key?:string, rpmLimit?:number, tpmLimit?:number}[]} chain
   * @returns {Array} 过滤后的链（顺序不变）
   */
  throttleByDeclared(chain) {
    if (!this.metrics || !Array.isArray(chain) || chain.length === 0) return chain;
    const meta = this.config.providerMeta ?? {};
    const nowMs = this._now?.getTime?.() ?? Date.now();
    const windowMs = 60_000;
    const threshold = 0.9; // 软上限 OQ7
    // 取近 60s 每个 provider 的请求计数 + token 总数。
    // RPM 计数自己从 snapshot().recent 累加；TPM 调用 metrics.recentTokenSum（v0.9.13）。
    // 两条路径任一抛错 → 不阻塞路由（容错优先）。
    let recent;
    try { recent = this.metrics.snapshot().recent ?? []; }
    catch { recent = []; }
    const counts = new Map();
    for (const r of recent) {
      if (!r || typeof r.provider !== 'string') continue;
      const t = Date.parse(r.ts);
      // 用 >= 而非 >：让 windowMs=0 真正排除全部（避免边界 case）
      if (!Number.isFinite(t) || nowMs - t >= windowMs) continue;
      counts.set(r.provider, (counts.get(r.provider) ?? 0) + 1);
    }
    // TPM：逐 provider 取 token 总数（已有 helper，v0.9.13 实现）
    const tokensByProvider = new Map();
    for (const hop of chain) {
      if (!hop || typeof hop.provider !== 'string') continue;
      if (tokensByProvider.has(hop.provider)) continue;
      try {
        tokensByProvider.set(hop.provider, this.metrics.recentTokenSum(hop.provider, windowMs, this._now ?? new Date(nowMs)));
      } catch { tokensByProvider.set(hop.provider, 0); } // 抛错 → 0（容错）
    }
    return chain.filter((hop) => {
      if (!hop || typeof hop.provider !== 'string') return true;
      const m = meta[hop.provider] ?? {};
      // route hop 内联优先 → providerMeta 兜底（与既有 v0.8.0 A-2 一致）
      const rpmDeclared = hop.rpmLimit !== undefined ? hop.rpmLimit : m.rpmLimit;
      const tpmDeclared = hop.tpmLimit !== undefined ? hop.tpmLimit : m.tpmLimit;
      // RPM 节流：未声明 → 跳过此维度
      if (Number.isInteger(rpmDeclared) && rpmDeclared >= 1) {
        const count = counts.get(hop.provider) ?? 0;
        if (count >= rpmDeclared * threshold) return false;
      }
      // TPM 节流：未声明 → 跳过此维度
      if (Number.isInteger(tpmDeclared) && tpmDeclared >= 1) {
        const tokens = tokensByProvider.get(hop.provider) ?? 0;
        if (tokens >= tpmDeclared * threshold) return false;
      }
      return true;
    });
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

  /** v0.9.4 B-B：记录一次 context 类失败（60s 内 contextReorder 生效）。 */
  noteContextFail() {
    this._lastContextFailAt = Date.now();
  }

  /**
   * v0.9.4 B-B：context 窗口感知重排。最近 60s 内发生过 context 类失败时，
   * 大窗口候选前移（>= hint 优先、未知窗口次之、小窗口殿后）——单模型累计
   * 上下文超窗后，后续切换优先选窗口更大的候选，避免再次 400。
   * 默认小干预：无窗口的候选不参与排序（原序保持），无 context 失败/链长<=1
   * 时原样返回。
   * @param {{provider:string, model:string, contextWindow?:number}[]} chain
   * @param {number} [contextSizeHint] 上下文量提示（>=0 的 token 数）；缺省 Infinity
   * @returns {{provider:string, model:string, contextWindow?:number}[]}
   */
  contextReorder(chain, contextSizeHint = Infinity) {
    const recent = this._lastContextFailAt > 0 && Date.now() - this._lastContextFailAt < 60_000;
    if (!recent || !Array.isArray(chain) || chain.length <= 1) return chain;
    const hint = typeof contextSizeHint === 'number' && contextSizeHint > 0 ? contextSizeHint : Infinity;
    return [...chain].sort((a, b) => {
      const wa = typeof a.contextWindow === 'number' ? a.contextWindow : NaN;
      const wb = typeof b.contextWindow === 'number' ? b.contextWindow : NaN;
      if (Number.isNaN(wa) && Number.isNaN(wb)) return 0;
      if (Number.isNaN(wa)) return 1; // 无窗口排后
      if (Number.isNaN(wb)) return -1;
      if (wa >= hint && wb < hint) return -1; // 满足 hint 的优先
      if (wb >= hint && wa < hint) return 1;
      return wb - wa; // 同侧按窗口降序
    });
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

  /**
   * F-5（批 4）：解析「选包路由」虚拟模型 id `__pkg:<ruleName>`（provider 固定为
   * PKG_PROVIDER）。命中 → 返回所选规则的 route[0] 真实 provider/model 与规则名，
   * agent/request 提议替换并附加 `__mr_rule`，wrapper 按绑定规则走完整 failover 链
   * （等价于插件接管整个对话）。
   * @param {{provider?: string, model?: string}} seed 请求种子（用户选中的虚拟模型）
   * @returns {{rule: object, ruleName: string, primary: {provider: string, model: string}}|null}
   *   未命中（非虚拟 provider / 名称不存在 / 规则无 route）返回 null
   */
  resolvePackage(seed = {}) {
    if (seed.provider !== PKG_PROVIDER) return null;
    const m = typeof seed.model === 'string' ? seed.model.match(/^__pkg:(.+)$/) : null;
    if (!m) return null;
    const rule = this.byName(m[1]);
    if (!rule || !Array.isArray(rule.route) || rule.route.length === 0) return null;
    return {
      rule,
      ruleName: rule.name,
      primary: { ...rule.route[0] },
    };
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
