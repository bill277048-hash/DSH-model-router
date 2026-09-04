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
    return { recent: recent.slice(-50), byRoute, sessionIds, sessions };
  }
}
