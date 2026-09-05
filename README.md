# @botton/dsh-model-router

DSH 多供应商模型路由插件（v0.7.0）：规则路由 + 首 token 前无感故障切换 + cooldown 熔断 + 用量记账 + 状态接口 + WebUI 面板。

- 兼容：dsh ≥ 0.1.1-rc.1，Node ≥ 22.19，零第三方运行时依赖
- 许可证：Apache-2.0

## 工作原理

```
agent 发起流式调用
  └─ llm/stream waterfall 包装层（本插件）
       ├─ 首选路由：原样 next() 透传（prepared 绑定不动，行为与无插件时完全一致）
       ├─ 首分片前收到 error finish 且错误码 ∈ failoverSignals
       │    → 失败路由进 cooldown → 取候选链下一项重发（对 agent loop 无感）
       ├─ 挂起不产分片 → TTFT 看门狗超时 → abort 并按 TIMEOUT 切换
       ├─ 候选耗尽 → 合成 error finish（保留真实错误码）交 agent/request-error
       └─ 首分片之后：绝不切换（commit-on-first-chunk，流文法硬约束）
```

安全边界：

- 不注册新 adapter、不读任何 API key——只在既有 ctx.llm provider 路由间切换
- 首选永远先尝试；cooldown 只约束重发候选
- 路由替换只走 `agent/request`（会话级提议）与 `llm/stream` 包装层两处正规入口
- `propose: false`（默认）时对会话模型选择零干预，只做故障切换

## 安装 / 卸载

### 方式一：插件市场

打开 dsh **设置 → 插件市场**，搜索 `dsh-model-router`，点安装。

或命令行：

```bash
dsh plugin --profile web add @botton/dsh-model-router
```

### 方式二：本仓库脚本

> Windows 推荐用方式一（`dsh plugin add`）；方式二为 bash 脚本，Windows 需 Git Bash 运行。

```bash
# 安装（备份 patch → 拷包 → 幂等追加条目；不自动重启）
scripts/deploy.sh
# 重载生效（确认后手动执行）：
#   macOS（launchd 守护）：
#     launchctl kickstart -k gui/$(id -u)/com.deepseek.dsh
#   Windows（无 launchd，手动重启 dsh 进程）：停止 dsh 后重新运行 dsh

# 卸载（先摘条目后删包，自动备份 patch）
scripts/undeploy.sh
# 重载同上
```

配置在 profile patch（`~/.deepseek-harness/home/profiles/web/cordis.patch.yml`）的 insert 条目 `config:` 块中，改完重载生效。

## 人工实测指引

状态接口（只读，仅限本机回环访问）：

```bash
curl --noproxy '*' -s http://127.0.0.1:3081/api/model-router/status
```

返回：规则与策略快照、cooldown 状态表、最近 50 次尝试（含每次 attemptIndex/TTFT/e2eMs/outcome；失败项附错误码）、按路由聚合统计、用量记账（滚动 5h/1w 窗口）、包装层计数器（wraps/passthroughs/failovers/timeouts/forced/exhaustions/userAborts）。

### 场景 A：真实故障切换

把默认规则的首选改为一个**故意写错的 model id**，备用为真实可用路由：

```yaml
route:
  - { provider: apikey-202606301659, model: wrong-model-id }   # 故意错
  - { provider: apikey-202608290333, model: glm-5.2 }          # 真实可用
```

重载后正常对话。预期：

1. 对话**正常完成、无感**（agent 侧不报错）；
2. status 接口 `metrics.recent` 出现 `p=apikey-202606301659 outcome=failed errorCode=*` 后紧跟 `p=apikey-202608290333 outcome=committed`；
3. `wrapper.failovers` 计数 +1；冷却表出现错误路由记录。

### 场景 B：无感行为基线（回归）

删掉错误 model 恢复正常配置，正常对话多轮，对比 status：`wrapper.failovers` 不增长、对话行为与装插件前一致。

### 场景 C：熔断与强制重试（可选）

把 `fallbackPolicy.failureThreshold` 调成 1，重复场景 A 三次以上，观察冷却表路由进入 `open` 状态、`cooldownSec` 后转 `half-open`。

### 观察要点与已知边界

