/**
 * 模型健康探测模块（v0.4.0）。
 *
 * 定位：作为路由「健康度参考数据」的数据源（呼应 model-router-market-analysis
 * 报告中 D4「metrics 采而不用」与 remediation-plan M1.2「健康感知排序」）。
 *
 * 两类能力：
 * 1. 轻量存活/延迟探测（ProbeBoard）：按 interval 对注册表每个 (provider,model)
 *    发一条极短请求，记录 状态(up/down/degraded) / TTFT / 最近错误 / 连续失败数。
 *    默认关闭（probe.enabled=false），避免无授权打真实 API；由面板/配置开启。
 * 2. 按需 TRM 压测（runBenchmark）：复刻 trm-test 方法论——QPS 阶梯找 RPM 边界，
 *    安全系数 0.6（与「两供应商TRM实测结论.md」一致）。手动触发（POST
 *    /api/model-router/benchmark），不自动跑（会真实打 API、可能触发限流）。
 *
 * 探测一律走 ctx.llm.stream 原生路径（复用 credentials，不存 key），并带
 * __mr_probe 标记让 wrapper 跳过 failover 包装（否则会测到兜底而非目标本身）。
 * messages 必须是 dsh 规范的 Message（id/content 块/source 齐全），用官方
 * createUserMessage 构造——简化 {role, content} 会被 adapter 拒绝（UNKNOWN）。
 */

import { createUserMessage } from '@deepseek-ai/dsh-llm';

const PROBE_FLAG = '__mr_probe';
export const PROBE_MARK = PROBE_FLAG;

const DEFAULT_PROMPT = 'ping';function nowMs() {
  return Date.now();
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * @param {object} llm LlmRuntime 实例
 * @param {string} provider
 * @param {string} model
 * @param {string} prompt
 * @param {number} timeoutMs
 * @param {object} [log]
 * @returns {Promise<{ok:boolean, errorCode?:string, errorKind?:string, ttftMs?:number}>}
 */
async function singleRaw(llm, provider, model, prompt, timeoutMs, log) {
  const started = nowMs();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('probe-timeout')), timeoutMs);
  let ttft = undefined;
  let outcome = { ok: false };
  try {
    const stream = llm.stream({
      provider,
      model,
      messages: [
        createUserMessage({
          content: [{ type: 'text', text: prompt }],
          source: { kind: 'plugin', plugin: 'model-router' },
        }),
      ],
      signal: controller.signal,
      [PROBE_FLAG]: true,
    });
    const it = stream[Symbol.asyncIterator]();
    let finished = false;
    while (!finished) {
      const { value: chunk, done } = await it.next();
      if (done) break;
      if (chunk?.type === 'finish') {
        const kind = chunk.reason?.kind;
        if (kind === 'stop') {
          outcome = { ok: true, ttftMs: ttft ?? nowMs() - started };
        } else if (kind === 'error') {
          outcome = {
            ok: false,
            errorCode: chunk.reason?.failure?.code,
            errorKind: 'error',
          };
        } else if (kind === 'aborted') {
          outcome = { ok: false, errorCode: 'ABORTED', errorKind: 'aborted' };
        }
        finished = true;
      } else if (ttft === undefined) {
        ttft = nowMs() - started;
      }
    }
  } catch (error) {
    outcome = {
      ok: false,
      errorCode: error?.code ?? 'STREAM_ERROR',
      errorKind: 'throw',
    };
  } finally {
    clearTimeout(timer);
    try {
      controller.abort();
    } catch {
      // ignore
    }
  }
  return outcome;
}

export class ProbeBoard {
  /**
   * @param {object} log
   * @param {{timeoutMs?:number, prompt?:string, enabled?:boolean}} opts
   */
  constructor(log, opts = {}) {
    this.log = log;
    this.timeoutMs = opts.timeoutMs ?? 20000;
    this.prompt = opts.prompt ?? DEFAULT_PROMPT;
    this.enabled = opts.enabled === true;
    /** @type {Map<string, object>} key = provider/model */
    this.health = new Map();
    /** @type {Map<string, object>} 最近一次 benchmark 报告（key = provider/model） */
    this.benchmarks = new Map();
    this.running = false;
  }

  keyOf(provider, model) {
    return `${provider}/${model}`;
  }

  healthOf(provider, model) {
    return this.health.get(this.keyOf(provider, model)) ?? null;
  }

  /**
   * 对单个 (provider,model) 跑一次存活探测并记录。
   * @returns {Promise<{provider,model,ok:boolean,ttftMs?:number,errorCode?:string}>}
   */
  async runProbe(llm, provider, model) {
    const outcome = await singleRaw(llm, provider, model, this.prompt, this.timeoutMs, this.log);
    const rec = {
      provider,
      model,
      ok: outcome.ok,
      ttftMs: outcome.ttftMs,
      errorCode: outcome.errorCode,
      lastProbeAt: new Date().toISOString(),
    };
    this._record(provider, model, rec);
    this.log?.info?.(
      `probe ${provider}/${model} → ${outcome.ok ? 'ok' : 'FAIL ' + (outcome.errorCode ?? '')} ttft=${outcome.ttftMs ?? '-'}`,
    );
    return { provider, model, ...outcome };
  }

