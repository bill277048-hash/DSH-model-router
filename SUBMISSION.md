# 提交 dsh-market / awesome-dsh-plugin 清单

本插件要上架 **dsh-market**，实际入口是精选列表仓库 **awesome-dsh-plugin**。
流程：**在本插件 GitHub 仓库准备好合规材料 → 去 awesome-dsh-plugin 提一个 PR（只加一个文件）→ CI 校验 → 维护者人工复核 → 合并后站点与市场自动收录**（通常一天内生效）。

> **仓库状态（2026-09-20 更新）**：`https://github.com/bill277048-hash/DSH-model-router`
> 已就绪——**仓库年龄门槛早已满足**（注册于 2026-09-03，CI 要求满 1 天）。
> 本机目录**已是 git 仓库并已关联远端**，`main` 已推送至 **v1.0.2**（commit `3ebd7d6`，CI 全绿）。
>
> ```
> origin  git@github.com:bill277048-hash/DSH-model-router.git
> main              3ebd7d6  feat(release): 提交 v1.0.2 安装包 + release.yml 按 tag 精确选包 + 更新 index.js 注释
> legacy-v0.8.1     2076c26  v0.8.1: providerMeta 持久化链路修复（生产同步）
> ```
>
> > ⚠ 本地 git 历史与远端**原本无共同祖先**（本地是重新 init 的独立历史）。
> > 2026-09-20 同步时采用「**强推 + 旧历史存 `legacy-v0.8.1` 分支**」——
> > 远端旧历史完整保留在该分支，`main` 指向 v1.0.2。已逐文件比对确认
> > **无内容丢失**（并补回了 `.github/workflows/release.yml` /
> > `assets/DSH-model-router-v0.8.0.zip` / `docs/RELEASE_NOTES_0.8.0.md`）。

## 〇、作者身份说明（避免维护者对账）

`package.json` 的 `author` 字段为 **botton指北**（公众号/作者实名），但本仓库 GitHub owner 为 **bill277048-hash**。
两者为同一人（作者为发布到 npm 与 GitHub 而新开的上架专用账号）。LICENSE 选用 **Apache-2.0**（与 GitHub 仓库创建时的默认许可证一致，未加个人 copyright 行）；`author` 字段保留 `botton指北`；若维护者问起，以 `botton指北` 为真实身份。

> 若你后续希望 GitHub owner 与 author 字面一致（例如要关联 GitHub Insights 头像），
> 再单独把 `author` 改成 `bill277048-hash` 即可（LICENSE 是 Apache 2.0，不受影响）。

---

## 一、要在 awesome-dsh-plugin 提 PR 加的文件

路径固定为 `data/plugins/<owner>__<repo>.yml`，本插件即：

```
data/plugins/bill277048-hash__DSH-model-router.yml
```

内容（**直接复制**）：

```yaml
url: https://github.com/bill277048-hash/DSH-model-router
name: bill277048-hash/DSH-model-router
category: model
description:
  en: Rule-based multi-provider model routing for DeepSeek Harness with pre-first-token failover, cooldown circuit-breaking, usage accounting, daily API reports, automated model testing, and a WebUI panel.
  zh: DeepSeek Harness 多供应商模型路由插件：规则路由 + 首 token 前无感故障切换 + cooldown 熔断 + 用量记账 + 每日 API 报告 + 模型全自动测试 + WebUI 面板。
```

要点（来自 contributing.md 的收录门槛 / submission gate）：

- **只编辑这一个文件**，不要手改 README（那两个 README 是脚本从 `data/plugins/*.yml` 生成的）。
- `category` 取值固定集合：`agi ui usage theme model identity session memory tools wsl browser vision voice docs skill workflow git notify dev security remote market fun`。
  本插件核心是「跨供应商/模型路由 + 故障切换」，首选 **`model`**；若你更想突出配额/用量维度，可选 `usage`。
- `description.en` **必填且必须以句号结尾**；`zh` 可省略（维护者会补），但建议带上。
- 描述**必须属实、不带营销词**，会被拿去对照代码核实。上面这句与 `README.md` / `README.zh.md` 开头的 v1.0.2 能力列表一致
  （每日 API 报告 → `lib/daily.js`；模型全自动测试 → `lib/model-test.js`；WebUI 面板 → `client.js` + `lib/routes.js`）。
  > ✅ `lib/index.js` 顶部注释已于 v1.0.2 更新（原写「能力（v0.2.0）」且只列 4 项，现已补全 v0.9/v1.0 能力并修正 4 处与实现不符的表述）。