- **首分片后不切换**：若首选已开始输出内容后断流，属流中途失败，走 DSH 原生 `agent/request-error`/retry 恢复（本插件不接手）——这是设计约束（防内容拼接错乱），不是 bug。
- **链耗尽收敛**：一次整链失败后 `exhaustionWindowSec`（默认 120s）内候选链收敛为单候选，防止与 `dsh-llm-retry` 叠加造成尝试次数乘法爆炸；status 的 `router.converged` 字段可见。
- **看门狗**：`firstTokenTimeoutMs`（默认 30000ms = 30s）内首选未产任何分片 → 判 TIMEOUT 切换；用户主动取消不受影响。
- **用量记账**：按 provider 粒度记录滚动 5h/1w token 窗口，仅可视，不参与路由排除（P3 加剩余预算视图与强制排除）。
- **收敛时间窗为全局口径**：单用户本地场景够用；多会话同时失败会互相影响收敛窗（已知局限）。

## 配置参考

| 字段 | 默认 | 说明 |
|---|---|---|
| `propose` | `false` | `true` 时经 `agent/request` 提议会话级 (provider, model) |
| `rules[]` | `[]` | 自上而下首个 match 生效；match 支持 `provider`/`model`/`default` |
| `fallbackPolicy.maxRetries` | `2` | 首选之后最多切换次数（首分片前） |
| `fallbackPolicy.failureThreshold` | `3` | 连续失败进 open 的阈值 |
| `fallbackPolicy.cooldownSec` | `60` | open → half-open 冷却秒数 |
| `fallbackPolicy.quotaFailureThreshold` | `1` | QUOTA（workspace 配额耗尽）触发阈值；v0.6.1 起配额型错误单独阈值 |
| `fallbackPolicy.quotaCooldownSec` | `600` | QUOTA 冷却秒数（10 分钟）；half-open 放行试探后自动回归 |
| `fallbackPolicy.failoverSignals` | 10 个错误码 | 可触发切换的 `failure.code`：`QUOTA` `QUOTA_EXCEEDED` `RATE_LIMIT` `TRANSPORT` `SERVER` `UNKNOWN` `INVALID_CREDENTIAL` `MISSING_CREDENTIAL` `EMPTY_RESPONSE` `TIMEOUT` |
| `fallbackPolicy.allCooldownFallback` | `force-first` | 候选全冷却时：`force-first` 强制重试首选候选 / `fail` 回退透传 |
| `fallbackPolicy.switchAfterFirstChunk` | `false` | **硬约束**：首分片之后绝不切换（commit-on-first-chunk，防内容拼接错乱） |
| `firstTokenTimeoutMs` | `30000` | 首分片看门狗毫秒（≥1000，30s） |
| `failoverBudgetMs` | `90000` | v0.6.1 一次请求内全部尝试（含看门狗）的总耗时上限；防挂起候选叠加拖死会话 |
| `exhaustionWindowSec` | `120` | 链耗尽后单候选收敛时间窗 |
| `mode` | `balanced` | v0.7.0 模式预设：`stable` / `balanced` / `fast`，覆盖 watchdog/budget/cooldown/quotaCooldown；不动规则链与 maxRetries |
| `registryRefreshSec` | `300` | 注册表（provider/模型目录）刷新周期秒数 |
| `probe.enabled` | `false` | v0.4.0 健康探测开关；默认关闭避免无授权打真实 API |
| `statusPath` | `/api/model-router/status` | 状态接口路径 |

## v0.7 范围声明

已实现：规则路由（四种扩展策略：explicit / same-model / same-provider / exclude-current，源自 dsh 模型注册表）、无感故障切换全语义（finish 分片驱动 + commit-on-first-chunk）、cooldown 三态熔断（含 v0.6.1 配额感知：QUOTA 单独阈值 1 次 + 600 秒冷却）、TTFT 看门狗（30s）+ 切换总预算（failoverBudgetMs 90s）、用量记账（可视，滚动 5h/1w 窗口）、状态接口、WebUI 面板（规则/配额/mode 热更新，store JSON 持久化免重启）、v0.7.0 模式预设（`stable` 60s/300s预算/120s冷却/900s配额冷却；`balanced` 30s/90s/60s/600s；`fast` 15s/45s/30s/300s）、v0.6.0 会话标题三级解析（live / snapshots / 持久化日志直读）、61 项单元测试。

## 许可证

Apache-2.0
