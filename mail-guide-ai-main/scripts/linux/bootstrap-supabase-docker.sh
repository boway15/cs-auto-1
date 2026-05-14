#!/usr/bin/env bash
# 从官方仓库拉取 Supabase 自建 Docker 模板到仓库根目录的 supabase-selfhost/。
# 依赖: git（建议 2.25+，支持 sparse-checkout）、bash
# 用法: ./bootstrap-supabase-docker.sh [目标目录]
set -euo pipefail

TARGET_DIR="${1:-}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MAIL_GUIDE_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
CS_MAIN_ROOT="$(cd "$MAIL_GUIDE_ROOT/.." && pwd)"

if [[ -z "$TARGET_DIR" ]]; then
  TARGET_DIR="$CS_MAIN_ROOT/supabase-selfhost"
fi

COMPOSE_FILE="$TARGET_DIR/docker-compose.yml"
if [[ -f "$COMPOSE_FILE" ]]; then
  echo "Already exists: $COMPOSE_FILE"
  echo "To re-bootstrap, backup .env then remove folder: $TARGET_DIR"
  exit 0
fi

if ! command -v git >/dev/null 2>&1; then
  echo "Git not found. Install git and ensure it is on PATH." >&2
  exit 1
fi

mkdir -p "$TARGET_DIR"
TEMP="$(mktemp -d "${TMPDIR:-/tmp}/supabase-official-docker-XXXXXX")"
cleanup() { rm -rf "$TEMP"; }
trap cleanup EXIT

echo "Cloning supabase/docker (Git 2.25+, github.com)..."
git clone --depth 1 --filter=blob:none --sparse https://github.com/supabase/supabase.git "$TEMP"
git -C "$TEMP" sparse-checkout set docker

DOCKER_SRC="$TEMP/docker"
if [[ ! -d "$DOCKER_SRC" ]]; then
  echo "docker folder missing after sparse-checkout: $DOCKER_SRC" >&2
  exit 1
fi

shopt -s dotglob
cp -a "$DOCKER_SRC"/* "$TARGET_DIR/"
shopt -u dotglob

echo "Done: $TARGET_DIR"
echo ""
echo "Next:"
echo "  1. cp .env.example .env   (in $TARGET_DIR)"
echo "  2. sh ./utils/generate-keys.sh   (see Supabase docker docs)"
echo "  3. Set SUPABASE_PUBLIC_URL, API_EXTERNAL_URL, SITE_URL (mail-guide-ai URL)"
echo "  4. docker compose pull && docker compose up -d"
echo "  5. See mail-guide-ai-main/docs/self-hosted-supabase.md (migrations + sync-functions)"
