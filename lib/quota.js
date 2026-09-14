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
 * 两层数据来源（v0.9.6 起语义钉死）：
 * - **静态声明**（limit / windowMs / 初始 resetAt）来自 providerMeta（store.json）或
 *   hop 内联，**每次 _assure 都从 meta 对齐**（增·改·删）。
 * - **运行态**（used / 滑窗后的 resetAt）**只在槽位首次物化时播种一次**（loaded 快照
 *   优先，其次 meta 声明值），此后只由 _slide / markReset / markBurnedOut / addUsage /
 *   syncWindows 改写；独立持久化到 quota-state.json（与配置态两层分离，§11.2-2）。
 *
 * 为什么必须这样分：v0.9.6 前每次 _assure 都无条件重放 meta + loaded，导致人工重置
 * 与上游 429 置满的效果活不过一次调用（详见 _assure 注释）。
 */
export class WindowLedger {
  constructor(opts = {}) {
    this.log = opts.log;
    this.storePath = opts.storePath || null;
    /** @type {Map<string, object>} provider -> { fiveHour, weekly, custom } */
    this.windows = new Map();
    /** @type {Map<string, object>} 已加载的动态态（used/resetAt）。仅在该槽位首次
     *   物化时被 _syncSlot/_syncCustom 消费一次并按槽位删除，此后以内存态为准。 */
    this.loaded = new Map();
  }

  /**
   * 声明对齐 + 运行态一次性播种（v0.9.6 重构）。
   *
   * 目标语义：**声明态（结构 / limit / windowMs）每次从 meta 对齐（增·改·删）；
   * 运行态（used / resetAt）只在槽位首次物化时播种一次**，此后只由 _slide /
   * markReset / markBurnedOut / addUsage / syncWindows 改写。
   *
   * v0.9.6 前本函数每次调用都无条件重放 meta 与 loaded 快照，导致三个缺陷：
   *   ① markReset（人工重置）效果活不过一次调用
   *   ② providerMeta 声明了 used 时 markBurnedOut（上游 429 置满）被抹掉
   *   ③ 清除声明后内存槽位只增不删，仍继续拦截
   */
  _assure(provider, meta) {
    const e = this.windows.get(provider) || { fiveHour: null, weekly: null, custom: [] };
    this.windows.set(provider, e);
    const qw = meta && meta.quotaWindows;
    const cw = meta && meta.customWindows;
    e.fiveHour = this._syncSlot(provider, e.fiveHour, 'fiveHour', 'five-hour', WINDOW_5H_MS, qw && qw.fiveHour);
    e.weekly = this._syncSlot(provider, e.weekly, 'weekly', 'weekly', WINDOW_1W_MS, qw && qw.weekly);
    e.custom = this._syncCustom(provider, e.custom, cw);
    this._slide(e); // 必须在声明对齐 + 播种之后（依赖 resetAt/limit 已就位）
    return e;
  }

  /**
   * 对齐单个窗口槽位（fiveHour / weekly）。
   * - `decl` 缺失 → 返回 null（声明消失即清除，连同运行态一起丢）
   * - 槽位首次物化（`cur == null`）→ 播种运行态：loaded 快照优先，其次 meta 声明值
   * - 槽位已存在 → **只对齐 limit，绝不碰 used/resetAt**（根因 A 的修复点）
   *
   * 「首次物化」刻意用槽位级判定而非 provider 级（如 !windows.has(provider)）：
   * provider 级会在两类边角失效——① syncWindows 已建条目但槽位未播种 → loaded 永不应用；
   * ② 先只声明 weekly、后补 fiveHour → 后者的 loaded 丢失。
   * @returns {object|null}
   */
  _syncSlot(provider, cur, slot, id, windowMs, decl) {
    if (!decl) return null;
    let w = cur;
    if (!w) {
      w = { id, windowMs, limit: undefined, used: 0, resetAt: null };
      // loaded 快照优先（重启恢复）；按槽位 delete —— 不 delete 的话，槽位被删后
      // 重新声明会复活旧快照，根因 A 以另一条路径复发。
      const ld = this.loaded.get(provider);
      if (ld && ld[slot]) {
        if (ld[slot].used != null) w.used = ld[slot].used;
        if (ld[slot].resetAt != null) w.resetAt = ld[slot].resetAt;
        delete ld[slot];
        if (Object.keys(ld).length === 0) this.loaded.delete(provider);
      }
      if (decl.used !== undefined) w.used = decl.used;
      if (decl.resetAt !== undefined) w.resetAt = +new Date(decl.resetAt);
    }
    // 声明态每次对齐。清空 limit 亦生效（validateOneWindow 对 limit:undefined 放行）。
    w.limit = decl.limit;
    return w;
  }

