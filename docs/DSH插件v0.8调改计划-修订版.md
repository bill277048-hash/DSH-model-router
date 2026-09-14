# DSH-model-router v0.8 调改计划（修订版 v1.3）

> **取代关系**：本修订版取代《DSH插件v0.8调改计划》（G1/G2/G3 版）与《CHANGES.md》（v0.8.0 16 项版），作为唯一实施依据。
> **修订依据**：对 CHANGES.md 的四维审核（逻辑 / 可行性 / 稳定性 / 可维护性）+ 用户 4 项决策确认（2026-09-07）+ 复审意见（REVIEW-REVISION.md，13 项事实核对 12 项正确、1 项分歧以实测 61 定案）+ 开源项目调研对照（2026-09-07，见 §2.9）+ 二次审核（REVIEW-REVISION-v2.md，实证确认基线差异为副本不一致、修正调度口径）。
> **目标代码库**：`DSH-model-router-main/`（审查副本，改动后同步 GitHub 仓库 `bill277048-hash/DSH-model-router`）。
> **适用对象**：@botton/dsh-model-router v0.7.0 → v0.8.0。
> **版本履历**：v1.0 = CHANGES.md 四维审核 + 4 项决策（初版修订）；v1.1 = 吸收复审意见有效点（B-1 必带 PROBE_MARK、批 4 前置 spike、README 双示例、adapter namespace spike、工作量 20–25h、测试基线以实测 61 定案）；v1.2 = 并入开源项目调研对照（§2.9），明确「只对照、不引入」硬约束，修正 §3.2 工作量口径与 §0 统一；v1.3 = 二次审核（REVIEW-REVISION-v2）实证确认：`DSH-model-router-main/test/unit.test.mjs` 实测定值 **61**（`node --test` = 61/61，grep `^test(` = 61），审核方 design 副本 43 系副本差异、非基线写错；§2.8 调度口径修正（沿用现有 setInterval，`ctx.interval` 移入可选清理项）。

---

## 0. 范围总览（修订后）

| 版本 | 范围 |
|------|------|
| **v0.8.0** | G1 每日 API 报告 + G2 面板信息分级 + G3 Windows 适配 + A-1/B-1/B-2/C-1/C-2/A-2/A-3/D-1/E-1（9 项修正版） |
| **v0.9.0（推迟）** | F 段全部（自命名规则 + mode 单一体系 + 注册新 adapter + 选包路由 UI 集成） |

**关键修订**：原 CHANGES.md 的 16 项中，F 段 7 项（F-1~F-7）整体推迟到 v0.9.0；A-3 与 C-1 因 F-5/F-6 推迟而**恢复保留**（原有冲突消除）；A-1/A-2/C-2/B-1/D-1 按审核意见**修正实现方式**。

| 编号 | 类别 | 标题 | 优先级 | 风险 | 状态 |
|------|------|------|--------|------|------|
| A-1 | 配置 | `failoverSignals` 加 `INVALID_REQUEST`（**基于实际 10 项追加**） | P0 | 低 | 待实施 |
| A-2 | 配置 | `quotaGroup` / `tier` 配置域（**改放 model-router 自家配置**） | P1 | 低 | 待实施 |
| A-3 | 配置 | `maxRetries` 默认值公式（保留，F-5 推迟后无冲突） | P1 | 低 | 待实施 |
| B-1 | 新模块 | `lib/loadtest.js` 4-phase 自动测试（**复用 probe 原语**） | P0 | 中 | 待实施 |
| B-2 | wiring | loadtest 端点 + 装配（**修正代码笔误**） | P0 | 低 | 待实施 |
| C-1 | 路由 | `router.candidates()` 按 `quotaGroup` 去重（保留） | P1 | 中 | 待实施 |
| C-2 | 元数据 | registry 读 `quotaGroup`/`tier`（**改从自家配置，不再跨插件读 settings**） | P1 | 中 | 待实施 |
| D-1 | 测试 | 新增单测（**基线修正为实际 61 条**） | P0 | — | 待实施 |
| E-1 | 文档 | README / CHANGELOG 同步 | P0 | — | 待实施 |
| G1 | 新模块 | 每日 API 报告（日账本 + 调度 + 三渠道） | P0 | 中 | 待实施 |
| G2 | 前端 | 面板三级信息结构 + 轮询分级 | P0 | 中 | 待实施 |
| G3 | 脚本 | Windows PowerShell 部署/卸载 + CI 三平台 | P0 | 低 | 待实施 |

