# Release Notes — @botton/dsh-model-router v0.8.0

> DSH 多供应商模型路由插件。规则路由 + 首 token 前无感故障切换 + cooldown 熔断 + 用量记账。
>
> **v0.8.0 主题：看得见、管得住、跑得动** —— 每日 API 报告、面板信息分级、Windows 适配、按需负载测试。

---

## 亮点摘要

- 📊 **G1 每日 API 报告**：每日凌晨 1 点自动汇总前一日（0:00–23:59）全部 API 调用，按供应商 × 模型给出稳定性评级（S/A/B/C/D/N/A）与 token 用量评价
- 🖥️ **G2 面板信息分级**：概览摘要卡 → 明细页签 → 工具折叠区的三级结构，重要信息优先可见，轮询负载分级
- 🪟 **G3 Windows 适配**：PowerShell 部署/卸载脚本（Win10+），CI 三平台（Ubuntu/macOS/Windows × Node 22/24）
- 🧪 **B 按需负载测试**：4-phase 状态机（probe / rpm / context / quota-group）一键测各供应商模型的路由链路与速率边界
- ⚙️ **A/C 路由增强**：`INVALID_REQUEST` 错误码归并、`providerMeta` 元数据配置域、`maxRetries` 自动调优、quotaGroup 去重

---

## 新功能

### G1 每日 API 报告

自动记录所有调用（含故障切换序列与纯透传路径），生成昨日报告：

- **稳定性评级**：按调用数 + 失败率评级 S/A/B/C/D/N/A（A 以上为可放心使用）
- **聚合维度**：供应商 × 模型（calls / 失败 / 切换次数 / token 用量 / 平均时延 / 错误码分布）
- **三渠道交付**：本地文件（`~/.deepseek-harness/home/model-router-reports/`）+ 面板「每日报告」页签 + HTTP API
- **独立可回退**：默认 `reports.enabled: false`，开启后零配置自动调度（默认凌晨 1 点，可用 `reports.hour` 调整）

```yaml
reports:
  enabled: true
  hour: '01:00'
```

```bash
curl -s 'http://127.0.0.1:3081/api/model-router/reports'                     # 摘要 + 今日实时
curl -s 'http://127.0.0.1:3081/api/model-router/reports?l1=1'               # 轻量（面板概览卡轮询）
curl -s 'http://127.0.0.1:3081/api/model-router/reports?day=2026-09-06'     # 指定日报告
curl -s -X POST 'http://127.0.0.1:3081/api/model-router/reports/generate'   # 立即生成昨日报告
```

### G2 面板信息分级

状态面板重构为五页签三级结构：

- **概览**：5 张摘要卡（健康总览 / 今日运行 / 昨日报告 / 熔断速览 / 规则速览），5 秒轮询轻量接口
- **切换规则 / 切换日志 / 可切换模型**：明细页签，工具（健康探测、TRM 压测、用量窗口）下沉至折叠区
- **每日报告**：日期下拉选择（近 30 天）、供应商 × 模型表格、错误码分布、一键立即生成

### G3 Windows 适配

- 新增 `scripts/deploy.ps1` / `undeploy.ps1`（PowerShell 5.1 兼容、无 BOM UTF-8、`id: model-router` 幂等部署）
- CI 流水线扩展为三平台 matrix（Ubuntu / macOS / Windows × Node 22/24），跨平台回归保障

### B-1/B-2 按需负载测试

手动触发的 4-phase 负载测试（复用健康探测原语，探针请求带 PROBE_MARK 直透——**跑完不污染** cooldown/metrics/quota/日账本）：

| phase | 用途 |
| --- | --- |
| `probe` | 存活 / 首 token 时延探测 |
| `rpm` | QPS 阶梯找 RPM 边界（记录 `lastOkRpm` / `first429Rpm`，触发限流自动等待恢复） |
| `context` | 多尺寸上下文接受度（长上下文闸门粗测） |
| `quota-group` | 同组（共享速率池）成员联动探测 |

```bash
curl -s -X POST 'http://127.0.0.1:3081/api/model-router/loadtest' \
  -H 'content-type: application/json' -d '{"phase":"probe"}'
curl -s -X POST 'http://127.0.0.1:3081/api/model-router/loadtest' \
  -H 'content-type: application/json' -d '{"phase":"rpm","tiers":["free"]}'
curl -s -X DELETE 'http://127.0.0.1:3081/api/model-router/loadtest'   # 中止
```

> 安全默认：**默认只测 free tier**（不烧付费 token）；`tiers` 显式传入才测其他档。重复 POST 返回 409。

### A 系列：故障切换增强

- **A-1**：`failoverSignals` 追加 `INVALID_REQUEST`（DSH httpErrorCode(400, 非 quota/context) 归此类）——修复 400 类错误不切换的盲区，共 11 个触发码
- **A-2**：新增 `providerMeta` 配置域（`quotaGroup` / `tier` 元数据，自家配置域不跨插件读 settings；route hop 可内联覆盖）
- **A-3**：`maxRetries` 自动调优——未显式声明时按 `max(quotaGroupCount × 2, 5)` 回填；**显式声明（含显式 2）一律尊重**

```yaml
providerMeta:
  deepseek:  { tier: 'paid-baseline', quotaGroup: 'primary' }
  glm:       { tier: 'free',          quotaGroup: 'primary' }   # 同组 → 候选去重只留链序第一个
```

### C 系列：路由与元数据

- **C-1**：候选按 `quotaGroup` 去重——同一速率池的模型不再重复排入候选链，故障切换更精准
- **C-2**：registry 注册表输出携带 `quotaGroup` / `tier` 元数据（`registeredPairs()` / `metaSnapshot()`）

---

## 修复

- `wrapper.js` sessionId 未赋值 bug（尝试级记账引用空值）
- 透传路径异常时记账遗漏（try/finally 兜底，透传与切换统一 quota/日账本口径）
- status 接口 `version` 去硬编码（读 package.json，避免版本漂移）
- **部署实测修复（v0.8.0 内）**：
  - `providerMeta` 持久化链路打通（normalizeState 白名单丢弃 → 加白名单字段；store 读回；启动覆盖；`POST /state` 热生效；status 回显）
  - registry 装配漏传 config 导致实机元数据失效

---

## 接口变更

- 新增 `GET/POST/DELETE /api/model-router/loadtest`
- 新增 `GET /api/model-router/reports`（`?l1=1` / `?day=YYYY-MM-DD`）与 `POST /reports/generate`
- `GET /status` 的 `config` 块新增 `providerMeta` 回显

## 兼容性说明

- 默认行为零变更：10 项既有 failoverSignals、3 级 mode、看门狗超时判定均未改动（仅末尾追加 `INVALID_REQUEST`，严禁整段替换）
- 零新增第三方运行时依赖（`@deepseek-ai/dsh-llm` 仍由 DSH 宿主提供）
- `reports.enabled` / `probe.enabled` 默认关闭，功能可独立回退
- 旧 store 文件（无 `providerMeta` 键）向后兼容，不会重置 patch 配置

## 测试

- **90 项单元测试全过**（`node --test test/unit.test.mjs`）
- CI 三平台（Ubuntu / macOS / Windows × Node 22/24）持续回归