  _record(provider, model, rec) {
    const key = this.keyOf(provider, model);
    const h = this.health.get(key) ?? {
      provider,
      model,
      total: 0,
      success: 0,
      consecutiveFails: 0,
      ttfts: [],
    };
    h.total += 1;
    if (rec.ok) {
      h.success += 1;
      h.consecutiveFails = 0;
      h.status = 'up';
    } else {
      h.consecutiveFails += 1;
      h.status = h.consecutiveFails >= 3 ? 'down' : 'degraded';
    }
    h.lastProbeAt = rec.lastProbeAt;
    h.lastError = rec.ok ? undefined : rec.errorCode;
    h.lastErrorCode = rec.errorCode;
    if (typeof rec.ttftMs === 'number') {
      h.ttfts.push(rec.ttftMs);
      if (h.ttfts.length > 20) h.ttfts.shift();
      h.ttftMs = Math.round((h.ttfts.reduce((a, b) => a + b, 0) / h.ttfts.length) * 10) / 10;
      const sorted = [...h.ttfts].sort((a, b) => a - b);
      h.p95TtftMs = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
    }
    h.successRate = h.total ? h.success / h.total : undefined;
    this.health.set(key, h);
  }

  /** 批量探测（interval 调用）。targets = [{provider,model}]。重入保护。 */
  async runAll(llm, targets) {
    if (this.running) return;
    this.running = true;
    try {
      for (const t of targets) {
        try {
          await this.runProbe(llm, t.provider, t.model);
        } catch (e) {
          this.log?.warn?.(`probe ${t.provider}/${t.model} crashed: ${e?.message ?? e}`);
        }
      }
    } finally {
      this.running = false;
    }
  }

  snapshot() {
    const entries = {};
    for (const [k, v] of this.health.entries()) entries[k] = v;
    const benchmarks = {};
    for (const [k, v] of this.benchmarks.entries()) benchmarks[k] = v;
    return { enabled: this.enabled, entries, benchmarks };
  }
}

/**
 * TRM 边界计算（纯函数，便于单测）。
 * @param {Array<{qps:number, success:number, total:number}>} ladder 每阶梯结果（success=total 视为该档干净）
 * @param {number} [safety] 安全系数（默认 0.6，与 trm-test 结论一致）
 */
export function computeTrmBound(ladder, safety = 0.6) {
  let boundaryQps = null;
  for (const step of ladder) {
    if (step.total > 0 && step.success === step.total) boundaryQps = step.qps;
    else break;
  }
  if (boundaryQps == null) {
    return { boundaryQps: null, safeQps: null, safeIntervalMs: null, maxConcurrency: null };
  }
  const safeQps = Math.round(boundaryQps * safety * 1000) / 1000;
  const safeIntervalMs = Math.round(1000 / safeQps);
  // 最大并发：按利特尔法则粗估（p90 延迟未知，给 ~4s 经验值）
  const maxConcurrency = Math.max(1, Math.round(safeQps * 4));
  return { boundaryQps, safeQps, safeIntervalMs, maxConcurrency };
}

/**
 * 按需 TRM 压测（复刻 trm-test 方法论：QPS 阶梯找 RPM 边界，安全系数 0.6）。
 * 会真实打 API、可能触发限流——仅手动触发。
 * @param {object} llm
 * @param {string} provider
 * @param {string} model
 * @param {object} [log]
 * @param {{qpsLadder?:number[], samplesPerStep?:number, prompt?:string, timeoutMs?:number, safety?:number}} [opts]
 */
export async function runBenchmark(llm, provider, model, log, opts = {}) {
  const qpsLadder = opts.qpsLadder ?? [0.05, 0.1, 0.2, 0.3];
  const samplesPerStep = opts.samplesPerStep ?? 5;
  const prompt = opts.prompt ?? DEFAULT_PROMPT;
  const timeoutMs = opts.timeoutMs ?? 15000;
  const safety = opts.safety ?? 0.6;
  const ladder = [];
  for (const qps of qpsLadder) {
    const interval = 1000 / qps;
    let success = 0;
    let total = 0;
    for (let i = 0; i < samplesPerStep; i++) {
      total += 1;
      const r = await singleRaw(llm, provider, model, prompt, timeoutMs, log);
      if (r.ok) success += 1;
      if (i < samplesPerStep - 1) await sleep(interval);
    }
    ladder.push({ qps, success, total });
    if (success < total) break; // 一旦越界即停（与 trm-test ramp 一致）
  }
  const bound = computeTrmBound(ladder, safety);
  return {
    provider,
    model,
    at: new Date().toISOString(),
    ladder,
    ...bound,
    note: '复刻 trm-test 方法论：QPS 阶梯找 RPM 边界，安全系数 0.6；长上下文 TPM 闸门未测（如需复测加 context-tokens）',
  };
}
