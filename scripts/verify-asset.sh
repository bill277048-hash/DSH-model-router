#!/bin/bash
# 产物 ↔ 源码 一致性校验（**门禁逻辑的单一来源**）。
#
# 为什么要有这个脚本：
#   同一套比对逻辑原先只写在 release.yml 里，若再往 test.yml 抄一份，
#   就回到「两处独立维护」——**这正是 VER-02（包与源码不一致）的根因**。
#   故与 pack.sh 同思路：逻辑收进脚本，workflow 只负责调用。
#
# 用法:  bash scripts/verify-asset.sh [版本]
#        版本缺省取 package.json 的 version
#
# 退出码:
#   0 = 一致（或资产不存在 —— 仅 ::warning::，便于「先改版本、后补包」）
#   1 = 不一致（应阻断）
#
# 判据的两处刻意取舍（2026-09-21 实测踩过，均为「与被测对象无关的变量」）:
#   ① **不比日期列** —— `unzip -l` 的日期是源文件 mtime；CI 检出时全变成检出时刻，
#      本地打包用编辑时刻 → 必然不一致。
#   ② **比对前必须 sort** —— `zip -r lib` 按**文件系统顺序**写入条目，
#      macOS/APFS 与 Linux/ext4 顺序不同 → 不排序必然不一致。
#   真实内容差异由内容级 `diff -r` 兜底（其输出与顺序无关）。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC_PKG="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$SRC_PKG"

VERSION="${1:-$(node -p "require('./package.json').version")}"
ASSET="assets/DSH-model-router-v${VERSION}.zip"

if [ ! -f "$ASSET" ]; then
  echo "::warning::$ASSET 不存在——跳过产物校验（发布前请先打包：bash scripts/pack.sh $VERSION $ASSET）"
  exit 0
fi

# ① 用当次源码重建（pack.sh 内部已断言 package.json 版本 == 目标版本）
bash "$SCRIPT_DIR/pack.sh" "$VERSION" /tmp/_verify_rebuilt.zip

# ② 条目级比对：未压缩大小 + 条目名（排序后）
unzip -l "$ASSET"                  | awk 'NR>3 && NF>=4 {print $1, $4}' | grep -v '^$' | sort > /tmp/_verify_asset.txt   || true
unzip -l /tmp/_verify_rebuilt.zip  | awk 'NR>3 && NF>=4 {print $1, $4}' | grep -v '^$' | sort > /tmp/_verify_rebuilt.txt || true
if ! diff -u /tmp/_verify_asset.txt /tmp/_verify_rebuilt.txt; then
  echo "::error::$ASSET 的条目清单（大小+名称）与「当次源码重建结果」不一致——请重打并提交"
  diff /tmp/_verify_asset.txt /tmp/_verify_rebuilt.txt | head -20 | while IFS= read -r line; do
    echo "::error::清单差异: ${line}"
  done
  exit 1
fi

# ③ 内容级比对：解压后逐文件比字节（条目级相同仍可能内容不同）
rm -rf /tmp/_verify_a /tmp/_verify_b && mkdir -p /tmp/_verify_a /tmp/_verify_b
unzip -q "$ASSET" -d /tmp/_verify_a
unzip -q /tmp/_verify_rebuilt.zip -d /tmp/_verify_b
if ! diff -r /tmp/_verify_a /tmp/_verify_b >/dev/null; then
  echo "::error::$ASSET 的内容与「当次源码重建结果」不一致——请重打并提交"
  diff -r /tmp/_verify_a /tmp/_verify_b | head -20
  exit 1
fi

echo "✓ $ASSET 与当次源码重建结果一致（条目级 + 内容级）"