  /**
   * 对齐自定义窗口列表：按 id 做集合差（meta 有则增/改，meta 无则删）。
   * 与 _syncSlot 同规则：已有槽位只对齐声明态，不碰 used/resetAt。
   * @param {object[]|undefined} cw meta.customWindows；undefined = 保持现状（不改）
   * @returns {object[]}
   */
  _syncCustom(provider, cur, cw) {
    const list = Array.isArray(cur) ? cur : [];
    if (!Array.isArray(cw)) return list; // 未声明该段 → 保持现状
    const prev = new Map(list.map((w) => [w.id, w]));
    const ld = this.loaded.get(provider);
    return cw.map((d) => {
      const w = prev.get(d.id);
      if (w) {
        w.windowMs = d.windowMs;
        w.limit = d.limit;
        return w;
      }
      const fresh = {
        id: d.id,
        windowMs: d.windowMs,
        limit: d.limit,
        used: d.used ?? 0,
        resetAt: d.resetAt ? +new Date(d.resetAt) : null,
      };
      const hit = ld && Array.isArray(ld.custom) ? ld.custom.find((c) => c.id === d.id) : null;
      if (hit) {
        if (hit.used != null) fresh.used = hit.used;
        if (hit.resetAt != null) fresh.resetAt = hit.resetAt;
        ld.custom = ld.custom.filter((c) => c.id !== d.id);
        if (ld.custom.length === 0) delete ld.custom;
        if (Object.keys(ld).length === 0) this.loaded.delete(provider);
      }
      return fresh;
    });
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

  /**
   * v0.9.6（根因 D 修复）：成功调用按 tokens 累加窗口用量。
   *
   * v0.9.6 前 used 只由 markBurnedOut / markReset / 人工声明改动，窗口永不自然耗尽
   * → 门只在上游已 429 之后才生效（正是用户要避免的「被动等上游 429 后再 cooldown」），
   * 概览段「接近 80% 标黄 / 95% 标红」也永不触发。
   * 口径：limit 单位 = token，与速率环同源（§11.1 两层职责独立，不构成双记）。
   * @param {string} provider
   * @param {number} amount 本次消耗 token 数
   */
  addUsage(provider, amount) {
    const e = this.windows.get(provider);
    if (!e || !(amount > 0)) return;
    this._slide(e);
    const list = [e.fiveHour, e.weekly, ...(Array.isArray(e.custom) ? e.custom : [])];
    for (const w of list) {
      if (w && w.limit != null) w.used = (w.used ?? 0) + amount;
    }
  }

  /**
   * 全量覆盖窗口配置（/quota/sync 入口）。
   *
   * v0.9.6：改为委托 _assure，复用同一套「声明对齐 + 运行态一次性播种」逻辑。
   * 此前这里自己实现了一份，形成第二条维护 limit/used/resetAt 的路径，且
   * `windows.fiveHour === undefined`（routes.js 传的删除后值）时不清槽位
   * → 删除声明后仍继续拦截；另有一个边角：重启后先开抽屉保存会先建槽位，
   * 导致后续 _assure 认为「已初始化」而丢掉 loaded 快照（重启恢复失效）。
   */
  syncWindows(provider, windows) {
    const w = windows || {};
    this._assure(provider, { quotaWindows: w, customWindows: w.customWindows });
    this.saveToDisk();
    return this.quotaSnapshot(provider);
  }

  /**
   * 上限仓快照（供 /quota/windows 与面板）。
   * v0.9.6：可传 meta —— 传了就先做声明对齐，使已删除的窗口即时从快照消失；
   * 未声明任何窗口时返回 null（保持既有「undeclared → null」契约）。
   * @param {string} provider
   * @param {object} [meta] providerMeta[provider]（不传则只读内存态，行为与旧版一致）
   */
  quotaSnapshot(provider, meta) {
    const e = meta !== undefined ? this._assure(provider, meta) : this.windows.get(provider);
    if (!e) return null;
    this._slide(e);
    const hasAny = !!e.fiveHour || !!e.weekly || (Array.isArray(e.custom) && e.custom.length > 0);
    if (!hasAny) return null;
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
    // §11：成功路径滑窗（自动清零过期窗口）。
    this.windowsLayer._slide(this.windowsLayer.windows.get(provider));
    // v0.9.6（根因 D）：上限仓按 tokens 累加窗口用量。
    // 此前注释写「used 不累加（避免与速率环双记）」——该理由不成立：§11.1 明确
    // 速率环（实际速率观测）与上限仓（窗口累计上限拦截）是「两套并行、职责独立」的
    // 语义，独立的两套不构成双记。不累加的后果是窗口永不自然耗尽，门只在上游已
    // 429 之后才生效，退化成「被动反应」而非 §11 要求的「主动避让」。
    this.windowsLayer.addUsage(provider, tokens);
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
    const r = this.windowsLayer.markBurnedOut(provider, windowId, meta, nextResetAt);
    // v0.9.6：补落盘——此前与 markReset 不对称（后者有 saveToDisk），重启即丢。
    if (r.ok) this.windowsLayer.saveToDisk();
    return r;
  }
  syncWindows(provider, windows) {
    return this.windowsLayer.syncWindows(provider, windows);
  }
  quotaSnapshot(provider, meta) {
    return this.windowsLayer.quotaSnapshot(provider, meta);
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