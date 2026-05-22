#!/usr/bin/env bash
# Apply one mail-guide-ai backend release on self-hosted Supabase.
# Usage:
#   apply-backend-release.sh [mail-guide-ai-main root] [supabase-selfhost root] [manifest]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEFAULT_MAIL_GUIDE_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

MAIL_GUIDE_ROOT="${1:-$DEFAULT_MAIL_GUIDE_ROOT}"
SELFHOST_ROOT="${2:-$(cd "$MAIL_GUIDE_ROOT/.." && pwd)/supabase-selfhost}"
MANIFEST="${3:-$MAIL_GUIDE_ROOT/deploy/backend-release.env}"

MIGRATIONS_DIR="$MAIL_GUIDE_ROOT/supabase/migrations"
FUNCTIONS_DIR="$SELFHOST_ROOT/volumes/functions"
COMPOSE_FILE="$SELFHOST_ROOT/docker-compose.yml"

if [[ ! -f "$MANIFEST" ]]; then echo "Missing release manifest: $MANIFEST" >&2; exit 1; fi
if [[ ! -d "$MIGRATIONS_DIR" ]]; then echo "Missing migrations dir: $MIGRATIONS_DIR" >&2; exit 1; fi
if [[ ! -d "$FUNCTIONS_DIR" ]]; then echo "Missing functions volume: $FUNCTIONS_DIR" >&2; exit 1; fi
if [[ ! -f "$COMPOSE_FILE" ]]; then echo "Missing compose file: $COMPOSE_FILE" >&2; exit 1; fi

# shellcheck source=/dev/null
source "$MANIFEST"

RELEASE_VERSION="${RELEASE_VERSION:-manual}"
RUN_APPLY_VAULT_AND_CRON="${RUN_APPLY_VAULT_AND_CRON:-false}"
APPLY_FUNCTIONS="${APPLY_FUNCTIONS:-true}"
BACKUP_FUNCTIONS="${BACKUP_FUNCTIONS:-true}"
if [[ ! "$RELEASE_VERSION" =~ ^[A-Za-z0-9._-]+$ ]]; then
  echo "Invalid RELEASE_VERSION: $RELEASE_VERSION" >&2
  exit 1
fi
if ! declare -p MIGRATIONS >/dev/null 2>&1; then
  MIGRATIONS=()
fi

run_db_sql() {
  docker compose -f "$COMPOSE_FILE" exec -T db psql -v ON_ERROR_STOP=1 -U postgres -d postgres "$@"
}

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

bool_is_true() {
  case "${1:-}" in
    true|TRUE|1|yes|YES|y|Y) return 0 ;;
    *) return 1 ;;
  esac
}

echo "==> Backend release: $RELEASE_VERSION"
echo "    mail-guide root : $MAIL_GUIDE_ROOT"
echo "    selfhost root   : $SELFHOST_ROOT"
echo "    manifest        : $MANIFEST"

cd "$SELFHOST_ROOT"
wait_db_ready 90

echo "==> Ensure backend migration ledger"
run_db_sql <<'SQL'
CREATE SCHEMA IF NOT EXISTS ops;
CREATE TABLE IF NOT EXISTS ops.backend_release_migrations (
  filename text PRIMARY KEY,
  release_version text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);
SQL

if (( ${#MIGRATIONS[@]} > 0 )); then
  echo "==> Apply listed migrations"
else
  echo "==> No migrations listed"
fi

for migration in "${MIGRATIONS[@]}"; do
  if [[ ! "$migration" =~ ^[0-9]{14}_[A-Za-z0-9_.-]+\.sql$ ]]; then
    echo "Invalid migration filename: $migration" >&2
    exit 1
  fi

  sql_path="$MIGRATIONS_DIR/$migration"
  if [[ ! -f "$sql_path" ]]; then
    echo "Migration file not found: $sql_path" >&2
    exit 1
  fi

  already_applied="$(docker compose -f "$COMPOSE_FILE" exec -T db psql -U postgres -d postgres -tAc "SELECT 1 FROM ops.backend_release_migrations WHERE filename = '$migration' LIMIT 1;" | tr -d '[:space:]')"
  if [[ "$already_applied" == "1" ]]; then
    echo "Skip already applied migration: $migration"
    continue
  fi

  echo "Apply migration: $migration"
  docker compose -f "$COMPOSE_FILE" cp "$sql_path" "db:/tmp/$migration"
  run_db_sql -f "/tmp/$migration"
  run_db_sql -c "INSERT INTO ops.backend_release_migrations(filename, release_version) VALUES ('$migration', '$RELEASE_VERSION') ON CONFLICT (filename) DO NOTHING;"
done

if bool_is_true "$RUN_APPLY_VAULT_AND_CRON"; then
  echo "==> Apply vault and cron"
  bash "$MAIL_GUIDE_ROOT/scripts/linux/selfhosted/apply-vault-and-cron.sh" "$SELFHOST_ROOT"
else
  echo "==> Skip vault and cron"
fi

if bool_is_true "$APPLY_FUNCTIONS"; then
  if bool_is_true "$BACKUP_FUNCTIONS"; then
    backup_root="${BACKUP_ROOT:-/data/temp/mail-guide-ai-main/backup}"
    backup_name="functions_${BUILD_NUMBER:-$(date +%Y%m%d%H%M%S)}"
    backup_dir="$backup_root/$backup_name"
    echo "==> Backup functions to $backup_dir"
    mkdir -p "$backup_dir"
    cp -a "$FUNCTIONS_DIR/." "$backup_dir/"
  fi

  echo "==> Sync Edge Functions"
  bash "$MAIL_GUIDE_ROOT/scripts/linux/sync-functions-to-selfhost.sh" "$SELFHOST_ROOT"

  echo "==> Recreate functions service"
  docker compose -f "$COMPOSE_FILE" up -d --force-recreate --no-deps functions
  sleep 20
  docker compose -f "$COMPOSE_FILE" logs functions --tail 50
else
  echo "==> Skip Edge Functions"
fi

echo "OK: backend release applied"
