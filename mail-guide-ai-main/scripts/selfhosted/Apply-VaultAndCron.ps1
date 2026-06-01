#Requires -Version 5.1
<#
.SYNOPSIS
  Self-hosted Supabase: update vault.service_role_key and pg_cron to call the in-stack Kong Functions URL.
  Registers business cron jobs for self-hosted Kong (no *.supabase.co):
  sync-mailbox, schedule-draft-generation, run-compensation-tasks, retry-risk-intercept-compensation,
  run-email-body-repair-tasks, run-email-attachment-repair-tasks, run-email-fetch-tasks,
  run-sla-mailbox-sync, run-mailbox-history-backfill.
  compensating-alerts is removed and replaced by first/final ops alerts.

.PARAMETER SelfhostRoot
  supabase-selfhost directory, defaults to <cs-main>/supabase-selfhost

.PARAMETER KongInternalUrl
  Kong base URL reachable from the db container, defaults to http://kong:8000
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
$uComp = Sql-EscapeLiteral ($base + "/functions/v1/run-compensation-tasks")
$uRiskRetry = Sql-EscapeLiteral ($base + "/functions/v1/retry-risk-intercept-compensation")
$uBodyRepair = Sql-EscapeLiteral ($base + "/functions/v1/run-email-body-repair-tasks")
$uAttRepair = Sql-EscapeLiteral ($base + "/functions/v1/run-email-attachment-repair-tasks")
$uFetchTasks = Sql-EscapeLiteral ($base + "/functions/v1/run-email-fetch-tasks")
$uSlaSync = Sql-EscapeLiteral ($base + "/functions/v1/run-sla-mailbox-sync")
$uHistoryBackfill = Sql-EscapeLiteral ($base + "/functions/v1/run-mailbox-history-backfill")

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

$lines.Add("SELECT cron.unschedule('compensating-alerts-every-30min') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'compensating-alerts-every-30min');")
$lines.Add("")
Add-CronBlock -Out $lines -JobName "auto-sync-mailbox-every-5min" -Schedule "*/4 * * * *" -UrlEscaped $uSync
Add-CronBlock -Out $lines -JobName "auto-draft-every-30min" -Schedule "2-59/4 * * * *" -UrlEscaped $uDraft
Add-CronBlock -Out $lines -JobName "run-compensation-tasks-every-30min" -Schedule "*/20 * * * *" -UrlEscaped $uComp
$lines.Add("SELECT cron.unschedule('retry-risk-intercept-hourly-at-10') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'retry-risk-intercept-hourly-at-10');")
$lines.Add("")
$lines.Add("SELECT cron.unschedule('retry-risk-intercept-hourly-at-29') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'retry-risk-intercept-hourly-at-29');")
$lines.Add("")
Add-CronBlock -Out $lines -JobName "retry-risk-intercept-hourly-at-45" -Schedule "*/20 * * * *" -UrlEscaped $uRiskRetry
Add-CronBlock -Out $lines -JobName "email-body-repair-tasks-every-3min" -Schedule "1-59/3 * * * *" -UrlEscaped $uBodyRepair
Add-CronBlock -Out $lines -JobName "email-attachment-repair-tasks-every-5min" -Schedule "2-59/5 * * * *" -UrlEscaped $uAttRepair
Add-CronBlock -Out $lines -JobName "email-fetch-tasks-every-3min" -Schedule "3-59/3 * * * *" -UrlEscaped $uFetchTasks
Add-CronBlock -Out $lines -JobName "run-sla-mailbox-sync-every-10min" -Schedule "5,15,25,35,45,55 * * * *" -UrlEscaped $uSlaSync
Add-CronBlock -Out $lines -JobName "run-mailbox-history-backfill-every-5min" -Schedule "8,18,28,38,48,58 * * * *" -UrlEscaped $uHistoryBackfill

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
