/**
 * 按需负载测试（v0.8.0 B-1/B-2）。
 *
 * 定位：对注册表 (provider, model) 自动跑一轮分相测试，验证路由链路健康度
 * 与速率边界。4-phase 状态机：probe / rpm / context / quota-group，配
 * snapshot() / abortAll()。仅手动触发（POST 端点），不自动跑（会真实打 API）。
 *
 * 硬约束（计划 §2.5 / §2.9 只对照、不引入）：
 * 1. 编排层复用 probe 原语：singleRaw（PROBE_MARK 透传 + createUserMessage +
 *    超时 + finish 解析）与 runBenchmark 的 QPS 阶梯逻辑；本模块不重复造轮子。
 * 2. 所有请求经 singleRaw → 必带 PROBE_MARK → wrapper 直透：不 failover、
 *    不写 cooldown/metrics/quota/daily（跑完生产状态零污染）。
 * 3. 默认 tierFilter=['free']（不烧付费 token）；显式传 tiers 才测其他档。
 * 4. rpm phase 触发 RATE_LIMIT/QUOTA 后自动等待恢复（S-3：探测与生产共享上游
 *    RPM 池，冷却窗口内生产同样受限，交还控制权前须等冷却）。
 */

import { singleRaw } from './probe.js';

export const LOADTEST_PHASES = ['probe', 'rpm', 'context', 'quota-group'];

const DEFAULT_TIERS = ['free'];
// 与 probe.runBenchmark 默认一致（复刻 trm-test 方法论）
const RPM_QPS_LADDER = [0.05, 0.1, 0.2, 0.3];
const RPM_SAMPLES = 5;
const CONTEXT_SIZES = [1024, 8192];
// sensenova 实测 429 冷却约 30s（S-3）
const RECOVERY_MS = 30_000;

