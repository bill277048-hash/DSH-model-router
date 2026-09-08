# Changelog

## 0.8.0 (2026-09-07)

- **G1 每日 API 报告**：日账本 NDJSON 按天追加 + 每日凌晨 1 点调度生成昨日报告（可配 `reports.hour`）
  - 稳定性评级 S/A/B/C/D/N/A；按供应商×模型聚合（calls/失败/切换/token/时延/错误码分布）
  - 三渠道交付：文件（`~/.deepseek-harness/home/model-router-reports/`）+ 面板「每日报告」页签 + API
  - 接口：`GET /reports`、`GET /reports?l1=1`（面板轻量摘要）、`GET /reports?day=YYYY-MM-DD`、`POST /reports/generate`
  - 默认 `reports.enabled=false`，零记账零调度，独立可回退
- **G2 面板信息分级**：五页签三级结构（概览摘要卡 → 明细页签 → 工具折叠区）
  - 概览 5 张摘要卡：健康总览 / 今日运行 / 昨日报告 / 熔断速览 / 规则速览
  - 轮询分级：概览态 5s 轮询 `?l1=1` 轻量接口，明细页才全量拉取
- **G3 Windows 适配**：`deploy.ps1` / `undeploy.ps1`（PS5.1 兼容、无 BOM UTF-8、`id: model-router` 幂等）+ CI 三平台 matrix
- **A-1**：`failoverSignals` 基于实际 10 项末尾追加 `INVALID_REQUEST`（DSH httpErrorCode(400, 非 quota/context)），严禁整段替换
- **A-2**：新增 `providerMeta` 配置域（`quotaGroup`/`tier`，自家配置域不跨插件读 settings）；route hop 内联优先
- **A-3**：`maxRetries` 自动调优——未显式声明时回填 `max(quotaGroupCount×2, 5)`；显式声明（含显式 2）一律尊重
- **B-1/B-2**：按需负载测试 `lib/loadtest.js`（4-phase：probe / rpm / context / quota-group），复用 probe 原语
  - 端点 `GET/POST/DELETE /api/model-router/loadtest`；默认只测 free tier；rpm 触发限流后自动等待恢复
  - 所有探针请求带 PROBE_MARK 直透——跑完 cooldown/metrics/quota/daily 零污染
- **C-1**：`router.candidates()` 按 `quotaGroup` 去重（同组保留链序第一个）
- **C-2**：registry `registeredPairs()`/`metaSnapshot()` 携带 `quotaGroup`/`tier` 元数据
- 附带修复：`wrapper.js` sessionId 未赋值 bug；透传路径 try/finally 兜底记账；status `version` 去硬编码
- 测试：86 项全过（基线 61 + 新增 25：A-2/A-3/C-1/C-2 8 项、G1 12 项、B-1/B-2 5 项）

## 0.7.0 (2026-09-04)

- 新增 mode 预设（v0.7.0）：`stable` / `balanced` / `fast`，面板一键切换
  - `stable`：watchdog 60s / 预算 300s / cooldown 120s / 配额冷却 900s
  - `balanced`（默认）：watchdog 30s / 预算 90s / cooldown 60s / 配额冷却 600s
  - `fast`：watchdog 15s / 预算 45s / cooldown 30s / 配额冷却 300s
- 模式预设只覆盖 watchdog/budget/cooldown/quotaCooldown；不动规则链与 maxRetries
- 已 open 的熔断器在切换模式时保留生效中冷却时长（防切换瞬间重置熔断状态）
- `routes.js` state POST 支持热切换 `mode`（cfg.mode 原地更新 + applyPolicy）
- `config.js` mode 校验（VALID_MODES）+ normalizeState 透传
- `client` 规则页：三按钮分段切换 + 说明行 + header 模式徽章
- 测试：61 项全过（新增 mode 预设 / cooldown applyPolicy 保留生效中冷却 2 项）

## 0.6.1 (2026-09-04)

- 配额感知自动切换（v0.6.1）：
  - `Cooldown` 配额类错误（`QUOTA`）单独阈值 1 次即 open、冷却 600s；
    `RATE_LIMIT` 走常规阈值 3 次 / 60s
  - 首选 open 时 seq 直接从首个可用候选发起（`llm/stream`）；half-open 期满自动回归
  - 切换总预算 `failoverBudgetMs`（默认 90s），每跳 watchdog = min(firstTokenTimeoutMs, budgetLeft)
  - 看门狗 60s → 30s
- 测试：58 项全过（新增配额冷却、首选跳过、fail 兜底透传、预算压缩 4 项）

## 0.6.0 (2026-09-04)

- 会话标题三级解析（v0.6.0）：live 折叠 → `ctx.get('sessionQuery').readTitleSnapshots`
  → 持久化日志直读（zstd 拼接帧容器解码）
- `cfg.sessionsDir` 默认 `/Users/apple/.deepseek-harness/sessions`
- `resolver` 改异步；`routes` await
- 测试：54 项全过（含 tmpdir 构造真实 zstd 容器的第 3 级测试）

## 0.1.0 (2026-09-03)

- 首个可测版：P0+P1+P2 全语义 + P3/P4 观测最小实现
- finish 分片驱动 failover、commit-on-first-chunk、TTFT 看门狗、cooldown 三态、
  链耗尽收敛、force-first 兜底、用量记账（可视）、`/api/model-router/status` 状态接口
- 16 项单元测试全过；三轮设计审核 16 个问题全部闭环