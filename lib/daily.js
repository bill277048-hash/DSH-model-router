/**
 * 每日 API 报告（v0.8.0 G1）：日账本 + 日聚合报告 + 每日调度。
 *
 * 数据流：wrapper 每次调用完成时 recordCall（含纯透传，见批 4 接入）→ 账本
 * 追加写当日 NDJSON 文件（文件即持久化账本，重启不丢）→ 每日凌晨 1 点调度
 * 生成「前一日 0:00–23:59」的聚合报告（NDJSON 原始行 + JSON 聚合报告）。
 *
 * 口径（与 quota.record 统一，见计划 §2.8）：token 取 usage 分片同源字段；
 * 面板摘要卡四元组（请求量/延迟/成本/错误率）+ 插件特有项（切换/熔断）在
 * l1Summary 聚合（批 5 面板消费）。
 *
 * 时区：复用 v0.5.0 的 timeZone 字段（null = 系统时区）；日界换算用 Intl 做
 * 确定性换算（与 router.localHHMM 同思路，不依赖 IP 定位）。
 *
 * 持久化位置：复用 store 路径目录（dirname(storePath)/reports/），避免另起
 * 新文件锁；append 追加写（单进程安全），报告文件 temp+rename 原子写。
 */

// v0.9.21：复用 router.localHHMM（消除重复的 Intl 选项实现，钉死 hourCycle 口径）。
// router.js 是零 import 的叶子模块，此处不会成环。
import { localHHMM } from './router.js';
import { mkdirSync, appendFileSync, readFileSync, writeFileSync, renameSync, existsSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

/** 稳定性评级档位（计划 §2.8）：S/A/B/C/D + N/A（样本不足）。 */
export const GRADES = ['S', 'A', 'B', 'C', 'D', 'N/A'];

/**
 * 时区日界：时间戳 → 当地日期 "YYYY-MM-DD"（en-CA locale 即该格式）。
 * timeZone 为 null/undefined 时用系统时区。
 */
export function dayKeyOf(ts, timeZone) {
  const opts = { year: 'numeric', month: '2-digit', day: '2-digit' };
  if (timeZone) opts.timeZone = timeZone;
  return new Intl.DateTimeFormat('en-CA', opts).format(new Date(ts));
}

/**
 * 稳定性评级（确定性规则，单测可断言）：
 * - 样本 < 3 → N/A（不足以评价）；
 * - 失败率 0 → S；<2% → A；<5% → B；<15% → C；其余 → D。
 * 失败 = outcome 'failed'；aborted（用户取消）不计失败。
 */
export function stabilityGrade({ calls, failed }) {
  if (!Number.isFinite(calls) || calls < 3) return 'N/A';
  const failRate = failed / calls;
  if (failRate === 0) return 'S';
  if (failRate < 0.02) return 'A';
  if (failRate < 0.05) return 'B';
  if (failRate < 0.15) return 'C';
  return 'D';
}

/** P95 时延（毫秒）；空样本返回 null。 */
function p95Of(list) {
  if (!list.length) return null;
  const sorted = [...list].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
}

/**
 * 日账本：记录调用 + 追加写当日 NDJSON（文件即持久化账本）。
 * 内存仅缓存当天行（l1 快速统计用）；历史天一律读文件。
 */
export class DailyLedger {
  /**
   * @param {object} opts
   * @param {string} opts.storePath store JSON 路径（报告目录取其 dirname）
   * @param {string|null} [opts.timeZone] IANA 时区（null = 系统）
   * @param {object} [opts.log]
   */
  constructor(opts) {
    const { storePath, timeZone = null, log = {}, reportDir } = opts || {};
    this.log = log;
    this.timeZone = timeZone ?? null;
    // v0.9.4 UX 清理：默认报告目录从 `~/.deepseek-harness/home/reports/`（深、不可达）
    // 改为 `~/Documents/dsh-model-router-reports/`——macOS 访达「前往 → 文档」即可达。
    // 若调用方显式传入 opts.reportDir（patch / store 里设了 reports.dir），优先沿用。
    this.reportDir = reportDir || join(homedir(), 'Documents', 'dsh-model-router-reports');
    this.currentDay = null;
    this.records = []; // 当天内存镜像
    // v0.9.3 P1-4：异步批量写——缓冲当日 NDJSON 行，按 5s / 100 条双触发 flush，
    // 进程退出同步兜底；消除 recordCall 同步 appendFileSync 阻塞 wrapper 主循环。
    this._flushIntervalMs = 5000;
    this._flushBatchSize = 100;
    this._buffer = new Map(); // day → 待追加 NDJSON 行
    this._flushing = false;
    mkdirSync(this.reportDir, { recursive: true });
    this._flushTimer = setInterval(() => {
      Promise.resolve().then(() => this._flush()).catch(() => {});
    }, this._flushIntervalMs);
    // 后台兜底 flush 计时器不阻塞进程退出（宿主 dsh 长驻保活；
    // 单测可自然退出，无需逐实例 dispose）。
    this._flushTimer.unref?.();
    this._onExit = () => { try { this._flushSync(); } catch { /* ignore */ } };
    process.once('exit', this._onExit);
  }

  _fileOf(day) {
    return join(this.reportDir, `${day}.ndjson`);
  }

  _roll(day) {
    if (this.currentDay !== day) {
      this.currentDay = day;
      this.records = [];
    }
  }

  /**
   * 记录一次调用。入参字段：
   * { provider, model, outcome:'committed'|'failed'|'aborted'|'passthrough',
   *   inSequence:boolean, attempts:number, switched:boolean,
   *   errorCode?:string, ttftMs?:number, e2eMs:number,
   *   tokens?:{inputTokens?,outputTokens?,totalTokens?},
   *   sessionId?:string, ts?:number }
   * 记账失败不影响主流程（best-effort append）。
   */
  recordCall(rec) {
    const ts = Number.isFinite(rec.ts) ? rec.ts : Date.now();
    const day = dayKeyOf(ts, this.timeZone);
    this._roll(day);
    this.records.push(rec);
    this._bumpRecordVersion();
    const line = JSON.stringify({ day, ts, ...rec });
    let buf = this._buffer.get(day);
    if (!buf) { buf = []; this._buffer.set(day, buf); }
    buf.push(line);
    if (buf.length >= this._flushBatchSize) {
      // 异步落盘，不阻塞调用方（P1-4：消除同步 IO）
      Promise.resolve().then(() => this._flush()).catch(() => {});
    }
  }

  /** 异步 flush：把缓冲 NDJSON 行 append 到对应日文件；失败仅 warn，不阻塞主流程。 */
  async _flush() {
    if (this._flushing) return;
    this._flushing = true;
    try {
      for (const [day, lines] of this._buffer.entries()) {
        if (lines.length === 0) continue;
        try {
          appendFileSync(this._fileOf(day), lines.join('\n') + '\n', 'utf8');
          this._buffer.set(day, []);
        } catch (error) {
          this.log.warn?.(`daily flush ${day} failed: ${error?.message ?? error}`);
        }
      }
    } finally {
      this._flushing = false;
    }
  }

  /** 同步 flush（进程退出 / dispose 兜底）。 */
  _flushSync() {
    for (const [day, lines] of this._buffer.entries()) {
      if (lines.length === 0) continue;
      try { appendFileSync(this._fileOf(day), lines.join('\n') + '\n', 'utf8'); }
      catch (error) { this.log.warn?.(`daily flushSync ${day} failed: ${error?.message ?? error}`); }
      this._buffer.set(day, []);
    }
  }

  /** 释放定时器并同步落盘剩余（dsh 插件清理路径调用）。 */
  dispose() {
    if (this._flushTimer) { clearInterval(this._flushTimer); this._flushTimer = null; }
    try { this._flushSync(); } catch { /* ignore */ }
    process.removeListener('exit', this._onExit);
  }

  /**
   * 读取某日全部记录（NDJSON 逐行解析，坏行跳过）+ 合并内存中未 flush 的当日记录。
   * v0.9.4：内存合并——v0.9.3 P1-4 引入 5s/100 条异步批量写后，report/查询场景可能命中
   * 「buffer 里有 records 但磁盘还没 flush」的窗口；readDayRecords 此前只读磁盘，
   * 导致「/reports?day=<今日>」与「/reports/generate」返回 no-data。改为以内存为权威、
   * 磁盘 NDJSON 为追加事实：内存中 _buffer[day] 已有 + 已 flush 行去重合并。
   * @returns {object[]}
   */
  readDayRecords(day) {
    const out = [];
    const seen = new Set();
    // 1) 内存 buffer 未 flush 行（v0.9.4 新增；权威优先——recordCall 刚 push 的最新记录在这里）
    const buf = this._buffer?.get(day);
    if (Array.isArray(buf)) {
      for (const line of buf) {
        if (!line) continue;
        try {
          const rec = JSON.parse(line);
          out.push(rec);
          seen.add(rec);
        } catch {
          // 坏行跳过
        }
      }
    }
    // 2) 已 flush 到磁盘的 NDJSON 行（去重——同一记录可能在 buffer 与磁盘中都存在；
    //    内存 records 引用相等性保证；非同日记录不在 seen 中不会被错算）
    const file = this._fileOf(day);
    if (existsSync(file)) {
      try {
        const text = readFileSync(file, 'utf8');
        for (const line of text.split('\n')) {
          if (!line) continue;
          try {
            const rec = JSON.parse(line);
            if (!seen.has(rec)) out.push(rec);
          } catch {
            // 坏行跳过（追加写被截断等极端情况）
          }
        }
      } catch (error) {
        this.log.warn?.(`daily read ${day} failed: ${error?.message ?? error}`);
      }
    }
    return out;
  }

  hasData(day) {
    return this.readDayRecords(day).length > 0;
  }

  /** 某日报告文件是否已生成（v0.9.5：磁盘只有 .md，不再判 .json）。 */
  hasReport(day) {
    return existsSync(join(this.reportDir, `${day}.report.md`));
  }

  /**
   * v0.9.5：当日内存聚合缓存（按日 + 记账版本号失效）。
   * 5s 轮询 l1Summary 场景：当日 records 通常几十~几百条，NDJSON 扫描毫秒级，但加缓存更稳妥。
   * 跨轮询复用上次聚合结果，仅在收到新记账事件或跨日后失效重算。
   * @returns {{ day: string, version: number, aggregate: object }}
   */
  _aggCacheOf(day) {
    if (!this._aggCache) this._aggCache = new Map();
    let e = this._aggCache.get(day);
    const ver = this._recordVersion ?? 0;
    if (!e || e.version !== ver) {
      const records = this.readDayRecords(day);
      let agg = null;
      if (records.length) {
        if (typeof this._aggregateFn === 'function') {
          agg = this._aggregateFn(records);
        } else {
          // 未注入聚合函数（单测 / 装配前）：仅保留 records，让 l1Summary 兜底路径走
          agg = { records, _noAggregator: true };
        }
      }
      e = { day, version: ver, aggregate: agg };
      this._aggCache.set(day, e);
    }
    return e;
  }

  /** 由 DailyReporter 注入：纯聚合函数；避免循环依赖。 */
  setAggregator(fn) {
    this._aggregateFn = fn;
  }

  /** 内部版本号：每次 recordCall 自增；让 _aggCacheOf 感知"数据变了"。 */
  _bumpRecordVersion() {
    if (!Number.isFinite(this._recordVersion)) this._recordVersion = 0;
    this._recordVersion += 1;
  }

  /** 当日内存快速统计（l1 概览用；返回轻量对象，不读文件）。 */
  todaySnapshot() {
    const today = this.currentDay ?? dayKeyOf(Date.now(), this.timeZone);
    const records = this.records;
    const calls = records.length;
    const failed = records.filter((r) => r.outcome === 'failed').length;
    const switched = records.filter((r) => r.switched === true).length;
    const tokens = records.reduce(
      (acc, r) => {
        const t = r.tokens;
        if (!t) return acc;
        acc.in += Number(t.inputTokens) || 0;
        acc.out += Number(t.outputTokens) || 0;
        acc.total += Number(t.totalTokens) || 0;
        return acc;
      },
      { in: 0, out: 0, total: 0 },
    );
    return { day: today, calls, failed, switched, tokens };
  }
}

/**
 * 日聚合器：把某日记录聚合成「按 provider×model」统计 + 汇总。
 * 口径参照开源实现（§2.9 借鉴点 2）：按日 bucket、按供应商×模型聚合。
 */
export class DailyReporter {
  /**
   * @param {object} opts
   * @param {DailyLedger} opts.ledger
   * @param {object} [opts.log]
   */
  constructor({ ledger, log = {} }) {
    this.ledger = ledger;
    this.log = log;
  }

  /**
   * 聚合某日记录（纯函数，供单测直调）。
   * @param {object[]} records
   * @returns {{summary: object, byProviderModel: object[], errors: object[]}}
   */
  aggregate(records) {
    const groups = new Map();
    const errorCounts = new Map();
    let calls = 0;
    let failed = 0;
    let aborted = 0;
    let switchedCalls = 0;
    let switchCount = 0;
    let inSeqCalls = 0;
    for (const r of records) {
      calls += 1;
      const isFailed = r.outcome === 'failed';
      const isAborted = r.outcome === 'aborted';
      if (isFailed) failed += 1;
      if (isAborted) aborted += 1;
      if (r.switched === true) switchedCalls += 1;
      if (Number.isFinite(r.attempts) && r.attempts > 1) switchCount += r.attempts - 1;
      if (r.inSequence === true) inSeqCalls += 1;
      if (r.errorCode) errorCounts.set(r.errorCode, (errorCounts.get(r.errorCode) ?? 0) + 1);

      const key = `${r.provider}/${r.model}`;
      let g = groups.get(key);
      if (!g) {
        g = {
          provider: r.provider,
          model: r.model,
          calls: 0,
          failed: 0,
          aborted: 0,
          switchedCalls: 0,
          ttftList: [],
          e2eSum: 0,
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          topErrors: new Map(),
        };
        groups.set(key, g);
      }
      g.calls += 1;
      if (isFailed) g.failed += 1;
      if (isAborted) g.aborted += 1;
      if (r.switched === true) g.switchedCalls += 1;
      if (Number.isFinite(r.ttftMs)) g.ttftList.push(r.ttftMs);
      g.e2eSum += Number.isFinite(r.e2eMs) ? r.e2eMs : 0;
      const t = r.tokens;
      if (t) {
        g.inputTokens += Number(t.inputTokens) || 0;
        g.outputTokens += Number(t.outputTokens) || 0;
        g.totalTokens += Number(t.totalTokens) || 0;
      }
      if (r.errorCode) g.topErrors.set(r.errorCode, (g.topErrors.get(r.errorCode) ?? 0) + 1);
    }

    const byProviderModel = [...groups.values()].map((g) => {
      const failRate = g.calls > 0 ? g.failed / g.calls : 0;
      const topErrors = [...g.topErrors.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([code, count]) => ({ code, count }));
      return {
        provider: g.provider,
        model: g.model,
        calls: g.calls,
        succeeded: g.calls - g.failed - g.aborted,
        failed: g.failed,
        aborted: g.aborted,
        failRate,
        avgTtftMs: g.ttftList.length ? Math.round(g.ttftList.reduce((a, b) => a + b, 0) / g.ttftList.length) : null,
        p95TtftMs: p95Of(g.ttftList),
        avgE2eMs: g.calls > 0 ? Math.round(g.e2eSum / g.calls) : null,
        inputTokens: g.inputTokens,
        outputTokens: g.outputTokens,
        totalTokens: g.totalTokens,
        switchedCalls: g.switchedCalls,
        grade: stabilityGrade({ calls: g.calls, failed: g.failed }),
        topErrors,
      };
    });

    const errors = [...errorCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([code, count]) => ({ code, count }));

    return {
      summary: {
        calls,
        succeeded: calls - failed - aborted,
        failed,
        aborted,
        inSequenceCalls: inSeqCalls,
        switchedCalls,
        switchCount,
      },
      byProviderModel,
      errors,
    };
  }

  /**
   * 生成某日聚合报告（v0.9.5）。
   * - 始终重新聚合 records（**不早返**：避免「手动立即生成」在 md 已存在时跳过重写导致磁盘与 API 不一致）。
   * - 并发去重：临时文件名 = `${day}.report.md.tmp-${Date.now()}-${rand}`，保证并发唯一，renameSync 原子覆盖（后写者胜）。
   * - 写盘失败抛错（v0.9.4 修复"假成功"问题，行为延续）。
   * - 写目标 = `${day}.report.md`（v0.9.5：磁盘不再保留 .json）。
   * - 返回结构化 report 对象（供 API 返回，与磁盘解耦）。
   */
  generate(day) {
    const records = this.ledger.readDayRecords(day);
    const { summary, byProviderModel, errors } = this.aggregate(records);
    const generatedAt = new Date().toISOString();
    const report = {
      ok: true,
      day,
      generatedAt,
      summary,
      byProviderModel,
      errors,
    };
    const markdown = formatReportMarkdown(report, { timeZone: this.ledger.timeZone ?? null });
    const target = join(this.ledger.reportDir, `${day}.report.md`);
    const rand = Math.random().toString(36).slice(2, 8);
    const tmp = `${target}.tmp-${Date.now()}-${rand}`;
    try {
      writeFileSync(tmp, markdown, { encoding: 'utf8', flag: 'wx' });
      renameSync(tmp, target);
    } catch (error) {
      this.log.error?.(`daily report write ${day} failed: ${error?.message ?? error}`);
      try {
        unlinkSync(tmp);
      } catch {
        // ignore
      }
      // v0.9.4 修复保留：throw 而非吞错
      const wrapped = new Error(`daily report write ${day} failed: ${error?.message ?? error}`);
      wrapped.cause = error;
      throw wrapped;
    }
    return report;
  }

  /**
   * 读取报告（v0.9.5 语义钉死）。
   * - 结构化数据一律实时聚合当日 NDJSON（不解析 md 内容，md 仅供人类阅读）。
   * - `generated / generatedAt` 由 md 文件存在性与首行注释决定：
   *   - md 存在 → generated=true，generatedAt 从首行 `<!-- generated by dsh-model-router v0.9.5 @<ISO8601> -->`
   *     内嵌时间戳解析；md 首行无注释/解析失败 → generatedAt=null。
   *   - md 不存在 → generated=false，generatedAt=null。
   * - 返回 `{ generated, generatedAt, report }`；当日 records 为空时 report=null。
   */
  readReport(day) {
    const target = join(this.ledger.reportDir, `${day}.report.md`);
    let generated = false;
    let generatedAt = null;
    if (existsSync(target)) {
      generated = true;
      try {
        const head = readFileSync(target, 'utf8').split('\n', 1)[0] ?? '';
        const m = head.match(/@(\S+?)\s*-->/);
        if (m && m[1]) {
          const ts = new Date(m[1]).getTime();
          if (Number.isFinite(ts)) generatedAt = new Date(ts).toISOString();
        }
      } catch {
        // 首行读取失败不影响 generated=true 标记
      }
    }
    const records = this.ledger.readDayRecords(day);
    const report = records.length ? this.aggregate(records) : null;
    return { generated, generatedAt, report };
  }

  /**
   * 概览摘要（v0.9.5 适配）：
   * - 历史日（i >= 1）：readReport 返 `{generated, generatedAt, report}`；
   *   report 非空时透传其 summary 字段（**当日内存聚合缓存兜底**：同日重复轮询复用上次结果）。
   * - 当日：l1 5s 轮询直走 ledger 内存聚合缓存，避免频繁磁盘读。
   */
  l1Summary(days = 7, now = Date.now()) {
    const today = dayKeyOf(now, this.ledger.timeZone);
    const out = [];
    for (let i = days - 1; i >= 1; i--) {
      const d = new Date(now - i * 86400_000);
      const day = dayKeyOf(d.getTime(), this.ledger.timeZone);
      // 历史日一律实时聚合（磁盘 NDJSON 一次性扫描，开销毫秒级）。
      const recs = this.ledger.readDayRecords(day);
      if (recs.length) {
        out.push({ day, summary: this.aggregate(recs).summary });
      }
    }
    // 当日用缓存；records 为空时今日 summary 也返 null
    const todayCache = this.ledger._aggCacheOf(today);
    const todaySnapshot = this.ledger.todaySnapshot();
    let todaySummary = null;
    if (todayCache.aggregate) {
      if (todayCache.aggregate._noAggregator) {
        // 兜底：未注入聚合函数时退到 todaySnapshot（仅 token/calls/failed/switched 轻量统计）
        todaySummary = null;
      } else {
        todaySummary = todayCache.aggregate.summary;
      }
    }
    const todayOut = {
      day: today,
      summary: todaySummary,
      generated: !!this.ledger.hasReport(today),
      generatedAt: this._readGeneratedAt(today),
      ...todaySnapshot,
    };
    return { days: out, today: todayOut };
  }

  /** 解析 md 首行注释的 generatedAt（独立函数，便于复用与单测）。 */
  _readGeneratedAt(day) {
    const target = join(this.ledger.reportDir, `${day}.report.md`);
    if (!existsSync(target)) return null;
    try {
      const head = readFileSync(target, 'utf8').split('\n', 1)[0] ?? '';
      const m = head.match(/@(\S+?)\s*-->/);
      if (m && m[1]) {
        const ts = new Date(m[1]).getTime();
        if (Number.isFinite(ts)) return new Date(ts).toISOString();
      }
    } catch {
      /* ignore */
    }
    return null;
  }
}

/**
 * 渲染 Markdown 报告（v0.9.5）：纯函数，单测可断言。
 * @param {object} report DailyReporter.aggregate 的输出 + day/ok 字段
 * @param {object} [opts] { timeZone?: string|null }
 * @returns {string} md 文本（首行 = `<!-- generated by dsh-model-router v0.9.5 @<ISO8601> -->`）
 */
export function formatReportMarkdown(report, opts = {}) {
  const tz = opts.timeZone ?? null;
  const day = report.day;
  const generatedAt = report.generatedAt ?? new Date().toISOString();
  const tzLabel = tz || '系统时区';
  const s = report.summary ?? {};
  const rows = Array.isArray(report.byProviderModel) ? report.byProviderModel : [];
  const errors = Array.isArray(report.errors) ? report.errors : [];

  const header = `<!-- generated by dsh-model-router v0.9.5 @${generatedAt} -->`;
  const lines = [];
  lines.push(header);
  lines.push('');
  lines.push(`# ${day} 每日报告`);
  lines.push('');
  lines.push(`- 生成时刻：${generatedAt}`);
  lines.push(`- 评级档位：S/A/B/C/D + N/A（样本不足）`);
  lines.push(`- 时区：${tzLabel}`);
  lines.push('');
  lines.push('## 汇总');
  lines.push('');
  lines.push('| 项 | 值 |');
  lines.push('|---|---:|');
  lines.push(`| 总调用 | ${s.calls ?? 0} |`);
  lines.push(`| 成功 | ${s.succeeded ?? 0} |`);
  lines.push(`| 失败 | ${s.failed ?? 0} |`);
  lines.push(`| 中止 | ${s.aborted ?? 0} |`);
  lines.push(`| 链内调用 | ${s.inSequenceCalls ?? 0} |`);
  lines.push(`| 切换调用 | ${s.switchedCalls ?? 0} |`);
  lines.push(`| 切换次数 | ${s.switchCount ?? 0} |`);
  lines.push('');
  lines.push('## 按 provider × model');
  lines.push('');
  if (rows.length === 0) {
    lines.push('（无）');
  } else {
    lines.push('| 供应商 | 模型 | 调用 | 成功率 | 平均 E2E | P95 TTFT | 输入 token | 输出 token | 评级 |');
    lines.push('|---|---|---:|---:|---:|---:|---:|---:|:-:|');
    for (const r of rows) {
      const success = r.calls > 0 ? ((r.succeeded / r.calls) * 100).toFixed(1) + '%' : '-';
      lines.push(
        `| ${r.provider} | ${r.model} | ${r.calls} | ${success} | ${r.avgE2eMs ?? '-'}ms | ${r.p95TtftMs ?? '-'}ms | ${r.inputTokens ?? 0} | ${r.outputTokens ?? 0} | **${r.grade ?? 'N/A'}** |`,
      );
    }
  }
  lines.push('');
  lines.push('## 错误（Top）');
  lines.push('');
  if (errors.length === 0) {
    lines.push('（无）');
  } else {
    for (const e of errors) {
      lines.push(`- \`${e.code}\` × ${e.count}`);
    }
  }
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('<!-- appendix: generated by dsh-model-router v0.9.5; parameters: prompt=default, timeoutMs=default, windows=r5h/r1w, timeZone=' + tzLabel + ' -->');
  lines.push('');
  return lines.join('\n');
}

/**
 * 每日调度：凌晨 1 点后生成「昨日」报告；启动即检查补生成。
 * 沿用 index.js 的 setInterval 风格（v1.3 修正：不引入 ctx.interval 新 API）。
 */
export class DailyScheduler {
  /**
   * @param {object} opts
   * @param {DailyLedger} opts.ledger
   * @param {DailyReporter} opts.reporter
   * @param {string|null} [opts.timeZone]
   * @param {object} [opts.log]
   * @param {number} [opts.intervalMs] 检查周期（默认 60s）
   * @param {string} [opts.hour="01:00"] 生成时刻（当地 HH:MM）
   * @param {() => Date} [opts.now] 时钟注入（单测用）
   */
  constructor({ ledger, reporter, timeZone = null, log = {}, intervalMs = 60_000, hour = '01:00', now = () => new Date() }) {
    this.ledger = ledger;
    this.reporter = reporter;
    this.timeZone = timeZone ?? null;
    this.log = log;
    this.intervalMs = intervalMs;
    this.hour = hour;
    this._now = now;
    this.timer = null;
    this.lastGenerated = null; // 最近一次成功生成的日（防重复生成）
  }

  /**
   * 当地 HH:MM。
   *
   * v0.9.21：改为**委托** `router.localHHMM`（此前是同一份 Intl 选项的重复实现）。
   * 去重的原因不只是「少写几行」——`tick()` 里 `hhmm < this.hour` 依赖 "HH:MM"
   * 零填充有序，而 `hourCycle` 口径一旦两处漂移，就会出现「调度用了 h24、
   * 路由用了 h23」这类极难排查的边界 bug。单一实现即单一口径。
   */
  _localHHMM(now) {
    return localHHMM(this.timeZone, now);
  }

  /** 前一日（跨月/跨年由 Date 处理）。 */
  _yesterdayOf(today, now) {
    const d = new Date(now.getTime() - 86400_000);
    return dayKeyOf(d.getTime(), this.timeZone);
  }

  tick() {
    const now = this._now();
    const today = dayKeyOf(now.getTime(), this.timeZone);
    const hhmm = this._localHHMM(now);
    if (hhmm < this.hour) return; // 未到生成时刻
    const yesterday = this._yesterdayOf(today, now);
    if (this.lastGenerated === yesterday) return; // 本日已生成
    if (this.ledger.hasReport(yesterday)) {
      this.lastGenerated = yesterday;
      return;
    }
    if (!this.ledger.hasData(yesterday)) {
      this.lastGenerated = yesterday; // 昨日无数据，标记避免每日空扫
      return;
    }
    const report = this.reporter.generate(yesterday);
    this.lastGenerated = yesterday;
    this.log.info?.(`daily report generated: ${yesterday} (calls=${report.summary.calls})`);
  }

  start() {
    if (this.timer) return this;
    this.tick(); // 启动补生成（满足条件即出昨日报告）
    this.timer = setInterval(() => {
      try {
        this.tick();
      } catch (error) {
        this.log.warn?.(`daily scheduler tick failed: ${error?.message ?? error}`);
      }
    }, this.intervalMs);
    return this;
  }

  dispose() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
