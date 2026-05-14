#!/usr/bin/env bash
# 将业务 Edge Functions 同步到自建 Supabase volumes/functions。
# 用法: ./sync-functions-to-selfhost.sh [supabase-selfhost 根目录]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MAIL_GUIDE_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
CS_MAIN_ROOT="$(cd "$MAIL_GUIDE_ROOT/.." && pwd)"
SELFHOST_ROOT="${1:-$CS_MAIN_ROOT/supabase-selfhost}"
SRC_FUNCTIONS="$MAIL_GUIDE_ROOT/supabase/functions"
DST_FUNCTIONS="$SELFHOST_ROOT/volumes/functions"

if [[ ! -d "$SRC_FUNCTIONS" ]]; then
  echo "Source functions folder not found: $SRC_FUNCTIONS" >&2
  exit 1
fi
if [[ ! -d "$DST_FUNCTIONS" ]]; then
  echo "Target folder not found: $DST_FUNCTIONS (run bootstrap and docker compose up first)" >&2
  exit 1
fi

for dir in "$SRC_FUNCTIONS"/*/; do
  name="$(basename "$dir")"
  [[ "$name" == "main" || "$name" == "hello" ]] && continue
  dest="$DST_FUNCTIONS/$name"
  echo "Sync: $name -> $dest"
  rm -rf "$dest"
  cp -a "$dir" "$dest"
done

echo "Done. Next: cd \"$SELFHOST_ROOT\"; docker compose restart functions --no-deps"
