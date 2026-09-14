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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

  /** 入口：串行跑所有 targets。opts.recoveryMs 透传。 */
  async run(targets, opts = {}) {
    if (this.running) throw new Error('model-test already running');
    const recoveryMs = typeof opts.recoveryMs === 'number' ? opts.recoveryMs : RECOVERY_MS;
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
      aborted: false,
      partial: false,
      targets: [],
    };
    try {
      for (const t of targets) {
        if (this.aborted) { report.aborted = true; report.partial = true; break; }
        const tr = await this._runTarget(t, recoveryMs);
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
      this.last = report;
      return report;
    } finally {
      this.running = false;
    }
  }

  async _runTarget(t, recoveryMs) {
    const outcome = { aborted: false, _sawThrottle: false, startedAt: new Date().toISOString() };
    const probe = await this._phaseProbe(t);
    outcome.probe = probe;
    if (this.aborted) { outcome.aborted = true; outcome.elapsedMs = this._elapsed(); return this._finalize(t, outcome); }

    const rpm = await this._phaseRpm(t);
    outcome.rpm = rpm;
    if (Array.isArray(rpm.ladder) && rpm.ladder.some((s) => s && s.success < s.total)) outcome._sawThrottle = true;
    if (this.aborted) { outcome.aborted = true; outcome.elapsedMs = this._elapsed(); return this._finalize(t, outcome); }

    const context = await this._phaseContext(t);
    outcome.context = context;
    if (this.aborted) { outcome.aborted = true; outcome.elapsedMs = this._elapsed(); return this._finalize(t, outcome); }

    const quotaGroup = await this._phaseQuotaGroup(t);
    outcome.quotaGroup = quotaGroup;
    outcome.elapsedMs = this._elapsed();
    return this._finalize(t, outcome);
  }

  _elapsed() {
    return this.startedAt ? Date.now() - this.startedAt : null;
  }

  /** 组装单个 target 结果 + verdict，剥离内部标记。 */
  _finalize(t, outcome) {
    const { aborted, startedAt, elapsedMs, probe, rpm, context, quotaGroup } = outcome;
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

  async _phaseProbe(t) {
    const r = await this._single(t, this.prompt);
    return {
      ok: r.ok,
      ttftMs: r.ttftMs ?? null,
      errorCode: r.errorCode ?? null,
      at: new Date().toISOString(),
    };
  }

  async _phaseRpm(t) {
    const ladder = [];
    let first429Rpm = null;
    for (const qps of RPM_QPS_LADDER) {
      if (this.aborted) break;
      const interval = 1000 / qps;
      let success = 0;
      let total = 0;
      for (let i = 0; i < RPM_SAMPLES; i++) {
        if (this.aborted) break;
        total += 1;
        const r = await this._single(t, this.prompt);
        if (r.ok) success += 1;
        if (!r.ok && (r.errorCode === 'RATE_LIMIT' || r.errorCode === 'QUOTA' || r.errorCode === 'QUOTA_EXCEEDED') && first429Rpm === null) {
          first429Rpm = qps;
        }
        if (i < RPM_SAMPLES - 1) await sleep(interval);
      }
      ladder.push({ qps, success, total });
      if (success < total) break; // 越界即停
    }
    const clean = ladder.filter((s) => s.success === s.total);
    const rpm = {
      lastOkRpm: clean.length ? clean[clean.length - 1].qps : null,
      first429Rpm,
      ladder,
    };
    // rpm.rateLimits 供面板红色判定：lastOkRpm < 0.2 视为弱
    return rpm;
  }

  async _phaseContext(t) {
    const sizes = [];
    for (const tokens of CONTEXT_SIZES) {
      if (this.aborted) break;
      const prompt = 'x'.repeat(Math.max(1, tokens * 4));
      const r = await this._single(t, prompt);
      sizes.push({ tokens, ok: r.ok, errorCode: r.errorCode ?? null });
    }
    const okSizes = sizes.filter((s) => s.ok).map((s) => s.tokens);
    return {
      sizes,
      maxAccepted: okSizes.length ? Math.max(...okSizes) : 0,
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
    if (quotaGroup && this.registry && typeof this.registry.registeredPairs === 'function') {
      const peers = this.registry.registeredPairs().filter((p) => p.quotaGroup === quotaGroup && !(p.provider === t.provider && p.model === t.model));
      for (const peer of peers.slice(0, 3)) {
        if (this.aborted) break;
        const r = await this._single({ provider: peer.provider, model: peer.model }, this.prompt);
        members.push({ provider: peer.provider, model: peer.model, ok: r.ok, errorCode: r.errorCode ?? null });
      }
    }
    return { quotaGroup, members };
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
  const report = await runner.run(targets, { recoveryMs: opts.recoveryMs });
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