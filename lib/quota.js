/**
 * 配额记账（v0.1 速率环 + v0.9.5 §11 窗口上限仓）。
 *
 * 双机制并行、职责独立（§11.1 关键，避免 double-count）：
 * - **速率环**（QuotaLedger）：滚动 5h（60×5min bucket）+ 滚动 1w（28×6h bucket），
 *   按 provider 粒度记 token/calls，`snapshot()` 返回实际消耗速率（概览展示）。
 * - **上限仓**（WindowLedger）：配额窗口（5h / 1周 / 自定义）的 limit/used/resetAt，
 *   `consumeAttempt` 在 wrapper 入口前置拦截、`markBurnedOut` 在上游 429/QUOTA 时
 *   保守置满、`markReset` 人工/自动重置。记录 token 时只进速率环；上限仓 used 不走
 *   record() 累加（避免与速率环双记），由 markBurnedOut + 滑窗自动清零维护。
 */

import { readFileSync, writeFileSync, renameSync, mkdirSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';

const BUCKETS_5H = 60; // 60 × 5min = 5h
const BUCKETS_1W = 28; // 28 × 6h = 7d（近似一周）
const BUCKET_MS = 5 * 60 * 1000;
const BUCKET_MS_1W = 6 * 60 * 60 * 1000;

const WINDOW_5H_MS = 5 * 3600 * 1000;
const WINDOW_1W_MS = 7 * 86400 * 1000;
const FLUSH_MS = 30_000; // 周期落盘（index.js setInterval 同步用）

/** 判定「是哪个窗口耗尽」的错误码映射（§11.3，集中在此便于调优）。 */
export function deriveWindowId(code) {
  const s = String(code || '').toUpperCase();
  if (s.includes('WEEK') || s.includes('MONTHLY')) return 'weekly';
  if (s.includes('QUOTA') || s.includes('RATE') || s.includes('LIMIT') || s.includes('429')) return 'five-hour';
  return 'five-hour';
}

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

/**
 * §11 上限仓：配额窗口（5h / 1周 / 自定义）。
 *
 * 静态声明（limit/windowMs/初始 resetAt）来自 providerMeta（store.json）或 hop 内联，
 * 由 consumeAttempt/syncWindows 首次触碰时初始化；动态态（used/resetAt 经过滑窗后
 * 的当前值）独立持久化到 quota-state.json（与配置态两层分离，§11.2-2）。
 */
export class WindowLedger {
  constructor(opts = {}) {
    this.log = opts.log;
    this.storePath = opts.storePath || null;
    /** @type {Map<string, object>} provider -> { fiveHour, weekly, custom } */
    this.windows = new Map();
    /** @type {Map<string, object>} 已加载的动态态（used/resetAt），_assure 时覆盖。 */
    this.loaded = new Map();
  }

  /** 确保 provider 入口存在并依据 meta 补齐窗口声明；随后滑窗（自然过期 → 清零）。 */
  _assure(provider, meta) {
    let e = this.windows.get(provider);
    if (!e) {
      e = { fiveHour: null, weekly: null, custom: [] };
      this.windows.set(provider, e);
    }
    const qw = meta && meta.quotaWindows;
    const cw = meta && meta.customWindows;
    if (qw) {
      if (qw.fiveHour) {
        e.fiveHour = e.fiveHour || {
          id: 'five-hour',
          windowMs: WINDOW_5H_MS,
          limit: undefined,
          used: 0,
          resetAt: null,
        };
        if (e.fiveHour.limit === undefined && qw.fiveHour.limit !== undefined) e.fiveHour.limit = qw.fiveHour.limit;
        if (qw.fiveHour.used !== undefined && !this.loadedHas(provider, 'fiveHour', 'used')) e.fiveHour.used = qw.fiveHour.used;
        if (qw.fiveHour.resetAt !== undefined && !this.loadedHas(provider, 'fiveHour', 'resetAt')) e.fiveHour.resetAt = +new Date(qw.fiveHour.resetAt);
      }
      if (qw.weekly) {
        e.weekly = e.weekly || {
          id: 'weekly',
          windowMs: WINDOW_1W_MS,
          limit: undefined,
          used: 0,
          resetAt: null,
        };
        if (e.weekly.limit === undefined && qw.weekly.limit !== undefined) e.weekly.limit = qw.weekly.limit;
        if (qw.weekly.used !== undefined && !this.loadedHas(provider, 'weekly', 'used')) e.weekly.used = qw.weekly.used;
        if (qw.weekly.resetAt !== undefined && !this.loadedHas(provider, 'weekly', 'resetAt')) e.weekly.resetAt = +new Date(qw.weekly.resetAt);
      }
    }
    if (Array.isArray(cw)) {
      for (const w of cw) {
        if (!e.custom.some((x) => x.id === w.id)) {
          e.custom.push({
            id: w.id,
            windowMs: w.windowMs,
            limit: w.limit,
            used: w.used ?? 0,
            resetAt: w.resetAt ? +new Date(w.resetAt) : null,
          });
        }
      }
    }
    // 覆盖已加载动态态（重启恢复）
    const ld = this.loaded.get(provider);
    if (ld) {
      if (ld.fiveHour && e.fiveHour) {
        if (ld.fiveHour.used != null) e.fiveHour.used = ld.fiveHour.used;
        if (ld.fiveHour.resetAt != null) e.fiveHour.resetAt = ld.fiveHour.resetAt;
      }
      if (ld.weekly && e.weekly) {
        if (ld.weekly.used != null) e.weekly.used = ld.weekly.used;
        if (ld.weekly.resetAt != null) e.weekly.resetAt = ld.weekly.resetAt;
      }
      if (ld.custom && e.custom.length) {
        for (const c of ld.custom) {
          const t = e.custom.find((x) => x.id === c.id);
          if (!t) continue;
          if (c.used != null) t.used = c.used;
          if (c.resetAt != null) t.resetAt = c.resetAt;
        }
      }
    }
    this._slide(e);
    return e;
  }

  loadedHas(provider, slot, field) {
    const ld = this.loaded.get(provider);
    return !!(ld && ld[slot] && ld[slot][field] != null);
  }

  /** 滑窗：resetAt 已过 → 清零 used 并推进到下一个未来滚动点（§11.2-8 自动滑）。 */
  _slide(e) {
    if (!e) return;
    const now = Date.now();
    const list = [];
    if (e.fiveHour) list.push(e.fiveHour);
    if (e.weekly) list.push(e.weekly);
    if (Array.isArray(e.custom)) list.push(...e.custom);
    for (const w of list) {
      if (!w) continue;
      if (w.resetAt == null || w.limit == null) continue; // 未声明期限或未声明限额 → 不滑
      if (now >= w.resetAt) {
        w.used = 0;
        const period = w.windowMs || 1;
        let next = w.resetAt;
        while (now >= next) next += period;
        w.resetAt = next;
      }
    }
  }

  _find(provider, windowId, meta) {
    const e = this._assure(provider, meta);
    if (windowId === 'five-hour') return e.fiveHour;
    if (windowId === 'weekly') return e.weekly;
    if (typeof windowId === 'string' && windowId.startsWith('custom:')) {
      return (e.custom || []).find((w) => w.id === windowId.slice('custom:'.length)) || null;
    }
    return null;
  }

  /** wrapper 入口拦截：未声明窗口 / 未声明限额 → 放行；限额耗尽 → 拒绝。 */
  consumeAttempt(provider, meta) {
    const qw = meta && meta.quotaWindows;
    const cw = meta && meta.customWindows;
    if (!qw && !cw) return { allowed: true, reason: 'no-windows-declared' };
    const e = this._assure(provider, meta);
    this._slide(e);
    const now = Date.now();
    const list = [];
    if (e.fiveHour && e.fiveHour.limit != null) list.push(e.fiveHour);
    if (e.weekly && e.weekly.limit != null) list.push(e.weekly);
    if (Array.isArray(e.custom)) list.push(...e.custom.filter((w) => w.limit != null));
    if (list.length === 0) return { allowed: true, reason: 'no-limit-declared' };
    for (const w of list) {
      if (w.used != null && w.limit != null && w.used >= w.limit) {
        return {
          allowed: false,
          reason: w.id === 'five-hour' ? 'five-hour-limit' : w.id === 'weekly' ? 'weekly-limit' : `custom-limit-${w.id}`,
          windowId: w.id,
          resetAt: w.resetAt ? new Date(w.resetAt).toISOString() : null,
          msToReset: w.resetAt ? Math.max(0, w.resetAt - now) : null,
        };
      }
    }
    return { allowed: true };
  }

  /** 人工/自动重置：清零 used；resetAt 缺省 = now + 窗口长度（粗估）。 */
  markReset(provider, windowId, meta, resetAt) {
    const w = this._find(provider, windowId, meta);
    if (!w) return { ok: false, error: `window「${windowId}」未声明或未知`, windowId };
    w.used = 0;
    w.resetAt = resetAt ? +new Date(resetAt) : Date.now() + (w.windowMs || 1);
    return { ok: true, windowId, used: 0, resetAt: new Date(w.resetAt).toISOString() };
  }

  /** 上游 429/QUOTA → 保守置 used=limit；optionally 推 resetAt 到下一自然滚动点（§14 #10）。 */
  markBurnedOut(provider, windowId, meta, nextResetAt) {
    const w = this._find(provider, windowId, meta);
    if (!w) return { ok: false, error: `window「${windowId}」未声明或未知`, windowId };
    if (w.limit == null) return { ok: false, error: `window「${windowId}」未声明限额，无法保守置满`, windowId };
    w.used = w.limit;
    if (nextResetAt) {
      w.resetAt = +new Date(nextResetAt);
    } else {
      const now = Date.now();
      const period = w.windowMs || 1;
      let next = w.resetAt == null ? now + period : w.resetAt;
      while (next <= now) next += period;
      w.resetAt = next;
    }
    this.log?.info?.(`quota markBurnedOut: ${provider}/${windowId} used=${w.used} resetAt=${new Date(w.resetAt).toISOString()}`);
    return { ok: true, windowId, used: w.used, resetAt: new Date(w.resetAt).toISOString() };
  }

  /** 全量覆盖窗口配置（/quota/sync 入口）：静态声明 + 动态态一并对齐。 */
  syncWindows(provider, windows) {
    let e = this.windows.get(provider) || { fiveHour: null, weekly: null, custom: [] };
    const now = Date.now();
    if (windows && windows.fiveHour) {
      e.fiveHour = e.fiveHour || { id: 'five-hour', windowMs: WINDOW_5H_MS };
      if (windows.fiveHour.limit !== undefined) e.fiveHour.limit = windows.fiveHour.limit;
      if (windows.fiveHour.used !== undefined) e.fiveHour.used = windows.fiveHour.used;
      if (windows.fiveHour.resetAt !== undefined) e.fiveHour.resetAt = +new Date(windows.fiveHour.resetAt);
      if (e.fiveHour.used === undefined) e.fiveHour.used = 0;
    }
    if (windows && windows.weekly) {
      e.weekly = e.weekly || { id: 'weekly', windowMs: WINDOW_1W_MS };
      if (windows.weekly.limit !== undefined) e.weekly.limit = windows.weekly.limit;
      if (windows.weekly.used !== undefined) e.weekly.used = windows.weekly.used;
      if (windows.weekly.resetAt !== undefined) e.weekly.resetAt = +new Date(windows.weekly.resetAt);
      if (e.weekly.used === undefined) e.weekly.used = 0;
    }
    if (windows && Array.isArray(windows.customWindows)) {
      e.custom = windows.customWindows.map((w) => ({
        id: w.id,
        windowMs: w.windowMs,
        limit: w.limit,
        used: w.used ?? 0,
        resetAt: w.resetAt ? +new Date(w.resetAt) : null,
      }));
    }
    this.windows.set(provider, e);
    this._slide(e);
    this.saveToDisk();
    return this.quotaSnapshot(provider);
  }

  /** 上限仓快照（供 /quota/windows 与面板）。未声明 → null。 */
  quotaSnapshot(provider) {
    const e = this.windows.get(provider);
    if (!e) return null;
    this._slide(e);
    const fmt = (w) => {
      if (!w) return null;
      const ratio = w.limit == null ? null : w.limit > 0 ? w.used / w.limit : null;
      return {
        limit: w.limit ?? null,
        used: w.limit == null ? null : w.used ?? 0,
        usedRatio: ratio,
        resetAt: w.resetAt ? new Date(w.resetAt).toISOString() : null,
        msToReset: w.resetAt ? Math.max(0, w.resetAt - Date.now()) : null,
      };
    };
    return {
      provider,
      fiveHour: fmt(e.fiveHour),
      weekly: fmt(e.weekly),
      customWindows: Array.isArray(e.custom) ? e.custom.map((w) => ({ id: w.id, windowMs: w.windowMs, ...fmt(w) })) : [],
    };
  }

  /** 仅落动态态（used/resetAt），静态声明（limit/windowMs）归属配置态不落盘（两层分离）。 */
  _stateForDisk() {
    const providers = {};
    for (const [p, e] of this.windows.entries()) {
      const entry = {};
      if (e.fiveHour && e.fiveHour.limit != null) entry.fiveHour = { used: e.fiveHour.used ?? 0, resetAt: e.fiveHour.resetAt ?? null };
      if (e.weekly && e.weekly.limit != null) entry.weekly = { used: e.weekly.used ?? 0, resetAt: e.weekly.resetAt ?? null };
      if (Array.isArray(e.custom)) {
        const c = e.custom.filter((w) => w.limit != null).map((w) => ({ id: w.id, used: w.used ?? 0, resetAt: w.resetAt ?? null }));
        if (c.length) entry.custom = c;
      }
      if (Object.keys(entry).length) providers[p] = entry;
    }
    return { version: 1, providers, savedAt: new Date().toISOString() };
  }

  loadFromDisk() {
    if (!this.storePath) return false;
    let raw;
    try {
      raw = JSON.parse(readFileSync(this.storePath, 'utf8'));
    } catch (error) {
      if (error?.code !== 'ENOENT') this.log?.warn?.(`quota-state 读取失败: ${error?.message ?? error}`);
      return false;
    }
    const providers = raw && raw.providers;
    if (!providers) return false;
    const map = new Map();
    for (const [p, v] of Object.entries(providers)) map.set(p, v);
    this.loaded = map;
    this.log?.info?.(`quota-state loaded: ${map.size} providers`);
    return true;
  }

  saveToDisk() {
    if (!this.storePath) return false;
    const payload = JSON.stringify(this._stateForDisk(), null, 2);
    const tmp = `${this.storePath}.tmp-${process.pid}`;
    try {
      mkdirSync(dirname(this.storePath), { recursive: true });
      writeFileSync(tmp, payload, { encoding: 'utf8', flag: 'wx' });
      renameSync(tmp, this.storePath);
      return true;
    } catch (error) {
      this.log?.warn?.(`quota-state 保存失败: ${error?.message ?? error}`);
      try {
        unlinkSync(tmp);
      } catch {
        // ignore
      }
      return false;
    }
  }
}

/**
 * 配额记账总入口（v0.1 速率环 + v0.9.5 上限仓）。
 * record/snapshot 为既有速率环接口（概览）；窗口上限相关接口见 method 注释。
 */
export class QuotaLedger {
  constructor(opts = {}) {
    /** @type {Map<string, {r5h: object[], r1w: object[]}>} */
    this.ledgers = new Map();
    // §11 上限仓：storePath 派生 quota-state.json（与 model-router-state.json 同目录）。
    const storePath = opts?.storePath
      ? join(dirname(opts.storePath), 'quota-state.json')
      : null;
    this.windowsLayer = new WindowLedger({ storePath, log: opts?.log });
  }

  /** 成功一次调用后记账（速率环）；usage 分片形如 {inputTokens, outputTokens, ...}（宽松取数）。 */
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
    // §11：成功路径滑窗（自动清零过期窗口）；used 不累加（避免与速率环双记）。
    this.windowsLayer._slide(this.windowsLayer.windows.get(provider));
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

  // —— §11 窗口上限仓委托（wrapper / routes 调用） ——
  consumeAttempt(provider, meta) {
    return this.windowsLayer.consumeAttempt(provider, meta);
  }
  markReset(provider, windowId, meta, resetAt) {
    const r = this.windowsLayer.markReset(provider, windowId, meta, resetAt);
    if (r.ok) this.windowsLayer.saveToDisk();
    return r;
  }
  markBurnedOut(provider, windowId, meta, nextResetAt) {
    return this.windowsLayer.markBurnedOut(provider, windowId, meta, nextResetAt);
  }
  syncWindows(provider, windows) {
    return this.windowsLayer.syncWindows(provider, windows);
  }
  quotaSnapshot(provider) {
    return this.windowsLayer.quotaSnapshot(provider);
  }
  loadFromDisk() {
    return this.windowsLayer.loadFromDisk();
  }
  saveToDisk() {
    return this.windowsLayer.saveToDisk();
  }
  saveToDiskSync() {
    return this.windowsLayer.saveToDisk();
  }
}

// FLUSH_MS 保留（index.js 周期可复用常量；此处仅导出避免未用告警）
export { FLUSH_MS };