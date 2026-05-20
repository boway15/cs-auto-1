#!/usr/bin/env bash
# 自建 Supabase：更新 vault.service_role_key，并配置 pg_cron 调用栈内 Kong 的 Functions URL。
# 用法:
#   ./apply-vault-and-cron.sh [supabase-selfhost 根目录] [Kong 内网基址，默认 http://kong:8000]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MAIL_GUIDE_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
CS_MAIN_ROOT="$(cd "$MAIL_GUIDE_ROOT/.." && pwd)"
SELFHOST_ROOT="${1:-$CS_MAIN_ROOT/supabase-selfhost}"
KONG_INTERNAL_URL="${2:-http://kong:8000}"

ENV_FILE="$SELFHOST_ROOT/.env"
COMPOSE_FILE="$SELFHOST_ROOT/docker-compose.yml"

if [[ ! -f "$ENV_FILE" ]]; then echo "Missing: $ENV_FILE" >&2; exit 1; fi
if [[ ! -f "$COMPOSE_FILE" ]]; then echo "Missing: $COMPOSE_FILE" >&2; exit 1; fi

get_dotenv_value() {
  local file="$1" key="$2"
  tr -d '\r' <"$file" | awk -F= -v k="$key" '
    $1 == k {
      v = substr($0, index($0, "=") + 1)
      gsub(/^[ \t]+|[ \t]+$/, "", v)
      if (v ~ /^".*"$/) { v = substr(v, 2, length(v)-2) }
      else if (v ~ /^'\''.*'\''$/) { v = substr(v, 2, length(v)-2) }
      print v
      exit
    }
  '
}

escape_sql_lit() {
  local s="$1"
  printf '%s' "${s//\'/\'\'}"
}

SERVICE_ROLE_KEY="$(get_dotenv_value "$ENV_FILE" SERVICE_ROLE_KEY)"
if [[ -z "${SERVICE_ROLE_KEY// }" ]]; then
  echo "SERVICE_ROLE_KEY not found or empty in $ENV_FILE" >&2
  exit 1
fi

base="${KONG_INTERNAL_URL%/}"
u_sync="$(escape_sql_lit "${base}/functions/v1/sync-mailbox")"
u_draft="$(escape_sql_lit "${base}/functions/v1/schedule-draft-generation")"
u_comp="$(escape_sql_lit "${base}/functions/v1/run-compensation-tasks")"
u_risk="$(escape_sql_lit "${base}/functions/v1/retry-risk-intercept-compensation")"

TAG="mga_$(openssl rand -hex 16)"
if [[ "$SERVICE_ROLE_KEY" == *"$TAG"* ]]; then
  echo "SERVICE_ROLE_KEY delimiter collision; retry." >&2
  exit 1
fi

DOLLAR_Q="$(printf '$%s$%s$%s$' "$TAG" "$SERVICE_ROLE_KEY" "$TAG")"

add_cron_block() {
  local job="$1" sched="$2" url="$3"
  printf "SELECT cron.unschedule('%s')\n" "$job"
  printf "WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = '%s');\n\n" "$job"
  printf "SELECT cron.schedule(\n  '%s',\n  '%s',\n" "$job" "$sched"
  printf '%s\n' '  $$'
  printf "  SELECT net.http_post(\n    url := '%s',\n" "$url"
  printf '%s\n' "    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (
        SELECT decrypted_secret FROM vault.decrypted_secrets
        WHERE name = 'service_role_key' LIMIT 1
      )
    ),
    body := '{}'::jsonb
  ) AS request_id;"
  printf '%s\n' '  $$'
  printf ");\n\n"
}

TMP="$(mktemp /tmp/mga-vault-cron.XXXXXX)"
trap 'rm -f "$TMP"' EXIT

{
  cat <<'PART1'
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

DO $$
DECLARE v_id uuid;
BEGIN
  SELECT id INTO v_id FROM vault.secrets WHERE name = 'service_role_key';
  IF v_id IS NOT NULL THEN
PART1
  printf '%s\n' "    PERFORM vault.update_secret(v_id, ${DOLLAR_Q}, 'service_role_key', 'Service role key for cron-invoked edge functions');"
  cat <<'PART2'
  ELSE
PART2
  printf '%s\n' "    PERFORM vault.create_secret(${DOLLAR_Q}, 'service_role_key', 'Service role key for cron-invoked edge functions');"
  cat <<'PART3'
  END IF;
END $$;

PART3
  printf "%s\n" "SELECT cron.unschedule('compensating-alerts-every-30min') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'compensating-alerts-every-30min');"
  printf "\n"
  add_cron_block "auto-sync-mailbox-every-5min" "*/4 * * * *" "$u_sync"
  add_cron_block "auto-draft-every-30min" "2-59/4 * * * *" "$u_draft"
  add_cron_block "run-compensation-tasks-every-30min" "*/20 * * * *" "$u_comp"
  cat <<'PART4'
SELECT cron.unschedule('retry-risk-intercept-hourly-at-10') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'retry-risk-intercept-hourly-at-10');

SELECT cron.unschedule('retry-risk-intercept-hourly-at-29') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'retry-risk-intercept-hourly-at-29');

PART4
  add_cron_block "retry-risk-intercept-hourly-at-45" "*/20 * * * *" "$u_risk"
} >"$TMP"

wait_db_ready() {
  local max="${1:-90}"
  local t=0
  while (( t < max )); do
    if docker compose -f "$COMPOSE_FILE" exec -T db pg_isready -U postgres -h localhost >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
    t=$((t + 2))
  done
  echo "Database not ready after ${max} seconds." >&2
  return 1
}

cd "$SELFHOST_ROOT"
wait_db_ready 90
docker compose -f "$COMPOSE_FILE" exec -T db psql -v ON_ERROR_STOP=1 -U postgres -d postgres <"$TMP"
echo "OK: vault + cron patched (Kong base: $base)"
