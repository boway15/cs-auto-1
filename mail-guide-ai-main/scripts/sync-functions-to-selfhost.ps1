#Requires -Version 5.1
<#
.SYNOPSIS
  Sync business functions into self-hosted Supabase volumes/functions.

.PARAMETER SelfhostRoot
  Self-hosted Supabase root. Default: <cs-main>/supabase-selfhost
#>
param(
    [string]$SelfhostRoot = ""
)

$ErrorActionPreference = "Stop"

$MailGuideRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$CsMainRoot = (Resolve-Path (Join-Path $MailGuideRoot "..")).Path
$SrcFunctions = Join-Path $MailGuideRoot "supabase\functions"

if (-not $SelfhostRoot) {
    $SelfhostRoot = Join-Path $CsMainRoot "supabase-selfhost"
}

$DstFunctions = Join-Path $SelfhostRoot "volumes\functions"

if (-not (Test-Path $SrcFunctions)) {
    throw "Source functions folder not found: $SrcFunctions"
}

if (-not (Test-Path $DstFunctions)) {
    throw "Target folder not found: $DstFunctions (run bootstrap and docker compose up first)"
}

$preserve = @("main", "hello")
Get-ChildItem -Path $SrcFunctions -Directory | ForEach-Object {
    if ($preserve -contains $_.Name) {
        return
    }
    $dest = Join-Path $DstFunctions $_.Name
    Write-Host "Sync: $($_.Name) -> $dest"
    if (Test-Path $dest) {
        Remove-Item -Recurse -Force $dest
    }
    Copy-Item -Path $_.FullName -Destination $dest -Recurse -Force
}

# 显式校验 TLS 证书（MAIL_TLS_CA_CERT_PATH 默认指向此文件）
$srcCa = Join-Path $SrcFunctions "certs\mail-ca.pem"
$dstCa = Join-Path $DstFunctions "certs\mail-ca.pem"
if (Test-Path $srcCa) {
    $dstCaDir = Split-Path $dstCa -Parent
    if (-not (Test-Path $dstCaDir)) {
        New-Item -ItemType Directory -Path $dstCaDir -Force | Out-Null
    }
    Copy-Item -Path $srcCa -Destination $dstCa -Force
    Write-Host "Sync: certs/mail-ca.pem -> $dstCa"
} else {
    Write-Warning "Missing $srcCa — IMAP TLS will rely on bundled 163 CA only."
}

Write-Host "Done. Next: cd `"$SelfhostRoot`"; docker compose up -d --force-recreate --no-deps functions"
