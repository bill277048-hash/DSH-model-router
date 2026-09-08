#Requires -Version 5.1
# @botton/dsh-model-router 部署脚本（Windows PowerShell 版，逻辑与 scripts/deploy.sh 对应）。
#
# 顺序（不可调换）：
#   ① 备份 profile patch（cordis.patch.yml.bak-<yyyyMMddHHmmss>）
#   ② 拷贝包到 profile node_modules/@botton/dsh-model-router/
#   ③ 幂等追加 insert 条目（id: model-router 已存在则跳过）
#   ④ 仅打印重载提示——绝不自动重启 dsh
#
# 为什么必须先拷包再追加条目：dsh 重载时 loader 遇 insert 行立即从
# node_modules 解析包；若条目先落位而包缺失，插件解析失败 → cordis 拒绝
# → 进程退出 → 崩溃循环。
$ErrorActionPreference = 'Stop'

$srcPkg = Split-Path $PSScriptRoot -Parent          # scripts/.. = 包根
$profileHome = Join-Path $HOME '.deepseek-harness\home\profiles\web'
$patchFile = Join-Path $profileHome 'cordis.patch.yml'
$destPkg = Join-Path $profileHome 'node_modules\@botton\dsh-model-router'
$stamp = Get-Date -Format 'yyyyMMddHHmmss'
$backup = "$patchFile.bak-$stamp"
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

# 0. 前置检查
if (-not (Test-Path (Join-Path $srcPkg 'lib\index.js'))) { Write-Error "找不到插件包 $srcPkg"; exit 1 }
if (-not (Test-Path $patchFile)) { Write-Error "找不到 profile patch $patchFile"; exit 1 }

# ① 备份 profile patch（无论后续是否改动，先留可回滚副本）
Copy-Item $patchFile $backup -Force
Write-Host "① 已备份 profile patch → $backup"

# ② 拷贝包到 profile node_modules（必须先于条目落位；生产目录只留运行必需）
if (Test-Path $destPkg) { Remove-Item $destPkg -Recurse -Force }
New-Item -ItemType Directory -Force -Path (Split-Path $destPkg -Parent) | Out-Null
Copy-Item $srcPkg $destPkg -Recurse -Force
foreach ($d in @('test', 'docs', 'scripts', '.github')) {
    $p = Join-Path $destPkg $d
    if (Test-Path $p) { Remove-Item $p -Recurse -Force }
}
Write-Host "② 已安装包 → $destPkg"

# ③ 幂等追加 insert 条目（id: model-router 精确幂等；改配置直接编辑 patch 条目后重载）
$already = Select-String -Path $patchFile -SimpleMatch 'id: model-router' -Quiet
if ($already) {
    Write-Host '③ patch 已含 model-router 条目，跳过追加（幂等；如需更新 config 请手动编辑 patch）'
}
else {
    $block = @'

# @botton/dsh-model-router：多供应商模型路由插件（故障切换 + 用量记账）。
# 路由只在既有 ctx.llm provider 路由之间切换，本插件不持有任何 API key。
# 卸载：运行 scripts/undeploy.ps1，或删除本条目 + node_modules/@botton/dsh-model-router 后重载 dsh。
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
          failoverSignals: [QUOTA, QUOTA_EXCEEDED, RATE_LIMIT, TRANSPORT, SERVER, UNKNOWN, INVALID_CREDENTIAL, MISSING_CREDENTIAL, EMPTY_RESPONSE, TIMEOUT, INVALID_REQUEST]
          allCooldownFallback: force-first
          switchAfterFirstChunk: false
        firstTokenTimeoutMs: 30000
        exhaustionWindowSec: 120
        statusPath: /api/model-router/status
'@
    [System.IO.File]::AppendAllText($patchFile, $block, $utf8NoBom)
    Write-Host "③ 已追加 insert 条目 → $patchFile"
}

# ④ 仅打印重载提示——绝不自动重启 dsh
Write-Host ''
Write-Host '④ 部署完成，插件将在 dsh 重载后生效。'
Write-Host '   Windows 无 launchd：停止 dsh 进程后重新运行 dsh 即可。'
Write-Host '   重载后验证：'
Write-Host "     curl --noproxy '*' -s http://127.0.0.1:3080/api/model-router/status"
