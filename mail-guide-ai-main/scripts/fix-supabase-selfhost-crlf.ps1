#Requires -Version 5.1
<#
.SYNOPSIS
  将 supabase-selfhost 中常见脚本/配置从 CRLF 转为 LF，避免 Docker 内 Kong / Supavisor 报错。

.DESCRIPTION
  典型错误：
  - Kong: exec /home/kong/kong-entrypoint.sh: no such file or directory
  - Pooler: unexpected token: carriage return (Elixir eval pooler.exs)

  默认处理 <cs-main>/supabase-selfhost 下的 kong-entrypoint.sh 与 pooler.exs。
#>
param(
    [string]$SelfhostRoot = ""
)

$ErrorActionPreference = "Stop"
$MailGuideRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$CsMainRoot = (Resolve-Path (Join-Path $MailGuideRoot "..")).Path
if (-not $SelfhostRoot) {
    $SelfhostRoot = Join-Path $CsMainRoot "supabase-selfhost"
}

$targets = @(
    (Join-Path $SelfhostRoot "volumes\api\kong-entrypoint.sh"),
    (Join-Path $SelfhostRoot "volumes\pooler\pooler.exs")
)

foreach ($p in $targets) {
    if (-not (Test-Path $p)) {
        Write-Warning "Skip (missing): $p"
        continue
    }
    $d = [IO.File]::ReadAllText($p) -replace "`r`n", "`n" -replace "`r", "`n"
    [IO.File]::WriteAllText($p, $d, [Text.UTF8Encoding]::new($false))
    Write-Host "LF: $p"
}

Write-Host "Done. Then: cd `"$SelfhostRoot`"; docker compose up -d --force-recreate kong supavisor"
