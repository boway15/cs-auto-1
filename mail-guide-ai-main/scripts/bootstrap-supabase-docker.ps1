#Requires -Version 5.1
<#
.SYNOPSIS
  从官方仓库拉取 Supabase 自建 Docker 模板到仓库根目录的 supabase-selfhost/。

.DESCRIPTION
  需已安装 Git。生成目录后请在本机执行密钥脚本并编辑 .env，详见 docs/self-hosted-supabase.md。

.PARAMETER TargetDir
  输出目录，默认：<cs-main>/supabase-selfhost
#>
param(
    [string]$TargetDir = ""
)

$ErrorActionPreference = "Stop"

$MailGuideRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$CsMainRoot = (Resolve-Path (Join-Path $MailGuideRoot "..")).Path

if (-not $TargetDir) {
    $TargetDir = Join-Path $CsMainRoot "supabase-selfhost"
}

$composeFile = Join-Path $TargetDir "docker-compose.yml"
if (Test-Path $composeFile) {
    Write-Host "Already exists: $composeFile"
    Write-Host "To re-bootstrap, backup .env then remove folder: $TargetDir"
    exit 0
}

$git = Get-Command git -ErrorAction SilentlyContinue
if (-not $git) {
    Write-Error "Git not found. Install Git for Windows and add to PATH."
}

New-Item -ItemType Directory -Path $TargetDir -Force | Out-Null
$temp = Join-Path $env:TEMP ("supabase-official-docker-" + [Guid]::NewGuid().ToString("n"))

try {
    Write-Host "Cloning supabase/docker (Git 2.25+, github.com)..."
    & git clone --depth 1 --filter=blob:none --sparse https://github.com/supabase/supabase.git $temp
    if ($LASTEXITCODE -ne 0) { throw "git clone failed; check network and Git version." }

    & git -C $temp sparse-checkout set docker
    if ($LASTEXITCODE -ne 0) { throw "git sparse-checkout failed." }

    $dockerSrc = Join-Path $temp "docker"
    if (-not (Test-Path $dockerSrc)) {
        throw "docker folder missing after sparse-checkout: $dockerSrc"
    }

    Copy-Item -Path (Join-Path $dockerSrc "*") -Destination $TargetDir -Recurse -Force
    Write-Host "Done: $TargetDir"
    Write-Host ""
    Write-Host "Next:"
    Write-Host "  1. Copy-Item .env.example .env"
    Write-Host "  2. In Git Bash or WSL: sh ./utils/generate-keys.sh (see Supabase docker docs)"
    Write-Host "  3. Set SUPABASE_PUBLIC_URL, API_EXTERNAL_URL, SITE_URL (mail-guide-ai URL, e.g. http://localhost:8080)"
    Write-Host "  4. docker compose pull; docker compose up -d"
    Write-Host "  5. mail-guide-ai-main/docs/self-hosted-supabase.md (migrations + sync-functions)"
}
finally {
    if (Test-Path $temp) {
        Remove-Item -Recurse -Force $temp -ErrorAction SilentlyContinue
    }
}
