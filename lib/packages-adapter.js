/**
 * 虚拟模型包 adapter（F-3，批 5）—— 纯展示层薄壳。
 *
 * 注册 `dsh-model-router` 虚拟 provider，在其 `listModels()` 暴露所有命名规则
 * （`__pkg:<ruleName>`）为虚拟模型，供 dsh UI 模型选择器展示「插件模型包」分组。
 *
 * 边界（避免 L-2 双重切换，启动文档 §4.3）：
 * - 本 adapter **不持有任何 API key、不实现 failover 循环**；
 * - 真正的「选包路由」已由 agent/request（F-5）完成——选中 `__pkg:<ruleName>`
 *   后由 agent/request 提议 route[0] 真实 provider/model 并附加 `__mr_rule`，
 *   wrapper 按绑定规则接管 failover；因此正常情况下不会以虚拟 id 触发本 adapter
 *   的 `stream()`。此处 `stream()` 仅作安全兜底，被意外调用时合成 error finish。
 *
 * 依赖命名（F-4 地基）：`router.config.rules` 经 applyDefaultNames 保证 name 非空。
 */
import { PKG_PROVIDER, PKG_PREFIX } from './router.js';
import { MODE_LABELS } from './modes.js';

/**
 * 构造虚拟模型包 adapter 对象（供 `ctx.llm.registerAdapter([PKG_PROVIDER], ...)`）。
 * @param {{router: import('./router.js').Router, log?: object}} deps
 * @returns {object} dsh adapter 契约（providerInfo/listModels/resolveModel/stream/attributionHeaders）
 */
export function createPackagesAdapter({ router, log }) {
  const info = log ?? console;
  return {
    /**
     * providerInfo：虚拟 provider 的目录声明。id 必须 === PKG_PROVIDER（与注册键一致）。
     */
    providerInfo() {
      return { id: PKG_PROVIDER, name: '插件模型包', settingsNs: PKG_PROVIDER };
    },
    /** 走默认重试策略。 */
    providerRetryPolicy() {
      return undefined;
    },
    /**
     * 暴露命名规则为虚拟模型。从 router 当前生效 rules 生成，面板热更新后可见。
     *
     * dsh-llm prepareRoutes（INVALID_CATALOG 校验，实机 UI 踩中）要求每个 model 元数据：
     * `model.provider === provider`（必须等于虚拟 provider id）&& id 非空 && name 非空
     * && description(若有) 为 string && 目录内 id 不重复。缺 `provider` 字段即抛
     * "adapter returned invalid or duplicate model metadata for provider ..."（INVALID_CATALOG）。
     * @returns {Promise<object[]>} [{ provider:'dsh-model-router', id:'__pkg:<name>', name:'<name>（<mode>）' }]
     */
    async listModels() {
      const out = [];
      const seen = new Set();
      for (const rule of router.config.rules) {
        if (!rule.name) continue;
        const id = PKG_PREFIX + rule.name;
        if (seen.has(id)) continue; // 目录内去重兜底（dsh-llm 对重复 id 抛 INVALID_CATALOG）
        seen.add(id);
        out.push({
          provider: PKG_PROVIDER,
          id,
          // v0.9：展示名直接采用用户命名的 `rule.name` + 模式中文标签（非模式原始键），
          // 解决问题 2「插件模型包 rule-0（balanced）→ 用户命名」。
          name: rule.mode && MODE_LABELS[rule.mode]
            ? `${rule.name}（${MODE_LABELS[rule.mode]}）`
            : rule.name,
          contextWindow: 0,
        });
      }
      return out;
    },
    /** 虚拟模型解析（UI/registry 展示级；路由由 agent/request 接管）。 */
    resolveModel(provider, model) {
      return Promise.resolve({ provider, id: model, name: model });
    },
    /** 安全兜底：正常情况下不会以虚拟 id 触发（见文件头）。 */
    stream() {
      return (async function* () {
        info.warn?.(
          `packages adapter stream invoked for virtual provider; 选包应经 agent/request 接管（返回合成 error finish）`,
        );
        yield {
          type: 'finish',
          reason: {
            kind: 'error',
            failure: {
              code: 'NO_PKG_STREAM',
              message: 'model-router: packages adapter stream not implemented (选包由 agent/request 接管)',
            },
          },
        };
      })();
    },
    attributionHeaders() {
      return Promise.resolve({});
    },
  };
}