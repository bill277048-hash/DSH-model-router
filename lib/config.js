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
  /** v0.9.4：是否保留旧 v0.8 规则级 match 语义。false = 丢弃残留 match（默认，杜绝 ISS-01 静默接管）。 */
  allowLegacyMatch: false,
  /**
   * v0.8.0 A-2：provider 元数据（自家配置域，不跨插件读 settings）。
   * 键 = provider；值 { quotaGroup?: string, tier?: 'free'|'paid-baseline'|'unknown' }。
   * 读取语义：route hop 内联（quotaGroup/tier）优先 → providerMeta 兜底。
   */
  providerMeta: Object.freeze({}),
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
      // v0.8.0 A-1：DSH httpErrorCode(400, 非 quota/context) 归 INVALID_REQUEST
      'INVALID_REQUEST',
      // v0.9.4 B-B：context 类 400（单模型累计上下文超窗）纳入 failover，避免硬失败
      'CONTEXT_LENGTH',
      'CONTEXT_WINDOW',
      'TOO_MANY_TOKENS',
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
  /**
   * v0.8.0 G1 每日 API 报告：默认关闭（每批独立可回退）。
   * 开启后 wrapper 记账 → 日账本 NDJSON 追加写 → 每日调度生成昨日报告。
   */
  reports: Object.freeze({
    /** 是否启用日账本记账与每日调度（false = 零记账零调度，行为与旧版一致）。 */
    enabled: false,
    /** 每日生成时刻（当地 HH:MM，默认凌晨 1 点）。 */
    hour: '01:00',
  }),
});

/** 规则候选扩展策略（v0.2 需求 4）。 */
const STRATEGIES = ['explicit', 'same-model', 'same-provider', 'exclude-current'];

/** v0.8.0 A-2：tier 合法值（宽松校验，默认 unknown）。 */
const TIERS = new Set(['free', 'paid-baseline', 'unknown']);

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

export function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * v0.9.4（M-1/决策 7，漏洞 1 修复）：剥离旧 v0.8 的 rule.match 字段。
 * allowLegacyMatch=true 时原样保留（向后兼容）；false 时复制 rules 并剔除 match。
 * @param {object[]} rules 原始规则数组（store/patch 路径共用）
 * @param {boolean} allowLegacyMatch
 * @param {object} [log]
 * @returns {object[]} 处理后的规则数组（isPlainObject 判定 match）
 */
export function stripLegacyMatch(rules, allowLegacyMatch, log) {
  if (!Array.isArray(rules)) return rules;
  if (allowLegacyMatch) return rules; // 显式开启：保留旧 v0.8 语义（不 throw、不剥离、不拷贝）
  // v0.9.4 收口：默认遇到残留 match 一律 fail-fast（一次性收集全部，不静默剥离）。
  // 静默失效比启动报错更危险——用户会以为旧规则还在生效。
  const legacy = [];
  for (const [i, r] of rules.entries()) {
    if (isPlainObject(r) && isPlainObject(r.match)) {
      legacy.push(`  rules[${i}] "${(r.name ?? '<unnamed>')}": keys=[${Object.keys(r.match).join(', ')}]`);
    }
  }
  if (legacy.length > 0) {
    throw new Error(
      `model-router 配置错误：发现 ${legacy.length} 条规则残留已废弃的 match 字段（v0.9.4 起 ` +
      `match 不再自动接管，规则启用由会话模型选择器驱动）。请删除规则的 match 字段，或在顶层设 ` +
      `allowLegacyMatch:true 保留旧 v0.8 语义。残留规则：\n${legacy.join('\n')}`,
    );
  }
  return rules; // 无残留：原样返回（不剥离不拷贝）
}