**总量**：新增/修改文件 12 个，预计新增单测 24–29 条（**基线 61** → 总量约 85–90），预计工作量 **20–25 工时**（含 spike 与集成回归；批 3/4 各加 0.5h buffer）。

---

## 1. 调整原因（审核发现 → 修订决策）

### 1.1 逻辑维度（3 处）

| # | 发现 | 结论 |
|---|------|------|
| L-1 | **F-8 规则绑定丢失（核心缺陷）**：agent/request 把虚拟 model 替换为 route[0] 后，wrapper 用新 seed 重新 `matchRule()`，而 F-3 只留 default → 命中 default 规则而非用户选中的 rule → 模型包的 failover 链走错规则 | **F 段推迟 v0.9.0**；v0.9.0 需先实现「规则绑定传递」（agent/request 返回 payload 附加 `__mr_rule`，wrapper 优先取绑定规则的 route），并 spike 验证附加字段传导到 llm/stream options |
| L-2 | **F-6 adapter 双重切换**：adapter.stream 自实现 failover 循环 + 内部调 `ctx.llm.stream` 会再经 waterfall（`wrapped` WeakSet 只防同一 options 对象）→ 双层 failover、预算翻倍 | F 段推迟；v0.9.0 中 adapter 定位为**纯展示层**（listModels 暴露虚拟包；stream 收到虚拟 id 仅解析 route[0] 透传），主路由走 agent/request 拦截 |
| L-3 | **F-3 删 match 语义未定**：只留 default 意味着所有流量被接管，「只接管部分流量」能力丢失 | **决策 1（已确认）**：保留 `provider/model` 可选条件 + 默认不注入 default 规则（无 default 时插件旁观纯透传） |

### 1.2 可行性维度（3 处）

| # | 发现 | 结论 |
|---|------|------|
| F-1 | **C-2 settings 注入未验证**：文档自认「假注入名」；工作区 node_modules 无 settings 服务包，跨插件读 `llm-pi-ai` 配置域可行性存疑 | **决策 2（已确认）**：quotaGroup/tier **改放 model-router 自家配置域**（顶层 `providerMeta` + route hop 内联），零跨插件依赖；settings 读取降级为可选增强（v0.9.0 再评估） |
| F-2 | **F-6 adapter UI 可见性未验证**：`registerConfigurableProviders` 强制 `settingsNs/settingsPath`；dsh 模型选择器是否显示无 key adapter 未知；且注册后 `registry.refreshProviders` 会把 `dsh-model-router` 的虚拟模型纳入候选展开（污染策略扩展与面板） | F 段推迟；v0.9.0 先 spike（空 adapter 注册看 UI）+ registry 按 provider id 排除虚拟 provider |
| F-3 | **B-1 与 probe 重复造轮子**：`probe.js` 已有 `singleRaw`（PROBE_MARK 透传 + createUserMessage + 超时 + finish 解析）与 `runBenchmark`（QPS 阶梯），B-1 的 `_single`/`_rpm_for` 与之重叠 | B-1 改为**编排层**：4-phase 状态机 + 端点，底层复用 probe 原语（修正 CHANGES.md「~400 行全新模块」的估算） |

### 1.3 稳定性维度（3 处）

