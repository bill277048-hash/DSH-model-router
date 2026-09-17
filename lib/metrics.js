/**
 * metrics 内存采样器（v0.1：环形缓冲 + 按 (provider,model) 聚合；SQLite 聚合属 P4）。
 */

const RING_CAPACITY = 200;

export class Metrics {
  constructor() {
    /** @type {object[]} 最近尝试环形缓冲 */
    this.ring = [];
    this.nextSeq = 1;
    /** @type {Map<string, {attempts:number, committed:number, failed:number, aborted:number, failovers:number, ttftSumMs:number, ttftN:number, e2eSumMs:number, e2eN:number, lastError?:string}>} */
    this.aggregates = new Map();
    /**
     * 捕捉到的会话（v0.4.2）：key=sessionId，value=最近出现时间戳。
     * Map 迭代序 = 插入序；noteSession 用 delete+set 把最近会话移到末尾，
     * snapshot 反转即得「新→旧」。包装层在透传路径也调用，保证每次对话都被捕捉。
     * @type {Map<string, number>}
     */
    this.sessions = new Map();
  }

  /**
   * 记录一次会话出现（新→旧去重，上限 30，超出丢最旧）。
   * 透传与故障切换路径都会调用——否则无候选链的纯透传对话永远不会进会话列表。
   */
  noteSession(sessionId) {
    if (typeof sessionId !== 'string' || !sessionId) return;
    this.sessions.delete(sessionId);
    this.sessions.set(sessionId, Date.now());
    if (this.sessions.size > 30) {
      const oldest = this.sessions.keys().next().value;
      this.sessions.delete(oldest);
    }
  }

  /** @private */
  aggregateOf(provider, model) {
    const key = `${provider}/${model}`;
    let a = this.aggregates.get(key);
    if (!a) {
      a = {
        attempts: 0,
        committed: 0,
        failed: 0,
        aborted: 0,
        failovers: 0,
        ttftSumMs: 0,
        ttftN: 0,
        e2eSumMs: 0,
        e2eN: 0,
        // v0.9.10 Task 3b：token 用量累计（驱动 TPM 节流与 observed.estimatedTpm）
        tokensSum: 0,
        tokensN: 0,
      };
      this.aggregates.set(key, a);
    }
    return a;
  }

  /**
   * 记录一次尝试。
   * @param {object} s {provider, model, attemptIndex, outcome, ttftMs?, e2eMs?, errorCode?, failover?}
   */
  sample(s) {
    this.noteSession(s.sessionId);
    const rec = {
      seq: this.nextSeq++,
      ts: new Date().toISOString(),
      provider: s.provider,
      model: s.model,
      attemptIndex: s.attemptIndex,
      outcome: s.outcome,
      ttftMs: s.ttftMs,
      e2eMs: s.e2eMs,
      errorCode: s.errorCode,
      sessionId: typeof s.sessionId === 'string' ? s.sessionId : undefined,
      // v0.9.8：切换明细需要的字段。seqId/prev* 只在 wrapper 采样路径提供；
      // 旧 caller 不传时保持 undefined/null，签名向后兼容。
      seqId: typeof s.seqId === 'string' ? s.seqId : undefined,
      prevProvider: typeof s.prevProvider === 'string' ? s.prevProvider : null,
      prevModel: typeof s.prevModel === 'string' ? s.prevModel : null,
      switched: s.switched === true,
      // v0.9.9：所属段（peak/valley），由 wrapper 写入；未启用/缺字段为 null。
      // 切换明细每行标注段，面板即可显示「当前峰段 · 绑定 X」。
      segment: s.segment === 'peak' || s.segment === 'valley' ? s.segment : null,
      // v0.9.10 Task 3b：token 用量（仅 committed 路径通常有 usage；**原样保留**——消费端判断）
      // 接受 number / null / undefined / 字符串（原样落 ring，便于面板/调试；聚合时拒非数字）
      tokens: s.tokens,
    };
    this.ring.push(rec);
    if (this.ring.length > RING_CAPACITY) this.ring.shift();

    const a = this.aggregateOf(s.provider, s.model);
    a.attempts += 1;
    if (s.outcome === 'committed') a.committed += 1;
    else if (s.outcome === 'failed') a.failed += 1;
    else if (s.outcome === 'aborted') a.aborted += 1;
    if (s.failover) a.failovers += 1;
    if (typeof s.ttftMs === 'number') {
      a.ttftSumMs += s.ttftMs;
      a.ttftN += 1;
    }
    if (typeof s.e2eMs === 'number') {
      a.e2eSumMs += s.e2eMs;
      a.e2eN += 1;
    }
    if (s.errorCode) a.lastError = s.errorCode;
    // v0.9.10 Task 3b：累计 token 用量（驱动 observed.estimatedTpm 与 TPM 节流）
    if (Number.isFinite(s.tokens) && s.tokens >= 0) {
      a.tokensSum += s.tokens;
      a.tokensN += 1;
    }
  }

  /**
   * v0.9.10 Task 3b：查询近 N ms 内某 provider 的 token 总用量。
   * 供后续 Task（路由 TPM 节流、冲突呈现 observed.estimatedTpm）使用。
   *
   * @param {string} provider provider id
   * @param {number} [windowMs=60_000] 滑动窗口毫秒（与 Task 2 RPM 一致）
   * @param {Date|number} [now=new Date()] 基准时刻（单测注入）
   * @returns {number} token 总数（>=0；无采样或全部窗口外 → 0）
   */
  recentTokenSum(provider, windowMs = 60_000, now = new Date()) {
    if (!this.ring.length || typeof provider !== 'string' || !provider) return 0;
    const nowMs = now instanceof Date ? now.getTime() : now;
    let total = 0;
    for (const r of this.ring) {
      if (r.provider !== provider) continue;
      if (!Number.isFinite(r.tokens)) continue;
      const t = Date.parse(r.ts);
      // 用 >= 而非 >：让 windowMs=0 真正排除全部（避免边界 case）
      if (!Number.isFinite(t) || nowMs - t >= windowMs) continue;
      total += r.tokens;
    }
    return total;
  }