function checkProviderModel(hop, where) {
  if (!isPlainObject(hop) || typeof hop.provider !== 'string' || !hop.provider) {
    throw new Error(`model-router 配置错误：${where} 每项须含非空 provider 字符串`);
  }
  if (typeof hop.model !== 'string' || !hop.model) {
    throw new Error(`model-router 配置错误：${where}.provider="${hop.provider}" 项须含非空 model 字符串`);
  }
  const out = { provider: hop.provider, model: hop.model };
  if (hop.key !== undefined) {
    if (typeof hop.key !== 'string' || !hop.key) {
      throw new Error(`model-router 配置错误：${where}.key 须为非空字符串`);
    }
    out.key = hop.key;
  }
  // v0.8.0 A-2：route hop 内联元数据（优先于 providerMeta 兜底）
  if (hop.quotaGroup !== undefined) {
    if (typeof hop.quotaGroup !== 'string' || !hop.quotaGroup) {
      throw new Error(`model-router 配置错误：${where}.quotaGroup 须为非空字符串`);
    }
    out.quotaGroup = hop.quotaGroup;
  }
  if (hop.tier !== undefined) {
    if (typeof hop.tier !== 'string' || !TIERS.has(hop.tier)) {
      throw new Error(`model-router 配置错误：${where}.tier 须为 ${[...TIERS].join(' | ')} 之一`);
    }
    out.tier = hop.tier;
  }
  // v0.9.5：hop 内联 quotaWindows/customWindows（同 providerMeta 段一样的语义）；
  // 在 route 阶段而非 normalizeConfig 阶段，因 hop 是 candidate 输入
  if (hop.quotaWindows !== undefined) {
    out.quotaWindows = validateWindows('quotaWindows', hop.quotaWindows, where);
  }
  if (hop.customWindows !== undefined) {
    out.customWindows = validateCustomWindows('customWindows', hop.customWindows, where);
  }
  return out;
}

/**
 * v0.9.5：quotaWindows 静态校验（只校验 limit/used/resetAt 类型合法性）。
 * 上限仓的 used/resetAt 滑动由 quota 模块接管（不在这里做语义判断）。
 */
function validateWindows(field, w, where) {
  if (typeof w !== 'object' || w === null || Array.isArray(w)) {
    throw new Error(`model-router 配置错误：${where}.${field} 须为对象（fiveHour/weekly 可选）`);
  }
  const out = {};
  for (const k of ['fiveHour', 'weekly']) {
    if (w[k] === undefined) continue;
    out[k] = validateOneWindow(field + '.' + k, w[k], where);
  }
  return out;
}

function validateOneWindow(field, w, where) {
  if (typeof w !== 'object' || w === null || Array.isArray(w)) {
    throw new Error(`model-router 配置错误：${where}.${field} 须为对象`);
  }
  const out = {};
  if (w.limit !== undefined) {
    if (typeof w.limit !== 'number' || !Number.isFinite(w.limit) || w.limit < 0) {
      throw new Error(`model-router 配置错误：${where}.${field}.limit 须为非负有限数字`);
    }
    out.limit = w.limit;
  }
  if (w.used !== undefined) {
    if (typeof w.used !== 'number' || !Number.isFinite(w.used) || w.used < 0) {
      throw new Error(`model-router 配置错误：${where}.${field}.used 须为非负有限数字`);
    }
    out.used = w.used;
  }
  if (w.resetAt !== undefined) {
    if (typeof w.resetAt !== 'string' || !w.resetAt) {
      throw new Error(`model-router 配置错误：${where}.${field}.resetAt 须为非空 ISO8601 字符串`);
    }
    const t = new Date(w.resetAt).getTime();
    if (!Number.isFinite(t) || t < 0) {
      throw new Error(`model-router 配置错误：${where}.${field}.resetAt 无法解析为合法时间`);
    }
    out.resetAt = w.resetAt;
  }
  return out;
}

