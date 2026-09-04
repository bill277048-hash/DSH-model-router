/**
 * 配额记账（v0.1：仅记账与可视，不做路由排除；滚动窗口 + 剩余预算视图 + 强制排除属 P3）。
 *
 * 窗口：滚动 5h（60×5min bucket）+ 滚动 1w（28×6h bucket），按 provider 粒度
 * （v0.1 不分 key/model，够人工观测用）。token 来源：成功 finish 前的 usage 分片。
 */

const BUCKETS_5H = 60; // 60 × 5min = 5h
const BUCKETS_1W = 28; // 28 × 6h = 7d（近似一周）
const BUCKET_MS = 5 * 60 * 1000;
const BUCKET_MS_1W = 6 * 60 * 60 * 1000;

function newRing(n) {
  return Array.from({ length: n }, () => ({ startTs: 0, tokens: 0, calls: 0 }));
}

function recordRing(ring, bucketMs, ts, tokens) {
  const idx = Math.floor(ts / bucketMs) % ring.length;
  const b = ring[idx];
  const bucketStart = Math.floor(ts / bucketMs) * bucketMs;
  if (b.startTs !== bucketStart) {
    b.startTs = bucketStart;
    b.tokens = 0;
    b.calls = 0;
  }
  b.tokens += tokens;
  b.calls += 1;
}

function sumRing(ring, bucketMs, now) {
  let tokens = 0;
  let calls = 0;
  for (const b of ring) {
    if (b.startTs > 0 && now - b.startTs < ring.length * bucketMs) {
      tokens += b.tokens;
      calls += b.calls;
    }
  }
  return { tokens, calls };
}

export class QuotaLedger {
  constructor() {
    /** @type {Map<string, {r5h: object[], r1w: object[]}>} */
    this.ledgers = new Map();
  }

  /** 成功一次调用后记账；usage 分片形如 {inputTokens, outputTokens, ...}（宽松取数）。 */
  record(provider, usage, ts = Date.now()) {
    if (!usage) return;
    const tokens =
      (Number(usage.inputTokens) || 0) +
      (Number(usage.outputTokens) || 0) +
      (Number(usage.cacheReadTokens) || 0) +
      (Number(usage.cacheWriteTokens) || 0) ||
      (Number(usage.totalTokens) || 0);
    if (!Number.isFinite(tokens) || tokens <= 0) return;
    let led = this.ledgers.get(provider);
    if (!led) {
      led = { r5h: newRing(BUCKETS_5H), r1w: newRing(BUCKETS_1W) };
      this.ledgers.set(provider, led);
    }
    recordRing(led.r5h, BUCKET_MS, ts, tokens);
    recordRing(led.r1w, BUCKET_MS_1W, ts, tokens);
  }

  snapshot() {
    const now = Date.now();
    const out = {};
    for (const [provider, led] of this.ledgers.entries()) {
      out[provider] = {
        window5h: sumRing(led.r5h, BUCKET_MS, now),
        window1w: sumRing(led.r1w, BUCKET_MS_1W, now),
      };
    }
    return out;
  }
}
