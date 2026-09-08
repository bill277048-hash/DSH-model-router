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

import { mkdirSync, appendFileSync, readFileSync, writeFileSync, renameSync, existsSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';

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
  constructor({ storePath, timeZone = null, log = {} }) {
    this.log = log;
    this.timeZone = timeZone ?? null;
    this.reportDir = join(dirname(storePath), 'reports');
    this.currentDay = null;
    this.records = []; // 当天内存镜像
    mkdirSync(this.reportDir, { recursive: true });
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
    const line = JSON.stringify({ day, ts, ...rec });
    this.records.push(rec);
    try {
      appendFileSync(this._fileOf(day), line + '\n', 'utf8');
    } catch (error) {
      this.log.warn?.(`daily recordCall append failed: ${error?.message ?? error}`);
    }
  }

  /** 读取某日全部记录（NDJSON 逐行解析，坏行跳过）；无数据返回 []。 */
  readDayRecords(day) {
    const file = this._fileOf(day);
    if (!existsSync(file)) return [];
    try {
      const text = readFileSync(file, 'utf8');
      const out = [];
      for (const line of text.split('\n')) {
        if (!line) continue;
        try {
          out.push(JSON.parse(line));
        } catch {
          // 坏行跳过（追加写被截断等极端情况）
        }
      }
      return out;
    } catch (error) {
      this.log.warn?.(`daily read ${day} failed: ${error?.message ?? error}`);
      return [];
    }
  }

  hasData(day) {
    return this.readDayRecords(day).length > 0;
  }

  /** 某日报告文件是否已生成。 */
  hasReport(day) {
    return existsSync(join(this.reportDir, `${day}.report.json`));
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

  /** 生成某日聚合报告（内存聚合 + 写 <day>.report.json，temp+rename 原子）。 */
  generate(day) {
    const records = this.ledger.readDayRecords(day);
    const { summary, byProviderModel, errors } = this.aggregate(records);
    const report = {
      ok: true,
      day,
      generatedAt: new Date().toISOString(),
      summary,
      byProviderModel,
      errors,
    };
    const target = join(this.ledger.reportDir, `${day}.report.json`);
    const tmp = `${target}.tmp-${process.pid}`;
    try {
      writeFileSync(tmp, JSON.stringify(report, null, 2), { encoding: 'utf8', flag: 'wx' });
      renameSync(tmp, target);
    } catch (error) {
      this.log.error?.(`daily report write ${day} failed: ${error?.message ?? error}`);
      try {
        unlinkSync(tmp);
      } catch {
        // ignore
      }
    }
    return report;
  }

  /** 读取已生成报告；未生成返回 null。 */
  readReport(day) {
    const target = join(this.ledger.reportDir, `${day}.report.json`);
    if (!existsSync(target)) return null;
    try {
      return JSON.parse(readFileSync(target, 'utf8'));
    } catch (error) {
      this.log.warn?.(`daily report read ${day} failed: ${error?.message ?? error}`);
      return null;
    }
  }

  /**
   * 概览摘要（?l1=1 轻量接口与面板概览卡消费）：最近 days 天的每日摘要 +
   * 当日实时快照。字段对齐 G2 摘要卡四元组 + 插件特有项（§2.9 借鉴点 3）。
   */
  l1Summary(days = 7, now = Date.now()) {
    const today = dayKeyOf(now, this.ledger.timeZone);
    const out = [];
    for (let i = days - 1; i >= 1; i--) {
      const d = new Date(now - i * 86400_000);
      const day = dayKeyOf(d.getTime(), this.ledger.timeZone);
      const rep = this.readReport(day);
      if (rep) {
        out.push({ day, summary: rep.summary });
      } else {
        // 无报告但有原始数据（未到生成点/启动补生成前）→ 实时聚合
        const recs = this.ledger.readDayRecords(day);
        if (recs.length) {
          out.push({ day, summary: this.aggregate(recs).summary });
        }
      }
    }
    const todaySnapshot = this.ledger.todaySnapshot();
    return { days: out, today: todaySnapshot };
  }
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

  /** 当地 HH:MM（与 router.localHHMM 同法）。 */
  _localHHMM(now) {
    const opts = { hour: '2-digit', minute: '2-digit', hour12: false };
    if (this.timeZone) opts.timeZone = this.timeZone;
    return new Intl.DateTimeFormat('en-GB', opts).format(now);
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
