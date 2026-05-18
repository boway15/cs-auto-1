#!/usr/bin/env bash
# 生产/验收环境发布后对账：仓库、Functions 目录、Kong 可达性、前端镜像（可选）。
# 用法:
#   export REPO_ROOT=/data/service/cs-main
#   export SELFHOST_ROOT=/data/service/supabase-selfhost
#   bash mail-guide-ai-main/scripts/linux/post-deploy-verify.sh
#
# 可选:
#   FRONTEND_CONTAINER=intelligent_customer_service  # 检查镜像内是否含 localhost
#   KONG_URL=http://127.0.0.1:8000                 # 默认；ANON 从 SELFHOST_ROOT/.env 读取
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MAIL_GUIDE_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
REPO_ROOT="${REPO_ROOT:-$(cd "$MAIL_GUIDE_ROOT/.." && pwd)}"
SELFHOST_ROOT="${SELFHOST_ROOT:-$REPO_ROOT/supabase-selfhost}"
SRC_FUNCTIONS="$MAIL_GUIDE_ROOT/supabase/functions"
DST_FUNCTIONS="$SELFHOST_ROOT/volumes/functions"
KONG_URL="${KONG_URL:-http://127.0.0.1:8000}"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'
FAIL=0
WARN=0

ok()   { echo -e "${GREEN}[OK]${NC} $*"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $*"; WARN=$((WARN + 1)); }
bad()  { echo -e "${RED}[FAIL]${NC} $*"; FAIL=$((FAIL + 1)); }

echo "=== post-deploy-verify ==="
echo "REPO_ROOT=$REPO_ROOT"
echo "SELFHOST_ROOT=$SELFHOST_ROOT"
echo ""

# --- 1) 完整仓库（同步脚本依赖）---
if [[ -d "$SRC_FUNCTIONS" ]]; then
  ok "业务函数源码: $SRC_FUNCTIONS"
else
  bad "缺少 mail-guide-ai-main/supabase/functions（无法正确执行 sync-functions-to-selfhost.sh）"
fi

# --- 2) 已部署函数目录 vs 源码 ---
EXPECTED_SKIP='^(main|hello)$'
if [[ -d "$DST_FUNCTIONS" ]]; then
  ok "Functions 卷: $DST_FUNCTIONS"
  missing=()
  while IFS= read -r -d '' dir; do
    name="$(basename "$dir")"
    [[ "$name" =~ $EXPECTED_SKIP ]] && continue
    [[ "$name" == "_shared" || "$name" == "certs" ]] && continue
    if [[ ! -f "$DST_FUNCTIONS/$name/index.ts" ]]; then
      missing+=("$name")
    fi
  done < <(find "$SRC_FUNCTIONS" -mindepth 1 -maxdepth 1 -type d -print0 2>/dev/null || true)
  if ((${#missing[@]})); then
    bad "volumes/functions 缺少或未完整同步: ${missing[*]}"
  else
    ok "volumes/functions 与源码目录一一对应（含 index.ts）"
  fi
  for required in main hello test-mailbox sync-mailbox _shared; do
    if [[ "$required" == "_shared" ]]; then
      [[ -d "$DST_FUNCTIONS/_shared" ]] || bad "缺少 _shared/"
    elif [[ -f "$DST_FUNCTIONS/$required/index.ts" ]]; then
      ok "关键目录: $required"
    else
      bad "缺少关键函数: $required/index.ts"
    fi
  done
else
  bad "不存在 $DST_FUNCTIONS"
fi

# --- 3) Docker 容器 ---
if command -v docker >/dev/null 2>&1; then
  for c in supabase-kong supabase-edge-functions supabase-db; do
    if docker ps --format '{{.Names}}' | grep -qx "$c"; then
      ok "容器运行中: $c"
    else
      bad "容器未运行: $c"
    fi
  done
else
  warn "未安装 docker，跳过容器检查"
fi

# --- 4) Kong / Functions HTTP ---
ENV_FILE="$SELFHOST_ROOT/.env"
if [[ -f "$ENV_FILE" ]]; then
  ANON=$(grep -m1 '^ANON_KEY=' "$ENV_FILE" | cut -d= -f2- | tr -d '\r')
  PUB=$(grep -m1 '^SUPABASE_PUBLIC_URL=' "$ENV_FILE" | cut -d= -f2- | tr -d '\r')
  [[ -n "$PUB" ]] && ok "SUPABASE_PUBLIC_URL=$PUB"
else
  warn "未找到 $ENV_FILE，跳过 HTTP 检查"
  ANON=""
fi

if [[ -n "${ANON:-}" ]] && command -v curl >/dev/null 2>&1; then
  code=$(curl -s -o /dev/null -w '%{http_code}' "$KONG_URL/functions/v1/hello" -H "apikey: $ANON" || echo "000")
  if [[ "$code" == "200" ]]; then
    ok "GET $KONG_URL/functions/v1/hello -> $code"
  else
    bad "GET /functions/v1/hello -> $code（预期 200）"
  fi
  body=$(curl -s -X POST "$KONG_URL/functions/v1/test-mailbox" \
    -H "apikey: $ANON" -H "Authorization: Bearer $ANON" \
    -H "Content-Type: application/json" \
    -d '{"host":"127.0.0.1","port":19999,"user":"u","pass":"p"}' || true)
  if echo "$body" | grep -q 'could not find an appropriate entrypoint'; then
    bad "test-mailbox 未部署（entrypoint 错误）— 需 sync-functions + 重建 functions"
  elif echo "$body" | grep -q '"ok"'; then
    ok "POST /functions/v1/test-mailbox 已响应（非 entrypoint 错误）"
  else
    warn "test-mailbox 响应异常: ${body:0:120}"
  fi
fi

# --- 5) .env.functions ---
if [[ -f "$SELFHOST_ROOT/.env.functions" ]]; then
  ok ".env.functions 存在"
  for key in DIFY_ANALYZE_URL DIFY_DRAFT_URL; do
    if grep -q "^${key}=" "$SELFHOST_ROOT/.env.functions" 2>/dev/null; then
      ok "已配置 $key"
    else
      warn "未配置 $key（收信/草稿链路可能失败）"
    fi
  done
else
  warn "缺少 $SELFHOST_ROOT/.env.functions"
fi

# --- 6) 前端镜像 VITE（可选）---
if [[ -n "${FRONTEND_CONTAINER:-}" ]] && command -v docker >/dev/null 2>&1; then
  if docker ps --format '{{.Names}}' | grep -qx "$FRONTEND_CONTAINER"; then
    if docker exec "$FRONTEND_CONTAINER" sh -c 'grep -l localhost /usr/share/nginx/html/assets/*.js 2>/dev/null' | grep -q .; then
      bad "前端镜像 $FRONTEND_CONTAINER 的 JS 含 localhost — 需用正确 VITE_* 重建镜像"
    else
      ok "前端镜像未发现 localhost（粗检）"
    fi
  else
    warn "未找到前端容器: $FRONTEND_CONTAINER"
  fi
fi

echo ""
echo "=== 汇总: FAIL=$FAIL WARN=$WARN ==="
if (( FAIL > 0 )); then
  echo "请对照: docs/ops-sync-edge-functions-on-production.md"
  echo "         docs/ops-fix-production-image-wrong-supabase.md"
  echo "         docs/docker-deploy-new-server.md §六"
  exit 1
fi
exit 0