- 描述里若出现 `: `（冒号加空格）必须加引号，否则 YAML 解析失败。
- 一个 PR **最多 3 条**；超过 CI 直接拒。本插件只占 1 条。
- 可选 `tarball:` 字段：把预构建包挂到 GitHub Release 后指向它，商店会优先展示而非源码构建。

---

## 二、CI 会依次检查（任何一个不过都打回，且会指明改哪）

1. **条目数 ≤ 3 / PR** — 已满足（1 条）。
2. **`dsh.bundle` 声明** — 从你仓库 `package.json` 读取（根包或 `packages/ plugins/ apps/` 子包）。
   **只声明 `dsh.client` 会在这里失败**（这是最常见的被拒原因，本插件原先就只声明了 client）。
   ✅ 本次已在 `package.json` 补上 `dsh.bundle.patch: "./cordis.patch.yml"` 并新增 `cordis.patch.yml`。
3. **仓库年龄 ≥ 1 天** — 你那边控制；新建仓库请等满 1 天再提 PR。
4. **awesome-lint + 站点构建** — 双语一致、分隔符、日期、截图格式等。
   ✅ `description.en/zh` 均已以句号结尾、无冒号空格问题。

> CI 通过只是**前置条件**，不是录取结论。维护者合并前会实际读你的目标仓库，
> 确认「能 `dsh plugin add` 装上、描述属实、分类正确、有维护」。

---

## 三、本仓库已为你补齐的合规项（提交前请逐项确认）

| 项 | 状态 | 说明 |
|---|---|---|
| `package.json` `private: false` | ✅ 已改 | 原先 `true`，发 npm 必须改。 |
| `package.json` `dsh.bundle.patch` | ✅ 已加 | `./cordis.patch.yml` |
| 仓库根 `cordis.patch.yml` | ✅ 已建 | `id: model-router` + `name: @botton/dsh-model-router` + `reports.enabled/hours` 段 + **注释化默认规则模板**（含 `name`/`mode`/`route`，用户去掉井号并替换 provider/model 即可） |
| `package.json` `files` 含 `cordis.patch.yml` + `screenshots.json` | ✅ 已加 | 否则发布包里没有这两个文件。 |
| `package.json` `repository` 指回本仓库 | ✅ 已替换 | `git+https://github.com/bill277048-hash/DSH-model-router.git`（npm 自动关联靠它）。 |
| `package.json` `homepage` / `bugs` | ✅ 已替换 | `https://github.com/bill277048-hash/DSH-model-router#readme`。 |
| GitHub 仓库加 `dsh-plugin` topic | ❌ 需你手动 | 在仓库 Settings → Topics 添加 `dsh-plugin`。 |
| 真实可运行代码 | ✅ 有 | 非占位/纯 README 仓库；`npm test` 返回 **290/290 通过**（单测 277 + 契约 13，约 25s）。 |
| `screenshots.json` + `assets/` 截图 | ⚠️ 模板已建 | 已声明 `assets/model-router-status.png` 与 `assets/model-router-settings.png`，**请把两张真实截图放进 `assets/`**（状态接口输出、设置面板各一张）。缺图也不致命——商店会从 README 抽图，但声明能控制顺序。 |
| README 安装说明含 `dsh plugin add` | ✅ 已加 | 中英 README 均补「方式一：插件市场」。 |
| 版本漂移 | ✅ 已修 | README×2 / package.json / CHANGELOG / client.js / lib/index.js 统一为 **v1.0.2**（含「范围声明」「阶段交付速览」「页签数」等 7 处历史残留）；CI 新增 `changelog-guard` job 在 PR 阶段校验「package.json 版本须在 CHANGELOG 有对应段落」，防止再次漂移。 |
| CHANGELOG 跟进 | ✅ 已补 | 共 **37 个版本节点**（v0.1.0 → v1.0.2）。 |
| CI 工作流 | ✅ 已增强 | `.github/workflows/test.yml`：3 OS × Node 22/24 矩阵跑 `npm test`；新增 `concurrency`（取消被取代的运行）、`timeout-minutes`、`workflow_dispatch`、`changelog-guard`。 |
| `release.yml` 自动发 Release | ✅ 已恢复 | 打 `v*` tag 时自动建 GitHub Release 并从 CHANGELOG 抽取该版本段落作正文，上传 `assets/DSH-model-router-<tag>.zip`（**按 tag 精确匹配**，避免历史版本包串版）。**（2026-09-20 同步时曾意外丢失，已从 `legacy-v0.8.1` 补回）** |
| README 配置表 vs 代码默认一致性 | ✅ 已修 | 复核时发现 `firstTokenTimeoutMs`/`failoverSignals` 数量等 4 项不一致，已与 `lib/config.js DEFAULT_CONFIG` 对齐；中英 README 均更新。 |
| README v0.7 范围声明 | ✅ 已扩 | 补 mode 三档参数 + v0.6.1 配额感知 + v0.6.0 标题三级解析。 |
| `peerDependencies` 预发布版本匹配（README 第 7 条警告） | ✅ 已修 | 原 `"@deepseek-ai/dsh-llm": "*"` 实际是「匹配一切但默默排除 prerelease」——用户装 dsh 0.1.1-rc.x 会 ERESOLVE。已改为 `">=0.0.1-rc.1 <0.1.0 \|\| >=0.1.1-rc.1 <0.2.0-0"`（0.1.1-rc.2 + 0.1.0-rc.7 均通过，0.2.0 拒绝）。 |
| `author` 与 GitHub owner 一致性 | ✅ 已说明 | 见下「作者身份说明」。 |