| # | 发现 | 结论 |
|---|------|------|
| S-1 | **【高危】A-1 基线错误**：文档声称 failoverSignals 6 项，实际 10 项（多 `QUOTA/TRANSPORT/SERVER/UNKNOWN`，v0.6.0 对齐实机错误码）；若按文档目标值整段替换会删掉既有 4 项 → 429/5xx 不再切换 | A-1 修正：**在现有 10 项末尾追加 `INVALID_REQUEST` 一行**，严禁整段替换 |
| S-2 | **INVALID_REQUEST 语义过宽**：涵盖所有非 quota/context 的 400（含「请求构造错误」等不可切换错误）→ 全链快速试错 | 接受（有 `failoverBudgetMs` + `maxRetries` 兜底）；验证矩阵补「全链同错收敛」用例；消息级细分留 v0.9.0 |
| S-3 | **B-1 rpm 探测共享上游 RPM 池**：探测触发 429 的冷却窗口内生产请求同样受限（A-2 实测同池共享） | rpm phase 结束时自动 `_waitRecovery`；README 明示「rpm 探测短暂占用目标供应商速率配额」；默认不自动跑 |

### 1.4 可维护性维度（4 处）

| # | 发现 | 结论 |
|---|------|------|
| M-1 | **测试基线错误**：实际 `test/unit.test.mjs` 有 61 个 test()，文档三处数字矛盾（43 / 52 / 59）→ 验收标准失效。**复核（2026-09-07 二次审核）**：运行 `node --test test/unit.test.mjs` 输出 `# tests 61 / # pass 61 / # fail 0`，61 为实测定值。**v1.3 实证定案（二次审核 REVIEW-REVISION-v2 对照）**：`DSH-model-router-main/test/unit.test.mjs`（GitHub 审查副本）`node --test` = 61/61 全绿、grep `^test(` = 61；审核方在 `design/` 副本实测 43——**两数各自在各自副本为真，属副本不一致，非基线写错**（`lib/` diff=0 但 `test/` 未同步）。**实施前必须统一三处基线副本**：以 61 为准，同步 `design/` 与部署版 test 文件（补 18 条）后再实施 | D-1 修正：基线 **61**，验收数字一律 61+N |
| M-2 | **文档内部矛盾**：A-3/C-1 标「被 F 段取代」却保留在批次与测试清单；B-1「1.3 带 PROBE_MARK」与「2.4.4 不走 wrapper」自相矛盾（测试请求必经 wrapper，不带标记会被 failover + 记账污染） | 本修订版统一口径：A-3/C-1 恢复保留；loadtest **必须带 PROBE_MARK 走透传** |
| M-3 | **F-5 mode 与 v0.7.0 mode 命名冲突**：顶层 `mode`(stable/balanced/fast) 与 `modes[]`/`rule.mode` 字段重叠、优先级未定义；wrapper 读全局 config 不支持 per-rule 参数 | **决策 3（已确认）**：统一为单一体系（v0.9.0 落地）——v0.7.0 三档并入 `modes[]` 作内置模式，顶层 `mode` 变「全局默认」，rule.mode 优先；wrapper 按命中 rule 解析参数（+3~4h）。**v0.8.0 保持现状 3 档不动** |
| M-4 | **细节笔误**：B-2 端点 `req.method === === 'GET'` 语法错误；quotaGroup 双重读取路径（route 内联 + provider meta）增加心智负担 | B-2 代码修正；C-2 设计为「route 内联优先 → providerMeta 兜底」单一路径语义 |

---

## 2. 调整思路（修订后的方案）

### 2.1 版本拆分（决策 4，已确认）

- **v0.8.0**：实测验证过的修复 + 三大目标。全部项可在本版独立验证、独立回退。
- **v0.9.0**：F 段（UI 集成）。需要 adapter 注册 spike、规则绑定重构、mode 单一体系改造——风险高、验证周期长，单独一版。

