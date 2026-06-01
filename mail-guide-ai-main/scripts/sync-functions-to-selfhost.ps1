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

# TLS 证书：163 自定义 CA + Gmail/Outlook 公网 CA 包（Edge 沙箱无法读 /etc/ssl）
$certsDir = Join-Path $DstFunctions "certs"
if (-not (Test-Path $certsDir)) {
    New-Item -ItemType Directory -Path $certsDir -Force | Out-Null
}
foreach ($name in @("mail-ca.pem", "public-ca.pem")) {
    $srcCa = Join-Path $SrcFunctions "certs\$name"
    $dstCa = Join-Path $certsDir $name
    if (Test-Path $srcCa) {
        Copy-Item -Path $srcCa -Destination $dstCa -Force
        Write-Host "Sync: certs/$name -> $dstCa"
    } elseif ($name -eq "mail-ca.pem") {
        Write-Warning "Missing $srcCa — IMAP TLS will rely on bundled 163 CA only."
    } elseif ($name -eq "public-ca.pem") {
        Write-Warning "Missing $srcCa — Gmail TLS may fail; run: docker cp supabase-edge-functions:/etc/ssl/certs/ca-certificates.crt `"$srcCa`""
    }
}

Write-Host "Done. Next: cd `"$SelfhostRoot`"; docker compose up -d --force-recreate --no-deps functions"
