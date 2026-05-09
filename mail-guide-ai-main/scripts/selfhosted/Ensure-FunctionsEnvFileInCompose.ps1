#Requires -Version 5.1
<#
.SYNOPSIS
  若 supabase-selfhost/docker-compose.yml 的 functions 服务未引用 .env.functions，则插入 env_file 块（便于 Dify 等密钥注入）。

.PARAMETER SelfhostRoot
  supabase-selfhost 目录，默认 <cs-main>/supabase-selfhost
#>
param(
    [string]$SelfhostRoot = ""
)

$ErrorActionPreference = "Stop"

$MailGuideRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$CsMainRoot = (Resolve-Path (Join-Path $MailGuideRoot "..")).Path
if (-not $SelfhostRoot) {
    $SelfhostRoot = Join-Path $CsMainRoot "supabase-selfhost"
}

$yml = Join-Path $SelfhostRoot "docker-compose.yml"
if (-not (Test-Path $yml)) { throw "Missing: $yml" }

$raw = [IO.File]::ReadAllText($yml)
if ($raw -match '(?m)^\s+-\s+\.env\.functions\s*$') {
    Write-Host "Already configured: .env.functions referenced in compose."
} else {
    $needleCr = "    restart: unless-stopped`r`n    volumes:`r`n      - ./volumes/functions:/home/deno/functions:Z`r`n      - deno-cache:/root/.cache/deno"
    $insertCr = "    restart: unless-stopped`r`n    env_file:`r`n      - .env.functions`r`n    volumes:`r`n      - ./volumes/functions:/home/deno/functions:Z`r`n      - deno-cache:/root/.cache/deno"
    $needleLf = $needleCr -replace "`r`n", "`n"
    $insertLf = $insertCr -replace "`r`n", "`n"
    if ($raw.Contains($needleCr)) {
        $raw = $raw.Replace($needleCr, $insertCr)
    } elseif ($raw.Contains($needleLf)) {
        $raw = $raw.Replace($needleLf, $insertLf)
    } else {
        throw "Could not find functions service block (restart + volumes). Edit docker-compose.yml manually — add under functions:`n    env_file:`n      - .env.functions"
    }
    [IO.File]::WriteAllText($yml, $raw, [Text.UTF8Encoding]::new($false))
    Write-Host "Patched: $yml (env_file .env.functions)"
}

$envFn = Join-Path $SelfhostRoot ".env.functions"
$example = Join-Path $MailGuideRoot "docs\self-hosted-env-functions.example"
if (-not (Test-Path $envFn) -and (Test-Path $example)) {
    Copy-Item -LiteralPath $example -Destination $envFn
    Write-Host "Created: $envFn (from example — fill secrets)"
} elseif (-not (Test-Path $envFn)) {
    [IO.File]::WriteAllText($envFn, "# Add DIFY_* and other keys — see docs/self-hosted-env-functions.example`n", [Text.UTF8Encoding]::new($false))
    Write-Host "Created stub: $envFn"
}

Write-Host "Next: edit $envFn then: cd `"$SelfhostRoot`"; docker compose up -d --force-recreate --no-deps functions"