### 2.2 决策 1：规则命中语义（保留 provider/model + 默认旁观）

- `rule.match` 保留可选条件：`provider`、`model`、`default`（删除 `sessionIds`、`hours`、`strategy`——功能退路在代码注释中标注，恢复成本低）。
- **默认不注入 default 规则**：无规则命中时 wrapper 走既有纯透传路径（`failoverCandidates.length === 0 → passthrough`，零行为改变）。
- 用户写 `match: {default: true}` 才全接管。
- 保留 `strategy` 字段兼容期：存在则忽略不报错（warn 一次），用户平滑迁移。

### 2.3 决策 2：quotaGroup/tier 配置域（自家配置）

```yaml
model-router:
  # 顶层映射：provider → 元数据（主渠道）
  providerMeta:
    apikey-202606301659:
      quotaGroup: apikey-st      # 共享 RPM 池的 provider 组（同账号）
      tier: free
    apikey-202608290333:
      quotaGroup: apikey-st199
      tier: free
    minimax-cn:
      tier: paid-baseline        # 付费，loadtest 默认跳过
  rules:
    - match: { default: true }
      route:
        - { provider: apikey-202606301659, model: deepseek-v4-flash }
        # route hop 可内联覆盖（单条特例优先于 providerMeta）：
        # - { provider: apikey-202606301659, model: kimi-k3, quotaGroup: apikey-st }
```

- **读取路径**：`registry._profileMeta(provider)` = `cfg.providerMeta[provider]` 兜底 route hop 内联 → 全在自家配置域，**不跨插件读 settings**。
- **schema 校验**：`providerMeta` 为可选对象；`quotaGroup`/`tier` 非空字符串；`tier ∈ {free, paid-baseline, unknown}` 宽松校验（默认 unknown）。
- C-2 相应简化为：`metaSnapshot()` / `registeredPairs()` 携带元数据，数据源 `cfg.providerMeta`（不再是 settings 服务）。
- **README 双示例**（避免用户混淆，E-1 落地）：同时展示「v0.7.0 习惯：在 settings.yaml 的 provider 配置配 quotaGroup（被忽略，仅示意）」与「v0.8.0 实际路径：在 model-router.providers[*].quotaGroup / providerMeta 配」，标注后者为唯一生效路径。

### 2.4 A-1 修正：基于实际 10 项追加

```js
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
  // v0.8.0 新增：DSH httpErrorCode(400, 非 quota/context) 归 INVALID_REQUEST
  'INVALID_REQUEST',
],
```

### 2.5 B-1 修正：loadtest 作为编排层复用 probe 原语

- 新增 `lib/loadtest.js`（~150 行，非 400 行）：`LoadTestRunner` 4-phase 状态机（probe / rpm / context / quota-group）+ `snapshot()` + `abortAll()`。
- **底层复用**：`probe.js` 的 `singleRaw()`（带 PROBE_MARK 透传、createUserMessage、超时、finish 解析）与 `runBenchmark()` 阶梯逻辑；`_rpm_for` 直接封装 `runBenchmark` 的 ramp 语义。
- **探针请求必带 `PROBE_MARK`**（修正 CHANGES.md 2.4.4 的反向描述）：否则被 wrapper 正常拦截 → failover + 记账污染生产状态。
- 默认 `tierFilter: ['free']`（不烧付费 token）；显式 `POST {tiers:['paid-baseline']}` 才测付费。

### 2.6 C-1 恢复保留（F-6 推迟后无冲突）

- `router.candidates()`：`healthReorder` → `converged` 收敛（slice(0,1)）→ quotaGroup 去重（按 chain 顺序保留每 group 第一个）→ 返回。
- 顺序决策：先收敛再去重；healthReorder 在去重前（避免保留同组不健康项）。
- `checkProviderModel` 保留 `key` 与新增 `quotaGroup` 字段（route 内联）。

