#Requires -Version 5.1
<#
.SYNOPSIS
  自建 Supabase：更新 vault.service_role_key，并将 pg_cron 改为调用栈内 Kong 的 Functions URL。
  注册 4 条任务：sync-mailbox(5min)、schedule-draft-generation、schedule-compensating-alerts、run-compensation-tasks（后三者均为 */30）。

.PARAMETER SelfhostRoot
  supabase-selfhost 目录，默认 <cs-main>/supabase-selfhost

.PARAMETER KongInternalUrl
  db 容器内可访问的 Kong 基址，默认同栈为 http://kong:8000
#>
param(
    [string]$SelfhostRoot = "",
    [string]$KongInternalUrl = "http://kong:8000"
)

$ErrorActionPreference = "Stop"

$MailGuideRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$CsMainRoot = (Resolve-Path (Join-Path $MailGuideRoot "..")).Path
if (-not $SelfhostRoot) {
    $SelfhostRoot = Join-Path $CsMainRoot "supabase-selfhost"
}

$envFile = Join-Path $SelfhostRoot ".env"
$composeFile = Join-Path $SelfhostRoot "docker-compose.yml"
if (-not (Test-Path $envFile)) { throw "Missing: $envFile" }
if (-not (Test-Path $composeFile)) { throw "Missing: $composeFile" }

function Get-DotEnvValue {
    param([string]$Path, [string]$Key)
    foreach ($line in [IO.File]::ReadAllLines($Path)) {
        $t = $line.Trim()
        if ($t.StartsWith("#") -or $t.Length -eq 0) { continue }
        $eq = $t.IndexOf("=")
        if ($eq -lt 1) { continue }
        $k = $t.Substring(0, $eq).Trim()
        if ($k -ne $Key) { continue }
        $v = $t.Substring($eq + 1).Trim()
        if ($v.Length -ge 2 -and (($v.StartsWith('"') -and $v.EndsWith('"')) -or ($v.StartsWith("'") -and $v.EndsWith("'")))) {
            $v = $v.Substring(1, $v.Length - 2)
        }
        return $v
    }
    return $null
}

function Sql-EscapeLiteral {
    param([string]$s)
    return $s.Replace("'", "''")
}

function Wait-DbReady {
    param(
        [string]$ComposeFile,
        [int]$MaxSeconds = 90
    )
    $started = Get-Date
    while (((Get-Date) - $started).TotalSeconds -lt $MaxSeconds) {
        docker compose -f $ComposeFile exec -T db pg_isready -U postgres -h localhost | Out-Null
        if ($LASTEXITCODE -eq 0) { return }
        Start-Sleep -Seconds 2
    }
    throw "Database not ready after $MaxSeconds seconds."
}

$serviceRoleKey = Get-DotEnvValue -Path $envFile -Key "SERVICE_ROLE_KEY"
if ([string]::IsNullOrWhiteSpace($serviceRoleKey)) {
    throw "SERVICE_ROLE_KEY not found or empty in $envFile"
}

$base = $KongInternalUrl.TrimEnd("/")
$uSync = Sql-EscapeLiteral ($base + "/functions/v1/sync-mailbox")
$uDraft = Sql-EscapeLiteral ($base + "/functions/v1/schedule-draft-generation")
$uAlert = Sql-EscapeLiteral ($base + "/functions/v1/schedule-compensating-alerts")
$uComp = Sql-EscapeLiteral ($base + "/functions/v1/run-compensation-tasks")

$tag = "mga_" + [Guid]::NewGuid().ToString("N")
if ($serviceRoleKey.Contains($tag)) { throw "SERVICE_ROLE_KEY delimiter collision; retry." }

$d = '$' + $tag + '$' + $serviceRoleKey + '$' + $tag + '$'

$lines = [System.Collections.Generic.List[string]]::new()
$lines.Add("CREATE EXTENSION IF NOT EXISTS pg_cron;")
$lines.Add("CREATE EXTENSION IF NOT EXISTS pg_net;")
$lines.Add("")
$lines.Add('DO $$')
$lines.Add("DECLARE v_id uuid;")
$lines.Add("BEGIN")
$lines.Add("  SELECT id INTO v_id FROM vault.secrets WHERE name = 'service_role_key';")
$lines.Add("  IF v_id IS NOT NULL THEN")
$lines.Add("    PERFORM vault.update_secret(v_id, $d, 'service_role_key', 'Service role key for cron-invoked edge functions');")
$lines.Add("  ELSE")
$lines.Add("    PERFORM vault.create_secret($d, 'service_role_key', 'Service role key for cron-invoked edge functions');")
$lines.Add("  END IF;")
$lines.Add('END $$;')
$lines.Add("")

function Add-CronBlock {
    param(
        [System.Collections.Generic.List[string]]$Out,
        [string]$JobName,
        [string]$Schedule,
        [string]$UrlEscaped
    )
    $Out.Add("SELECT cron.unschedule('$JobName')")
    $Out.Add("WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = '$JobName');")
    $Out.Add("")
    $Out.Add("SELECT cron.schedule(")
    $Out.Add("  '$JobName',")
    $Out.Add("  '$Schedule',")
    $Out.Add('  $$')
    $Out.Add("  SELECT net.http_post(")
    $Out.Add("    url := '$UrlEscaped',")
    $Out.Add("    headers := jsonb_build_object(")
    $Out.Add("      'Content-Type', 'application/json',")
    $Out.Add("      'Authorization', 'Bearer ' || (")
    $Out.Add("        SELECT decrypted_secret FROM vault.decrypted_secrets")
    $Out.Add("        WHERE name = 'service_role_key' LIMIT 1")
    $Out.Add("      )")
    $Out.Add("    ),")
    $Out.Add("    body := '{}'::jsonb")
    $Out.Add("  ) AS request_id;")
    $Out.Add('  $$')
    $Out.Add(");")
    $Out.Add("")
}

Add-CronBlock -Out $lines -JobName "auto-sync-mailbox-every-5min" -Schedule "*/5 * * * *" -UrlEscaped $uSync
Add-CronBlock -Out $lines -JobName "auto-draft-every-30min" -Schedule "*/30 * * * *" -UrlEscaped $uDraft
Add-CronBlock -Out $lines -JobName "compensating-alerts-every-30min" -Schedule "*/30 * * * *" -UrlEscaped $uAlert
Add-CronBlock -Out $lines -JobName "run-compensation-tasks-every-30min" -Schedule "*/30 * * * *" -UrlEscaped $uComp

$sql = ($lines -join "`n") + "`n"
$tempSql = [IO.Path]::GetTempFileName() + ".sql"
try {
    [IO.File]::WriteAllText($tempSql, $sql, [Text.UTF8Encoding]::new($false))
    Push-Location $SelfhostRoot
    Wait-DbReady -ComposeFile $composeFile
    Get-Content -LiteralPath $tempSql -Raw -Encoding UTF8 | docker compose -f $composeFile exec -T db psql -v ON_ERROR_STOP=1 -U postgres -d postgres
    if ($LASTEXITCODE -ne 0) { throw "psql failed with exit $LASTEXITCODE" }
    Write-Host "OK: vault + cron patched (Kong base: $base)"
}
finally {
    Pop-Location
    if (Test-Path $tempSql) { Remove-Item -LiteralPath $tempSql -Force -ErrorAction SilentlyContinue }
}
