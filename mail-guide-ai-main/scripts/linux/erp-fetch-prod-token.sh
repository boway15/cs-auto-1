#!/usr/bin/env bash
# POST ERP production OAuth2 password grant; prints JSON.
# 环境变量: ERP_USERNAME, ERP_PASSWORD
# 可选: ERP_CLIENT_ID (默认 ERP)
# 可选第一个参数: Token URL（默认生产）
set -euo pipefail

TOKEN_URL="${1:-https://loginserver.bestwo.net:9443/connect/token}"
USER="${ERP_USERNAME:-}"
PASS="${ERP_PASSWORD:-}"
CLIENT_ID="${ERP_CLIENT_ID:-ERP}"

if [[ -z "$USER" || -z "$PASS" ]]; then
  echo "Set ERP_USERNAME and ERP_PASSWORD. See docs/erp-order-api.md section 3.4." >&2
  exit 1
fi

# 使用 Python 做 URL 编码（CentOS 上通常有 python3）
if command -v python3 >/dev/null 2>&1; then
  enc() { python3 -c "import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1], safe=''))" "$1"; }
elif command -v python >/dev/null 2>&1; then
  enc() { python -c "import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1], safe=''))" "$1"; }
else
  echo "Need python3 (or python) for form encoding." >&2
  exit 1
fi

FORM="username=$(enc "$USER")&password=$(enc "$PASS")&client_id=$(enc "$CLIENT_ID")&grant_type=password"

if command -v curl >/dev/null 2>&1; then
  OUT="$(curl -sS -X POST "$TOKEN_URL" \
    -H "Content-Type: application/x-www-form-urlencoded; charset=utf-8" \
    --data-binary "$FORM")"
  if command -v python3 >/dev/null 2>&1; then
    echo "$OUT" | python3 -m json.tool 2>/dev/null || echo "$OUT"
  else
    echo "$OUT"
  fi
else
  echo "curl not found." >&2
  exit 1
fi
