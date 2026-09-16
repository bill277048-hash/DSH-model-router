# Changelog

## 0.9.11 (2026-09-17)

> **v0.9.10 Task 2：路由节流（按声明 rpmLimit；不读 observed）**。
> 声明优先（OQ1 决策）：路由用 `providerMeta[provider].rpmLimit` 限速，**不读** observed。

### 新增 · 路由节流（`lib/router.js`）

- `Router` 构造新增 `metrics` 参数（注入式，避免隐式依赖）
- `candidatesForRule` 末尾（**最后一道过滤**）调用 `throttleByDeclared(chain)`
- `throttleByDeclared(chain)` 判定规则：
  - 数据源：`metrics.snapshot().recent`（近 60s 滚动窗口）
  - 阈值：`recentCount >= declared * 0.9`（90% 软上限，OQ7 默认）
  - 优先级：route hop 内联 `rpmLimit` > `providerMeta[provider].rpmLimit`（与既有 v0.8.0 A-2 一致）
  - **声明为 null**（未声明）→ 不节流
  - **metrics 未注入 / snapshot 抛错**→ 不阻塞（容错优先）

### 关键设计决策

- **末尾过滤**（在 healthReorder / contextReorder / dedupeByQuotaGroup 之后）→ 保证上游已清理的链不会被重新插入
- **只做 RPM 节流**——TPM 节流**待 Task 3** 提供 token 用量数据后启用（当前 `metrics.recent` 仅有请求计数）
- **容错优先**——metrics 缺失 / snapshot 抛错均不阻塞路由（fail-open）

### 单测

- 189 → **196**（+7 条）：
  - 未声明 rpmLimit → 不过滤
  - 达 90% 软上限 → 跳过该 hop
  - 超过 60s 窗口的采样不计入
  - route hop 内联 rpmLimit 优先于 providerMeta
  - metrics 未注入 → 不过滤（容错）
  - metrics.snapshot() 抛错 → 不阻塞（容错）
  - `candidatesForRule` 端到端集成
- **突变验证**（3 组全有效）：
  - 阈值改 0（永远不节流）→ 4 条变红
  - 去掉 60s 窗口过滤 → 1 条变红
  - 优先级反转（hop 内联 → providerMeta）→ 1 条变红
  - 还原 → 196/196

### 踩坑记录

🔴 **`Metrics.sample()` 不接受 `ts` 参数**：
初版测试用 `sample({ts: ...})` 模拟历史采样，但 `metrics.js:66` 写死
`new Date().toISOString()`——参数 ts **不生效**。
**修测试**：删 ts 参数；用 `r._now = sampleNow + 30_000` 让窗口基准后移，
让 sample ts（在 now 之前 30s）落入 60s 窗口内。

🔴 **同名冲突**：
- `Router` 已在 line 15 import → 不要重复
- `makeRouter` 已有 → 用 `makeRouterT2` 区分

## 0.9.10 (2026-09-17)

> **渠道档案 schema 一次到位 · Task 1：providerMeta 新增字段**。
> 声明优先（OQ1 决策），实测仅作提示，**不引入 schemaVersion 递增**（迁移成本归零）。

### 新增 · providerMeta 声明字段（6 个）

| 字段 | 类型 | 校验 |
| --- | --- | --- |
| `rpmLimit` | 正整数 | >10000 警告"是不是填错单位" |
| `tpmLimit` | 正整数 | 同上 |
| `resetPolicy` | `{ window, at? \| rollingSec? }` | `window ∈ {minute, hour, day, rolling}`；hour/day 必填 HH:MM `at`（复用既有 `HHMM_RE`）；rolling 必填 `rollingSec`（1-86400） |
| `resetPolicySourceUrl` | URL | 必须 `http(s)://`（拒绝 javascript:/data:/file:） |
| `tpmLimitSourceUrl` | URL | 同上 |
| `notes` | string | 长度上限 500（防 DoS） |

- **route hop 内联**同步支持（与既有 `quotaGroup`/`tier`/`quotaWindows`/`customWindows` 同模式）
- **既有字段 100% 保留**（quotaGroup / tier / quotaWindows / customWindows / exclude）

### 新增 · 校验函数（`lib/config.js`）

- `validateResetPolicy(rp, where)` —— 三种窗口分支校验
- `validateSourceUrl(url, where)` —— 仅 http(s)://（XSS 边界）
- `validateRateLimit(value, field, where)` —— 正整数 + 单位过大警告（返回 `{value, warn?}`）

### 关键设计决策

- **`validateRateLimit` 返回 `{value, warn?}`**（不直接调 log）—— **避免隐式依赖外层 log**（踩坑后修正：测试未传 log → ReferenceError）
- **复用既有 `HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/`**（config.js:62）—— 与 `hours.start/end` 同一正则，比朴素 `/^\d{2}:\d{2}$/` 严格（拒绝 `25:00`）
- **`version: 1` 不变**（D4 决策红利）—— 旧 store 文件 **完全兼容**，不需要 patch

### 单测

- 185 → **189**（+4 条）：
  - 合法 rpmLimit/tpmLimit/resetPolicy/SourceUrl/notes 全覆盖
  - 14 种非法值各自抛错（含具体的错误信息正则断言）
  - **兼容旧 store**（v0.9.9 无新字段不报错）
  - route hop 内联同样校验
- **突变验证**（3 组全有效）：
  - rpmLimit 不校验非正 → 2 条变红
  - resetPolicy window 校验失效 → 1 条变红
  - SourceUrl http(s) 校验失效 → 1 条变红
  - 还原 → 189/189

### 踩坑记录

**🔴 `validateRateLimit` 隐式依赖外层 `log`**：
初版写 `log?.warn?.(...)` 假设外层作用域有 `log`，但测试调用 `normalizeConfig({providerMeta:{...}})` 没传 `log` → `log is not defined` → ReferenceError。
修：改为返回 `{value, warn?}`，主流程决定是否打日志——**解耦**。

**🔴 Edit 工具误删半个函数**：
中间删 `validateResetPolicy` 末尾时锚点不精准，把 `return out; }` 与后面的 `validateSourceUrl` 注释粘到了一起 → 导致 `validateResetPolicy` 提前终止、`validateSourceUrl` 缺注释。
修：用更长的 old_string（含跨函数内容）锚定。

## 0.9.9.5 (2026-09-16)

> **「测试档案」页签上线**（v0.9.9 收口 Task 7 + 8）。前端消费 v0.9.9.4 的两个端点；
> 三类档案（模型测试 / 负载测试 / 健康探测）可罗列 + 点行看详情。
> 至此 **v0.9.9 的「档案」部分完成**（cosmic-forging §6-2 全项）。

### 新增 · 「测试档案」页签（Task 7）

- `TABS` 追加 `{ key: 'archives', label: '测试档案' }`（第 8 个页签，紧随「模型测试」）
- 新增 `ArchivesPanel` 组件（与既有 `ModelTestPanel` 同模式）：
  - 挂载即拉 `GET /test-archives`（轻量列表）
  - **按 kind 三组**展示（模型测试 / 负载测试 / 健康探测），组内时间倒序（后端已排序）
  - 每行显示 `runId` / 时间 / 大小；空组显示「暂无档案」
  - **点行开详情**（选中行高亮 + `cursor: pointer`）
  - 刷新按钮 + 错误提示

### 新增 · 三个详情视图（Task 8）

新增 `renderArchiveDetail(detail)`，按 kind 分支：

| kind | 展示内容 |
| --- | --- |
| `model-test` | 目标数 / 相 / 是否中断 + **targets 表**（provider / model / verdict / 分）+ Markdown 原文折叠 |
| `loadtest` | 已完成相列表 + 每相的目标数与时间 |
| `probe` | 探测目标数 / 是否启用周期探测 + **entries 表**（目标 / 状态 / 成功总 / 最近探测） |

- **不强行复用** `ModelTestPanel` 内的内联渲染器（那是内联实现，抽取会引入重构风险）——
  本组件按 kind 写简洁视图（Enforce Simplicity）
- **所有文本走 `h()` 子节点**，全文件无 HTML 直通（源码级断言守住）

### 改进 · 命名消歧（方案 §6-2 要求）

- `ArchiveDrawer` 标题：`模型档案 · <provider>` → **`窗口限额档案 · <provider>`**
- 与新页签「测试档案」区分——两者都叫「档案」但语义不同
  （窗口限额档案 = 渠道的限额声明；测试档案 = 一次跑批的结果）

### 单测

- 184 → **185**（+1 条）：
  `v0.9.9.5 Task7/8: client——archives 页签 / ArchivesPanel / 详情渲染 / 命名消歧 契约存在`
  （源码级断言，与既有 v0.9.8 client 测试同模式）
- **mock React runtime**：8 个页签（含新 `archives`）全部渲染成功、无抛错

### 踩坑记录

初版 `renderArchiveDetail` 的注释写了「绝不 innerHTML」—— 触发既有源码级断言
`assert.equal(/dangerouslySetInnerHTML|innerHTML/.test(src), false)`（**注释也会被匹配**）。
→ 改措辞为「不使用 HTML 直通」。
**教训**：源码级断言的 pattern 会匹配注释，写注释时要避开被断言的敏感词。

## 0.9.9.4 (2026-09-16)

> **档案端点上线 + 路径穿越漏洞加固**（v0.9.9 收口 Task 5 + 6）。
> 新增 2 个端点；**同时修复一个既有的路径穿越漏洞**（`/model-test/manual`）。

### 🔴 安全修复 · 既有路径穿越漏洞（`/model-test/manual`）

- **漏洞位置**：`lib/routes.js` 的 `/model-test/manual` 端点
- **成因**：原实现直接 `join(reportDir, `${runId}.model-test.json`)`，而 `runId` 来自
  POST body —— `validateManualInput`（`lib/model-test.js:154`）只校验**非空字符串**，
  **不校验格式**
- **影响**：`runId = "../../../tmp/evil"` 可通过校验 → `archiveWriteAtomic` 写该路径
  → **任意文件写**（后缀限 `.model-test.json`）；需回环访问（`guard` 已限制）
