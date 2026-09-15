/**
 * 模型全自动测试模式（v0.9.5 §9）。
 *
 * 定位：对指定的 (provider, model) 清单串行跑完整 4 相（probe / rpm / context /
 * quota-group），给出 TTFT / RPM 边界 / 上下文接受 / 配额组联动等关键参数，产一份
 * 完整报告落盘（json + md 双份，复用 daily 的 reportDir），供面板「模型测试」页签
 * 查看；每 target 带 verdict（primary/backup/exclude），结论可被面板一键桥接进
 * 规则编辑器作为路由参考。
 *
 * 硬约束（与 loadtest 一致）：所有请求经 singleRaw（probe.js 导出的公用 raw 驱动，
 * 必带 PROBE_MARK 零污染）——不 failover、不写 cooldown/metrics/quota/daily。
 * 非 free tier 必须显式 confirmPaidBurn=true 才允许，防止误烧付费 token。
 *
 * 零三方依赖：报告生成走模板字符串。
 */

import { singleRaw } from './probe.js';
import { writeFileSync, readFileSync, mkdirSync, renameSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';

// 判定阈值（v0.9.5 硬编码，后续可经 config.reports.modelTestThreshold 覆盖）
const DEFAULT_THRESHOLD = { primary: 0.7, backup: 0.4 };

const RPM_QPS_LADDER = [0.05, 0.1, 0.2, 0.3];
const RPM_SAMPLES = 5;
const CONTEXT_SIZES = [1024, 8192];
// 触发限流后等待恢复，交还控制权前须等冷却（S-3）
const RECOVERY_MS = 30_000;

// v0.9.8：测试内容选择。undefined/缺省 = 全跑（向后兼容既有 132/142）。
// 非法 → throw 由 routes 层 catch 转为 400。
export const MODEL_TEST_PHASES = ['probe', 'rpm', 'context', 'quota-group'];
export function validatePhases(v) {
  if (v === undefined || v === null) return MODEL_TEST_PHASES.slice();
  if (!Array.isArray(v) || v.length === 0) {
    throw new Error(`model-test: phases 须为非空数组（${MODEL_TEST_PHASES.join('/')} 子集）`);
  }
  for (const p of v) if (!MODEL_TEST_PHASES.includes(p)) {
    throw new Error(`model-test: phases 含未知项 "${p}"，须为 ${MODEL_TEST_PHASES.join('/')} 子集`);
  }
  // 去重 + 固定序
  return MODEL_TEST_PHASES.filter((p) => v.includes(p));
}

// v0.9.8：phase 错误处理只依据真实 errorCode，不从 lastOkRpm/maxAccepted 反推。
const SHORT_CIRCUIT_CODES = {
  probe: new Set(['AUTH', 'INVALID_CREDENTIAL', 'MISSING_CREDENTIAL', 'INVALID_REQUEST', 'QUOTA', 'QUOTA_EXCEEDED']),
  rpm: new Set(['QUOTA', 'QUOTA_EXCEEDED']),
  context: new Set(['CONTEXT_LENGTH', 'CONTEXT_WINDOW', 'TOO_MANY_TOKENS']),
};
const capMessage = (value) => typeof value === 'string' ? value.slice(0, 200) : null;
function firstActualError(phase, result) {
  if (!result) return null;
  if (result.firstError && result.firstError.errorCode) return result.firstError;
  if (phase === 'probe' && result.ok === false) {
    return { errorCode: result.errorCode ?? 'UNKNOWN', errorMessage: capMessage(result.errorMessage) };
  }
  if (phase === 'rpm') {
    const step = Array.isArray(result.ladder) && result.ladder.find((s) => s && s.firstError?.errorCode);
    return step?.firstError ?? null;
  }
  if (phase === 'context') {
    const item = Array.isArray(result.sizes) && result.sizes.find((s) => s && s.errorCode);
    return item ? { errorCode: item.errorCode, errorMessage: capMessage(item.errorMessage) } : null;
  }
  if (phase === 'quota-group') {
    const member = Array.isArray(result.members) && result.members.find((m) => m && m.errorCode);
    return member ? { errorCode: member.errorCode, errorMessage: capMessage(member.errorMessage) } : null;
  }
  return null;
}
function shouldShortCircuit(phase, error) {
  return Boolean(error?.errorCode && SHORT_CIRCUIT_CODES[phase]?.has(error.errorCode));
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// v0.9.8：可重试的错误码集合——仅 probe 相退避。
// 不含 AUTH/400/QUOTA/INVALID_REQUEST 等确定性错误（重试无意义）。
const RETRYABLE = new Set([
  'TRANSPORT', 'SERVER', 'UNKNOWN', 'TIMEOUT', 'ABORTED', 'STREAM_ERROR', 'EMPTY_RESPONSE',
]);

/**
 * 校验 model-test 入参 targets 数组。
 * - target 至少含 provider/model；tier 缺省 'free'；含非 free 时须 confirmPaidBurn=true。
 * - 透传人工字段 manualTpm / manualMaxContext / label。
 * @returns {object[]} 规范化后的 targets
 * @throws {Error} 入参非法或付费缺确认
 */
export function validateModelTestTargets(targets, confirmPaidBurn) {
  if (!Array.isArray(targets) || targets.length === 0) {
    throw new Error('model-test: body.targets 须为非空数组 [{provider, model}]');
  }
  const out = [];
  for (const t of targets) {
    if (!t || typeof t !== 'object') throw new Error('model-test: targets 内元素须为对象');
    if (typeof t.provider !== 'string' || !t.provider) throw new Error('model-test: targets[].provider 须为非空字符串');
    if (typeof t.model !== 'string' || !t.model) throw new Error('model-test: targets[].model 须为非空字符串');
    const tier = typeof t.tier === 'string' && t.tier ? t.tier : 'free';
    if (tier !== 'free' && confirmPaidBurn !== true) {
      throw new Error('非 free tier 会真实消耗付费 token；请在 body 中显式声明 "confirmPaidBurn": true 后再试');
    }
    const target = {
      provider: t.provider,
      model: t.model,
      tier,
      label: typeof t.label === 'string' && t.label ? t.label : null,
    };
    if (t.manualTpm !== undefined) {
      if (typeof t.manualTpm !== 'number' || !Number.isFinite(t.manualTpm)) throw new Error('model-test: targets[].manualTpm 须为有限数字');
      target.manualTpm = t.manualTpm;
    }
    if (t.manualMaxContext !== undefined) {
      if (!Number.isInteger(t.manualMaxContext) || t.manualMaxContext <= 0) throw new Error('model-test: targets[].manualMaxContext 须为正整数');
      target.manualMaxContext = t.manualMaxContext;
    }
    out.push(target);
  }
  return out;
}

/**
 * 校验 model-test/manual 入参。
 * @returns {object} { runId, targetKey, manualTpm?, manualMaxContext?, label?, notes? }
 * @throws {Error} 入参非法
 */
export function validateManualInput(body) {
  if (!body || typeof body !== 'object') throw new Error('model-test/manual: body 须为对象');
  const { runId, targetKey } = body;
  if (typeof runId !== 'string' || !runId) throw new Error('model-test/manual: runId 须为非空字符串');
  if (typeof targetKey !== 'string' || !targetKey) throw new Error('model-test/manual: targetKey 须为非空字符串');
  if (body.manualTpm !== undefined && (typeof body.manualTpm !== 'number' || !Number.isFinite(body.manualTpm))) {
    throw new Error('model-test/manual: manualTpm 须为有限数字');
  }
  if (body.manualMaxContext !== undefined && (!Number.isInteger(body.manualMaxContext) || body.manualMaxContext <= 0)) {
    throw new Error('model-test/manual: manualMaxContext 须为正整数');
  }
  return {
    runId,
    targetKey,
    manualTpm: body.manualTpm,
    manualMaxContext: body.manualMaxContext,
    label: body.label,
    notes: body.notes,
  };
}

/**
 * verdict 评分（纯函数，供单测）。
 * 含 §14 修复 #4 的「失败但 rpm 可用」分支：probe 失败但 rpm 仍可用 → score=0.35、recommend=backup。
 * @param {object} tr { probe, rpm, context, quotaGroup }
 * @param {object} [threshold] { primary, backup }
 */
export function verdictOf(tr, threshold = DEFAULT_THRESHOLD) {
  const { probe, rpm, context, quotaGroup } = tr || {};
  let score = 0.5;
  // v0.9.6（§14 #4）：某些分支需要直接锁定 recommend，不能只靠分数推断——
  // 例如「probe 失败但 rpm 仍可用」应判 backup，但 base 0.35 低于 backup 阈值 0.4，
  // 若靠后续加成把它抬过阈值，最高可到 0.75 反而溢出成 primary。故用 forced 显式锁定。
  let forced = null;
  const reasons = [];

  if (probe && probe.ok === true) {
    score += 0.1;
    reasons.push('probe 存活');
    if (Number.isFinite(probe.ttftMs) && probe.ttftMs < 3000) { score += 0.05; reasons.push('TTFT < 3s'); }
    if (Number.isFinite(probe.ttftMs) && probe.ttftMs < 1000) { score += 0.05; }
  } else if (probe && probe.ok === false) {
    const rpmOk = rpm && Number.isFinite(rpm.lastOkRpm) && rpm.lastOkRpm > 0;
    if (rpmOk) {
      // §14 #4：probe 失败但 rpm 仍可用 → backup，避免直接 exclude（用 forced 锁定，
      // 不依赖分数越过阈值——见上方注释）。
      score = 0.35;
      forced = 'backup';
      reasons.push('probe 失败但 rpm 仍可用');
    } else {
      score -= 0.2;
      reasons.push('probe 失败且 rpm 不可用');
    }
  }

  if (rpm) {
    if (Number.isFinite(rpm.lastOkRpm) && rpm.lastOkRpm >= 0.2) { score += 0.1; reasons.push('RPM 边界高'); }
    if (rpm.first429Rpm === null) { score += 0.05; reasons.push('未观测到限流'); }
  }
  if (context && Number.isFinite(context.maxAccepted)) {
    if (context.maxAccepted >= 8192) { score += 0.05; reasons.push('上下文 8k+ 接受'); }
    if (context.maxAccepted >= 32768) { score += 0.05; }
  }
  if (quotaGroup && Array.isArray(quotaGroup.members) && quotaGroup.members.length) {
    if (quotaGroup.members.every((m) => m && m.ok)) { score += 0.05; reasons.push('配额组全通过'); }
  }

  score = Math.max(0, Math.min(1, score));
  let recommend;
  if (forced !== null) recommend = forced;
  else if (score >= threshold.primary) recommend = 'primary';
  else if (score >= threshold.backup) recommend = 'backup';
  else recommend = 'exclude';

  // §11.4 桥接：quotaRisk 粗推断（基于 RPM 边界 + probe 稳定性）
  let quotaRisk = 'unknown';
  if (probe && probe.ok === false && rpm && rpm.first429Rpm !== null) quotaRisk = 'high';
  else if (rpm && Number.isFinite(rpm.lastOkRpm) && rpm.lastOkRpm < 0.2) quotaRisk = 'medium';
  else if (rpm && rpm.first429Rpm === null) quotaRisk = 'low';

  return { recommend, score, quotaRisk, reasons };
}

/** target key 唯一化（provider\u0000model，跨 provider 同名模型不冲突）。 */
function targetKeyOf(t) {
  return `${t.provider}\u0000${t.model}`;
}

/**
 * ModelTestRunner：对指定 targets 串行跑 4 相。与 LoadTestRunner 定位不同
 * （loadtest=注册表全跑、model-test=指定清单定向跑+报告落盘+路由桥接），
 * 共用 probe.js 导出的 raw 驱动 singleRaw，不依赖 loadtest 私有方法。
 */
export class ModelTestRunner {
  constructor({ llm, registry, daily, log, prompt = 'ping', timeoutMs = 20000, threshold }) {
    this.llm = llm;
    this.registry = registry;
    this.daily = daily; // 仅用于拿 reportDir
    this.log = log;
    this.prompt = prompt;
    this.timeoutMs = timeoutMs;
    this.threshold = threshold || DEFAULT_THRESHOLD;
    this.running = false;
    this.aborted = false;
    this.startedAt = null;
    this.finishedAt = null;
    this.last = null;
  }

  get reportDir() {
    return this.daily && this.daily.reportDir ? this.daily.reportDir : null;
  }

  snapshot() {
    return {
      running: this.running,
      aborted: this.aborted,
      startedAt: this.startedAt ? new Date(this.startedAt).toISOString() : null,
      finishedAt: this.finishedAt ? new Date(this.finishedAt).toISOString() : null,
      last: this.last,
    };
  }

  abortAll() {
    this.aborted = true;
    this.log?.warn?.('model-test aborted');
  }

  /** 入口：串行跑所有 targets。opts.recoveryMs 透传。opts.phases 控制要跑哪几相。 */
  async run(targets, opts = {}) {
    if (this.running) throw new Error('model-test already running');
    const recoveryMs = typeof opts.recoveryMs === 'number' ? opts.recoveryMs : RECOVERY_MS;
    // v0.9.8 phases：validatePhases 已在 routes 层调用；此处再调一次兜底（直接调
    // lib/*.js 时可缺校验），并允许 undefined → 全跑（向后兼容）。
    const phases = validatePhases(opts.phases);
    this.running = true;
    this.aborted = false;
    this.startedAt = Date.now();
    this.finishedAt = null;
    let sawThrottle = false;
    const report = {
      ok: true,
      runId: opts.runId ?? null,
      startedAt: new Date(this.startedAt).toISOString(),
      finishedAt: null,
      elapsedMs: null,
      aborted: false,
      partial: false,
      phases,
      targets: [],
    };
    try {
      for (const t of targets) {
        if (this.aborted) { report.aborted = true; report.partial = true; break; }
        const tr = await this._runTarget(t, recoveryMs, phases);
        if (tr.aborted === true) { report.aborted = true; report.partial = true; }
        if (tr._sawThrottle) sawThrottle = true;
        report.targets.push(tr);
      }
      if (sawThrottle && recoveryMs > 0 && !this.aborted) {
        this.log?.info?.(`model-test 触发限流，等待 ${recoveryMs}ms 恢复后再交还控制权…`);
        await sleep(recoveryMs);
      }
      this.finishedAt = Date.now();
      report.finishedAt = new Date(this.finishedAt).toISOString();
      report.elapsedMs = this.finishedAt - this.startedAt;   // v0.9.8：跑批总量（与
      // 每个 target 的 outcome.elapsedMs 并存，前者看整批，后者看单 target）
      this.last = report;
      return report;
    } finally {
      this.running = false;
    }
  }

  async _runTarget(t, recoveryMs, phases) {
    const tStart = Date.now();
    const outcome = {
      aborted: false,
      _sawThrottle: false,
      startedAt: new Date(tStart).toISOString(),
      phases: phases.slice(),
      notSelected: MODEL_TEST_PHASES.filter((p) => !phases.includes(p)),
      skipped: [],
      skipReasons: {},
      phaseErrors: {},
    };
    const targetElapsed = () => Date.now() - tStart;
    let stopReason = null;

    for (const phase of MODEL_TEST_PHASES) {
      if (!phases.includes(phase)) continue;
      if (this.aborted) {
        outcome.aborted = true;
        outcome.skipped.push(phase);
        outcome.skipReasons[phase] = 'ABORTED';
        continue;
      }
      if (stopReason) {
        outcome.skipped.push(phase);
        outcome.skipReasons[phase] = stopReason;
        continue;
      }

      let result;
      if (phase === 'probe') result = await this._phaseProbe(t);
      else if (phase === 'rpm') result = await this._phaseRpm(t);
      else if (phase === 'context') result = await this._phaseContext(t);
      else if (phase === 'quota-group') result = await this._phaseQuotaGroup(t);
      outcome[phase === 'quota-group' ? 'quotaGroup' : phase] = result;

      if (phase === 'rpm' && Array.isArray(result?.ladder) && result.ladder.some((s) => s && s.success < s.total)) {
        outcome._sawThrottle = true;
      }
      const error = firstActualError(phase, result);
      if (error) outcome.phaseErrors[phase] = error;
      if (shouldShortCircuit(phase, error)) stopReason = `skipped: ${error.errorCode} after ${phase}`;
    }

    outcome.elapsedMs = targetElapsed();
    return this._finalize(t, outcome);
  }

  /** 组装单个 target 结果 + verdict，剥离内部标记。 */
  _finalize(t, outcome) {
    const {
      aborted, startedAt, elapsedMs, probe, rpm, context, quotaGroup,
      phases, notSelected, skipped, skipReasons, phaseErrors,
    } = outcome;
    const targetResult = {
      provider: t.provider,
      model: t.model,
      label: t.label ?? null,
      tier: t.tier ?? 'free',
      manualTpm: t.manualTpm,
      manualMaxContext: t.manualMaxContext,
      probe: probe ?? null,
      rpm: rpm ?? null,
      context: context ?? null,
      quotaGroup: quotaGroup ?? null,
      phases: phases ?? MODEL_TEST_PHASES.slice(),
      notSelected: notSelected ?? [],
      skipped: skipped ?? [],
      skipReasons: skipReasons ?? {},
      phaseErrors: phaseErrors ?? {},
      aborted: aborted === true,
      startedAt,
      elapsedMs,
    };
    targetResult.verdict = verdictOf(targetResult, this.threshold);
    return targetResult;
  }

  async _single(t, prompt) {
    return singleRaw(this.llm, t.provider, t.model, prompt, this.timeoutMs, this.log);
  }

  /**
   * v0.9.8：probe 相专用退避重试。
   *
   * 为什么仅 probe 用（rpm/context 不退避）：
   *   _phaseRpm 是 4 档 × 5 样本的 QPS 阶梯（`RPM_QPS_LADDER`×`RPM_SAMPLES`），靠
   *   `sleep(1000/qps)` 控制请求密度来测限流边界。`_single` 里插入 800/1600ms 退避
   *   会改变实际请求密度，让 `lastOkRpm` / `first429Rpm` 失真。退避只对瞬时网络
   *   错误（TRANSPORT/TIMEOUT/…）有意义，对 RPM 测量本身无意义。
   *
   * @returns 单次结果 + 实际重试次数（0 = 首次即成功或首次即确定性失败）
   */
  async _singleWithRetry(t, prompt) {
    for (let a = 0; ; a++) {
      const r = await this._single(t, prompt);
      if (r.ok || a >= 2 || !RETRYABLE.has(r.errorCode)) return { ...r, retries: a };
      // 800ms / 1600ms + 最多 250ms jitter（避免重试雷击）
      await sleep(800 * Math.pow(2, a) + Math.floor(Math.random() * 250));
    }
  }

  async _phaseProbe(t) {
    const r = await this._singleWithRetry(t, this.prompt);
    return {
      ok: r.ok,
      ttftMs: r.ttftMs ?? null,
      errorCode: r.errorCode ?? null,
      // v0.9.8：probe.js 透传的 errorMessage 也带回（200 字符截断避免报告膨胀）。
      errorMessage: typeof r.errorMessage === 'string' ? r.errorMessage.slice(0, 200) : null,
      retries: r.retries,
      at: new Date().toISOString(),
    };
  }

  async _phaseRpm(t) {
    const ladder = [];
    let first429Rpm = null;
    let firstError = null;
    for (const qps of RPM_QPS_LADDER) {
      if (this.aborted) break;
      const interval = 1000 / qps;
      let success = 0;
      let total = 0;
      let stepError = null;
      for (let i = 0; i < RPM_SAMPLES; i++) {
        if (this.aborted) break;
        total += 1;
        const r = await this._single(t, this.prompt);
        if (r.ok) success += 1;
        if (!r.ok) {
          const error = { errorCode: r.errorCode ?? 'UNKNOWN', errorMessage: capMessage(r.errorMessage) };
          if (!stepError) stepError = error;
          if (!firstError) firstError = error;
          if ((r.errorCode === 'RATE_LIMIT' || r.errorCode === 'QUOTA' || r.errorCode === 'QUOTA_EXCEEDED') && first429Rpm === null) {
            first429Rpm = qps;
          }
        }
        if (i < RPM_SAMPLES - 1) await sleep(interval);
      }
      const step = { qps, success, total };
      if (stepError) step.firstError = stepError;
      ladder.push(step);
      if (success < total) break; // 越界即停
    }
    const clean = ladder.filter((s) => s.success === s.total);
    return {
      lastOkRpm: clean.length ? clean[clean.length - 1].qps : null,
      first429Rpm,
      firstError,
      ladder,
    };
  }

  async _phaseContext(t) {
    const sizes = [];
    let firstError = null;
    for (const tokens of CONTEXT_SIZES) {
      if (this.aborted) break;
      const prompt = 'x'.repeat(Math.max(1, tokens * 4));
      const r = await this._single(t, prompt);
      const item = {
        tokens,
        ok: r.ok,
        errorCode: r.errorCode ?? null,
        errorMessage: capMessage(r.errorMessage),
      };
      if (!r.ok && !firstError) firstError = { errorCode: item.errorCode ?? 'UNKNOWN', errorMessage: item.errorMessage };
      sizes.push(item);
    }
    const okSizes = sizes.filter((s) => s.ok).map((s) => s.tokens);
    return {
      sizes,
      maxAccepted: okSizes.length ? Math.max(...okSizes) : 0,
      firstError,
    };
  }

  /** quota-group：单 target，取自身 quotaGroup（若注册表有）并探测同组成员。 */
  async _phaseQuotaGroup(t) {
    let quotaGroup = null;
    if (this.registry && typeof this.registry.registeredPairs === 'function') {
      const pairs = this.registry.registeredPairs();
      const self = pairs.find((p) => p.provider === t.provider && p.model === t.model);
      quotaGroup = (self && self.quotaGroup) || null;
    }
    const members = [];
    let firstError = null;
    if (quotaGroup && this.registry && typeof this.registry.registeredPairs === 'function') {
      const peers = this.registry.registeredPairs().filter((p) => p.quotaGroup === quotaGroup && !(p.provider === t.provider && p.model === t.model));
      for (const peer of peers.slice(0, 3)) {
        if (this.aborted) break;
        const r = await this._single({ provider: peer.provider, model: peer.model }, this.prompt);
        const member = {
          provider: peer.provider,
          model: peer.model,
          ok: r.ok,
          errorCode: r.errorCode ?? null,
          errorMessage: capMessage(r.errorMessage),
        };
        if (!r.ok && !firstError) firstError = { errorCode: member.errorCode ?? 'UNKNOWN', errorMessage: member.errorMessage };
        members.push(member);
      }
    }
    return { quotaGroup, members, firstError };
  }
}

/**
 * 生成人类可读 markdown 报告（§9 版）。
 * @param {object} report model-test 报告对象
 */
export function formatReportMarkdown(report) {
  const tz = report.timeZone ?? '系统时区';
  const lines = [];
  lines.push(`# 模型测试报告 · ${report.runId ?? 'untitled'}`);
  lines.push('');
  lines.push(`- 时区：${tz}`);
  lines.push(`- 开始：${report.startedAt ?? '—'}`);
  lines.push(`- 结束：${report.finishedAt ?? '—'}`);
  lines.push(`- 状态：${report.aborted ? '已中断（部分完成）' : '完成'}`);
  lines.push(`- 测试内容：${Array.isArray(report.phases) ? report.phases.join(' / ') : 'probe / rpm / context / quota-group'}`);
  lines.push(`- 批次耗时：${Number.isFinite(report.elapsedMs) ? report.elapsedMs + 'ms' : '—'}`);
  lines.push('');
  lines.push('## 逐模型结论');
  lines.push('');
  lines.push('| provider | model | tier | 标签 | probe | 可用 RPM | Context | verdict | 分 |');
  lines.push('|---|---|---|---|---|---|---|---|---:|');
  const targets = Array.isArray(report.targets) ? report.targets : [];
  for (const tr of targets) {
    const probe = tr.probe ? (tr.probe.ok ? 'OK' : `FAIL(${tr.probe.errorCode ?? '?'})`) : '—';
    const rpm = tr.rpm ? (tr.rpm.lastOkRpm ?? '—') : '—';
    const ctx = tr.context ? String(tr.context.maxAccepted ?? '—') : '—';
    const v = tr.verdict ? tr.verdict.recommend : '—';
    const score = tr.verdict && tr.verdict.score !== undefined ? tr.verdict.score.toFixed(2) : '—';
    lines.push(`| ${tr.provider} | ${tr.model} | ${tr.tier} | ${tr.label ?? '—'} | ${probe} | ${rpm} | ${ctx} | **${v}** | ${score} |`);
  }
  lines.push('');
  lines.push('## 错误详情');
  lines.push('');
  const errorRows = [];
  for (const tr of targets) {
    const phaseErrors = tr.phaseErrors && typeof tr.phaseErrors === 'object' ? tr.phaseErrors : {};
    for (const [phase, error] of Object.entries(phaseErrors)) {
      if (!error || !error.errorCode) continue;
      errorRows.push(`- ${tr.provider}/${tr.model} · ${phase} · ${error.errorCode}${error.errorMessage ? `：${error.errorMessage}` : ''}`);
    }
  }
  lines.push(...(errorRows.length ? errorRows : ['（无）']));
  lines.push('');
  lines.push('> verdict：primary=首选 / backup=备用 / exclude=排除；仅供参考，最终以人工确认为准。');
  return lines.join('\n');
}

/** 校验某 target 的人工字段（verdict 无阻断，仅记录 visual warnings）。 */
export function manualWarnings(targetResult) {
  const warnings = [];
  if (!targetResult.rpm || !Number.isFinite(targetResult.rpm.lastOkRpm)) {
    warnings.push('无 RPM 实测值，人工 TPM 无法比对');
  } else if (Number.isFinite(targetResult.manualTpm)) {
    const estTpmBound = targetResult.rpm.lastOkRpm * 60;
    if (estTpmBound > 0 && targetResult.manualTpm > estTpmBound * 5) {
      warnings.push(`manualTpm(${targetResult.manualTpm}) 与实测 RPM 边界换算(≈${Math.round(estTpmBound)}TPM)相差 5× 以上，请人工核实`);
    }
  }
  if (targetResult.manualMaxContext != null && targetResult.context && !Number.isFinite(targetResult.context.maxAccepted)) {
    warnings.push('manualMaxContext 已填但实测 context 无可接受值');
  }
  return warnings;
}

/**
 * 顶层入口：build runId → 串行跑全部 targets → 落 json + md 双份 → 返回 report。
 * @param {object} opts { llm, registry, daily, log, targets, recoveryMs, prompt, timeoutMs, confirmPaidBurn, threshold, testThreshold }
 * @returns {Promise<object>} 完整报告
 */
export async function runReport(opts) {
  const { llm, registry, daily, log } = opts;
  const threshold = opts.testThreshold || DEFAULT_THRESHOLD;
  const runner = new ModelTestRunner({ llm, registry, daily, log, prompt: opts.prompt, timeoutMs: opts.timeoutMs, threshold });
  const targets = validateModelTestTargets(opts.targets, opts.confirmPaidBurn);
  const runId = (opts.runId ?? buildRunId());
  const report = await runner.run(targets, { recoveryMs: opts.recoveryMs, phases: opts.phases });
  report.runId = runId;
  if (daily && daily.reportDir) {
    persistReport(daily.reportDir, runId, report, log);
  } else {
    log?.warn?.('model-test: daily 报告目录不可用，跳过落盘');
  }
  return report;
}

function buildRunId() {
  const now = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const suffix = Math.random().toString(36).slice(2, 6);
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}T${p(now.getHours())}-${p(now.getMinutes())}-${p(now.getSeconds())}-${suffix}`;
}

/** 落盘 json + md（原子写），并回置该报告文件的绝对路径。 */
function persistReport(reportDir, runId, report, log) {
  try {
    mkdirSync(reportDir, { recursive: true });
    const jsonTarget = join(reportDir, `${runId}.model-test.json`);
    const mdTarget = join(reportDir, `${runId}.model-test.md`);
    const jsonBody = JSON.stringify({ ...report, timeZone: null, file: jsonTarget }, null, 2);
    const mdBody = formatReportMarkdown({ ...report, timeZone: null });
    writeAtomic(jsonTarget, jsonBody, log);
    writeAtomic(mdTarget, mdBody, log);
    report.file = jsonTarget;
    report.md = mdTarget;
    return jsonTarget;
  } catch (error) {
    log?.warn?.(`model-test 落盘失败: ${error?.message ?? error}`);
    return null;
  }
}

function writeAtomic(target, content, log) {
  const tmp = `${target}.tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    writeFileSync(tmp, content, { encoding: 'utf8', flag: 'wx' });
    renameSync(tmp, target);
  } catch (error) {
    log?.warn?.(`model-test 写盘失败: ${error?.message ?? error}`);
    throw error;
  }
}