---

## 四、发布到 npm（推荐，非强制）

发 npm 的好处：商店能展示并按下载量排序；**预构建安装会跳过 `allowBuilds` 构建授权**；npm `repository` 字段自动把包关联到本仓库（无需在 yml 手写 `npm:` 字段，手写反而会被校验拒绝）。

```bash
# 1) 确认 package.json 的 name / version / repository 正确
# 2) 登录 npm（你已有账号）
npm login
# 3) 发布（public 因为 scoped）
npm publish --access public
```

> 不发 npm 也能上架：商店会从 GitHub 源码安装。但那样没有下载量、且首次安装可能要走构建授权。

---

## 五、提交 PR 后的动作

- 同一分支推送修复即可，无需重开 PR；CI 失败会明确告诉你改哪。
- 合并后 awesome-dsh-plugin.com 与 dsh-market 自动重建，**无需你再动任何文件**。
- 后续要改自己条目：只改 `data/plugins/bill277048-hash__DSH-model-router.yml` 那一个文件。

---

## 六、一个上架前的强烈建议（与本次「静默停止」复盘相关）

§IX 复盘指出：之前兜底规则被误配到单个会话（`match.sessionIds` 只含 `ca19df1d`），
导致另一会话 `d8e6f66f` 没有任何候选链 → 6 次重试 glm-5.2 → 停止。
若用户装上后不做任何配置 = 插件透传、不故障切换，容易误判「没生效」而给差评。

> ✅ **已落实**：`cordis.patch.yml` 现已内置**注释化默认规则模板**，
> 用户去掉井号并替换 provider/model 即可启用。同时 **v0.9.1 起改为「纯选择驱动」**
> （见 CHANGELOG `## 0.9.1`：「纯选择驱动、移除自动改派（问题 3）」）：
> 规则 = 命名「规则包」，在面板「切换规则」页创建后，于对话框模型选择器选中即生效——
> **不再需要手改 patch 文件**，这比模板更不容易误配。
>
> ⚠ 同时注意 **v0.9.1 已移除 `match`（生效范围）与 `propose`（开场改派）语义**：
> 旧配置残留的 `match` 字段默认**剥离并告警**（`allowLegacyMatch=false`），可安全删除。
> 因此上面 §六 提到的「兜底规则误配到单个会话」这类问题在 v1.0 已**结构上不可能发生**。

当前 `cordis.patch.yml` 的模板形态（**注释化，用户按需启用**；节选自实际文件）：

```yaml
- insert:
    - id: model-router
      name: '@botton/dsh-model-router'
      config:
        # 每日 API 报告：enabled=true 后 wrapper 透传/切换调用都会记账
        reports:
          enabled: true
          hour: '01:00'
        # ===== 推荐规则模板（去掉井号启用，并替换成你自己的 provider/model）=====
        # rules:
        #   - name: my-fast-pack          # 规则名即「插件模型包」显示名
        #     mode: fast                  # 每规则优先模式：stable/balanced/fast/free-tier/custom
        #     route:
        #       - { provider: <首选 provider>, model: <首选模型> }
        #       - { provider: <备用 provider>,   model: <备用模型> }
        # fallbackPolicy:
        #   maxRetries: 4               # 默认 2；>=3 才能跨多个备用
        #   failoverSignals: [QUOTA, QUOTA_EXCEEDED, RATE_LIMIT, TRANSPORT, SERVER, UNKNOWN, INVALID_CREDENTIAL, MISSING_CREDENTIAL, EMPTY_RESPONSE, TIMEOUT]
        #   allCooldownFallback: force-first
```

> 注：`fallbackPolicy` / `firstTokenTimeoutMs` / `exhaustionWindowSec` / `statusPath` 等
> 已有代码默认值（见 `lib/config.js` 的 `DEFAULT_CONFIG`），**无需在 patch 里显式写出**。
