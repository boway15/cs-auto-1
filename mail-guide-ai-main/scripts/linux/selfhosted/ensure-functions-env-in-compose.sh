#!/usr/bin/env bash
# 若 supabase-selfhost/docker-compose.yml 的 functions 服务未引用 .env.functions，则插入 env_file。
# 用法: ./ensure-functions-env-in-compose.sh [supabase-selfhost 根目录]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MAIL_GUIDE_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
CS_MAIN_ROOT="$(cd "$MAIL_GUIDE_ROOT/.." && pwd)"
SELFHOST_ROOT="${1:-$CS_MAIN_ROOT/supabase-selfhost}"
YML="$SELFHOST_ROOT/docker-compose.yml"

if [[ ! -f "$YML" ]]; then echo "Missing: $YML" >&2; exit 1; fi

if grep -Eq '^[[:space:]]*-[[:space:]]+\.env\.functions[[:space:]]*$' "$YML"; then
  echo "Already configured: .env.functions referenced in compose."
else
  NEEDLE_CR=$'    restart: unless-stopped\r\n    volumes:\r\n      - ./volumes/functions:/home/deno/functions:Z\r\n      - deno-cache:/root/.cache/deno'
  INSERT_CR=$'    restart: unless-stopped\r\n    env_file:\r\n      - .env.functions\r\n    volumes:\r\n      - ./volumes/functions:/home/deno/functions:Z\r\n      - deno-cache:/root/.cache/deno'
  NEEDLE_LF=$'    restart: unless-stopped\n    volumes:\n      - ./volumes/functions:/home/deno/functions:Z\n      - deno-cache:/root/.cache/deno'
  INSERT_LF=$'    restart: unless-stopped\n    env_file:\n      - .env.functions\n    volumes:\n      - ./volumes/functions:/home/deno/functions:Z\n      - deno-cache:/root/.cache/deno'

  RAW="$(cat "$YML")"
  if [[ "$RAW" == *"$NEEDLE_CR"* ]]; then
    printf '%s' "${RAW//$NEEDLE_CR/$INSERT_CR}" >"$YML"
    echo "Patched: $YML (env_file .env.functions)"
  elif [[ "$RAW" == *"$NEEDLE_LF"* ]]; then
    printf '%s' "${RAW//$NEEDLE_LF/$INSERT_LF}" >"$YML"
    echo "Patched: $YML (env_file .env.functions)"
  else
    echo "Could not find functions service block (restart + volumes). Edit docker-compose.yml manually — add under functions:" >&2
    echo "    env_file:" >&2
    echo "      - .env.functions" >&2
    exit 1
  fi
fi

ENV_FN="$SELFHOST_ROOT/.env.functions"
EXAMPLE="$MAIL_GUIDE_ROOT/docs/self-hosted-env-functions.example"
if [[ ! -f "$ENV_FN" && -f "$EXAMPLE" ]]; then
  cp -a "$EXAMPLE" "$ENV_FN"
  echo "Created: $ENV_FN (from example — fill secrets)"
elif [[ ! -f "$ENV_FN" ]]; then
  printf '%s\n' "# Add DIFY_* and other keys — see docs/self-hosted-env-functions.example" >"$ENV_FN"
  echo "Created stub: $ENV_FN"
fi

echo "Next: edit $ENV_FN then: cd \"$SELFHOST_ROOT\"; docker compose up -d --force-recreate --no-deps functions"