function validateCustomWindows(field, list, where) {
  if (!Array.isArray(list)) {
    throw new Error(`model-router 配置错误：${where}.${field} 须为数组`);
  }
  const out = [];
  list.forEach((w, i) => {
    if (typeof w !== 'object' || w === null) {
      throw new Error(`model-router 配置错误：${where}.${field}[${i}] 须为对象`);
    }
    if (typeof w.id !== 'string' || !/^[A-Za-z0-9_-]{1,32}$/.test(w.id)) {
      throw new Error(`model-router 配置错误：${where}.${field}[${i}].id 须为 [A-Za-z0-9_-]{1,32}`);
    }
    if (typeof w.windowMs !== 'number' || !Number.isFinite(w.windowMs) || w.windowMs < 60000 || w.windowMs > 30 * 86400_000) {
      throw new Error(`model-router 配置错误：${where}.${field}[${i}].windowMs 须为 60000..30d 之间的有限数字`);
    }
    const item = { id: w.id, windowMs: w.windowMs };
    if (w.limit !== undefined) item.limit = w.limit;
    if (w.used !== undefined) item.used = w.used;
    if (w.resetAt !== undefined) item.resetAt = w.resetAt;
    if (w.limit !== undefined && typeof w.limit === 'number' && Number.isFinite(w.limit) && w.limit >= 0) item.limit = w.limit;
    if (w.used !== undefined && typeof w.used === 'number' && Number.isFinite(w.used) && w.used >= 0) item.used = w.used;
    if (w.resetAt !== undefined) {
      const t = new Date(w.resetAt).getTime();
      if (!Number.isFinite(t) || t < 0) {
        throw new Error(`model-router 配置错误：${where}.${field}[${i}].resetAt 无法解析为合法时间`);
      }
      item.resetAt = w.resetAt;
    }
    out.push(item);
  });
  return out;
}

/**
 * v0.9.5：providerMeta 顶层 quotaWindows/customWindows 校验（不在 hop 里时）。
 * 与 hop 路径复用 validateWindows/validateCustomWindows。
 */
export function validateProviderMetaWindows(meta, where) {
  if (typeof meta !== 'object' || meta === null) return meta;
  const out = Object.assign({}, meta);
  if (out.quotaWindows !== undefined) {
    out.quotaWindows = validateWindows('quotaWindows', out.quotaWindows, where);
  }
  if (out.customWindows !== undefined) {
    out.customWindows = validateCustomWindows('customWindows', out.customWindows, where);
  }
  return out;
}

/**
 * v0.8.0 A-3：统计配置中声明的不同 quotaGroup 数量（providerMeta 兜底 +
 * route hop 内联并集）。maxRetries 自动调优的依据：quotaGroup 越多，
 * 同组共享限流池的候选越多，需更多重试次数覆盖。
 * @param {object} cfg 规范化后的配置
 * @returns {number} 不同 quotaGroup 数量（>=0）
 */
export function quotaGroupCount(cfg) {
  const groups = new Set();
  for (const m of Object.values(cfg.providerMeta ?? {})) {
    if (m && m.quotaGroup) groups.add(m.quotaGroup);
  }
  for (const rule of cfg.rules ?? []) {
    for (const hop of rule.route ?? []) {
      if (hop && hop.quotaGroup) groups.add(hop.quotaGroup);
    }
  }
  return groups.size;
}

/**
 * v0.8.0 A-3：maxRetries 自动调优（原地修改 cfg.fallbackPolicy.maxRetries）。
 * 仅未显式声明时回填 max(quotaGroupCount*2, 5)；显式声明（含显式 2）不覆盖。
 * @param {object} cfg 规范化后的配置（normalizeConfig 输出）
 * @returns {object} 同一 cfg 引用
 */
export function autoTuneMaxRetries(cfg) {
  if (cfg._hasExplicitMaxRetries) return cfg;
  const auto = Math.max(quotaGroupCount(cfg) * 2, 5);
  if (auto !== cfg.fallbackPolicy.maxRetries) {
    cfg.fallbackPolicy.maxRetries = auto;
  }
  return cfg;
}

/**
 * F-2：解析并校验模式键（顶层 mode 与 rule.mode 复用）。仅允许 VALID_MODES 内合法值。
 * @param {unknown} value 待校验模式键（须为字符串）
 * @param {string} where 报错用定位（如 "mode" 或 "rules[0].mode"）
 * @returns {string} 合法模式键
 * @throws {Error} 非字符串或不在合法模式集内
 */
function parseMode(value, where) {
  if (typeof value !== 'string' || !VALID_MODES.includes(value)) {
    throw new Error(`model-router 配置错误：${where} 须为 ${VALID_MODES.join(' | ')} 之一`);
  }
  return value;
}

/** v0.9（自定义模式参数）：rule.custom 允许的键与其合法下限。 */
const CUSTOM_KEYS = {
  firstTokenTimeoutMs: 1000,
  failoverBudgetMs: 1000,
  cooldownSec: 1,
  quotaCooldownSec: 1,
};

