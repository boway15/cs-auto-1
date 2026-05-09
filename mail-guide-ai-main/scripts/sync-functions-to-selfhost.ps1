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

Write-Host "Done. Next: cd `"$SelfhostRoot`"; docker compose restart functions --no-deps"