  /**
   * v0.9.10 Task 3c：从 ring **实时计算**某 provider 的 observed 快照。
   *
   * **不持久化**（与 D8「conflicts 实时计算」一致）：observed 只是「最近观测」的
   * 只读投影，重启后由新采样自然重建；持久化会引入 store 白名单 + 回放冲突等复杂度，
   * 且与 OQ1「声明优先、实测仅提示」的定位不符。
   *
   * @param {string} provider provider id
   * @param {number} [windowMs=60_000] 滑动窗口毫秒
   * @param {Date|number} [now=new Date()] 基准时刻（单测注入）
   * @returns {object|null} observed 快照；窗口内无采样 → null（区别于「全 0」）
   */
  observedOf(provider, windowMs = 60_000, now = new Date()) {
    if (!this.ring.length || typeof provider !== 'string' || !provider) return null;
    const nowMs = now instanceof Date ? now.getTime() : now;
    let sampleSize = 0;
    let tokensSum = 0;
    let tokensN = 0;
    let lastTs = null;
    const counts = { rateLimited429Count: 0, quotaExhausted429Count: 0, accountTpm429Count: 0 };
    for (const r of this.ring) {
      if (r.provider !== provider) continue;
      const t = Date.parse(r.ts);
      if (!Number.isFinite(t) || nowMs - t >= windowMs) continue;
      sampleSize += 1;
      if (lastTs === null || r.ts > lastTs) lastTs = r.ts;
      // 三类 429 计数（errorCode 已由 wrapper.classifyBurnError 细分）
      if (r.errorCode === 'RATE_LIMITED') counts.rateLimited429Count += 1;
      else if (r.errorCode === 'QUOTA_EXHAUSTED') counts.quotaExhausted429Count += 1;
      else if (r.errorCode === 'ACCOUNT_TPM_LIMITED') counts.accountTpm429Count += 1;
      if (Number.isFinite(r.tokens) && r.tokens >= 0) {
        tokensSum += r.tokens;
        tokensN += 1;
      }
    }
    if (sampleSize === 0) return null;
    const out = {
      lastUpdatedAt: lastTs ?? new Date(nowMs).toISOString(),
      ...counts,
      sampleSize,
    };
    // 折算为「每分钟」速率（窗口可为任意长度）
    const minutes = windowMs / 60_000;
    if (minutes > 0) {
      out.estimatedRpm = Math.round(sampleSize / minutes);
      if (tokensN > 0) out.estimatedTpm = Math.round(tokensSum / minutes);
    }
    return out;
  }

  snapshot() {
    const recent = [...this.ring];
    // 最近活跃会话（新→旧去重，供面板「指定会话」作用域点选）：优先用会话表
    //（含透传捕捉）；表为空时回退环形缓冲推导（兼容旧数据）
    let sessionIds = [...this.sessions.keys()].reverse().slice(0, 10);
    // v0.5.1：附带最近活跃时间戳，供面板显示标题 + 活跃时间
    let sessions = [...this.sessions.entries()]
      .reverse()
      .slice(0, 10)
      .map(([id, ts]) => ({ id, ts }));
    if (sessionIds.length === 0) {
      sessionIds = [];
      for (let i = recent.length - 1; i >= 0 && sessionIds.length < 10; i--) {
        const sid = recent[i].sessionId;
        if (sid && !sessionIds.includes(sid)) {
          sessionIds.push(sid);
          sessions.push({ id: sid });
        }
      }
    }
    const byRoute = {};
    for (const [key, a] of this.aggregates.entries()) {
      byRoute[key] = {
        attempts: a.attempts,
        committed: a.committed,
        failed: a.failed,
        aborted: a.aborted,
        failovers: a.failovers,
        avgTtftMs: a.ttftN ? Math.round(a.ttftSumMs / a.ttftN) : undefined,
        avgE2eMs: a.e2eN ? Math.round(a.e2eSumMs / a.e2eN) : undefined,
        lastError: a.lastError,
      };
    }
    // v0.9.21 修复：返回完整 ring（ring 上限 200 = 5s 轮询 × 2min 缓冲，
    // 面板 5s 轮询拉一次最坏 200 条 = ~2KB/s 传输，远低于任何阈值）。
    //
    // 此前 `recent.slice(-50)` 在「单 provider 60s 内 >50 次」场景下会**静默截断**：
    // 数据从 50→100 仍返回 50 → 上层 RPM/TPM 节流判定数值偏低，
    // 可能在确实超限的情况下「未触发节流」（**功能失效**，非性能问题）。
    //
    // v0.9.18 引入节流后这条数据源被强依赖——v0.9.18/19 实现的 6 条单测都是
    // 「显式构造 metrics.snapshot 模拟」，未触碰 ring/snapshot 的真实差异。
    // v0.9.21 实机观察期项目 (b) 跑 60 次/30s 复现：路由层只看到 50 → 未触发节流。
    //
    // 保留 cap 由 ring.length>RING_CAPACITY 时的 shift 控制（环形），snapshot
    // 这里只是透传；如未来需要面板限速，可加 `recentForPanel` 子集。
    return { recent, byRoute, sessionIds, sessions };
  }
}
