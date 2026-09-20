#!/bin/bash
# 打包脚本（**打包标准的单一来源**）——人工打包与 CI 产物校验共用同一份逻辑。
#
# 为什么要有这个脚本（v1.0.2 教训 VER-02）：
#   此前人工打包、CHANGELOG 里的规格描述、release.yml 的上传是**三处独立维护**，
#   于是出现「包在 11:20 打出，CHANGELOG 在 14:28 改写成扁平标准，但包未重打」——
#   包内 CHANGELOG 自述「904.6 KB / 34 文件 / 含 scripts/」而实际是
#   「251.0 KB / 29 条目 / 扁平 / 不含」，Release 却照常发布（release.yml 只校验
#   「文件存在」，不校验「内容来自本 tag 源码」）。
#   把打包逻辑收进本脚本后，release.yml 可「用当次源码重建 → 与 assets/ 比对」。
#
# 用法：
#   bash scripts/pack.sh [版本] [输出路径]
#   版本缺省取 package.json 的 version；输出缺省 /tmp/DSH-model-router-v<版本>.zip
#
# 打包标准（与 skill §4 一致，勿凭直觉扩展）：
#   扁平布局（无顶层目录前缀）；内容 = package.json client.js cordis.patch.yml
#   screenshots.json README.md README.zh.md CHANGELOG.md LICENSE lib
#   排除 node_modules / .git / test/ / docs/ / scripts/ / assets/ / *.zip /
#        .DS_Store / *.bak
#   —— 面向「解压后拷进 node_modules/@botton/dsh-model-router/」场景，
#      脚本与截图都不需要（README「方式二」的脚本取自**本仓库**，不由包提供）。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC_PKG="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$SRC_PKG"

VERSION="${1:-$(node -p "require('./package.json').version")}"
OUT="${2:-/tmp/DSH-model-router-v${VERSION}.zip}"

# 打包清单（单一来源；改这里即改标准）
ITEMS=(package.json client.js cordis.patch.yml screenshots.json \
       README.md README.zh.md CHANGELOG.md LICENSE lib)

# 0. 前置检查：清单项必须都存在
for f in "${ITEMS[@]}"; do
  [ -e "$f" ] || { echo "错误：打包清单项缺失 $f" >&2; exit 1; }
done

# 1. 断言 package.json 版本与目标一致（防打出「文件名 vX、内容 vY」的包）
PKG_VERSION="$(node -p "require('./package.json').version")"
[ "$PKG_VERSION" = "$VERSION" ] || {
  echo "错误：package.json 版本 $PKG_VERSION ≠ 目标版本 $VERSION" >&2; exit 1; }

# 2. 在**源码目录内** zip（否则会带上绝对路径前缀）
rm -f "$OUT"
zip -r -X -q "$OUT" "${ITEMS[@]}" -x '*.DS_Store' '*/.*' '*.bak' '*.zip'

# 3. 清理 Info-ZIP 临时文件（Apple 版在目标名/被压缩目录含非 ASCII 时会留残）
find "$SRC_PKG" -maxdepth 2 \( -name 'zi??????' -o -name 'XX??????' \) -not -path '*/node_modules/*' -delete 2>/dev/null || true

# 4. 自检
fail=0
ENTRIES="$(unzip -l "$OUT" | tail -1 | awk '{print $2}')"
UNPACKED="$(unzip -l "$OUT" | tail -1 | awk '{print $1}')"

# 4a. 版本
unzip -p "$OUT" package.json | grep -q "\"version\": \"$VERSION\"" \
  || { echo "✗ 包内版本 ≠ $VERSION" >&2; fail=1; }

# 4b. 不含排除清单里的目录
BAD="$(unzip -l "$OUT" | awk 'NR>3 && NF>=4 {print $4}' | grep -cE '^(node_modules/|\.git/|test/|docs/|scripts/|assets/)|\.DS_Store|\.bak$' || true)"
[ "$BAD" = "0" ] || { echo "✗ 包内含应排除的条目（$BAD 个）" >&2; fail=1; }

# 4c. 顶层无目录前缀（扁平）
PREFIXED="$(unzip -l "$OUT" | awk 'NR>3 && NF>=4 {print $4}' | grep -c '^DSH-model-router' || true)"
[ "$PREFIXED" = "0" ] || { echo "✗ 包不是扁平布局（$PREFIXED 个条目带顶层前缀）" >&2; fail=1; }

# 4d. 条目名全 ASCII（防 Info-ZIP 中文名乱码）
NONASCII="$(node -e '
  const {execSync}=require("child_process");
  const out=execSync("unzip -l " + JSON.stringify(process.argv[1])).toString();
  const names=out.split("\n").slice(3).map(l=>l.slice(30).trim())
    .filter(x=>x && !x.startsWith("---") && !/^Archive:|^  Length/.test(x));
  const bad=names.filter(n=>!/^[\x20-\x7E]+$/.test(n));
  console.log(bad.length);
' "$OUT")"
[ "$NONASCII" = "0" ] || { echo "✗ 包内 $NONASCII 个条目名非 ASCII" >&2; fail=1; }

[ $fail -eq 0 ] || exit 1

echo "✓ 打包完成：$OUT"
echo "  版本   : $VERSION"
echo "  条目   : $ENTRIES"
echo "  解压   : $UNPACKED B"
echo "  布局   : 扁平（无顶层前缀）"