- **修复**：改用新增的 `archive.safeArchivePath`（**双校验**）
- **验证**：红→绿 —— 退回加固前状态 → `not ok 184`；恢复 → 184/184

### 新增 · `archive.js` 安全辅助

- `assertSafeRunId(runId)` —— **第一道防线**：白名单正则 `/^[\w.-]+$/`（不含 `/` `\`）+
  显式拒 `..`（正则允许 `.`，故需单独拒）+ 长度上限 200
- `safeArchivePath(dir, kind, runId)` —— **第二道防线**：`resolve()` 归一化后必须仍在
  `dir` 内（`startsWith(base + sep)`）。即使第一道被绕过也能兜住
- `listArchives(dir)` —— **轻量 lister**：只 `stat`（文件名 + mtime + size），
  **不读档案内容**（实测读 9 个档案全文需 466ms，stat 为 0ms）；只扫 `ARCHIVE_KINDS`
  白名单后缀（忽略同目录的 `.ndjson` / `.report.md`）；按 mtime 倒序

### 新增 · 端点（Task 5 + 6）

| 端点 | 说明 |
| --- | --- |
| `GET /api/model-router/test-archives` | 三类档案轻量列表 → `{ ok, items, archiveDir }`；item 含 `kind`/`runId`/`size`/`startedAt` |
| `GET /api/model-router/test-archives/detail?kind&runId` | 详情 → `{ ok, kind, runId, report, markdown }`；**kind/runId 双校验**（非法 → 400，文件不存在 → 404） |
| `GET /api/model-router/model-test/list` | **保持为兼容别名**（响应结构 `{ok, list, reportDir}` 不变）—— 面板历史报告依赖 `list[].targets`（`client.js:2379`），故仍走「读全文 + targets 摘要」 |

- markdown 仅 `model-test` 有（loadtest/probe 只落 json）→ 其他 kind 返回 `markdown: null`
- 错误响应**不泄露具体路径**（统一文案）

### 单测

- 178 → **184**（+6 条）：
  - `assertSafeRunId`：合法通过；空/非字符串/`../`/`a/b`/`a\b`/`..`/`a..b`/超长 均被拒
  - `safeArchivePath`：合法在目录内；非法 kind；穿越；绝对路径
  - `listArchives`：三类识别 + 忽略 ndjson/report.md/md + 按 mtime 倒序 + 空目录/不存在目录
  - `/test-archives` 端点：列表 200 / 非回环 403
  - `/test-archives/detail` 端点：合法 200（含 md）/ probe 无 md / **穿越 400** / 非法 kind 400 / 缺参 400 / 404
  - `/model-test/manual`：**穿越 runId → 400**（加固验证）/ 合法但不存在 → 404
- **红→绿验证（安全关键，方案 §6.3 判据 13）**：
  退回加固前状态 → **4 条变红**（179/180/183/184）；恢复 → 184/184

## 0.9.9.3 (2026-09-16)

> **loadtest / probe 结果落盘**（v0.9.9 收口 Task 3 + 4）。三类档案
> （model-test / loadtest / probe）至此全部落盘，统一 `kind` + `schemaVersion`。
> 零破坏性变更。

### 改进 · `loadtest` 结果落盘（Task 3）

- `LoadTestRunner` 构造新增 `reportDir`（由 `index.js` 用 `archive.resolveArchiveDir(cfg)` 注入）
- **每个 phase 跑完落盘一次**（`run()` 的 `finally` —— 即使 phase 抛错也落盘已完成部分）
- **实例级 `runId` + 覆盖写**：loadtest 是用户逐 phase 手动触发的（POST 逐个 phase），
  累积成一份「完整负载测试报告」比每 phase 一份更符合直觉
- 档案内容：`kind` / `schemaVersion` / `runId` / `startedAt` / `finishedAt` / `elapsedMs` /
  `aborted` / `phases`（已完成列表）/ `results`（各 phase 结果）
- **只落 json**（无 md）

### 改进 · `probe` 健康快照落盘（Task 4）

- `ProbeBoard` 构造新增 `reportDir`（同 Task 3 注入方式）
- **一轮探测完成落盘一次**（`runAll()` 的 `finally`）
- **实例级 `runId` + 覆盖写**：探测是周期高频的（默认 300s 一轮），每轮一份会**无界堆积磁盘**；
  健康快照的价值在「当前状态」，故覆盖写
- 档案内容：`kind` / `schemaVersion` / `runId` / `startedAt` / `finishedAt` / `elapsedMs` /
  `targetCount` / `enabled` / `entries` / `benchmarks`
- **只落 json**（probe 是快照数据，md 价值低 —— 方案 Open Question 3）

### 新增 · `archive.resolveArchiveDir(cfg)`

- 优先 `cfg.reports.dir`，否则 `~/Documents/dsh-model-router-reports`（与 `lib/daily.js:77` 一致）
- **不依赖 `reports.enabled`** —— 那是「每日报告」开关，与档案落盘是两回事：
  用户可能不开每日报告，但仍希望跑批结果落盘可见

### 单测

- 170 → **178**（+8 条）：
  - `resolveArchiveDir` 四种入参（有 dir / 无 dir / 无 reports / 无 cfg / 空字符串）
  - loadtest：跑 phase 后落盘含 `kind`/`schemaVersion`/`runId`；多 phase 覆盖同一档案（累积不新增）；
    `reportDir=null` 不落盘不抛错；落盘失败不阻塞跑批
  - probe：`runAll` 后落盘含 `kind`/`schemaVersion`/`entries`；多轮覆盖同一档案；
    `reportDir=null` 不落盘；重入保护仍生效
- **突变验证**（4 组全有效）：
  - loadtest 不写 `kind` → 1 条变红
  - loadtest 不在 `finally` 落盘 → 2 条变红
  - probe 不写 `schemaVersion` → 1 条变红
  - probe 每轮新 `runId`（破坏覆盖写）→ 1 条变红
  - 还原 → 178/178

### 修正的测试误判（记录）

初版 probe 落盘测试断言 `entries['p/a'].ok === true` —— 实测 `undefined`。
核实 `ProbeBoard._record`（`lib/probe.js:178`）：它把单次 rec 转成**聚合结构**
（`{total, success, consecutiveFails, status, ttfts, ...}`），**无 `ok` 字段**。
**是测试断言写错，非实现错** —— 改为断言 `status === 'up'` / `total === 1` / `success === 1`。

## 0.9.9.2 (2026-09-16)

> **档案统一 schema + 消除三套重复实现**。新增 `lib/archive.js` 公共模块；
> 三类档案（model-test / loadtest / probe）落盘统一带 `kind` + `schemaVersion`。
> 零破坏性变更（旧档案读取端自动回退 `kind='model-test'`）。

### 新增 · `lib/archive.js`（档案公共模块）

- `ARCHIVE_KINDS = ['model-test','loadtest','probe']` 白名单
- `KIND_SCHEMA_VERSION = 1`
- `archiveName(runId, kind, ext)` → `<runId>.<kind>.<ext>`（非法 kind 抛错）
- `kindOfFilename(name)` → 反向解析（白名单外返回 `null`）
- `writeAtomic(target, content, log)` → 原子写（.tmp + rename）
- `persistReport(reportDir, {runId, kind, jsonBody, mdBody}, log)` → 统一落盘，
  失败/参数不全返回 `null`（不阻塞跑批）

### 修复 · 消除三套重复的原子写实现

本仓库此前有**三处**独立实现同一逻辑：

| 位置 | 函数 | 处置 |
| --- | --- | --- |
| `lib/model-test.js:657` | `writeAtomic`（私有） | 删除，改用 `archive.writeAtomic` |
| `lib/routes.js:993` | `writeFileSyncAtomic` | 删除，改用 `archive.writeAtomic` |
| `lib/archive.js` | `writeAtomic`（新） | 唯一实现 |

同时消除 `lib/model-test.js:persistReport` 与 `lib/routes.js:persistModelTestDir`
的**两套落盘逻辑**——现统一走 `archive.persistReport`。

> **顺带修正的不一致**：原 `model-test.js:persistReport` 的 JSON 里含 `file` 字段
> （`{...report, file: jsonTarget}`），而 `routes.js:persistModelTestDir` 不含——
> 两条路径产出格式不一致（既有缺陷）。统一后**均不含** `file`（该字段无人消费，已 grep 确认）。
> 注：`report.file` / `report.md` 运行时字段**仍回置**（契约不变）。

### 改进 · 档案统一 schema

- `model-test` 落盘顶层加 `kind: 'model-test'` + `schemaVersion: 1`
  （两条路径：`lib/model-test.js:runReport` 与 `lib/routes.js:/model-test` 端点）
- **向后兼容**：旧档案无 `kind` → 读取端按 `'model-test'` 处理（`kindOfFilename` 返回 `null` 时由调用方兜底）

### 单测

- 166 → **170**（+4 条）：
  - `archiveName` 命名 + 非法 kind 抛错
  - `kindOfFilename` 反向解析（`.ndjson` / `.report.md` / `.model-test.md` 均返回 `null`）
  - `persistReport` 落盘含 `kind`/`schemaVersion`；参数不全/非法 kind 返回 `null` 不抛错；probe 类无 md
  - `writeAtomic` 原子写（无 `.tmp` 残留）
- **突变验证**：
  - `kindOfFilename` 白名单失效 → 1 条变红
  - `archiveName` 不校验 kind → 1 条变红
  - 同时移除 `persistReport` + `archiveName` 的白名单（组合突变）→ 2 条变红
  - 还原 → 170/170
  - 注：单独移除 `persistReport` 白名单是**等价突变**（`archiveName` 为第二道防线）

## 0.9.9.1 (2026-09-16)

> **修一个 P0 + 段列上线**。行为变更：空 `provider` / `model` 不再被
> `normalizeTimeWindows` 放行——与 `rules[].route` 走同一校验函数（`checkProviderModel`）。
> 「切换明细」表新增「段」列（cosmic-forging §十一 验收判据）。
> 零破坏性变更。

### 修复 · `normalizeTimeWindows` 放行空 provider/model（P0，真 bug）

- **现象**：v0.9.9 实施时 `lib/config.js:47` 留了 TODO「复用 checkProviderModel...留待」，但未完成。
  校验只查 `typeof === 'string'`，**不查非空**——`{provider:"", model:""}` 被放行。
- **可达路径**：面板「+ 添加候选」在 `knownPairs` 为空（registry 未就绪）时，默认值
  `{provider:"", model:""}` → 提交后通过 → 存入空 route。
- **修复**：`normalizeTimeWindows` 改用 `checkProviderModel` 校验 route hop，与
  `rules[].route`（`config.js:549`）走同一函数。两条路径校验强度一致。
- **保留**：合法 route 的 `quotaGroup` / `tier` / `key` 内联字段（`checkProviderModel` 会提取）。
- **单测红→绿**：回退到 buggy 版 → 新断言 `not ok 165`；恢复 fixed → 166/166 全绿。
- **影响范围**：`lib/config.js`（1 处替换）+ `test/unit.test.mjs`（v0.9.9 用例扩展为 v0.9.9.1）。
  总数 166 → 166（v0.9.9 用例被同名替换/扩展）。

### 改进 · 切换明细「段」列（Task 1b，cosmic-forging §十一 验收判据）

- **背景**：v0.9.9 已在 `metrics.recent[].segment` 写入了峰/谷段（wrapper 4 处采样），
  但前端表格未渲染——半成状态。
- **改动**：「切换日志」页签的切换明细表头 7 → 8 列（耗时与会话之间加「段」）。
  单元格显示「峰」「谷」「—」（`segment` 为 `null` 或缺字段时显示 `—`）。
- **保留**：既有 7 列的取值与顺序**不变**；既有 `r.sessionId` 列等。

### 未做

- v0.9.9 收口的其余 9 项 Task（详见 `docs/v0.9.9-实施方案.md`）——按既定节奏分批推进。

## 0.9.9 (2026-09-16)

> **极简峰谷定价 + 配置持久化补全**。新增 `timeWindows` 字段（峰谷两段完整候选链），新契约 1 项：
> `POST /api/model-router/state` body 含可选 `timeWindows` 字段；`GET /api/model-router/status` 回显
> 现算的 `segment` 与 `nextBoundaryAt`。缺省行为与既有完全兼容（仍跑 4 相），无破坏性变更。

### 改进 · 极简峰谷定价（问题 1，方案 §6-1）

**结构**（`lib/config.js` `DEFAULT_CONFIG` 与 `normalizeTimeWindows`）：

```js
timeWindows: {
  enabled: false,
  peakStart: "09:00", valleyStart: "22:00",
  peak:   { route: [{ provider, model }, ...] },   // 峰段：完整候选链
  valley: { route: [{ provider, model }, ...] },   // 谷段：完整候选链
}
```

**消费点（关键：放 `matchRule` 末尾）**：`router.js` 新增 `segmentOf` / `segmentOfNow` / `segmentChain`；
`matchRule` 返回处统一收口（**一处覆盖 4 个消费者**：match / matchName / candidates / pickPrimary）。

- **半开区间 [peakStart, valleyStart)**：跨零点按 `t >= peak || t < valley` 处理，
  两段拼接完整 24 小时，无重叠无缝隙。峰谷点相等 → 抛错。
- **优先级**：段 `route` **整体替换**候选链，不引入「段 strategy 覆盖原规则」的组合语义；
  `__segment` 仅内存，绝不写回 config / store。
- **包模式（`__mr_rule` 绑定 / `__pkg:`）不受段影响**——与 v0.9.7 `exclude` 的边界一致。
- **时区取 `config.timeZone`**（null = 系统），与既有时间窗同口径。

**记录点**：`wrapper/index.js` 4 处 `metrics.sample` 与 `daily.recordCall` 全部写入
`segment`（peak / valley / null）。`metrics.js` rec 增加 `segment` 字段，向后兼容（缺省 null）。
`/status` 回显现算的 `segment` + `nextBoundaryAt`（ISO 时间戳）。

### 改进 · 配置持久化补全（顺手修 v0.9.8 §十三-9 已知问题）

- `timeWindows` 接入 store 白名单（`store.js loadState` 与 `index.js` 合并点），跨重启保留。
- 顺手修 `timeZone` 与 `mode` 持久化断链（v0.9.8 已知但未修，本次一并补）。

### 新增 / 改进端点

- `GET /api/model-router/status` 回显 `timeWindows: { enabled, peakStart, valleyStart, segment, nextBoundaryAt, tz }`
  —— `segment` 与 `nextBoundaryAt` 由 routes 侧用 `segmentOf` + `localHHMM` **现算**，不落 config
- `POST /api/model-router/state` 接受 `timeWindows`（与现有 `reports` / `providerMeta` 同模式）
- 峰谷点相等 → `400 + 含具体错误信息`

### 前端 · 峰谷 UI（替换原「时间窗口径」块）

- 总开关 checkbox + 两个 `input type="time"`（峰起 / 谷起）+ 当前段指示徽章
- 峰 / 谷两套候选链编辑（双 select + 删除按钮 + 添加按钮，provider/model 联动）
- 峰谷点相同 → 实时校验提示
- **主保存 body 必须包含 `timeWindows`**（§十四-7；未提交时由后端兜底为保留 patch 值）

### 单测

- 154/156 → **166/166**（新增 10 条行为断言）：
  - `segmentOf` 半开区间（含跨零点）/ 未启用 → null / 缺字段 → null
  - `segmentOfNow` 实例方法复用 config 与 `_now` 注入
  - `segmentChain` 未启用/段无 route → null
  - `matchRule` 段链路合成 `__segment` 规则
  - **`pickPrimary` 在段启用时返回段 route[0]**（v0.9.8.1 留底断言）
  - 包模式 `byName` 不受段影响
  - `normalizeTimeWindows` HH:MM / 峰谷不等 / route 结构校验
  - `normalizeState` 透传 / `normalizeConfig` 拒非对象
- **突变验证**（证明测试是有效的）：
  - 反相 `segmentOf` → 5 条用例变红
  - 禁用段链路 → 2 条用例变红（matchRule + pickPrimary）
  - 还原 → 166/166

### 风险与未做

- 未做任意时段列表 / 多窗口叠加（极简峰谷两段制满足典型作息）
- 未做段级 `ruleName` / `strategy` 覆盖（方案 §十四-5 砍掉：递归风险 + 实机 `rules=[]` 时无规则可名）
- 未做 v0.9.9 方案 §6-2 的「统一测试档案」——按既定节奏推迟到 v0.9.9.1 或 v1.0.0

## 0.9.8.1 (2026-09-16)

> **测量修正版**。`context` 相改为**隔离执行**（提前到 `rpm` 相之前），消除 `rpm` 相的
> TPM 消耗对上下文容量测量的污染。新增 `PHASE_EXEC_ORDER` / `phaseOrder`；契约顺序不变。
> **行为变更**：`context` 相拿到容量类错误时，现在会同时跳过 `rpm` 与 `quota-group`（此前只跳后者）。

### 修复 · `context` 相测量被前序相污染（问题定位）

- **现象**：实机 ST-rrx（`apikey-202606301659`）/ ST-rrx199（`apikey-202608290333`）的
  `deepseek-v4-flash` 在 `model-test` 报告中 `context` 相为「1024 ✓ / 8192 ✗ RATE_LIMIT」，
  初看像「上下文越长越易限流」。
- **根因**：上游错误消息（v0.9.8 起透传）为 `inference exceeds tpm/rpm limit`（code `429001`）
  ——**是 TPM（tokens per minute）类限流，不是「输入过长」**。而 `rpm` 相是最多 4 档 × 5 样本的
  阶梯压测，跑完已大量消耗 TPM；`context` 相排在其后，测到的「能否接受 N tokens」被前序消耗污染。
- **佐证**：同一渠道的 `glm-5.2` 在同批测试中 `8192 ✓` 全通过——说明不是该渠道整体受限，
  且耦合是「渠道 × 模型」级属性。

### 修复 · 相间隔离

- 新增 `PHASE_EXEC_ORDER = ['probe', 'context', 'rpm', 'quota-group']`（**执行顺序**）与
  `orderPhasesForExecution(phases)` 辅助函数（均导出）。
- `_runTarget` 改为按**执行顺序**遍历；`context` 相在 `rpm` 相之前执行，测量不再被污染。
- **契约顺序不变**：`MODEL_TEST_PHASES`（`validatePhases` 返回值 / 面板勾选顺序 / 报告 `phases` 字段）
  仍是 `probe → rpm → context → quota-group`，既有消费者不受影响。
- 新增 `phaseOrder` 字段（report 级与 target 级），报告 md 显式标注「执行顺序」，
  避免「报告里的相顺序与勾选顺序不一致」被误读为 bug。
- `routes.js` 的 `listRunJson` 透传 `phaseOrder`，供面板历史报告渲染。

### 实机 A/B 对照验证（隔离有效性的直接证据）

同一渠道、同一模型、同一测试内容（`context` 相 8192 tokens），**唯一变量是执行顺序**：

| 条件 | 执行顺序 | `context` 相 8192 结果 |
| --- | --- | --- |
| 隔离**前**（报告 `2026-09-16T00-46-57-oqdp`） | `rpm` → `context` | **8192 ✗ `RATE_LIMIT`**（`maxAccepted=1024`） |
| 隔离**后**（本版实机复测） | `context` → `rpm` | **8192 ✓**（`maxAccepted=8192`） |

- 目标：`apikey-202606301659`（ST-rrx）/ `deepseek-v4-flash`
- 结论：**此前的 8192 失败源于前序 `rpm` 相的 TPM 消耗，与「上下文长度」无关**。
  这也构成「不把上下文长度作为独立限制维度」的实证依据（见方向性方案 4.7 第 2 点）。
- 附：同批验证 `report.phases=["rpm","context"]`（契约序）而 `report.phaseOrder=["context","rpm"]`（执行序），
  两者分离符合设计。

### 变更 · 短路语义更保守

- `context` 相位于 `rpm` 之前后，其短路影响范围扩大：拿到 `CONTEXT_LENGTH` / `CONTEXT_WINDOW` /
  `TOO_MANY_TOKENS` 时，现在会跳过 `rpm` **与** `quota-group`（此前只跳 `quota-group`）。
- **语义上更合理**：模型容量都不够，测速率无意义。

### 变更 · `skipped` 顺序规范化

- `skipped` 收集时按执行序 push，`_finalize` 现按**契约顺序**重排，与 `phases` / `notSelected`
  三者同序，便于面板对照展示（`skipReasons` 是对象，顺序无关）。

### 单测

- 154 → **156**（新增 2 条）：
  - 「`context` 相隔离执行（在 `rpm` 之前）」——断言执行序、契约序不变、`phaseOrder` 记录正确、
    `orderPhasesForExecution` 对子集同样按执行序排列。
  - 「短路语义随执行序变化」——断言 `context` 容量类错误现在跳 `rpm` + `quota-group`。
- 既有 2 条断言随执行序更新（`called` 顺序）。
- **突变验证**：把 `PHASE_EXEC_ORDER` 改回契约顺序（即取消隔离）→ 4 条用例变红；
  还原后 156/156。

### 未做的

- **未改** `MODEL_TEST_PHASES`（契约顺序）——避免破坏面板与既有 API 消费者。
- **未扩展** `context` 相粒度（仍是 1024 / 8192 两档）——隔离后精度问题降级，
  容量上限探测排在 v1.x（见方向性方案 6-C）。

## 0.9.8 (2026-09-16)

> **诊断可见 + 测试精度提升**。6 项面板/链路改进；含 1 项独立 phase 选择 + 1 项退避重试 +
> 1 项短路表 + 1 项错误消息透传。新契约：仅 `POST /api/model-router/model-test` 的可选 `phases` 入参；
> 缺省行为与既有完全兼容（仍跑 4 相），无破坏性变更。

### 改进 · 切换明细可分组 + 诊断页签（问题 1）

- 根因：当前面板只展示最近尝试（每条独立行），用户看不到「这是同一会话的第几次尝试」与
  「上一跳是哪家供应商」。`metrics.sample` 记录的 `rec.seq` 是**全会话单调递增**，不是同一请求内的 hop 序号。
- 修复：增加 4 个结构化字段到 `metrics.sample` 的 rec：
  `seqId`（同一请求会话级唯一 ID）、`prevProvider`/`prevModel`（上一跳）、`switched`（本次是否由前一跳切来）。
  **不加 `segment`**——那是 v0.9.9 峰谷定价的内容，本版不提前耦合（单测显式断言 `'segment' in r === false`）。
- `runAttempt` 函数体顶部把 `prevProvider/prevModel` 抽成 `metaFields`，7 处采样统一补字段——
  不动各采样点的写法，最小改动。`switched` 由「真实前序 vs 当前 provider/model」比较得出，
  不用 `attemptIndex` 猜。
- seq 循环入口算 `prevHop = i>0 ? seq[i-1] : seed`；首次尝试时 `prevProvider/prevModel = seed`，
  因此首跳 `switched=false`，与方案既定一致。
- **透传路径（无候选直连）也采 1 条 metrics**：`seqId` 由 caller 注入、`prevProvider/prevModel = null`、
  `switched: false`。避免「无切换明细行」实际是「未采集」造成假阴性。
- 透传路径的采样点共 3 处，互斥（gate 命中 `return`、catch 分支 `throw`、正常结束 fall through），
  不会重复计数——已有单测断言「透传正常路径只采样一次」「透传 throw 只采样一次」。
- 入口 `allBlocked`（全部窗口限额耗尽）另采 1 条 QUOTA 失败记录，避免「链耗尽计数有值但明细为空」；
  该分支不重复调用 `quota.record`，无重复配额记账。
- 前端切换日志页签：**新增「诊断」页签**（原 `切换日志` / `切换规则` / `可切换模型` 之后）。
  工具折叠区（探测 / 压测 / 用量窗口）从 `logs` 迁到 `diag`；统计 / Cooldown / 最近尝试仍留 `logs`。
  最少改法：logs 外层 `if (activeTab === "logs")` 加 `|| "diag"`；工具区单包 `if (activeTab === "diag")`。
  **不搬那 229 行** hyperscript，避免括号与作用域风险。
- 最近尝试改为「按 seqId 分组」**平铺表格**（非折叠交互）：每组一个跨列组头行
  （`请求链 · N 次尝试 · M 次切换 · @会话 · seqId`），其下逐跳列出
  时间/从/到/结果/错误码/耗时/会话。分组保留**「无切换的 passthrough 行」**——
  它显示「同一请求只此一跳」更直观。无 `seqId` 的旧记录用 `seq-<seq>` 兜底分组。

### 改进 · 报告结构化（ReportView，删 md 解析器，§5-2）

- 根因：原前端用 `markdown` 字段渲染面板，需在前端跑一遍 md→HTML 解析器（~110 行），
  才能把表格解析回 DOM。**实测 `/api/model-router/reports?day=2026-09-14` 返回顶层就有
  `{ok, report: {summary, byProviderModel[], errors[]}, generated, markdown}`**——`markdown`
  就是从 `report` 结构生成的（`lib/daily.js:541 formatReportMarkdown`）。
- 修复：直接渲染 `body.report` 结构化数据，`markdown` 字段降级为「收起」的原 md 全文作为附录
  （`<details>` + `<summary>查看 Markdown 原文（审计）</summary>`）。
  **日报页签**渲染为：summary 关键指标行 + 「按供应商 × 模型」表（**10 列**：供应商/模型、评级、
  调用、失败、成功率、TTFT 均值、P95 TTFT、token(入/出)、切换调用、主要错误）+
  「错误码分布」区块 + 原始 JSON 受控 details。
  **删除** `client.js` 里旧的 md→HTML 解析器（约 110 行）。
- 旧响应（只有 `markdown`、没有 `report`）走 fallback：渲染一个默认展开的
  `<details>Markdown 原文（旧响应兼容）</details>`，不让结构化数据缺失时页面变空。
- `loadReport` 加 `setReport(body.report)`；`sShowMd/showMd/setShowMd` 三处 state 随之删除
  （改为 `<details>` 原生折叠，不再需要独立 open state）。
- `summary.switchCount` 确认算法：`sum(r.attempts > 1 ? r.attempts - 1 : 0)`，
  与 `switchedCalls`（含切换的调用数）语义不同，前端展示「切换 N 次」取 `switchCount`。

> 注：**模型测试**页签的结果表是另一张表（7 列：模型、probe、RPM、Context、verdict/分、
> 失败原因、操作），与日报表无关，见下方「失败原因可读」段。

### 改进 · 失败原因可读（probe 透传 failure.message，§5-1）

- 根因：`/api/model-router/probe` 与 `model-test` 报告只显示 `errorCode`（如 `RATE_LIMIT`），
  用户看不到上游**具体错误消息**（如 `429: Rate limit reached for request`），无法判断是限流、
  模型不存在还是临时网络抖动。
- 修复：`lib/probe.js` 三处失败分支都补 `errorMessage`（行 77 / 81 / 93）：
  - `error finish`：`chunk.reason?.failure?.message`
  - `aborted` 分支：固定字符串 `'aborted'`
  - `catch` 分支：`error?.message`
- `ProbeBoard._record` 补 `lastErrorMessage`（`h.lastErrorMessage = rec.ok ? undefined : rec.errorMessage`）。
- `model-test` `_phaseProbe` 透传并截断 200 字符（避免报告膨胀）；`_phaseRpm` 补
  `firstError: {errorCode, errorMessage}`（ladder 每档也带 `firstError`）；
  `_phaseContext` 每项补 `errorMessage`；`_phaseQuotaGroup` 每个 member 补 `errorMessage`。
- **模型测试结果表**（7 列：模型、probe、RPM、Context、verdict/分、失败原因、操作）：
  - probe 单元格加 `title = probe.errorMessage`，鼠标悬停看完整原因；
  - 新增「失败原因」列：取**首个** `phaseErrors` 条目渲染为 `errorCode：errorMessage`
    （超过 48 字符截断为 `…`，完整内容在 `title`）；无错误时显示「跳过：<phase 列表>」；否则「—」。
    注意是「取首个」而非「按 errorCode 聚合」——聚合展示在报告 md 的「错误详情」段。
- `formatReportMarkdown` 新增「错误详情」段：逐 target 列出 `provider/model · phase · code：message`。

### 改进 · 模型测试退避重试（probe 仅，§5-3）

- 根因：probe 是单点探测——一次失败（如 502 / 网络抖动）就标记整 target 失败。
  真实环境瞬时错误占比 ~10%，加重试更准确。
- 修复：新增 `_singleWithRetry`（仅 `_phaseProbe` 用）：
  - `RETRYABLE` 错误码集合（**瞬时/传输类**）：`TRANSPORT`、`SERVER`、`UNKNOWN`、`TIMEOUT`、
    `ABORTED`、`STREAM_ERROR`、`EMPTY_RESPONSE`。
    **刻意不含** `AUTH`/`INVALID_CREDENTIAL`/`QUOTA`/`INVALID_REQUEST`/`RATE_LIMIT` 等确定性错误——
    重试无意义，只会拖长跑批。
  - 最多 3 次尝试（1 首次 + 2 重试）：`800ms` / `1600ms` 指数退避 + 最多 `250ms` 抖动（避免重试雷击）。
  - 首次即成功、或首次即确定性失败（非 RETRYABLE）时 `retries = 0`，直接返回。
- `_phaseRpm` / `_phaseContext` / `_phaseQuotaGroup` **不**重试——`_phaseRpm` 靠 `sleep(1000/qps)`
  控制请求密度来测限流边界，插入退避会让 `lastOkRpm` / `first429Rpm` 失真。

### 改进 · 模型测试短路表（避免白耗 ~90s，§5-3）

- 根因：probe 拿到 `INVALID_CREDENTIAL` / `QUOTA` 等硬错后，后续 rpm/context/quotaGroup 三相
  仍各跑 ~30s（合计 ~90s）——纯白耗，结果仍不会变。
- 修复：新增 `shouldShortCircuit(phase, error)` + 集中式 `SHORT_CIRCUIT_CODES` 表。
  语义：**某一相拿到该相集合内的错误码 → 记 `stopReason`，此后所有已选相都跳**（写入
  `outcome.skipped` + `outcome.skipReasons[phase]`）。
  - `probe` 相：`AUTH` / `INVALID_CREDENTIAL` / `MISSING_CREDENTIAL` / `INVALID_REQUEST` /
    `QUOTA` / `QUOTA_EXCEEDED` → **全停**（probe 是首相，故等效后续三相全跳）。
  - `rpm` 相：`QUOTA` / `QUOTA_EXCEEDED` → 跳 `context` + `quota-group`。
  - `context` 相：`CONTEXT_LENGTH` / `CONTEXT_WINDOW` / `TOO_MANY_TOKENS` → 跳 `quota-group`
    （不跳 rpm，rpm 已跑完）。
  - `RATE_LIMIT` **不在任何集合**——本相即测限流边界，越界即正常 verdict，不短路。
- **只依据真实 `errorCode`**，不从 `lastOkRpm === null` / `maxAccepted === 0` 这类派生字段反推
  （那些值可能来自 transport / auth / abort，反推会误判）。错误码来源见 `firstActualError(phase, result)`。
- `skipped`（短路跳过）与 `notSelected`（未勾选该相）是**两个独立字段**，不混淆；
  abort 时剩余相也记入 `skipped` 且 `skipReasons[phase] = 'ABORTED'`。
  `skipReasons[phase]` 存短路原因字符串（如 `skipped: INVALID_CREDENTIAL after probe`）。

### 改进 · 测试耗时按 target 计算（修既有 bug，§5-3）

- 根因：`ModelTestRunner._elapsed()` 始终用 `this.startedAt`（跑批起点）累加。
  多 target 跑批时 `target.elapsedMs` 累成 ~7M ms（不可读）；单 target 也因目标间 sleep 算入而虚高。
- 修复：`_runTarget` 入口起 `tStart = Date.now()`；最终 `outcome.elapsedMs = targetElapsed()`
  （即 `Date.now() - tStart`，只看本 target）。**删除了已无调用点的 `_elapsed()` 方法**。
- 跑批总量另存 `report.elapsedMs = this.finishedAt - this.startedAt`，与 `target.elapsedMs` 并存
  （前者看整批，后者看单 target）。
- 前端「最近一次报告」摘要行与历史列表各新增「耗时」列，消费这两个字段；旧报告 JSON 无此字段时显示 `—`。

### 改进 · 测试 phase 可独立选择（§5-4）

- 根因：硬编码 4 相都跑，但「只测健康度」或「只补 context 测」的诉求无法满足；跑了 4 相就慢。
- 修复：`POST /api/model-router/model-test` body 加可选 `phases: string[]`：
  - 缺省：`undefined` → 默认全跑 4 相（向后兼容）。
  - 子集：每个 phase 独立可选（用户确认）——只选 `rpm` 也实际跑 rpm，不隐式补 probe。
  - 非法：`validatePhases` 抛错（含 `[]`、含未知项、缺类型），返回 400。
- 常量 `MODEL_TEST_PHASES = ['probe', 'rpm', 'context', 'quota-group']` 与 `validatePhases`
  导出供面板消费。
- 前端 ModelTestPanel 新建表单新增 4 个 checkbox（API 健康探测 / 压力·RPM 阶梯 / 上下文窗口 /
  配额组联动），默认全选，按固定序 `probe→rpm→context→quota-group` 展示。
  - 提交时**全选则不发 `phases`**（走服务端缺省，与旧客户端行为完全一致）；
    **子集才发 `phases`**（`if (phases.length < 4) requestBody.phases = phases.slice()`）。
  - 未选任何相时提交按钮 disabled，并提示「请至少选择一项测试内容」。
  - 按钮文案「启动测试（N 个目标）」；旁边 meta 显示「已选 M 相」。
- 凭据黄条：扫描 `last.targets` 统计 `probe.errorCode ∈ AUTH/INVALID_CREDENTIAL/MISSING_CREDENTIAL`
  的目标数，顶部黄条「N 个目标为凭据类失败（上游 401/403），不是限流；请检查对应 provider 的 API key。」
  **局限**：只看 `probe` 相——若用户只勾 rpm/context（未跑 probe），黄条不会触发。

### 清理

- 删除 `POST /model-test` 里的 `prompt` / `timeoutMs` 死代码——routes 层透传但 `ModelTestRunner.run`
  从未读取，前端也不发（避免误导未来维护者）。
- 删除 `client.js` 的 `sShowMd` / `showMd` / `setShowMd` 三处 state——Markdown 改为 `<details>` 原生折叠。
- 删除 `ModelTestRunner._elapsed()`——改用 target 局部 `tStart`/`targetElapsed()`（见「测试耗时」段）。
- `run` 入口 `opts.recoveryMs` 透传保留；新增 `opts.phases` 透传（`validatePhases` 兜底校验）。
- `formatReportMarkdown` 新增两行摘要（「测试内容」「批次耗时」）与一个「错误详情」段
  （逐 target 列 `provider/model · phase · code：message`）。
- `listRunJson` 摘要补 `elapsedMs` / `phases` / `notSelected` / `skipped` / `phaseErrors`，
  以及各相 `firstError`，供面板历史报告渲染。

### 单测

- 新增 12 条用例（基线 142 → v0.9.8 共 154，全过）：
  - `validatePhases` 边界：缺省/`null` 全跑、去重 + 固定序、`[]`/未知项/非数组抛错。
  - `MODEL_TEST_PHASES` 常量完整。
  - **短路表行为**：凭据类 → 后续三相全跳（断言 `called` 调用序、`skipped`、`skipReasons`、
    `phaseErrors`）；`RATE_LIMIT` → 不短路跑满四相；probe 正常 → 全跑且 `skipped`/`phaseErrors` 为空。
  - **`_singleWithRetry` 行为**：首次成功、确定性错误（`INVALID_CREDENTIAL`）均不重试；
    `TRANSPORT` 重试到 3 次上限（真实等待 800+1600ms 退避）；中途成功即停；
    另加结构性检查「rpm/context/quota-group 三相不调用退避」。
  - **独立 phases 行为**：缺省全跑；`phases:['rpm']` 只跑 rpm 且 `probe === null`；
    `notSelected` 与 `skipped` 两字段分离。
  - **`elapsedMs` 行为**：给两个 target 各注入 40ms 延迟，断言第 2 个 target 的 `elapsedMs`
    不累加第 1 个的耗时（旧实现会 ≥ 2×延迟，直接变红）；整批 `report.elapsedMs` 覆盖两者。
  - `metrics.sample` 用**真实 `Metrics` 类**断言 4 字段落库与默认值，并显式断言
    `'segment' in r === false`（不提前耦合 v0.9.9）。
  - `probe.js` 透传 `errorMessage`（error finish + catch 分支，用真实 `singleRaw` + mock stream）。
  - `formatReportMarkdown` 的「错误详情」段含错误码与真实消息。
  - 客户端源码契约：诊断页签存在、`phases` 子集提交路径、Markdown fallback 存在、不引入 `innerHTML`。
- **测试有效性已用突变验证**（证明测试不是装饰）：分别注入
  ①「短路表移除 `INVALID_CREDENTIAL`」②「恢复旧 `_elapsed` 累加」③「`RETRYABLE` 置空」
  三个缺陷，对应用例均变红（153/154）；还原后 154/154。
- 测试总时长约 9.5s（退避用例真实等待 2.4s + 1.6s 退避，属预期）。

### 风险与未做的

- **未做** v0.9.9 段链路（峰谷定价）与统一测试档案新页签——按既定两版节奏延后。
  段链路启用后会改变 `pickPrimary` 的返回值（段 `route[0]` 而非原规则 `route[0]`），
  该不变式目前无断言覆盖；**v0.9.9 实施时必须补**「`pickPrimary` 一致」用例。
- **已知窄口径**：凭据失败黄条只读 `tr.probe.errorCode`。若用户只勾 rpm/context/quota-group
  而未跑 probe，黄条不会触发（即便 rpm 相实际撞到 AUTH）。属有意的最小实现，后续可扩展到
  `phaseErrors` 全相扫描。
- **已知口径差异**（既有代码，非本版引入）：透传路径 `catch` 分支中，
  新增的 `metrics.sample` 记真实 `error?.code ?? 'STREAM_ERROR'`，
  而同分支既有的 `daily.recordCall` 记硬编码 `'EMPTY_RESPONSE'`。
  两套账本对同一失败事件错误码不同。本版**未改动** `daily` 那行（避免超出范围），
  仅在「切换明细」与「每日报告」并列时可见差异。
- **更正（复核时自己引入的误报）**：早先本段记有一条「既有 bug：`/model-test/list` 返回
  `runs: []`」——**该结论是错的**。实际响应键名是 **`list`**（不是 `runs`），用正确键名读回
  **7 条报告**，且首条已含 v0.9.8 新增的 `elapsedMs: 1157595` / `phases: [...]` 字段。
  误报根因：未先确认响应结构就按假定键名断言。**列表功能正常，无需修复。**

## 0.9.7 (2026-09-15)

> **纯前端版本**（只改 `client.js`，后端零改动）。修复 v0.9.6 实装后用户报告的 3 项面板可用性问题。

### 修复 · 新建测试只能单目标（问题 1）

- 根因：**纯前端表单限制**。原表单是两个级联 `<select>`（provider + model），只能表达
  「单个 / 某 provider 全部 / 全部 provider 全部」三种粒度。**后端本就支持任意长度 targets 数组**
  （`lib/routes.js` 直透 `body.targets`、`lib/model-test.js` 逐元素校验并串行跑 4 相），
  所以这是纯 UI 限制，无需改后端。
- 改为**可增删的 target 行列表**：每行 provider 下拉 + model 下拉 + 删除（换 provider 自动清空该行 model）；
  工具栏保留批量添加入口（「＋ 添加该供应商全部模型」/「＋ 添加全部供应商全部模型」/「＋ 添加目标」/「清空」）
  —— 原「全部 provider / 全部模型」的便捷语义保留，但改由按钮承担，不再用 `""` 哨兵值表达。
- `(provider, model)` 自动去重并提示忽略数量；空列表禁止提交（按钮 disabled + 兜底提示）；
  提交按钮显示目标数；成功后保留 targets 便于对同一批复跑。
- 行 key 用 `useRef` 单调计数器而非数组 index —— 删行后 index 会错位导致输入框串值；
  且 key 在 state updater **外**生成，避免 StrictMode 双调用 updater 时计数器多推、key 错位。

### 修复 · 模型测试找不到「档案」（问题 2）

- 根因：**入口被藏在「有测试结果」的表格行内**。「档案」按钮的唯一渲染点位于结果表行内，
  而结果表要求 `displayTitle`（= `selRun || last`）成立，`last` 仅在跑完一次测试后才有值
  → 隐含「必须先跑一次测试才能填档案」。
- **把抽屉抽成模块级组件 `ArchiveDrawer`**，顶层只上提「打开哪个 provider」一个状态。
  结构性前提：`ModelTestPanel` 只在 `activeTab === "modelTest"` 时挂载、切页签即卸载，
  其内部 state 会销毁，抽屉无法留在它内部被跨页签复用。
- **在「切换日志 → 窗口限额」栏目新增「供应商档案总览」表**，列出**全部已注册 provider**
  （不只 `providerMeta` 里已声明的），每行一个「档案」按钮打开同一抽屉，**无需跑任何测试**。
- 模型测试页签头部补一句引导，指向新位置。
- ⚠ 抽屉挂载点必须在**所有页签条件块之外**：若误写进 `if (activeTab === "modelTest")` 块内，
  抽屉就只在模型测试页签渲染，从「切换日志」点「档案」将毫无反应。
- 抽出时的三处适配（第 3 处最易漏）：① `saveArchive` 内 `load()` → `props.onSaved()`；
  ② 关闭按钮 → `props.onClose()`；③ `resetWindow` 成功分支原为 `openArchive(provider)`
  （重开抽屉 = 重拉数据），组件化后 `props.provider` 不变、组件不重挂载 →
  `useEffect(load, [provider])` 不再触发，**必须显式调用组件内部 `load()`**，
  否则重置后抽屉仍显示旧 `used`（看起来像重置失败）。

### 修复 · 切换日志「用量窗口」「窗口限额」两栏目空白（问题 3）

- 根因是**两处 UI 缺陷叠加**：① 两个栏目是 `<details>` 且**没有 `open` 属性** → 默认收起；
  ② `styles.foldSummary` 写了 `listStyle: "none"` → **浏览器原生的折叠三角被抹掉**，
  用户只看到「一行标题 + 下方空白」，连可点的提示都没有；空态引导文案同样躺在收起态里不可见。
- 另：`quotaWindows` 由 `Object.keys(providerMeta)` 生成，`providerMeta` 为空时该栏目
  **结构性永远为空**，且该栏目纯只读、整页无任何输入控件 → 用户既看不到信息也找不到填写入口。
- 修复：
  - 删 `styles.foldSummary` 的 `listStyle: "none"`，恢复原生 `▸/▾`
    （一并影响「健康探测」/「TRM 压测」两个折叠块，属同一可发现性问题的正向修复）。
  - 两个 `<details>` 改为**完全受控**且默认展开。**刻意不用 `onToggle`** —— 非概览页签每 5s 走
    `refresh() → setStatus` **全量重渲染**，受控 `open` 每次渲染都会被回写；一旦 `toggle` 事件
    未按预期触发，用户收起后就会被下一次轮询弹开（即本次要修的缺陷）。改用 `summary` 的
    `onClick` + `preventDefault` 由 state 驱动（键盘 Enter/Space 激活 `summary` 同样触发 click）。
  - `probe` / `bench` 两个折叠块不加 `open`，保持非受控原生行为。
  - 标题行上提状态摘要：「用量窗口（5h / 1w）· N 家 · …」「窗口限额（…）· 未声明 / 已声明 N 家 · …」。

### 文案调整

- 抽屉内：「启用 / 删除」→「**声明限额 / 取消声明**」；未声明态写明「未声明（不限制、不参与避让）」；
  placeholder「限额」→「**token 上限**」；「重置」→「**重置已用**」；「删」→「**移除窗口**」；
  说明段改为「未声明 = 不限制，声明后耗尽即避让」。
- 「窗口限额」空态与 hint 文案改为指向本页签的「档案」按钮（不再指向「模型测试」行内）。

### 兼容

- 无破坏性变更。后端 API、`lib/` 全部未动；单测 142/142 零回归。
- 面板行为变更（属预期）：新建测试支持任意多目标；「档案」入口新增于「切换日志」页签
  （「模型测试」结果行内入口保留）；「切换日志」两个栏目默认展开。

### 未纳入本版

- §13 P1-6 wrapper 拆四文件 → 仍留 v0.9.8。
- hop 内联 `quotaWindows` 运行时未生效 → 仍记 TODO。

## 0.9.6 (2026-09-15)

> 本版为 **v0.9.5 的缺陷修复版**。v0.9.5 已实装，故不改其版本号；其验收实际未通过的两项
> （§9 路由桥接、§11 人工重置）在本版修复，v0.9.5 条目内相应描述已加注更正。

### 修复 · 根因 A：上限仓运行态被无条件覆盖（`lib/quota.js`）

- `WindowLedger._assure` 此前在**每次** `consumeAttempt` 都用 providerMeta 声明值或启动
  `loaded` 快照覆盖内存 `used`/`resetAt`，导致三个症状：① `markReset`（人工重置）效果活不过
  一次调用——用户点「重置」后下一个请求照样被拦；② providerMeta 声明了 `used` 时
  `markBurnedOut`（上游 429 置满）被抹掉；③ 清除声明后内存槽位只增不删，仍继续拦截。
- 重构为：**声明态（结构 / `limit` / `windowMs`）每次从 meta 对齐（增·改·删）；运行态
  （`used` / `resetAt`）只在槽位首次物化时播种一次**（`loaded` 优先，其次 meta 声明值），
  此后只由 `_slide` / `markReset` / `markBurnedOut` / `addUsage` / `syncWindows` 改写。
- 三个必须守住的设计点：① 「首次物化」用**槽位级** `cur == null` 判定（provider 级会在
  「`syncWindows` 已建条目但槽位未播种」「先声明 weekly 后补 fiveHour」两类边角失效）；
  ② `loaded` 按**槽位 `delete`**（不删则槽位重建会复活旧快照）；③ `_slide` 放**最末**
  （依赖 `resetAt`/`limit` 已就位）。
- 顺带：`syncWindows` 改为委托 `_assure`，消除第二条维护 `limit`/`used`/`resetAt` 的路径，
  并修掉「`windows.fiveHour === undefined` 不清槽位」与「重启后先开抽屉保存会丢 `loaded`」
  两个边角；删除死代码 `loadedHas`；`quotaSnapshot(provider, meta?)` 增可选第二参，
  `/status` 与 `/quota/windows` 传入 meta，使已删除的窗口即时从快照消失。

### 修复 · 根因 D：上限仓 `used` 从不累加 → 「主动避让」实为「被动反应」（`lib/quota.js`）

- `record()` 原注释写「`used` 不累加（避免与速率环双记）」——该理由不成立：§11.1 明确速率环
  （速率观测）与上限仓（窗口累计上限拦截）是「两套并行、职责独立」的语义，独立的两套不构成双记。
- 不累加的后果：窗口**永不自然耗尽** → 门只在上游已 429 之后才生效（正是 §11 要避免的
  「被动等上游返回 429 后再 cooldown」），概览段「接近 80% 标黄 / 95% 标红」也永不触发。
- 新增 `WindowLedger.addUsage(provider, amount)`，`record()` 末尾按 tokens 累加（仅对已声明
  `limit` 的窗口）。**口径：`limit` 单位 = token**。
- 另修：`QuotaLedger.markBurnedOut` 缺 `saveToDisk`（与 `markReset` 不对称，重启即丢）。

### 修复 · 根因 C：面板与服务端契约错配 → 三个桥接按钮全失效（`client.js`）

- `bridge()` 原用 `fetch(API.state)`（**GET**），而 `/api/model-router/state` 只接受 **POST**
  → 恒返 405，导致「模型测试」页签的「加入首选 / 加入备用 / 排除」三按钮**从未成功执行过**。
- 改读 `GET /status` 的 `config` 块（已回显 `rules`/`providerMeta`/`timeZone`/`mode`）。
  **刻意不用 `props.status`**：该组件保存后只调自己的 `load()`（仅刷新 model-test 数据），
  不刷新父组件 `status` → 连点两个按钮时第二次会读到旧 rules 造成丢更新。

### 修复 · 根因 B：`exclude` 端到端断链（`lib/config.js` + `lib/registry.js`）

- 写入端：`providerMeta` 白名单新增 `exclude` 布尔校验（此前白名单只收
  `quotaGroup`/`tier`/`quotaWindows`/`customWindows`，`exclude` 被**静默丢弃**）。
  顺带删除死代码 `validateProviderMetaWindows`（全仓库零 import，双份真相源）。
- 读取端：`Registry.isExcluded()` + `registeredPairs()` 一处过滤，即覆盖
  same-model / same-provider / exclude-current 三策略。
- **语义刻意收窄**：`exclude` 只裁剪「注册表自动展开」的候选池，**不否决**用户手工写进
  `rule.route` 的条目与当前会话 seed（面板「排除」的语境是 verdict=exclude「别再自动选它」，
  非全局禁用该 provider）。`_profileMeta` / `metaSnapshot` 不动。

### 修复 · 面板表达一致性（`client.js`）

- §5「高级选项」此前是**死控件**：`advancedForRule` 只用于按钮自身文案、不 gate 任何渲染
  → 点击只换文字。现按 §5 原意真折叠：默认只显示当前 strategy 名，展开才给 4 档下拉；
  按钮文案由「高级选项（mode / 时序参数）」改为「**高级选项（候选链规则）**」——
  卡片内本就没有 mode/时序段，原标题是虚假承诺。
- 补 §5 要求的 mode 与「候选链规则」关系说明段（时间预算 vs 拓扑，两者独立可组合）。
- 补 §14 #17 要求的预设 tooltip 警示（「⚠ 仅写入编辑区，不自动保存；将覆盖 strategy + mode」）。
- `verdictOf` 的「probe 失败但 rpm 可用」分支（§14 #4）改用 `forced` 变量锁定
  `recommend='backup'`：此前只设 `score=0.35`，而 backup 阈值 0.4，当 `lastOkRpm ∈ (0, 0.2)`
  且观测到限流时加成全无 → 误判 `exclude`。不用「调分数」实现（0.45 + 各项加成最高 0.75
  会溢成 `primary`）。

### 测试与文档

- 单测 **142/142 全过**（v0.9.5 基线 132 + 新增 10：exclude 配置 1 + exclude 注册表 2 +
  verdict 1 + 上限仓 6）。新增用例均已验证**红→绿**（stash 源码后确实失败）。
  既有 11 条 `WindowLedger` 用例零回归，其中滑窗 / 重启恢复 / burn 后拦截为三道守门测试。
- 19 个源文件 `node -c` 全过。
- README.md / README.zh.md 同步：补「模型全自动测试」与「配额窗口」两节（此前完全未提）、
  修正报告目录（实为 `~/Documents/dsh-model-router-reports/`）、`providerMeta` 表补 `exclude`、
  `reports` 表补 `modelTestThreshold`、写明 `limit` 单位为 token。

### 兼容

- 无破坏性变更。`exclude` 为新增可选字段，未声明时行为与 v0.9.5 完全一致。
- `quotaSnapshot` 第二参可选，不传时行为与 v0.9.5 一致。
- `WindowLedger` 对外方法签名与返回结构不变（`consumeAttempt` / `markReset` /
  `markBurnedOut` / `syncWindows`）。
- 行为变更（属预期）：窗口 `used` 现在会随成功调用按 tokens 增长，达到 `limit` 时**主动**
  跳过该 provider（此前只在收到上游 429 后才会跳过）。

### 未纳入本版

- §13 P1-6 wrapper 拆四文件（741 行，需先引入统一 ctx 对象透传闭包状态，纯重构回归面大）
  → v0.9.7；本版仅更正 v0.9.5 方案文档中不实的验收勾选。
- hop 内联 `quotaWindows` 运行时未生效（`config.js` 校验了它，但 `providerMetaFor` 只读
  `config.providerMeta[provider]`）→ 记 TODO。

## 0.9.5 (2026-09-14)

> ⚠ **事后更正（2026-09-15，v0.9.6 复核）**：本版验收实际未通过。经实机复核确认：
> ① 「模型测试」页签的「加入首选 / 加入备用 / 排除」三按钮因客户端用 GET 打只接受 POST 的
> `/state` 端点（恒 405）而**从未成功执行过**；② 模型档案的「重置」按钮**实际无效**
> （`_assure` 每次调用都从 meta/loaded 恢复 `used`，重置效果活不过一次调用）；
> ③ 下方「「高级选项（mode / 时序参数）」按钮折叠 mode 与时序段」一句**不实**——该按钮
> 只切换自身文案，不 gate 任何内容。三项均已由 v0.9.6 修复，详见上节。

- **每日报告改 Markdown（B 方案）**：磁盘只写 `<day>.report.md`，文件首行 `<!-- generated by dsh-model-router v0.9.5 @<ISO8601> -->`（生成时刻内嵌），人类可读 + 访达双击即可。`DailyReporter.generate()` 始终重新聚合 + 唯一临时文件名（`tmp-<ts>-<rand>`）+ `renameSync` 原子覆盖（**不早返**——避免「手动立即生成」跳过重写导致磁盘与 API 不一致）；`readReport()` 语义钉死为 `{ generated, generatedAt, report }`，结构化数据实时聚合 NDJSON，md 文件仅作 generated/generatedAt 标记
- **报告 API 新增 `markdown` 字段**：`GET /api/model-router/reports?day=` 与 `POST /reports/generate` 响应附 `markdown`（仅已生成才返），客户端「查看 Markdown」按钮一键渲染；未启用 daily 仍可走原 503 路径
- **客户端报告页签 markdown 视图**：新增 `showMd` / `markdown` 全局 state；按钮位于按供应商表下方，渲染块用 pre-wrap + monospace，等宽展示 md 全文
- **切换逻辑文案 + 折叠（降冗余）**：默认显示「候选链规则」下拉 + 3 个场景预设按钮（长任务·稳定同模型 / 短问·快切免费 / 冷启动·全注册表，鼠标悬停看 tooltip 解释）；「高级选项（mode / 时序参数）」按钮折叠 mode 与时序段
- **场景预设覆盖 rule.strategy + rule.mode**：3 档预设（`same-model/stable`、`same-provider/free-tier`、`exclude-current/balanced`），tooltip 明示行为，按下即覆盖当前规则（其它规则不动），toast 反馈
- **providerMeta 限额字段静态校验**：新增 `quotaWindows`（fiveHour / weekly，limit/used/resetAt）与 `customWindows`（id/windowMs/limit/used/resetAt）字段，限值与时间戳类型校验 fail-fast；**动态滑窗 + 限仓 + quota-state.json 持久化与 wrapper 入口拦截留待 §11 完整版与 §9 一起交付**
- **§13 P2-13 顶层 mode deprecate warn**：`normalizeConfig` 检测到用户显式声明顶层 mode（非默认 balanced）输出 deprecation warning；`normalizeState` 同步加 warn（routes.js 透传 log）。默认 balanced 不告警，避免日志噪音。v0.10.0 移除顶层 mode 解析
- **§13 P1-6 wrapper 拆分（阶段一）**：建立 `lib/wrapper/` 目录 + `wrapper/index.js`（承载全部 667 行）；`lib/wrapper.js` 退化为 20 行 re-export 薄桥，保证单测与 lib/index.js 的 `import ... from './wrapper.js'`（带 .js 后缀）路径不破坏。**按职责拆 4 文件（failover/quota-cooldown/errors/index）属完整落地，留待 v0.9.6**
- **新单测**：v0.9.4 111 → v0.9.5 **112 项全过**（新增 `formatReportMarkdown` + `readReport` 新语义 + `l1Summary` 当日缓存兜底 + 限额字段静态校验 5 例 + 顶层 mode deprecate warn 4 例）
- **部署**：版本升至 0.9.5；部署包 `DSH-model-router-v0.9.5-部署包.zip`（md 报告 + 策略降冗余 + providerMeta 限额字段 + wrapper 拆分布局 + 顶层 mode warn 合并）
- 兼容：旧 `.report.json` 残留文件不再被读取（仅 md 是新磁盘真相源），用户首次实装后下次生成即覆盖；providerMeta 旧字段（quotaGroup/tier）继续透传，新字段可选
- 推迟至 v0.9.6：P1-8 cordis.patch.yml 默认规则、P2-10 Cache-Control、P2-11 ESLint、P2-12 集成测试、§11 quota 上限仓运行时（动态 used 维护 + 持久化 + wrapper 入口拦截）、§9 模型全自动测试模块

## 0.9.4 (2026-09-12)

- **每日报告启动按钮（UX 补丁）**：面板「每日报告」页签未启用时显示横幅 + 「一键启用每日报告」按钮，一键 `POST /state` 提交 `reports.enabled=true`（normalizeState 新增透传 `reports` 段）；`routes.js` 探测 reports 切换，响应带 `requiresReload + reloadHint`（明示需重启 dsh 让 daily 实例装配，macOS 命令随附）；已启用态顶部显示 reportDir + 自动生成时刻
- **生成反馈 toast（UX 补丁）**：`client.js` 新增全局浮层 toast——「立即生成昨日报告」成功显示「已生成 <day> · 调用 N 次 + 文件路径」，失败显示原因；「reports disabled」类错误内嵌「立即启用」按钮直达启用；3.5s/6s 自动消失，组件卸载清理计时器
- **修复 ISS-01 根治（漏洞 1）· store 加载点剥离残留 match**：此前仅 normalizeConfig/normalizeState 丢弃 match，而 store 存在时 `index.js` 用 `cfg.rules = stored.rules` 整体替换，绕过丢弃——残留 `match:{default:true}` 会让非选包会话被 default 规则接管。本版抽 `stripLegacyMatch(rules, allowLegacyMatch, log)` helper（config.js 导出），store 加载路径在 index.js 一并剥离，patch/store 双路径各 warn 一次、行为一致
- **新增 `allowLegacyMatch` 配置开关**：默认 `false`——`rule.match` 一律剥离（不会命中），启动日志 warning 明示；显式 `true` 保留旧 v0.8 明细解析（provider/model/default/sessionIds/hours）。`normalizeState(raw, legacyMatch)` 复用 patch 现值，面板保存不再把 legacy 语义强制归 false（漏洞 2）；status 接口回显 `allowLegacyMatch` 便于诊断
- **免费模型 429 调优（B-1）· free-tier 跨请求节流**：新增模块级纯函数 `throttleWait` + `interProvider` 账本（provider → 最近成功发送时刻）。发起前对 `seed.provider` 只读等待，请求内相邻候选间隔与跨请求口径统一；**成功路径才推进账本**（失败不锁死 provider）。普通/其它模式 `requestIntervalMs===undefined` 零行为变化
- **上下文 400 调优（B-3/B-4/B-5）· context 类码纳入 failover + 窗口感知重排**：`failoverSignals` 追加 `CONTEXT_LENGTH`/`CONTEXT_WINDOW`/`TOO_MANY_TOKENS`（累计上下文超窗 400 不再硬失败）；registry `refreshModels`/`registeredPairs` 透传 `contextWindow`（camelCase）；`router.noteContextFail()` 打点后 60s 内 `contextReorder` 把大窗口候选前移（无窗口候选小干预、原序保持），收敛态 `slice(0,1)` 取到被排前的大窗口首选（O-2 子用例覆盖）
- **测试**：111 项单测全过（新增 v0.9.4 A 9 项 + B 5 项 + daily 4 项 + **UX 3 项：normalizeState 透传 reports 段 / POST /state 切换 reports 返 requiresReload+reloadHint / 未提交 reports 无回归**：默认剥离/legacy 保留/matchRule 命中语义/类型 fail-fast/漏洞 1、2/throttleWait 三态/context 码集合/contextReorder 三场景/O-2 收敛取大窗口/registeredPairs 带 window/**readDayRecords 合并内存 buffer/generate 写盘失败 throw/hasReport 行为未变/status 回显 reports 字段**；另修复 DailyLedger 兜底 flush 计时器未 unref 导致测试进程不退出、modes 合法模式集断言过时）
- **每日报告 UX 修复（v0.9.3 实机根因补强）**：`daily.js` 的 `readDayRecords` 合并内存 `_buffer` 中未 flush 的当日记录（v0.9.3 P1-4 异步批量写引入的「buffer 有但磁盘未落盘」窗口——`/reports?day=<今日>` 与「立即生成昨日」可能命中 no-data）；`generate()` 写盘失败 throw 而非吞错（v0.9.3 仅 `log.error` 即返 ok:true，致前端「假成功」+ 磁盘无文件）；`routes.js` 在 `/api/model-router/status` 顶层回显 `reports.enabled / reports.reportDir / reports.hour`，用户无需先开 enabled 也能看到「报告文件落在哪」；`POST /reports/generate` 写盘失败显式 500 + `error`（不再被通用 `guard` 包成「插件内部错误」）
- **部署**：版本升至 0.9.4；部署包 `DSH-model-router-v0.9.4-部署包.zip`（A+B+daily-UX 合并，整包回退 v0.9.3）
- 兼容：0.9.3 面板/loadtest 确认门不变；旧配置残留 match 将被默认剥离（预期行为收紧，CHANGELOG 点名）

## 0.9.3 (2026-09-12)

- **安全加固（S-3）· 负载测试付费 tier 确认门**：`POST /api/model-router/loadtest` 默认只测 `free`；显式传付费 tier（`paid-baseline` 等）须在 body 附 `"confirmPaidBurn": true`，缺省 400。抽 `validateLoadtestOptions(opts)` 供单测与 client 勾选提示复用，防误操作真实烧付费 token / 触发上游限流
- **稳定性（ST-5）· zstd 容器解码魔数扫描上限**：`titles.js` 对超大持久化日志 buffer 的帧魔数扫描加 `MAX_FRAMES=10000` 提前终止，防字节级 O(N) 全扫描卡顿 status 接口（仅防卡顿，不替代大文件解码）
- **可行性（F-2）· free-tier 限速字段运行时消费**：`resolveRequestMode` 对 `free-tier` 预设透传 `requestIntervalMs=2000` / `interModelDelayMs=500`；wrapper attempt 间（i>0）按 interval 限速、切 provider 时叠加 inter-provider 延迟；`custom`/`stable`/`balanced`/`fast` 不强制限速
- **稳定性（S-2）· daily 账本异步批量写**：`recordCall` 由同步 `appendFileSync` 改为内存 buffer + 每 100 条 / 每 5s flush + `process.exit` 同步兜底；清理回调调 `dispose()` 落盘剩余缓冲。极端卡顿下不再引入 ms 级写盘抖动
- **可观测性（P1-9）· status 接口增补元字段**：`fallbackPolicy` 增 `maxRetriesSource`（'auto'|'explicit'）、`autoTuneFormula`；顶层增 `quotaGroupCount`、`adapterRegistered`（注册失败时面板可显红卡），配置透明化
- **可行性（F-4）· 部署脚本端口对齐实机**：`scripts/deploy.sh` 验证命令 `:3080` → `:3081`（与 README/本机 status 一致），杜绝按提示执行失联
- **可行性（F-9）· Windows 部署脚本**：补 `scripts/deploy.ps1` / `undeploy.ps1`（PowerShell 5.1 兼容，行为与 bash 版对齐：备份→拷包→单源校验/逆序摘 patch→删包→仅提示不重启）
- **测试**：52 项单测全过（新增 loadtest 付费确认门、resolveRequestMode free-tier/custom/stable 字段断言）
- **部署**：版本升至 0.9.3；部署包 `DSH-model-router-v0.9.3-部署包.zip`
- 兼容：0.9.2 面板渲染修复/ErrorBoundary/单源装载语义不变；loadtest 非 free 用例需带确认字段（行为收紧，属预期）

## 0.9.2 (2026-09-12)

- **修复 Web 插件面板渲染崩溃（面板隐身）**：`ModelRouterPanel` 头部徽章 `Object.assign({}, styles.badge, meta.color, …)` 将十六进制颜色字符串（如 `"#9a6700"`）误当对象展开，产生数字 style 键，触发 `TypeError: Failed to set an indexed property [0] on 'CSSStyleDeclaration'`，并被 `web-ui.plugin.item` 槽位错误边界静默吞噬，导致设置页「模型路由」面板不可见。改为 `{ color: meta.color }`，面板恢复正常渲染。
- **渲染兜底**：`ModelRouterPanel` 外包 ErrorBoundary，未来渲染异常以红卡形式外显而非被静默吞掉。
- **部署纪要**：dsh 装载从「profile 手工 insert」收敛为「`dsh.profile.bundles` 单源」（插件自带 `dsh.bundle.patch` 只插一次），消除 `duplicate loader entry id: model-router` 启动崩溃。
- **验证**：root `/` 200、`/api/model-router/status` 200、设置页「模型路由」卡片为正常配置面板、状态正常监听、控制台无 MR-BOUNDARY/CSSStyleDeclaration 报错。
- **部署**：版本升至 0.9.2；部署包 `DSH-model-router-v0.9.2-部署包.zip`
- 兼容：0.9.1 规则命名/纯选择驱动/逐规则 mode/自定义参数语义不变

## 0.9.1 (2026-09-12)

- **规则命名闭环（问题 1/2）**：规则卡片新增「规则名」输入框，`rule.name` 全链路贯通（保存/校验/路由/面板/状态接口）；对话模型选择器「插件模型包」展示名直接用用户命名 `name（模式中文标签）`，不再以默认 `rule-0` 命名——`applyDefaultNames` 仅对未命名规则兜底补 `rule-{N}`
- **纯选择驱动、移除自动改派（问题 3）**：删除「生效范围」下拉及模型/供应商/会话/时间窗 match 编辑器、「时间窗口径/时区」UI；规则不再携带 `match`，顶层 `propose` 移除（后端 `applyModeOverrides` 仅保留为兜底参数装配）。选中某命名包 = 完整接管（按链首选发送 + 报错/超时沿链切换 + 应用该包 mode/custom 参数）；不选任何包 = 纯直连透传，插件不介入
- **移除开场改派（问题 4）**：删除「开场改派模型」开关与 `save` payload 的 `propose`；改派完全由「选中包」驱动
- **自定义参数界面（问题 5）**：「优先模式」由全局迁入每条规则独立单选（stable/balanced/fast/free-tier/custom）；选 `custom` 展开关联参数表单（`firstTokenTimeoutMs`/`failoverBudgetMs`/`cooldownSec`/`quotaCooldownSec`），仅在该包被选中时于等待/预算/冷却判定生效；cooldown 支持 per-request 覆盖（`policyOverride` 仅影响 open→half-open 期满判定，不改持久态）
- **校验强化**：`config.validateCustomParams`（下限/预算≥等待关系）、`rule.name` id 安全（trim/禁 `/`/≤40）与去重；旧配置容错（缺名自动命名、`match` 忽略 + warning）
- **部署**：版本升到 0.9.1；部署包 `DSH-model-router-v0.9.1-部署包.zip`；113 项单测全过
- 兼容：0.9.0 的五档 mode 预设、F-1 绑定传递、F-5 选包路由、F-3 adapter 注册语义不变

## 0.9.0 (2026-09-12)

- **F-4 规则命名（批 1）**：`rule.name` 显式命名 + 未命名规则自动回填最小未占用 `rule-{N}`；`byName` 索引 + 重名 fail-fast；`name` 参与路由/状态/面板展示
- **F-2 模式单一体系（批 2）**：五档 mode 预设 `stable` / `balanced` / `fast` / `free-tier` / `custom`；per-request `resolveRequestMode`（watchdog/budget 覆盖）+ legacy `applyModeOverrides` 兼容；CLI 启动时区固化（TZ 钉 UTC）
- **F-1 规则绑定传递（批 3）**：会话级提议时为提议前种子 `matchName` 并随 payload 附加 `__mr_rule`；wrapper 据此 `byName` 取回**绑定规则**并 `candidatesForRule` 生成候选链，避免被替换后的真实 provider 重新 match 命中 default；`resolveRequestMode` 基于绑定规则
- **F-5 选包路由（批 4）**：`router.resolvePackage` 解析 `provider=dsh-model-router` + `model=__pkg:<ruleName>` → 提议 route[0] + 附 `__mr_rule`，由绑定链接管 whole 对话;常量 `PKG_PROVIDER`/`PKG_PREFIX` 导出
- **F-3 adapter 注册（批 5）**：`lib/packages-adapter.js` 虚拟模型展示层薄壳（`registerAdapter` + 虚拟 provider `__pkg:*`），registry 双循环排除虚拟 provider 不污染真实候选集；UI 显示「插件模型包」分组
- **部署**：版本升到 0.9.0；部署包 `DSH-model-router-v0.9.0-部署包.zip`；109 项单测全过
- 已知边界：free-tier 预设的 `maxRetries/requestIntervalMs/interModelDelayMs` 声明但暂未在运行时消费（批 2 安全台阶，下迭代补消费点）

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