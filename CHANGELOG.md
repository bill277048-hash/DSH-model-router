# Changelog

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