/**
 * v0.9（自定义模式）：校验 `rule.custom` 参数集（仅 mode==='custom' 时消费）。
 * 键均为可选的有限正数；`failoverBudgetMs` 须 >= `firstTokenTimeoutMs`
 * （否则首分片永远无法在预算内到达，看门狗空转）。
 * @param {unknown} raw rule.custom 原始值
 * @param {string} where 报错定位（如 "rules[0].custom"）
 * @returns {object} 规范化后的 {firstTokenTimeoutMs?, failoverBudgetMs?, cooldownSec?, quotaCooldownSec?}
 * @throws {Error} 类型/下限/预算关系不合法
 */
export function validateCustomParams(raw, where) {
  if (!isPlainObject(raw)) throw new Error(`model-router 配置错误：${where} 须为对象`);
  const out = {};
  for (const [k, min] of Object.entries(CUSTOM_KEYS)) {
    if (raw[k] === undefined) continue;
    if (typeof raw[k] !== 'number' || !Number.isFinite(raw[k]) || raw[k] < min) {
      throw new Error(`model-router 配置错误：${where}.${k} 须为 >=${min} 的数字`);
    }
    out[k] = raw[k];
  }
  if (out.firstTokenTimeoutMs !== undefined && out.failoverBudgetMs !== undefined &&
      out.failoverBudgetMs < out.firstTokenTimeoutMs) {
    throw new Error(`model-router 配置错误：${where}.failoverBudgetMs 须 >= firstTokenTimeoutMs`);
  }
  return out;
}

/**
 * F-4 默认命名（CHANGES 内联算法 applyDefaultNames）：为缺省 `rule.name` 的规则
 * 自动分配 `rule-{N}`。一句话：显式 name 优先保留，缺省规则取最小的未被占用 N。
 * @param {object[]} rules normalizeConfig 输出的规则数组（含 match/strategy/route）
 * @returns {object[]} 同一数组引用（原地补 name）
 * @throws {Error} name 非空字符串校验或重名 fail-fast
 */
export function applyDefaultNames(rules) {
  const used = new Set();
  for (const rule of rules) {
    if (rule.name !== undefined) {
      if (typeof rule.name !== 'string' || !rule.name.trim()) {
        throw new Error('model-router 配置错误：rule.name 须为非空字符串');
      }
      const trimmed = rule.name.trim();
      if (trimmed.includes('/')) {
        throw new Error(`model-router 配置错误：规则名 "${trimmed}" 不得含 "/"（规则名用作虚拟模型 id __pkg:<name>）`);
      }
      if (trimmed.length > 40) {
        throw new Error(`model-router 配置错误：规则名 "${trimmed}" 长度须 <=40`);
      }
      if (used.has(trimmed)) {
        throw new Error(`model-router 配置错误：重复规则名 "${trimmed}"`);
      }
      used.add(trimmed);
      rule.name = trimmed; // 归一化首尾空白
    }
  }
  let n = 0;
  for (const rule of rules) {
    if (rule.name === undefined) {
      while (used.has(`rule-${n}`)) n += 1;
      rule.name = `rule-${n}`;
      used.add(rule.name);
      n += 1;
    }
  }
  return rules;
}

/**
 * 规范化 insert config。未知字段忽略；类型不符抛错（dsh 加载期即失败，
 * 错误信息出现在启动日志，避免静默失效）。
 * @param {object|undefined} raw insert 条目的 config
 * @returns {object} 完整运行时配置
 */
