/**
 * 配置规范化与校验（insert 条目 config 块 → 运行时配置）。
 *
 * v0.1 范围（与三轮审定方案一致）：
 * - 路由 = 静态链（按 rules 声明顺序）+ cooldown 排除 + 「链耗尽→单候选」收敛；
 *   quota/延迟感知评分属 P3/P4，本版不做排序加权。
 * - 不读取/不存储任何 API key：本插件只在既有 ctx.llm provider 路由之间切换，
 *   key 由各家 adapter 自行解析（provider 路由排他性，方案 §7.3）。
 */

import { VALID_MODES } from './modes.js';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_CONFIG = Object.freeze({
  /** 是否经 agent/request waterfall 提议会话级 (provider, model)。false = 仅故障切换。 */
  propose: false,
  /** 路由规则，自上而下首个 match 生效。match: {provider?, model?, default?} */
  rules: [],
  fallbackPolicy: Object.freeze({
    /** 首选之后、首分片之前最多切换次数（总尝试 = maxRetries + 1）。 */
    maxRetries: 2,
    /** 连续失败多少次进入 open（cooldown 熔断阈值）。 */
    failureThreshold: 3,
    /** open → half-open 的冷却秒数。 */
    cooldownSec: 60,
    /** v0.6.1 配额感知：QUOTA（workspace 配额耗尽）阈值——1 次即熔断（配额不会短冷却内恢复）。 */
    quotaFailureThreshold: 1,
    /** v0.6.1 配额感知：QUOTA 冷却秒数（默认 10 分钟，half-open 放行试探自动回归）。 */
    quotaCooldownSec: 600,
    /** 可触发切换的错误码（finish.reason.failure.code）。v0.6.0 对齐 dsh-llm
     *  适配器实机错误码（QUOTA/TRANSPORT/SERVER/UNKNOWN——旧表 QUOTA_EXCEEDED/
     *  RATE_LIMIT 与实机不符，导致 429 不切换）。 */
    failoverSignals: [
      'QUOTA',
      'QUOTA_EXCEEDED',
      'RATE_LIMIT',
      'TRANSPORT',
      'SERVER',
      'UNKNOWN',
      'INVALID_CREDENTIAL',
      'MISSING_CREDENTIAL',
      'EMPTY_RESPONSE',
      'TIMEOUT',
    ],
    /** 候选全在 cooldown 时：'force-first' 无视冷却强制首选一次；'fail' 直接失败。 */
    allCooldownFallback: 'force-first',
    /** 硬约束：首分片（任意非 finish 分片）之后绝不切换（commit-on-first-chunk）。 */
    switchAfterFirstChunk: false,
  }),
  /** 首分片看门狗：供应商挂起不产任何分片时，超时 abort 并按 TIMEOUT 切换。 */
  firstTokenTimeoutMs: 30000,
  /** v0.6.1 切换总预算：一次请求内全部尝试（含看门狗等待）的耗时上限，防挂起候选叠加拖死会话。 */
  failoverBudgetMs: 90000,
  /** 链耗尽后，候选链收敛为单候选的时间窗（秒），防 retry×failover 乘法爆炸。 */
  exhaustionWindowSec: 120,
  /** 模型健康探测（v0.4.0）：结果作为路由「健康度参考数据」。默认关闭，避免无授权打真实 API。 */
  probe: Object.freeze({
    /** 是否启用周期探测（注册表每个 provider/model 一条极短请求）。 */
    enabled: false,
    /** 探测周期秒数（>=30）。 */
    intervalSec: 300,
    /** 探测用极短 prompt（任意非空字符串）。 */
    prompt: 'ping',
    /** 单次探测超时毫秒（>=2000）。 */
    timeoutMs: 20000,
  }),
  /** 状态接口路径（webServer，回环围栏）。 */
  statusPath: '/api/model-router/status',
  /** v0.7.0 优先模式：stable | balanced | fast（面板一键切换，预设覆盖对应参数）。 */
  mode: 'balanced',
  /** 运行时状态（rules/propose 面板改动）持久化文件；存在时覆盖 patch config 的同名项。 */
  storePath: null,
  /** 持久化会话根目录（v0.6.0 会话标题第 3 级解析：`<dir>/<cwd-slug>/session-<id>/session.jsonl.zstd`）。 */
  sessionsDir: path.join(os.homedir(), '.deepseek-harness', 'sessions'),
  /** 注册表（provider/模型目录）刷新周期秒数。 */
  registryRefreshSec: 300,
  /**
   * 时间窗规则所用 IANA 时区（v0.5.0，峰谷定价）。
   * null = 用系统时区。显式指定（如 Asia/Shanghai）可钉死口径——
   * VPN 可能改变系统自动定位的时区，Intl 按显式时区换算不受其影响。
   */
  timeZone: null,
});

