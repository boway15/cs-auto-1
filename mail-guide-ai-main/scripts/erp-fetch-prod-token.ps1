#Requires -Version 5.1
<#
.SYNOPSIS
  POST ERP production OAuth2 password grant; prints JSON (access_token, etc.).

.DESCRIPTION
  Same contract as docs/erp-order-api.md section 3.4 (production):
  URL https://loginserver.bestwo.net:9443/connect/token
  Body: username, password, client_id, grant_type=password (x-www-form-urlencoded).
  Test env may use field name "pw" and client_id Java; this script targets prod.

  Set env vars (do not commit secrets):
    ERP_USERNAME, ERP_PASSWORD
  Optional:
    ERP_CLIENT_ID (default: ERP)

  Example:
    $env:ERP_USERNAME = '...'
    $env:ERP_PASSWORD = '...'
    .\scripts\erp-fetch-prod-token.ps1

.PARAMETER TokenUrl
  Token endpoint URL (override for staging if needed).
#>
param(
  [string]$TokenUrl = "https://loginserver.bestwo.net:9443/connect/token"
)

$ErrorActionPreference = "Stop"

$user = $env:ERP_USERNAME
$pass = $env:ERP_PASSWORD
$clientId = if ($env:ERP_CLIENT_ID) { $env:ERP_CLIENT_ID } else { "ERP" }

if (-not $user -or -not $pass) {
  Write-Error "Set ERP_USERNAME and ERP_PASSWORD. See docs/erp-order-api.md section 3.4."
  exit 1
}

function Escape-Form([string]$s) {
  return [System.Uri]::EscapeDataString($s)
}

$form = 'username={0}&password={1}&client_id={2}&grant_type=password' -f @(
  (Escape-Form $user),
  (Escape-Form $pass),
  (Escape-Form $clientId)
)

try {
  $resp = Invoke-RestMethod -Uri $TokenUrl -Method Post -Body $form `
    -ContentType 'application/x-www-form-urlencoded; charset=utf-8'
  $resp | ConvertTo-Json -Depth 6 -Compress:$false
}
catch {
  Write-Error $_.Exception.Message
  if ($_.ErrorDetails -and $_.ErrorDetails.Message) {
    Write-Host $_.ErrorDetails.Message
  }
  exit 1
}