### 2.7 A-3 恢复保留（F-5 推迟后无冲突）

- `normalizeConfig` 记录 `hasExplicitMaxRetries`（`fp.maxRetries !== undefined`）——**弃用 CHANGES.md 的 `=== 2` 哨兵**（用户显式给 2 会被误覆盖的缺陷）。
- `apply()` 仅在 `!hasExplicitMaxRetries` 时回填 `Math.max(quotaGroupCount * 2, 5)`，log.info 明示。

### 2.8 G1/G2/G3 按原设计执行（与原计划一致）

- **G1**：`lib/daily.js`（DailyLedger + DailyReporter + 调度），wrapper 透传路径 try/finally 兜底记账 + 同步 `quota.record`（口径统一），routes 报告接口 + `?l1=1` 摘要，index 装配调度；稳定性评级 S/A/B/C/D/N/A。实现注意：**调度沿用现有 `setInterval` 风格**（与 index.js 一致，v1.3 修正——不引入 `ctx.interval` 新 API 用法；`ctx.interval` 统一迁移列为可选清理项）；**持久化复用 store 路径**（`~/.deepseek-harness/home/model-router-state.json`，避免新文件锁）；**报告格式用 NDJSON 按天追加**（便于追加与查询）；时区复用 v0.5.0 已有 `timeZone` 字段，不新加。
- **G2**：`client.js` 五页签三级结构（概览摘要卡 → 明细页签 → 工具折叠区），轮询分级（概览 5s 轮 `?l1=1`，明细页全量）。
- **G3**：`deploy.ps1`/`undeploy.ps1`（PS5.1 兼容、无 BOM UTF-8 追加、`id: model-router` 精确幂等）+ README Windows 章节（端口示例统一 3081）+ CI 三平台 matrix。
- 附带修复：`wrapper.js` sessionId 赋值 bug（`state = { ..., sessionId: seed.sessionId }`）。

### 2.9 开源项目调研对照（v1.2 并入；只对照、不引入）

> 调研全文见《开源项目调研-参考价值评估.md》（3 类 20+ 项目）。结论一句话：**市面上无「直接采用」即可达成同样效果的现成项目**（「DSH 插件内嵌、agent/request + llm/stream 两层正规入口拦截、流式安全切换」形态独一无二）；约 5 个设计点与调改预期相关，仅以「对照翻源码」方式进入实施。

**不引入边界（防 bug 硬约束，实施全程有效）**：

1. **零第三方依赖**：不新增任何 npm 包 / 独立服务 / 网关；调研结论不改变既有「不变量」（两层入口拦截、PROBE_MARK 透传、commit-on-substantive）。
2. **零默认行为变更**：`failoverSignals` 10 项保持、`mode` 3 档保持、watchdog 超时判定不默认改动（v0.8.0 无对应变更项）。
3. **翻源码仅作对照**：实施中查看外部源码只用于「确认既有实现与成熟做法一致」；若发现差异，先提风险项评审，**不得直接照搬改码**。

**5 个借鉴点 → 落到本计划的位置**：

| # | 借鉴点 | 来源 | 落地方式（不引入代码，只校准口径/判据） |
|---|---|---|---|
| 1 | first chunk arrival timeout 语义（首分片超时预算 → fallback） | robust-llm-chain | 批 3 前抽 0.5h 对照其超时判定源码，核对既有 watchdog 超时语义与 G1 稳定性评级中的时延判据；有差异走风险评审，不直接改码 |
| 2 | 按 provider×model 的用量聚合 + 每日/月度报告 | LiteLLM DailyUserSpend、AIWatch | G1 daily.js 聚合层与报告格式的**口径参照**（按日 bucket、按供应商×模型聚合、稳定性评分维度），实现仍走自有 DailyLedger |
| 3 | 面板指标体系（request volume / latency / costs / error rates 四元组） | Portkey、Langfuse | G2 概览摘要卡**字段口径对齐**：5 张摘要卡 = 四元组 4 项（请求量/延迟/成本/错误率）+ 插件特有 1 项（切换/熔断状态），批 5 实现时按此命名 |
| 4 | fallback chain + token budget + 限流自动跳转 | freellmapi | **零变更**：仅用于验证既有 failoverSignals + quota 窗口设计与其同构，无需调整 |
| 5 | 双层冷却（key 级 + 实例级） | Higress | **仅记录对照项**：v0.8.0 **不新增**实例级冷却维度（避免行为变更）；列入 v0.9.0 可选增强评估 |

