/**
 * cooldown 熔断器（三态 closed / open / half-open，按 hop 键隔离）。
 *
 * closed --连续失败 >= failureThreshold--> open(openedAt=now)
 * open   --now-openedAt >= cooldownSec--> half-open（下次 allow 放行一次试探）
 * half-open --成功--> closed(failures=0) / --失败--> open(openedAt=now)
 */

export function hopKeyOf(hop) {
  return hop.key ? `${hop.provider}#${hop.key}/${hop.model}` : `${hop.provider}/${hop.model}`;
}

const STATE = { CLOSED: 'closed', OPEN: 'open', HALF_OPEN: 'half-open' };

class Circuit {
  constructor(threshold, cooldownMs, quotaThreshold, quotaCooldownMs) {
    this.threshold = threshold;
    this.cooldownMs = cooldownMs;
    // v0.6.1 配额感知：QUOTA（workspace 配额耗尽）与瞬时限流不同——不会在短冷却内
    // 恢复，用更低阈值 + 更长冷却；触发 open 时按触发码选用对应冷却时长。
    this.quotaThreshold = quotaThreshold;
    this.quotaCooldownMs = quotaCooldownMs;
    this.activeCooldownMs = cooldownMs;
    this.state = STATE.CLOSED;
    this.failures = 0;
    this.openedAt = 0;
    this.lastErrorCode = null;
  }

  onFail(code, now = Date.now()) {
    this.failures += 1;
    this.lastErrorCode = code ?? null;
    const isQuota = code === 'QUOTA';
    const threshold = isQuota ? this.quotaThreshold : this.threshold;
    if (this.state === STATE.HALF_OPEN || this.failures >= threshold) {
      this.state = STATE.OPEN;
      this.openedAt = now;
      this.activeCooldownMs = isQuota ? this.quotaCooldownMs : this.cooldownMs;
    }
  }

  onSuccess() {
    this.state = STATE.CLOSED;
    this.failures = 0;
    this.openedAt = 0;
    this.lastErrorCode = null;
    this.activeCooldownMs = this.cooldownMs;
  }

  /** open 期满自动转 half-open；half-open 放行一次试探。 */
  allow(now = Date.now()) {
    if (this.state === STATE.CLOSED) return true;
    if (this.state === STATE.OPEN && now - this.openedAt >= this.activeCooldownMs) {
      this.state = STATE.HALF_OPEN;
      return true;
    }
    return this.state === STATE.HALF_OPEN;
  }

  forceReset() {
    this.onSuccess();
  }

  snapshot() {
    return {
      state: this.state,
      failures: this.failures,
      openedAt: this.openedAt || undefined,
      lastErrorCode: this.lastErrorCode ?? undefined,
    };
  }
}

export class CooldownBoard {
  /**
   * @param {{ failureThreshold: number, cooldownSec: number,
   *           quotaFailureThreshold?: number, quotaCooldownSec?: number }} policy
   */
  constructor(policy) {
    this.threshold = policy.failureThreshold;
    this.cooldownMs = Math.max(0, policy.cooldownSec) * 1000;
    this.quotaThreshold = Math.max(1, policy.quotaFailureThreshold ?? 1);
    this.quotaCooldownMs = Math.max(0, policy.quotaCooldownSec ?? 600) * 1000;
    /** @type {Map<string, Circuit>} */
    this.circuits = new Map();
  }

  /** @private */
  circuitOf(key) {
    let c = this.circuits.get(key);
    if (!c) {
      c = new Circuit(this.threshold, this.cooldownMs, this.quotaThreshold, this.quotaCooldownMs);
      this.circuits.set(key, c);
    }
    return c;
  }

  onFail(key, code, now) {
    this.circuitOf(key).onFail(code, now);
  }

  /**
   * v0.7.0 优先模式热切换：更新 board 默认参数与既有熔断器的阈值/常规冷却。
   * 已处于 open 的熔断器保留其生效中的冷却时长（activeCooldownMs，按触发码设定），
   * 下次重新 open 时采用新时长——避免切换瞬间重置正在进行的熔断状态。
   */
  applyPolicy(policy) {
    this.threshold = policy.failureThreshold;
    this.cooldownMs = Math.max(0, policy.cooldownSec) * 1000;
    this.quotaThreshold = Math.max(1, policy.quotaFailureThreshold ?? 1);
    this.quotaCooldownMs = Math.max(0, policy.quotaCooldownSec ?? 600) * 1000;
    for (const c of this.circuits.values()) {
      c.threshold = this.threshold;
      c.cooldownMs = this.cooldownMs;
      c.quotaThreshold = this.quotaThreshold;
      c.quotaCooldownMs = this.quotaCooldownMs;
    }
  }

  onSuccess(key) {
    this.circuitOf(key).onSuccess();
  }

  allow(key, now) {
    return this.circuitOf(key).allow(now);
  }

  forceReset(key) {
    this.circuitOf(key).forceReset();
  }

  snapshot() {
    const out = {};
    for (const [key, c] of this.circuits.entries()) out[key] = c.snapshot();
    return out;
  }
}
