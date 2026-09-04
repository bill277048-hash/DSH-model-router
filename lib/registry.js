/**
 * dsh 模型注册表镜像（v0.2 需求 3 数据源）。
 *
 * 数据一律来自 dsh 自身的 llm 服务（即「设置-模型」页面的同一数据源）：
 * - provider 路由：`ctx.llm.adapters`（已注册路由）
 * - displayName：`ctx.llm.listConfigurableProviders()`（目录声明）
 * - 模型目录：`ctx.llm.listModels(provider)`（adapter 目录，含 name/contextWindow）
 *
 * 用途：① 同模型/同供应商/排除模式 的候选扩展；② 面板标注（区分「本插件
 * 路由条目」与「dsh 注册条目」）；③ 路由指向未注册条目时的告警。
 * 刷新失败不影响旧快照（每个 provider 独立 try/catch）。
 */

export class Registry {
  /**
   * @param {object} llm LlmRuntime 实例（inject 'llm' 或派发 thisArg）
   * @param {object} log
   * @param {number} refreshSec
   */
  constructor(llm, log, refreshSec = 300) {
    this.llm = llm;
    this.log = log;
    this.refreshSec = refreshSec;
    /** @type {{providers: object[], updatedAt: string|null}} */
    this.snapshot = { providers: [], updatedAt: null };
    this.refreshing = false;
  }

  /**
   * 收集 provider 路由 + displayName（同步、无网络 IO，随时可调）。
   * adapters 键 = 已注册路由；directory 提供 displayName（可能不全）。
   */
  refreshProviders() {
    try {
      const dirByName = new Map();
      try {
        for (const entry of this.llm.listConfigurableProviders?.() ?? []) {
          if (entry && entry.provider) dirByName.set(entry.provider, entry);
        }
      } catch (error) {
        this.log.debug?.(`listConfigurableProviders failed: ${error?.message ?? error}`);
      }
      const providers = [];
      for (const provider of this.llm.adapters.keys()) {
        const dir = dirByName.get(provider);
        providers.push({
          provider,
          displayName: dir?.displayName ?? null, // 与 dsh「设置-模型」页一致
          settingsNs: dir?.settingsNs ?? null,
          models: [], // 由 refreshModels 异步补齐
        });
      }
      // 目录里声明但未注册（休眠）的 provider 也列出，标注 dormant
      for (const [provider, dir] of dirByName.entries()) {
        if (!providers.some((p) => p.provider === provider)) {
          providers.push({
            provider,
            displayName: dir.displayName ?? null,
            settingsNs: dir.settingsNs ?? null,
            models: [],
            dormant: true,
          });
        }
      }
      // 保留旧 models（refreshProviders 只动 provider 骨架）
      const prev = new Map(this.snapshot.providers.map((p) => [p.provider, p]));
      for (const p of providers) {
        const old = prev.get(p.provider);
        if (old && old.models?.length) p.models = old.models;
      }
      this.snapshot = { providers, updatedAt: new Date().toISOString() };
      this.log.info(`registry providers: ${providers.map((p) => p.provider).join(', ')}`);
      return this.snapshot;
    } catch (error) {
      this.log.warn(`registry refreshProviders failed: ${error?.message ?? error}`);
      return this.snapshot;
    }
  }

  /** 逐 provider 拉模型目录（网络 IO，容错；单家失败不影响其余）。 */
  async refreshModels() {
    if (this.refreshing) return this.snapshot;
    this.refreshing = true;
    try {
      for (const p of this.snapshot.providers) {
        if (p.dormant) continue;
        try {
          const models = await this.llm.listModels(p.provider);
          p.models = models.map((m) => ({ id: m.id, name: m.name }));
        } catch (error) {
          this.log.debug?.(`listModels(${p.provider}) failed: ${error?.message ?? error}`);
          if (!p.models) p.models = [];
        }
      }
      this.snapshot = { ...this.snapshot, updatedAt: new Date().toISOString() };
    } finally {
      this.refreshing = false;
    }
    return this.snapshot;
  }

  /**
   * 候选扩展用：返回全部已注册 (provider, model) 对（排除休眠项）。
   * 无模型目录时退化为仅 provider 层信息。
   */
  registeredPairs() {
    const pairs = [];
    for (const p of this.snapshot.providers) {
      if (p.dormant) continue;
      if (p.models.length === 0) {
        pairs.push({ provider: p.provider, model: null }); // 模型目录未就绪
      } else {
        for (const m of p.models) pairs.push({ provider: p.provider, model: m.id });
      }
    }
    return pairs;
  }

  /** provider 是否已注册（面板告警用）。 */
  isKnownProvider(provider) {
    return this.snapshot.providers.some((p) => p.provider === provider && !p.dormant);
  }

  /** (provider, model) 是否在注册表模型目录中（面板告警用；目录未就绪时返回 null 不判）。 */
  isKnownModel(provider, model) {
    const p = this.snapshot.providers.find((x) => x.provider === provider);
    if (!p || p.dormant) return false;
    if (p.models.length === 0) return null; // 目录未就绪，不判
    return p.models.some((m) => m.id === model);
  }

  displayName(provider) {
    const p = this.snapshot.providers.find((x) => x.provider === provider);
    return p?.displayName ?? null;
  }

  snapshotOut() {
    return {
      ...this.snapshot,
      source: 'dsh 设置-模型（llm 服务目录镜像）',
    };
  }
}