**明确排除项**：Higress / Kong / Envoy 类云原生网关与插件场景架构差异过大，仅取其机制作后续版本参考；claude-code-router 等绑定外部生态（Claude Code），拦截逻辑无法复用，仅 v0.9.0 选包路由的「路由标记 + 日志上报」模式可参考（前提仍是 §5 的字段传导性 spike 通过）。

---

## 3. 实施方式（批次与依赖）

### 3.1 依赖图

```
A-1 (INVALID_REQUEST)           ─→ 独立
A-2 (providerMeta 配置域)       ─→ 独立（schema + 文档）
C-2 (registry 读 providerMeta)  ─→ 依赖 A-2
C-1 (router quotaGroup 去重)    ─→ 依赖 C-2
A-3 (maxRetries 公式)           ─→ 依赖 C-2
B-1 (loadtest 模块)             ─→ 依赖 probe 原语（已存在）
B-2 (loadtest wiring)           ─→ 依赖 B-1
G1 (daily.js)                   ─→ 独立（wrapper 注入可选 daily，测试传 null 兼容）
G2 (client.js 分级)             ─→ 依赖 G1（报告接口 + l1 摘要）
G3 (PS 脚本 + CI)               ─→ 独立
D-1 (单测)                      ─→ 依赖 A-1/A-2/A-3/B-1/C-1/C-2/G1
E-1 (README/CHANGELOG)          ─→ 依赖所有
```

### 3.2 实施批次（每批独立可测，跑 `node --test` 回归）

| 批 | 内容 | 依赖 | 工作量 | 说明 |
|----|------|------|--------|------|
| **批 1（独立/低风险）** | A-1（10 项追加一行）+ A-2（providerMeta schema + 校验 + 文档）+ G3（deploy.ps1/undeploy.ps1 + README Windows + CI workflow） | 无 | ~3h | 三个互不干扰的独立项，先落地止血 |
| **批 2（quotaGroup 链）** | C-2（registry 读 providerMeta + metaSnapshot）+ C-1（router 去重）+ A-3（maxRetries 公式，hasExplicitMaxRetries 语义） | 批 1 的 A-2 | ~2.5h | 核心路由路径，逐项带单测 |
| **批 3（G1 数据层）** | `lib/daily.js`（DailyLedger + DailyReporter + 调度 + 持久化 + 时区换算算法） | 无 | ~4h | 体量最大模块；先写单测跑绿；批前 0.5h 翻源码对照（§2.9 借鉴点 1/2） |
| **批 4（G1 接入）** | wrapper 透传包装 + try/finally 兜底记账 + 同步 quota.record + sessionId 修复；routes 报告接口 + `?l1=1` 摘要 + version 去硬编码；index 装配调度 + 启动补生成 | 批 3 | ~3h | 涉及核心切换路径，回归重点 |
| **批 5（G2 面板）** | client.js 五页签三级结构 + 概览摘要卡 + 报告页签 + 工具下沉 + 轮询分级 | 批 4 | ~3h | 纯前端，手写 h() 零构建 |
| **批 6（loadtest + 收尾）** | B-1（loadtest 编排层复用 probe）+ B-2（端点 + wiring，修正笔误）+ D-1（全部新增单测）+ E-1（README/CHANGELOG）+ 全量回归 | 批 2、批 4 | ~3h | 收尾验证 |

