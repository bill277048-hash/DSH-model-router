/**
 * 优先模式预设（v0.7.0）：把底层切换参数收敛为 3 个用户意图档位，面板一键切换。
 *
 * 设计原则（新手零理解成本）：模式是「意图」，参数是「实现」。切模式即覆盖对应
 * 参数（覆盖 patch 显式值——面板所见即所得）；未覆盖的参数（如 maxRetries、
 * failoverSignals、规则链）保持用户配置不动。
 *
 * 定位与取舍：
 * - stable  稳定优先：长线任务不中断第一。容忍长等待（挂起 60s 才切、总预算 5 分钟），
 *   换取更低误切率（慢思考模型不会被误杀）与更少 token 重发。
 * - balanced 平衡（默认）：大多数交互任务的折中（30s/90s）。
 * - fast    极速优先：即时问答尽快出结果。挂起 15s 即切、总预算 45s、冷却更短
 *   （更快重试恢复的模型）；代价：慢 TTFT 模型可能被误判超时 → 切换 → 重发 prompt
 *   （token 消耗增加），且切换更频繁可能放大非必要切换。
 */

/** 模式键 → 展示名（客户端/日志共用）。 */
export const MODE_LABELS = {
  stable: '稳定优先',
  balanced: '平衡（默认）',
  fast: '极速优先',
  'free-tier': '免费额度模式',
  custom: '自定义',
};

/**
 * 模式 → 参数预设。字段必须是 config 顶层/fallbackPolicy 的既有键。
 * quotaCooldownSec（配额型错误的停用时长）三档都保持长冷却——配额耗尽不会因
 * 模式偏好而更快恢复，仅按模式放宽/收紧重试节奏。
 *
 * free-tier（CHANGES F-5，批 2 定案）：maxRetries=5、首令牌看门狗=60s、请求间隔
 * =2s、候选间延迟=500ms；预算/冷却/配额冷却取 balanced 基准。requestIntervalMs/
 * interModelDelayMs/maxRetries 作为既定语义记录在本预设，消费点随批 2 后续（wrapper
 * per-request）落地；applyModeOverrides 暂只覆盖既有的 4 个运行时参数，避免触碰
 * 核心切换路径（安全台阶）。v0.9.4 B-1：requestIntervalMs 现同时约束跨请求
 * + 请求内间隔（wrapper throttleWait，成功路径提交账本）；默认 2s/500ms 不改。
 *
 * custom：占位（用户全自定义），本版不参与预设覆盖——切到 custom 保持现状，
 * 用户显式配置各自参数。
 */
export const MODE_PRESETS = {
  stable: {
    label: MODE_LABELS.stable,
    firstTokenTimeoutMs: 60_000,
    failoverBudgetMs: 300_000,
    cooldownSec: 120,
    quotaCooldownSec: 900,
  },
  balanced: {
    label: MODE_LABELS.balanced,
    firstTokenTimeoutMs: 30_000,
    failoverBudgetMs: 90_000,
    cooldownSec: 60,
    quotaCooldownSec: 600,
  },
  fast: {
    label: MODE_LABELS.fast,
    firstTokenTimeoutMs: 15_000,
    failoverBudgetMs: 45_000,
    cooldownSec: 30,
    quotaCooldownSec: 300,
  },
  'free-tier': {
    label: MODE_LABELS['free-tier'],
    firstTokenTimeoutMs: 60_000,
    failoverBudgetMs: 90_000, // balanced 基准
    cooldownSec: 60, // balanced 基准
    quotaCooldownSec: 600, // balanced 基准
    maxRetries: 5, // CHANGES F-5（消费点随批 2 后续落地）
    requestIntervalMs: 2_000, // CHANGES F-5（消费点随批 2 后续落地）
    interModelDelayMs: 500, // CHANGES F-5（消费点随批 2 后续落地）
  },
  custom: {
    label: MODE_LABELS.custom,
    // 占位：用户全自定义，本版不预设覆盖
  },
};

/** 合法模式键集合（校验用）。 */
export const VALID_MODES = Object.keys(MODE_PRESETS);

/**
 * 把模式预设覆盖到 cfg 上（原地修改，供启动装配与面板热切换共用）。
 * @param {object} cfg 规范化后的插件配置（会被原地修改）
 * @param {string} mode 模式键
 * @returns {object} 同一 cfg 引用
 */
export function applyModeOverrides(cfg, mode) {
  const preset = MODE_PRESETS[mode];
  if (!preset) return cfg;
  cfg.mode = mode;
  // custom 等占位预设可能没有运行时参数 → 不覆盖（用户全自定义）
  if (preset.firstTokenTimeoutMs === undefined) return cfg;
  cfg.firstTokenTimeoutMs = preset.firstTokenTimeoutMs;
  cfg.failoverBudgetMs = preset.failoverBudgetMs;
  if (cfg.fallbackPolicy) {
    cfg.fallbackPolicy.cooldownSec = preset.cooldownSec;
    cfg.fallbackPolicy.quotaCooldownSec = preset.quotaCooldownSec;
  }
  return cfg;
}