/** 规则候选扩展策略（v0.2 需求 4）。 */
const STRATEGIES = ['explicit', 'same-model', 'same-provider', 'exclude-current'];

const VALID_FALLBACK = new Set(['force-first', 'fail']);

const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** IANA 时区名合法性（Node 22 内置 full-ICU，非法名构造即抛 RangeError）。 */
export function isValidTimeZone(tz) {
  if (typeof tz !== 'string' || !tz) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function checkProviderModel(hop, where) {
  if (!isPlainObject(hop) || typeof hop.provider !== 'string' || !hop.provider) {
    throw new Error(`model-router 配置错误：${where} 每项须含非空 provider 字符串`);
  }
  if (typeof hop.model !== 'string' || !hop.model) {
    throw new Error(`model-router 配置错误：${where}.provider="${hop.provider}" 项须含非空 model 字符串`);
  }
  return hop.key ? { provider: hop.provider, model: hop.model, key: hop.key } : { provider: hop.provider, model: hop.model };
}

/**
 * 规范化 insert config。未知字段忽略；类型不符抛错（dsh 加载期即失败，
 * 错误信息出现在启动日志，避免静默失效）。
 * @param {object|undefined} raw insert 条目的 config
 * @returns {object} 完整运行时配置
 */
export function normalizeConfig(raw) {
  const c = { ...DEFAULT_CONFIG, ...(isPlainObject(raw) ? raw : {}) };
  const merged = {
    propose: c.propose === true,
    rules: [],
    fallbackPolicy: { ...DEFAULT_CONFIG.fallbackPolicy },
    firstTokenTimeoutMs: DEFAULT_CONFIG.firstTokenTimeoutMs,
    failoverBudgetMs: DEFAULT_CONFIG.failoverBudgetMs,
    exhaustionWindowSec: DEFAULT_CONFIG.exhaustionWindowSec,
    probe: { ...DEFAULT_CONFIG.probe },
    timeZone: null,
    statusPath: DEFAULT_CONFIG.statusPath,
    mode: DEFAULT_CONFIG.mode,
    logLevel: typeof c.logLevel === 'string' ? c.logLevel : 'info',
  };

  // v0.7.0 优先模式校验
  if (c.mode !== undefined && !VALID_MODES.includes(c.mode)) {
    throw new Error(`model-router 配置错误：mode 须为 ${VALID_MODES.join(' | ')} 之一`);
  }
  if (typeof c.mode === 'string') merged.mode = c.mode;

  if (!Array.isArray(c.rules)) throw new Error('model-router 配置错误：rules 须为数组');
  for (const [i, rule] of c.rules.entries()) {
    if (!isPlainObject(rule) || !isPlainObject(rule.match)) {
      throw new Error(`model-router 配置错误：rules[${i}] 须含 match 对象`);
    }
    if (!Array.isArray(rule.route) || rule.route.length === 0) {
      throw new Error(`model-router 配置错误：rules[${i}].route 须为非空数组`);
    }
    const m = rule.match;
    const match = {
      provider: typeof m.provider === 'string' ? m.provider : undefined,
      model: typeof m.model === 'string' ? m.model : undefined,
      default: m.default === true,
    };
    if (m.sessionIds !== undefined) {
      if (!Array.isArray(m.sessionIds) || m.sessionIds.some((s) => typeof s !== 'string' || !s)) {
        throw new Error(`model-router 配置错误：rules[${i}].match.sessionIds 须为非空字符串数组`);
      }
      if (m.sessionIds.length > 50) {
        throw new Error(`model-router 配置错误：rules[${i}].match.sessionIds 上限 50 条`);
      }
      // AND 语义下空数组永不命中（即便与其他条件组合也是死规则）——明确拒绝，
      // 而不是落进下方「至少一个条件」的笼统报错让用户猜（v0.4.1）
    if (m.sessionIds.length === 0) {
      throw new Error(`model-router 配置错误：rules[${i}].match.sessionIds 为空数组——指定会话须至少添加 1 条，或删除该条件`);
    }
      match.sessionIds = [...new Set(m.sessionIds)];
    }
    // 时间窗条件（v0.5.0，峰谷定价）：{start:"HH:MM", end:"HH:MM"}，跨零点自动支持
    if (m.hours !== undefined) {
      if (!isPlainObject(m.hours)) {
        throw new Error(`model-router 配置错误：rules[${i}].match.hours 须为 {start:"HH:MM", end:"HH:MM"}`);
      }
      if (typeof m.hours.start !== 'string' || !HHMM_RE.test(m.hours.start) ||
          typeof m.hours.end !== 'string' || !HHMM_RE.test(m.hours.end)) {
        throw new Error(`model-router 配置错误：rules[${i}].match.hours 须为 24 小时制 HH:MM（如 {"start":"22:00","end":"08:00"}）`);
      }
      if (m.hours.start === m.hours.end) {
        throw new Error(`model-router 配置错误：rules[${i}].match.hours start 与 end 不能相同`);
      }
      match.hours = { start: m.hours.start, end: m.hours.end };
    }
    // 作用域语义（v0.3 起）：多条件为 AND（全部满足才命中）。
    // 至少要有一个限定条件（provider/model/sessionIds/hours 之一或 default）。
    if (!match.provider && !match.model && !match.default && !(match.sessionIds?.length) && !match.hours) {
      throw new Error(`model-router 配置错误：rules[${i}].match 须含 provider/model/sessionIds/hours 之一或 default: true`);
    }
    const strategy = rule.strategy === undefined ? 'explicit' : rule.strategy;
    if (!STRATEGIES.includes(strategy)) {
      throw new Error(`model-router 配置错误：rules[${i}].strategy 须为 ${STRATEGIES.join(' | ')}`);
    }
    merged.rules.push({
      match,
      strategy,
      route: rule.route.map((hop, j) => checkProviderModel(hop, `rules[${i}].route[${j}]`)),
    });
  }

  const fp = isPlainObject(c.fallbackPolicy) ? c.fallbackPolicy : {};
  const p = merged.fallbackPolicy;
  if (fp.maxRetries !== undefined) {
    if (!Number.isInteger(fp.maxRetries) || fp.maxRetries < 0 || fp.maxRetries > 10) {
      throw new Error('model-router 配置错误：fallbackPolicy.maxRetries 须为 0..10 整数');
    }
    p.maxRetries = fp.maxRetries;
  }
  if (fp.failureThreshold !== undefined) {
    if (!Number.isInteger(fp.failureThreshold) || fp.failureThreshold < 1) {
      throw new Error('model-router 配置错误：fallbackPolicy.failureThreshold 须为 >=1 整数');
    }
    p.failureThreshold = fp.failureThreshold;
  }
  if (fp.cooldownSec !== undefined) {
    if (typeof fp.cooldownSec !== 'number' || fp.cooldownSec < 0) {
      throw new Error('model-router 配置错误：fallbackPolicy.cooldownSec 须为 >=0 数字');
    }
    p.cooldownSec = fp.cooldownSec;
  }
  // v0.6.1 配额感知冷却：QUOTA（workspace 配额耗尽）与瞬时限流分离——低阈值 + 长冷却
  if (fp.quotaFailureThreshold !== undefined) {
    if (!Number.isInteger(fp.quotaFailureThreshold) || fp.quotaFailureThreshold < 1) {
      throw new Error('model-router 配置错误：fallbackPolicy.quotaFailureThreshold 须为 >=1 整数');
    }
    p.quotaFailureThreshold = fp.quotaFailureThreshold;
  }
  if (fp.quotaCooldownSec !== undefined) {
    if (typeof fp.quotaCooldownSec !== 'number' || fp.quotaCooldownSec < 0) {
      throw new Error('model-router 配置错误：fallbackPolicy.quotaCooldownSec 须为 >=0 数字');
    }
    p.quotaCooldownSec = fp.quotaCooldownSec;
  }
  if (fp.failoverSignals !== undefined) {
    if (!Array.isArray(fp.failoverSignals) || fp.failoverSignals.some((s) => typeof s !== 'string')) {
      throw new Error('model-router 配置错误：fallbackPolicy.failoverSignals 须为字符串数组');
    }
    p.failoverSignals = [...fp.failoverSignals];
  }
  if (fp.allCooldownFallback !== undefined) {
    if (!VALID_FALLBACK.has(fp.allCooldownFallback)) {
      throw new Error('model-router 配置错误：fallbackPolicy.allCooldownFallback 须为 force-first | fail');
    }
    p.allCooldownFallback = fp.allCooldownFallback;
  }
  if (fp.switchAfterFirstChunk !== undefined && fp.switchAfterFirstChunk === true) {
    throw new Error('model-router 配置错误：switchAfterFirstChunk=true 违反流文法硬约束，仅允许 false');
  }
  if (c.firstTokenTimeoutMs !== undefined) {
    if (typeof c.firstTokenTimeoutMs !== 'number' || c.firstTokenTimeoutMs < 1000) {
      throw new Error('model-router 配置错误：firstTokenTimeoutMs 须为 >=1000 的毫秒数');
    }
    merged.firstTokenTimeoutMs = c.firstTokenTimeoutMs;
  }
  if (c.failoverBudgetMs !== undefined) {
    if (typeof c.failoverBudgetMs !== 'number' || c.failoverBudgetMs < c.firstTokenTimeoutMs) {
      throw new Error('model-router 配置错误：failoverBudgetMs 须为 >= firstTokenTimeoutMs 的毫秒数');
    }
    merged.failoverBudgetMs = c.failoverBudgetMs;
  }
  if (c.exhaustionWindowSec !== undefined) {
    if (typeof c.exhaustionWindowSec !== 'number' || c.exhaustionWindowSec < 0) {
      throw new Error('model-router 配置错误：exhaustionWindowSec 须为 >=0 秒数');
    }
    merged.exhaustionWindowSec = c.exhaustionWindowSec;
  }
  if (c.statusPath !== undefined) {
    if (typeof c.statusPath !== 'string' || !c.statusPath.startsWith('/api/')) {
      throw new Error('model-router 配置错误：statusPath 须以 /api/ 开头');
    }
    merged.statusPath = c.statusPath;
  }
  if (c.storePath !== undefined && c.storePath !== null) {
    if (typeof c.storePath !== 'string' || !path.isAbsolute(c.storePath)) {
      throw new Error('model-router 配置错误：storePath 须为绝对路径或 null');
    }
    merged.storePath = c.storePath;
  } else {
    // 默认落在 dsh home（用户主目录下 .deepseek-harness，跨平台，原子写安全）
    merged.storePath = DEFAULT_CONFIG.storePath ?? path.join(os.homedir(), '.deepseek-harness', 'home', 'model-router-state.json');
  }
  // 持久化会话根目录（v0.6.0 三级标题解析的第 3 级数据源）
  if (c.sessionsDir !== undefined && c.sessionsDir !== null) {
    if (typeof c.sessionsDir !== 'string' || !path.isAbsolute(c.sessionsDir)) {
      throw new Error('model-router 配置错误：sessionsDir 须为绝对路径或 null');
    }
    merged.sessionsDir = c.sessionsDir;
  } else {
    merged.sessionsDir = DEFAULT_CONFIG.sessionsDir;
  }
  if (c.registryRefreshSec !== undefined) {
    if (typeof c.registryRefreshSec !== 'number' || c.registryRefreshSec < 30) {
      throw new Error('model-router 配置错误：registryRefreshSec 须为 >=30 秒数');
    }
    merged.registryRefreshSec = c.registryRefreshSec;
  }
  // 健康探测配置（v0.4.0）
  const pb = isPlainObject(c.probe) ? c.probe : {};
  if (pb.enabled !== undefined && pb.enabled !== true && pb.enabled !== false) {
    throw new Error('model-router 配置错误：probe.enabled 须为 true|false');
  }
  if (pb.enabled === true) merged.probe.enabled = true;
  if (pb.intervalSec !== undefined) {
    if (typeof pb.intervalSec !== 'number' || pb.intervalSec < 30) {
      throw new Error('model-router 配置错误：probe.intervalSec 须为 >=30 秒数');
    }
    merged.probe.intervalSec = pb.intervalSec;
  }
  if (pb.prompt !== undefined) {
    if (typeof pb.prompt !== 'string' || !pb.prompt) {
      throw new Error('model-router 配置错误：probe.prompt 须为非空字符串');
    }
    merged.probe.prompt = pb.prompt;
  }
  if (pb.timeoutMs !== undefined) {
    if (typeof pb.timeoutMs !== 'number' || pb.timeoutMs < 2000) {
      throw new Error('model-router 配置错误：probe.timeoutMs 须为 >=2000 的毫秒数');
    }
    merged.probe.timeoutMs = pb.timeoutMs;
  }
  // 时间窗规则时区（v0.5.0）：null=系统时区；字符串=显式 IANA 时区（防 VPN 改系统时区）
  if (c.timeZone !== undefined && c.timeZone !== null) {
    if (!isValidTimeZone(c.timeZone)) {
      throw new Error('model-router 配置错误：timeZone 须为合法 IANA 时区名（如 Asia/Shanghai）');
    }
    merged.timeZone = c.timeZone;
  }
  return merged;
}

/**
 * 校验面板提交的运行时状态（rules + propose），返回规范化结果。
 * 与 normalizeConfig 的规则段同构，供 POST /state 复用。
 */
export function normalizeState(raw) {
  if (!isPlainObject(raw)) throw new Error('model-router：state 须为对象');
  const normalized = normalizeConfig({
    propose: raw.propose === true,
    rules: raw.rules ?? [],
    fallbackPolicy: DEFAULT_CONFIG.fallbackPolicy,
    timeZone: raw.timeZone === undefined ? null : raw.timeZone,
    mode: raw.mode === undefined ? DEFAULT_CONFIG.mode : raw.mode,
  });
  return { propose: normalized.propose, rules: normalized.rules, timeZone: normalized.timeZone, mode: normalized.mode };
}