**总工作量：~20–25 工时**（批次合计约 18.5h；批 3/4 各加 0.5h buffer；含 spike：透传 PROBE_MARK 集成验证、报告时区换算实机核对、LiteLLM/robust-llm-chain 翻源码对照约 0.5h——与 §0 总量口径一致）。

### 3.3 风险分布（修订后）

| 风险 | 变更项 | 应对 |
|------|--------|------|
| **中** | B-1（loadtest 打真实 API）/ C-1（router 核心路径）/ C-2（新配置域读取）/ G1（新模块 + 调度）/ G2（前端重构） | 每批独立可回退；loadtest 默认关闭、tier 过滤免费；G1 默认 `enabled:false`；G2 保留原页签语义 |
| **低** | A-1（追加一行）/ A-2（纯配置）/ A-3（仅默认值）/ B-2（纯端点）/ G3（脚本）/ D-1 / E-1 | 单点回退 |

---

## 4. 验收标准

### 4.1 测试基线（修正）

- 基线：`test/unit.test.mjs` **61 条**（实际已核实，非 CHANGES.md 的 43）。
- 新增：A/B/C/D/E 系 9 条 + G 系 15–20 条（daily 聚合/评级边界/透传兜底/口径断言/report 接口/l1 摘要/PS 幂等逻辑等）。
- **验收数字：全量 `node --test test/unit.test.mjs` ≥ 85 条全绿**（61 + 24~29）。

### 4.2 分层验证矩阵

| 层 | 工具 | 期望 |
|---|---|---|
| 静态 | `node --check lib/*.js` | 0 错 |
| 单元 | `node --test test/unit.test.mjs` | ≥ 85/85 全过（基线 61 + 新增） |
| 集成 | dsh 加载 + `curl --noproxy '*' http://127.0.0.1:3081/api/model-router/status` | 200，无崩溃循环 |
| 实战 | 路由链含 opencode/deepseek-v4-flash-free 触发 `code=INVALID_REQUEST` | 切下一候选（A-1） |
| 实战 | settings 配 providerMeta 后看 log | `maxRetries auto-tuned: 2 → 5 (quotaGroupCount=2)`（A-3） |
| 实战 | `curl POST .../loadtest -d '{"phase":"probe"}'` | 202 + 默认只测 free；跑完 status 的 cooldown/metrics **不增加**（PROBE_MARK 透传） |
| 实战 | rpm phase 触发 429 | 记录 lastOkRpm + first429Rpm；结束后自动等待恢复（mock 上游 429 响应 + sensenova 实测 30s 冷却 sleep） |
| 实战 | `POST /api/model-router/reports/generate` | 立即生成昨日报告（G1，**依赖 daily.js 已实现**） |
| 实战 | 面板概览页 | 5 张摘要卡；概览态 5s 轮询 `?l1=1` 轻量接口；明细页全量 |
| 实战 | **多会话并发** | 并发 10 路请求（共享/独立 sessionId 混合）后，daily 聚合与 quota 累加**数字准确**（口径一致性关键测试） |
| 实战 | Win10 运行 deploy.ps1 | 幂等安装（备份、无 BOM UTF-8、`id: model-router` 精确追加、重载提示不自动执行） |
| CI | GitHub Actions 三平台 × Node 22/24 | `node --test` 全绿 |

### 4.3 各批验收要点

