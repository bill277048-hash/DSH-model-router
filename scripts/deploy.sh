#!/bin/bash
# @botton/dsh-model-router 部署脚本（顺序安全，与 dsh-guardian deploy.sh 同纪律）。
#
# 顺序（不可调换）：
#   ① 备份 profile patch（cordis.patch.yml.bak-<yyyymmddhhmmss>）
#   ② 拷贝包到 profile node_modules/@botton/dsh-model-router/
#   ③ 幂等追加 insert 条目（含默认 config；grep -q 'dsh-model-router' 存在则跳过）
#   ④ 仅打印重载提示——绝不执行 kickstart
#
# 为什么必须先拷包再追加条目：dsh 重载时 loader 遇 insert 行立即从
# node_modules 解析包；若条目先落位而包缺失，插件解析失败 → cordis 拒绝
# → 进程退出 → launchd 崩溃循环。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC_PKG="$(cd "$SCRIPT_DIR/.." && pwd)"
PROFILE_HOME="$HOME/.deepseek-harness/home/profiles/web"
PATCH_FILE="$PROFILE_HOME/cordis.patch.yml"
DEST_PKG="$PROFILE_HOME/node_modules/@botton/dsh-model-router"
STAMP="$(date +%Y%m%d%H%M%S)"
BACKUP="$PATCH_FILE.bak-$STAMP"

# 0. 前置检查
[ -f "$SRC_PKG/lib/index.js" ] || { echo "错误：找不到插件包 $SRC_PKG" >&2; exit 1; }
[ -f "$PATCH_FILE" ] || { echo "错误：找不到 profile patch $PATCH_FILE" >&2; exit 1; }

# ① 备份 profile patch（无论后续是否改动，先留可回滚副本）
cp -p "$PATCH_FILE" "$BACKUP"
echo "① 已备份 profile patch → $BACKUP"

# ② 拷贝包到 profile node_modules（必须先于条目落位）
mkdir -p "$(dirname "$DEST_PKG")"
rm -rf "$DEST_PKG"
cp -R "$SRC_PKG" "$DEST_PKG"
rm -rf "$DEST_PKG/test" "$DEST_PKG/docs" "$DEST_PKG/scripts"   # 生产目录只留运行必需
echo "② 已安装包 → $DEST_PKG"

# ③ 幂等追加 insert 条目（config 由本脚本写入；改配置直接编辑 patch 条目后重载）
if grep -q "dsh-model-router" "$PATCH_FILE"; then
  echo "③ patch 已含 dsh-model-router 条目，跳过追加（幂等；如需更新 config 请手动编辑 patch）"
else
  cat >> "$PATCH_FILE" <<'YAML'

# 2026-09-03 @botton/dsh-model-router：多供应商模型路由插件（故障切换 + 用量记账）。
# 路由只在既有 ctx.llm provider 路由之间切换，本插件不持有任何 API key。
# 卸载：运行 scripts/undeploy.sh，或删除本条目 + node_modules/@botton/dsh-model-router 后重载 dsh。
# 人工测试场景与观察方法见包内 README.zh.md。
- insert:
    - id: model-router
      name: '@botton/dsh-model-router'
      config:
        logLevel: info
        propose: false
        rules:
          - match:
              default: true
            route:
              - { provider: minimax-cn, model: MiniMax-M3 }
              - { provider: apikey-202606301659, model: glm-5.2 }
              - { provider: apikey-202608290333, model: glm-5.2 }
        fallbackPolicy:
          maxRetries: 4
          failureThreshold: 3
          cooldownSec: 60
          failoverSignals: [QUOTA, QUOTA_EXCEEDED, RATE_LIMIT, TRANSPORT, SERVER, UNKNOWN, INVALID_CREDENTIAL, MISSING_CREDENTIAL, EMPTY_RESPONSE, TIMEOUT]
          allCooldownFallback: force-first
          switchAfterFirstChunk: false
        firstTokenTimeoutMs: 30000
        exhaustionWindowSec: 120
        statusPath: /api/model-router/status
YAML
  echo "③ 已追加 insert 条目 → $PATCH_FILE"
fi

# ④ 仅打印重载提示——绝不自行 kickstart dsh（须先告知主理人并获确认）
cat <<'EOF'
④ 部署完成，插件将在 dsh 重载后生效。
   重载命令（主理人确认后执行）：
     launchctl kickstart -k gui/$(id -u)/com.deepseek.dsh
   重载后验证：
     pgrep -fl dsh                     # 进程存活、未崩溃重启
     curl --noproxy '*' -s http://127.0.0.1:3080/api/model-router/status | head -c 400
   人工测试场景：见 README.zh.md「人工实测指引」。
EOF