export function normalizeConfig(raw, opts = {}) {
  const log = opts.log ?? {};
  const c = { ...DEFAULT_CONFIG, ...(isPlainObject(raw) ? raw : {}) };
  const merged = {
    propose: c.propose === true,
    rules: [],
    providerMeta: {},
    fallbackPolicy: { ...DEFAULT_CONFIG.fallbackPolicy },
    firstTokenTimeoutMs: DEFAULT_CONFIG.firstTokenTimeoutMs,
    failoverBudgetMs: DEFAULT_CONFIG.failoverBudgetMs,
    exhaustionWindowSec: DEFAULT_CONFIG.exhaustionWindowSec,
    probe: { ...DEFAULT_CONFIG.probe },
    timeZone: null,
    statusPath: DEFAULT_CONFIG.statusPath,
    mode: DEFAULT_CONFIG.mode,
    logLevel: typeof c.logLevel === 'string' ? c.logLevel : 'info',
    reports: { ...DEFAULT_CONFIG.reports },
    // v0.9.4（漏洞 2 修复）：默认丢弃残留 match，除非 patch 显式开启
    allowLegacyMatch: c.allowLegacyMatch === true,
  };

  // v0.7.0 优先模式校验（F-2：顶层 mode=全局默认；rule.mode 校验见 parseMode 复用）
  if (c.mode !== undefined) {
    merged.mode = parseMode(c.mode, 'mode');
    // v0.9.5（§13 P2-13）：顶层 mode 已废弃——v0.9.1 起 mode 归属迁移到 rule.mode；
    // 仅在用户**显式**声明顶层 mode（非默认 balanced）时 warn，使用默认 balanced 不告警（避免日志噪音）。
    if (c.mode !== DEFAULT_CONFIG.mode) {
      log.warn?.('顶层 mode 已废弃——v0.9.1 起 mode 归属迁移到每条规则包（rule.mode）；全局默认请保留 balanced 或显式设每个 rule.mode。');
    }
  }

  if (!Array.isArray(c.rules)) throw new Error('model-router 配置错误：rules 须为数组');
  // v0.9.4（M-1/决策 7）：patch 路径在此入口统一剥离 match（allowLegacyMatch 决定保留）。
  // store 路径在 index.js A-3 剥离，两者各自独立、各 warn 一次，不重叠不重复。
  const rules = stripLegacyMatch(c.rules, merged.allowLegacyMatch, log);
  for (const [i, rule] of rules.entries()) {
    if (!isPlainObject(rule)) {
      throw new Error(`model-router 配置错误：rules[${i}] 须为对象`);
    }
    if (!Array.isArray(rule.route) || rule.route.length === 0) {
      throw new Error(`model-router 配置错误：rules[${i}].route 须为非空数组`);
    }
    // v0.9 纯选择驱动：规则是命名「规则包」，由对话选中（resolvePackage）启用，
    // 不再依赖 match 自动改派。新配置不需要 match；旧配置残留 match 则容错沿用
    // （成员 default 规则仍可在注册表级 match（若有 provider/model）时兜底）。
    const entry = {
      // F-4：name 可选；类型/重名/长度校验在末尾 applyDefaultNames 统一处理。
      ...(rule.name !== undefined ? { name: rule.name } : {}),
      // F-2：rule.mode 可选，须在合法模式集内；缺省沿用顶层全局 mode（wrapper 层解析）。
      ...(rule.mode !== undefined ? { mode: parseMode(rule.mode, `rules[${i}].mode`) } : {}),
      // v0.9：custom 参数仅 mode==='custom' 时由 wrapper 消费；其余模式被忽略。
      ...(rule.custom !== undefined ? { custom: validateCustomParams(rule.custom, `rules[${i}].custom`) } : {}),
    };
    const strategy = rule.strategy === undefined ? 'explicit' : rule.strategy;
    if (!STRATEGIES.includes(strategy)) {
      throw new Error(`model-router 配置错误：rules[${i}].strategy 须为 ${STRATEGIES.join(' | ')}`);
    }
    entry.strategy = strategy;
    entry.route = rule.route.map((hop, j) => checkProviderModel(hop, `rules[${i}].route[${j}]`));
    // v0.9.4（漏洞 1/决策 7）：此段仅 allowLegacyMatch=true 时可达——
    // 入口 stripLegacyMatch 已在 false 时剥离 rule.match（rule.match 恒 undefined，
    // 天然不复写 entry.match）。true 时入口原样返回，走下方旧 v0.8 明细解析。
    // 类型 fail-fast 保留开关无关（显式 legacy 用户传入非法 match 同样报错）。
    if (rule.match !== undefined && !isPlainObject(rule.match)) {
      throw new Error(`model-router 配置错误：rules[${i}].match 若提供须为对象`);
    }
    if (isPlainObject(rule.match)) {
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
        if (m.sessionIds.length === 0) {
          throw new Error(`model-router 配置错误：rules[${i}].match.sessionIds 为空数组——指定会话须至少添加 1 条，或删除该条件`);
        }
        match.sessionIds = [...new Set(m.sessionIds)];
      }
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
      entry.match = match;
    }
    merged.rules.push(entry);
  }

  // v0.8.0 A-2：providerMeta 校验（自家配置域）。值缺省字段不写默认值——
  // 读取方（registry._profileMeta）对缺省字段返回 undefined，避免与
  // 「显式 unknown」混淆；tier 缺省即 unknown 语义在消费端处理。
  if (c.providerMeta !== undefined) {
    if (!isPlainObject(c.providerMeta)) {
      throw new Error('model-router 配置错误：providerMeta 须为对象');
    }
    for (const [provider, m] of Object.entries(c.providerMeta)) {
      if (!isPlainObject(m)) {
        throw new Error(`model-router 配置错误：providerMeta.${provider} 须为对象`);
      }
      const entry = {};
      if (m.quotaGroup !== undefined) {
        if (typeof m.quotaGroup !== 'string' || !m.quotaGroup) {
          throw new Error(`model-router 配置错误：providerMeta.${provider}.quotaGroup 须为非空字符串`);
        }
        entry.quotaGroup = m.quotaGroup;
      }
      if (m.tier !== undefined) {
        if (typeof m.tier !== 'string' || !TIERS.has(m.tier)) {
          throw new Error(`model-router 配置错误：providerMeta.${provider}.tier 须为 ${[...TIERS].join(' | ')} 之一`);
        }
        entry.tier = m.tier;
      }
      // v0.9.5：quotaWindows / customWindows（静态校验；运行时滑窗/重置由 quota 模块接管）
      if (m.quotaWindows !== undefined) {
        entry.quotaWindows = validateWindows('quotaWindows', m.quotaWindows, `providerMeta.${provider}`);
      }
      if (m.customWindows !== undefined) {
        entry.customWindows = validateCustomWindows('customWindows', m.customWindows, `providerMeta.${provider}`);
      }
      merged.providerMeta[provider] = entry;
    }
  }

  const fp = isPlainObject(c.fallbackPolicy) ? c.fallbackPolicy : {};
  const p = merged.fallbackPolicy;
  // v0.8.0 A-3：记录用户是否显式声明过 maxRetries（undefined = 未声明）。
  // 必须基于原始输入 raw.fallbackPolicy 判断——c 已与 DEFAULT_CONFIG 展开合并，
  // 其 fallbackPolicy 恒含 maxRetries:2，会误判「未声明」为「显式 2」导致
  // auto-tune 永不触发。弃用「=== 2 哨兵」判定（用户显式给 2 会被误覆盖的缺陷）。
  // normalizeState 传入 DEFAULT_CONFIG.fallbackPolicy 时标记为 true，但 state
  // 路径不消费此字段，无影响。
  const rawFp = isPlainObject(raw?.fallbackPolicy) ? raw.fallbackPolicy : undefined;
  Object.defineProperty(merged, '_hasExplicitMaxRetries', {
    value: rawFp !== undefined && rawFp.maxRetries !== undefined,
    enumerable: false,
    configurable: true,
  });
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
  // v0.8.0 G1 每日报告：reports.enabled（默认 false 零记账）/ reports.hour（生成时刻）
  const rp = isPlainObject(c.reports) ? c.reports : {};
  if (rp.enabled !== undefined && rp.enabled !== true && rp.enabled !== false) {
    throw new Error('model-router 配置错误：reports.enabled 须为 true|false');
  }
  if (rp.enabled === true) merged.reports.enabled = true;
  if (rp.hour !== undefined) {
    if (typeof rp.hour !== 'string' || !HHMM_RE.test(rp.hour)) {
      throw new Error('model-router 配置错误：reports.hour 须为 24 小时制 HH:MM（如 "01:00"）');
    }
    merged.reports.hour = rp.hour;
  }
  // v0.9.4 UX 清理：可选 reports.dir——显式指定报告目录（绝对路径）；不传时
  // DailyLedger 走 homedir()/Documents/dsh-model-router-reports 默认。
  if (rp.dir !== undefined) {
    if (typeof rp.dir !== 'string' || rp.dir.length === 0 || !path.isAbsolute(rp.dir)) {
      throw new Error('model-router 配置错误：reports.dir 须为非空字符串绝对路径');
    }
    merged.reports.dir = rp.dir;
  }
  // v0.9.5 §9：可选 modelTestThreshold = { primary, backup } verdict 评分阈值
  if (rp.modelTestThreshold !== undefined) {
    const mt = rp.modelTestThreshold;
    if (!isPlainObject(mt)) {
      throw new Error('model-router 配置错误：reports.modelTestThreshold 须为对象 { primary, backup }');
    }
    const primary = mt.primary;
    const backup = mt.backup;
    if (typeof primary !== 'number' || typeof backup !== 'number' ||
        !Number.isFinite(primary) || !Number.isFinite(backup)) {
      throw new Error('model-router 配置错误：reports.modelTestThreshold.primary/backup 须为有限数字');
    }
    if (!(0 <= backup && backup < primary && primary <= 1)) {
      throw new Error('model-router 配置错误：reports.modelTestThreshold 须满足 0<=backup<primary<=1');
    }
    merged.reports.modelTestThreshold = { primary, backup };
  }
  // F-4：统一自动命名 + 重名 fail-fast（normalizeConfig 每次重建规则名，含面板热更新路径）
  applyDefaultNames(merged.rules);
  return merged;
}