const PHASE_METHODS = {
  probe: '_phase_probe',
  rpm: '_phase_rpm',
  context: '_phase_context',
  'quota-group': '_phase_quotaGroup',
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class LoadTestRunner {
  /**
   * @param {object} deps
   * @param {object} deps.llm LlmRuntime 实例
   * @param {object} deps.registry Registry 实例（registeredPairs 供目标选择）
   * @param {object} [deps.log]
   * @param {string} [deps.prompt]
   * @param {number} [deps.timeoutMs]
   */
  constructor({ llm, registry, log, prompt = 'ping', timeoutMs = 20000 }) {
    this.llm = llm;
    this.registry = registry;
    this.log = log;
    this.prompt = prompt;
    this.timeoutMs = timeoutMs;
    this.running = false;
    this.aborted = false;
    this.startedAt = null;
    this.finishedAt = null;
    /** @type {object|null} 最近一次完整跑批结果 */
    this.last = null;
    /** @type {Record<string, object>} phase → 最近结果 */
    this.results = {};
  }

  /**
   * 目标选择：注册表全部已注册 (provider, model)，按 tier 过滤（默认只测 free）。
   * opts：{ tiers?: string[], provider?: string, model?: string }
   */
  _targets(opts = {}) {
    const tiers = Array.isArray(opts.tiers) && opts.tiers.length ? opts.tiers : DEFAULT_TIERS;
    const allowed = new Set(tiers);
    let pairs = (this.registry?.registeredPairs?.() ?? []).filter((p) => p.model !== null);
    if (typeof opts.provider === 'string' && opts.provider) pairs = pairs.filter((p) => p.provider === opts.provider);
    if (typeof opts.model === 'string' && opts.model) pairs = pairs.filter((p) => p.model === opts.model);
    return pairs.filter((p) => allowed.has(p.tier ?? 'unknown'));
  }

  /** 启动一个 phase。运行中再启会抛错（端点映射为 409）。 */
  async run(phase, opts = {}) {
    if (this.running) throw new Error('loadtest already running');
    const method = PHASE_METHODS[phase];
    if (!method) throw new Error(`unknown phase: ${phase}`);
    this.running = true;
    this.aborted = false;
    this.startedAt = Date.now();
    this.finishedAt = null;
    try {
      const result = await this[method](opts);
      result.aborted = this.aborted;
      this.results[phase] = result;
      this.last = result;
      return result;
    } finally {
      this.running = false;
      this.finishedAt = Date.now();
    }
  }

  /** 中止（置标志，当前请求完成后停止调度新请求）。 */
  abortAll() {
    this.aborted = true;
    this.log?.warn?.('loadtest aborted');
  }

  snapshot() {
    return {
      running: this.running,
      aborted: this.aborted,
      startedAt: this.startedAt,
      finishedAt: this.finishedAt,
      last: this.last,
      results: { ...this.results },
    };
  }

  /** probe phase：对每个目标发一条存活/延迟探测（复用 singleRaw）。 */
  async _phase_probe(opts) {
    const targets = this._targets(opts);
    const out = { phase: 'probe', at: new Date().toISOString(), targets: [] };
    for (const t of targets) {
      if (this.aborted) break;
      const r = await singleRaw(this.llm, t.provider, t.model, this.prompt, this.timeoutMs, this.log);
      out.targets.push({
        provider: t.provider,
        model: t.model,
        ok: r.ok,
        ttftMs: r.ttftMs,
        errorCode: r.errorCode,
      });
    }
    return out;
  }

  /**
   * rpm phase：复刻 runBenchmark 的 QPS 阶梯语义（同默认阶梯/样本数/越界即停），
   * 但经 singleRaw 逐请求捕获错误码 → 可定位 first429Rpm（RATE_LIMIT/QUOTA）。
   * 触发限流后自动等待恢复（S-3）。
   */
  async _phase_rpm(opts) {
    const targets = this._targets(opts);
    const recoveryMs = typeof opts.recoveryMs === 'number' ? opts.recoveryMs : RECOVERY_MS;
    const qpsLadder = Array.isArray(opts.qpsLadder) && opts.qpsLadder.length ? opts.qpsLadder : RPM_QPS_LADDER;
    const samplesPerStep = opts.samplesPerStep ?? RPM_SAMPLES;
    const out = { phase: 'rpm', at: new Date().toISOString(), targets: [] };
    let sawThrottle = false;
    for (const t of targets) {
      if (this.aborted) break;
      const ladder = [];
      let first429Rpm = null;
      for (const qps of qpsLadder) {
        const interval = 1000 / qps;
        let success = 0;
        let total = 0;
        for (let i = 0; i < samplesPerStep; i++) {
          if (this.aborted) break;
          total += 1;
          const r = await singleRaw(this.llm, t.provider, t.model, this.prompt, this.timeoutMs, this.log);
          if (r.ok) success += 1;
          if (
            !r.ok &&
            (r.errorCode === 'RATE_LIMIT' || r.errorCode === 'QUOTA' || r.errorCode === 'QUOTA_EXCEEDED') &&
            first429Rpm === null
          ) {
            first429Rpm = qps;
          }
          if (i < samplesPerStep - 1) await sleep(interval);
        }
        ladder.push({ qps, success, total });
        if (success < total) break; // 越界即停（与 runBenchmark ramp 一致）
      }
      const clean = ladder.filter((s) => s.success === s.total);
      out.targets.push({
        provider: t.provider,
        model: t.model,
        lastOkRpm: clean.length ? clean[clean.length - 1].qps : null,
        first429Rpm,
        ladder,
        note: '复刻 trm-test 方法论：QPS 阶梯找 RPM 边界，安全系数 0.6',
      });
      if (first429Rpm !== null) sawThrottle = true;
    }
    if (sawThrottle && recoveryMs > 0 && !this.aborted) {
      this.log?.info?.(`loadtest rpm 触发限流，等待 ${recoveryMs}ms 恢复后再交还控制权…`);
      await sleep(recoveryMs);
    }
    return out;
  }

  /** context phase：不同上下文长度下模型是否接受（长上下文 TPM 闸门粗测）。 */
  async _phase_context(opts) {
    const targets = this._targets(opts);
    const sizes = Array.isArray(opts.sizes) && opts.sizes.length ? opts.sizes : CONTEXT_SIZES;
    const out = { phase: 'context', at: new Date().toISOString(), targets: [] };
    for (const t of targets) {
      if (this.aborted) break;
      const entries = [];
      for (const tokens of sizes) {
        if (this.aborted) break;
        // 4 chars/token 粗估（英文），足够触发超长上下文拒绝/接受判定
        const prompt = 'x'.repeat(Math.max(1, tokens * 4));
        const r = await singleRaw(this.llm, t.provider, t.model, prompt, this.timeoutMs, this.log);
        entries.push({ tokens, ok: r.ok, ttftMs: r.ttftMs, errorCode: r.errorCode });
      }
      out.targets.push({ provider: t.provider, model: t.model, sizes: entries });
    }
    return out;
  }

  /** quota-group phase：按 quotaGroup 分组，同组（共享 RPM 池）成员交替探测，观察限流联动。 */
  async _phase_quotaGroup(opts) {
    const pairs = this._targets(opts);
    const groups = new Map();
    for (const p of pairs) {
      const g = p.quotaGroup ?? '__none__';
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(p);
    }
    const out = { phase: 'quota-group', at: new Date().toISOString(), groups: [] };
    for (const [g, members] of groups.entries()) {
      if (this.aborted) break;
      const entries = [];
      for (const m of members) {
        if (this.aborted) break;
        const r = await singleRaw(this.llm, m.provider, m.model, this.prompt, this.timeoutMs, this.log);
        entries.push({ provider: m.provider, model: m.model, ok: r.ok, ttftMs: r.ttftMs, errorCode: r.errorCode });
      }
      out.groups.push({ quotaGroup: g === '__none__' ? null : g, members: entries });
    }
    return out;
  }
}
