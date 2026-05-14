#!/usr/bin/env bash
# 将 supabase-selfhost 中常见脚本/配置从 CRLF 转为 LF，避免 Docker 内 Kong / Supavisor 报错。
# 用法: ./fix-supabase-selfhost-crlf.sh [supabase-selfhost 根目录]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MAIL_GUIDE_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
CS_MAIN_ROOT="$(cd "$MAIL_GUIDE_ROOT/.." && pwd)"
SELFHOST_ROOT="${1:-$CS_MAIN_ROOT/supabase-selfhost}"

fix_file() {
  local f="$1"
  if [[ ! -f "$f" ]]; then
    echo "Skip (missing): $f" >&2
    return 0
  fi
  if command -v perl >/dev/null 2>&1; then
    perl -pi -e 's/\r\n/\n/g; s/\r/\n/g' "$f"
  else
    sed -i 's/\r$//' "$f"
  fi
  echo "LF: $f"
}

fix_file "$SELFHOST_ROOT/volumes/api/kong-entrypoint.sh"
fix_file "$SELFHOST_ROOT/volumes/pooler/pooler.exs"

echo "Done. Then: cd \"$SELFHOST_ROOT\"; docker compose up -d --force-recreate kong supavisor"