/**
 * 校验面板提交的运行时状态（rules + propose），返回规范化结果。
 * 与 normalizeConfig 的规则段同构，供 POST /state 复用。
 */
export function normalizeState(raw, legacyMatch = false, opts = {}) {
  if (!isPlainObject(raw)) throw new Error('model-router：state 须为对象');
  const log = opts.log;
  const normalized = normalizeConfig({
    propose: raw.propose === true,
    rules: raw.rules ?? [],
    fallbackPolicy: DEFAULT_CONFIG.fallbackPolicy,
    timeZone: raw.timeZone === undefined ? null : raw.timeZone,
    // v0.9：全局 mode 不再由面板热切换（mode 归属迁移到每个规则包）。
    // 仅为兼容旧客户端解析出合法 mode；新客户端不再提交。
    ...(raw.mode !== undefined ? { mode: raw.mode } : {}),
    // v0.8.0 修复（部署发现）：providerMeta 此前被返回白名单丢弃，面板提交后
    // 无法持久化/热生效。经 normalizeConfig 既有校验（quotaGroup 非空字符串、
    // tier 枚举）清洗；未提交时为 undefined（不重置 patch 值，向后兼容）。
    providerMeta: raw.providerMeta,
    // v0.9.4（漏洞 2 修复）：复用 patch 现值的 allowLegacyMatch，避免面板保存
    // 把 legacy 语义强制归 false（此前构造 raw 会落 DEFAULT=false）。
    // S-3：默认 false 仅作函数签名兜底——routes.js 总透传 config.allowLegacyMatch === true，
    // 仅在独立调用（如单测显式调用不传第二参）时才依赖默认值。
    allowLegacyMatch: legacyMatch === true,
    // v0.9.4 UX 补丁：面板可提交 reports 段（启用/关闭每日报告）。未提交时 undefined →
    // 不重置 patch 值（保留原本 enabled）。仅在面板显式提交时走 normalized.reports。
    ...(raw.reports !== undefined ? { reports: raw.reports } : {}),
  }, { log });
  return {
    rules: normalized.rules,
    // 兼容旧字段（旧客户端/日志用；新客户端不再提交 propose/mode/timeZone）
    ...(raw.propose !== undefined ? { propose: normalized.propose } : {}),
    ...(raw.timeZone !== undefined ? { timeZone: normalized.timeZone } : {}),
    ...(raw.mode !== undefined ? { mode: normalized.mode } : {}),
    providerMeta: raw.providerMeta === undefined ? undefined : normalized.providerMeta,
    // v0.9.4 UX 补丁：回传 reports（面板一键开启后立即生效展示状态）
    ...(raw.reports !== undefined ? { reports: normalized.reports } : {}),
  };
}
