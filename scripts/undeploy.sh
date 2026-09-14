#!/bin/bash
# @botton/dsh-model-router 卸载脚本（逆序安全：先摘 patch 条目，后删包）。
set -euo pipefail

PROFILE_HOME="$HOME/.deepseek-harness/home/profiles/web"
PATCH_FILE="$PROFILE_HOME/cordis.patch.yml"
PKG_DIR="$PROFILE_HOME/node_modules/@botton/dsh-model-router"
STAMP="$(date +%Y%m%d%H%M%S)"

[ -f "$PATCH_FILE" ] || { echo "错误：找不到 profile patch" >&2; exit 1; }

cp -p "$PATCH_FILE" "$PATCH_FILE.bak-undeploy-$STAMP"
echo "① 已备份 patch → $PATCH_FILE.bak-undeploy-$STAMP"

# 摘除条目：从 marker 注释起，吞掉 '- insert:' 行与其后的缩进 config 块；
# 遇下一个顶层 '- ' 或顶层 '#' 注释即认为块结束。
if grep -q "dsh-model-router" "$PATCH_FILE"; then
  awk '
    /^# 2026-09-03 @botton\/dsh-model-router/ { skip=1; next }
    skip {
      if ($0 ~ /^- insert:/) { inblock=1; next }
      if (inblock && ($0 ~ /^- / || $0 ~ /^#/)) { skip=0 }
      else if (inblock && $0 !~ /^[ \t]/ && $0 !~ /^$/) { skip=0 }
      else if (!inblock) { next }
      else { next }
    }
    { print }
  ' "$PATCH_FILE" > "$PATCH_FILE.tmp" && mv "$PATCH_FILE.tmp" "$PATCH_FILE"
  echo "② 已摘除 patch 条目"
else
  echo "② patch 无 dsh-model-router 条目，跳过"
fi

if [ -d "$PKG_DIR" ]; then
  rm -rf "$PKG_DIR"
  echo "③ 已删除包目录 → $PKG_DIR"
else
  echo "③ 包目录不存在，跳过"
fi

cat <<'EOF'
④ 卸载完成。重载生效（主理人确认后执行）：
     launchctl kickstart -k gui/$(id -u)/com.deepseek.dsh
EOF
