#Requires -Version 5.1
# @botton/dsh-model-router 卸载脚本（Windows PowerShell 版，逆序安全：先摘 patch 条目，后删包）。
$ErrorActionPreference = 'Stop'

$profileHome = Join-Path $HOME '.deepseek-harness\home\profiles\web'
$patchFile = Join-Path $profileHome 'cordis.patch.yml'
$pkgDir = Join-Path $profileHome 'node_modules\@botton\dsh-model-router'
$stamp = Get-Date -Format 'yyyyMMddHHmmss'
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

if (-not (Test-Path $patchFile)) { Write-Error '找不到 profile patch'; exit 1 }

# ① 备份 patch
Copy-Item $patchFile "$patchFile.bak-undeploy-$stamp" -Force
Write-Host "① 已备份 patch → $patchFile.bak-undeploy-$stamp"

# ② 摘除条目：marker 注释行起吞掉 '- insert:' 与其后的缩进 config 块；
#    遇下一个顶层 '- ' / 顶层 '#' / 非缩进非空行即认为块结束（该行保留）。
$lines = [System.IO.File]::ReadAllLines($patchFile)
$out = New-Object System.Collections.Generic.List[string]
$skip = $false
$inBlock = $false
foreach ($line in $lines) {
    if (-not $skip -and $line -match '^# @botton/dsh-model-router') { $skip = $true; continue }
    if ($skip) {
        if ($line -match '^- insert:') { $inBlock = $true; continue }
        if ($inBlock) {
            if ($line -match '^-\s' -or $line -match '^#') {
                $skip = $false; $inBlock = $false
            }
            elseif ($line -notmatch '^[ \t]' -and $line -ne '') {
                $skip = $false; $inBlock = $false
            }
            else { continue }
        }
        else { continue }
    }
    $out.Add($line)
}
if ($out.Count -lt $lines.Length) {
    [System.IO.File]::WriteAllLines($patchFile, $out.ToArray(), $utf8NoBom)
    Write-Host '② 已摘除 patch 条目'
}
else {
    Write-Host '② patch 无 model-router 条目，跳过'
}

# ③ 删除包目录
if (Test-Path $pkgDir) {
    Remove-Item $pkgDir -Recurse -Force
    Write-Host "③ 已删除包目录 → $pkgDir"
}
else {
    Write-Host '③ 包目录不存在，跳过'
}

Write-Host ''
Write-Host '④ 卸载完成。重载生效：停止 dsh 进程后重新运行 dsh。'