- **批 1**：A-1 单测 `INVALID_REQUEST 触发 failover`；A-2 单测 `providerMeta 校验分支`；G3 在 Win10 实机验证脚本幂等。
- **批 2**：C-1 单测 `quotaGroup 去重（4 项 → 3 项）` + `无 quotaGroup 保序`；C-2 单测 `registeredPairs 携带元数据` + `未声明默认 null/unknown`；A-3 单测 `auto-tune` + `用户显式 maxRetries=2 不被覆盖`（hasExplicitMaxRetries）。
- **批 3/4**：daily 日界换算（跨时区/跨日）、评级规则边界、透传 `recordCall(inSequence:false)` + usage 捕获、**注入 throwing 迭代器验证 try/finally 兜底不跳过**、**透传同步 `quota.record` 断言（口径一致）**、sessionId 修复断言、报告接口 403/400/200、`?l1=1` 摘要字段。
- **批 5**：面板五页签可达性——原功能（规则编辑/保存、探测、压测、用量窗口、日志、模型）在分级后全部可达。
- **批 6**：loadtest 4-phase 各自产结果结构正确；端点 GET/POST/DELETE 分支；重复 POST 409；全量回归。

### 4.4 回退策略

每项独立可回退（详见各变更节）。整体回退顺序：B-2/B-1（删 loadtest 模块与端点）→ A-1（删末项）→ A-3（删 apply 回填）→ C-1（删 seenGroups 循环）→ C-2（删 _profileMeta）→ A-2（删 providerMeta schema）→ G1（删 daily 模块 + wrapper 恢复 `yield* next()`）→ G2（client.js 还原）→ G3（删脚本与 CI 任务）→ D-1/E-1（撤测试与文档）。

**回退后状态：与 v0.7.0 diff = 0。**

---

## 5. 待 v0.9.0（F 段预留）

本版不实施，但设计已冻结，避免 v0.8.0 埋下冲突：

1. **规则绑定传递**（L-1 修复，**需重新设计，非简单附加字段**）：候选方案——
   - (a) agent/request 返回 payload 附加 `__mr_rule: ruleName`，wrapper 优先 `router.byName(__mr_rule).route`；**前提**：spike 验证 dsh-llm 不过滤该字段（PROBE_MARK 是先例但被 wrapper 消费、不传给底层，性质不同，不能直接类推）；
   - (b) wrapper 启动时维护 `map<seedModel, ruleName>`，agent/request 拦截时记录——**前提**：seed.model 唯一对应 rule，用户改路由后需失效重建；
   - (c) F-8 选包场景：agent/request 层**动态注入**选中的 rule 作为本次请求的 default（呼应原始需求「选了包=接管，不选=不接管」）。
   - **v0.9.0 启动前必须先闭环此设计并 spike 验证 (a) 的字段传导性**；选 (b) 需额外处理路由热更新。
2. **mode 单一体系**（决策 3）：v0.7.0 的 stable/balanced/fast 并入 `modes[]` 作内置模式（保留 label），顶层 `mode` 变「全局默认」，rule.mode 优先；wrapper 按命中 rule 解析参数集（改造点：watchdog/budget/cooldown/maxRetries 从全局 config 改为 per-request 解析）。
3. **adapter 注册**（F-6）：先 spike 两项——①空 adapter 注册后 dsh UI 是否显示虚拟模型（无凭据 provider 的可见性）；②settings namespace 注册可行性（plugin 无权注册 `llm-pi-ai` ns，需验证自建 ns 是否可行）；registry 按 provider id 排除 `dsh-model-router`；adapter 纯展示层（listModels 暴露虚拟包、stream 收到虚拟 id 仅解析 route[0] 透传），不实现 failover 循环。
4. **自命名与默认命名**（F-3/F-4/F-7）：`rule.name` 可选 + `rule-N` 自动命名 + 重名 fail-fast。
5. **选包路由**（F-8）：agent/request 解析 `__pkg:<ruleName>` → 绑定规则 → wrapper 按绑定规则 failover；「选普通模型 = 不经路由」在「默认不注入 default」语义下自然成立。

---

*本修订版（v1.3）为 v0.8.0 唯一实施依据。批 1–批 6 按 §3.2 顺序实施，每批完成即回归；§2.9 的「只对照、不引入」为实施全程硬约束；实施首步为统一三处基线副本（以 61 为准）。*
