#!/usr/bin/env bash
# One-shot bootstrap for Linux/macOS. Mirror of bootstrap.ps1.
set -euo pipefail

POSTGRES_CONTAINER="${POSTGRES_CONTAINER:-zalo-crm-db}"
DB_USER="${DB_USER:-crmuser}"
DB_NAME="${DB_NAME:-zalocrm}"
N8N_BASE_URL="${N8N_BASE_URL:-http://localhost:5678}"
ORG_ID="${ORG_ID:-}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

psql_run() {
  local database="$1"; shift
  local file="$1"; shift
  docker exec -i "$POSTGRES_CONTAINER" psql -U "$DB_USER" -d "$database" -v ON_ERROR_STOP=1 "$@" < "$file"
}

echo "[1/4] Creating n8n + litellm databases..."
psql_run postgres "$SCRIPT_DIR/01-create-databases.sql"

echo "[2/4] Creating content + omni schemas..."
psql_run "$DB_NAME" "$SCRIPT_DIR/02-content-schema.sql"

if [ -z "$ORG_ID" ]; then
  echo "[3a/4] Discovering default organization..."
  ORG_ID="$(docker exec "$POSTGRES_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -tAc "SELECT id FROM organizations ORDER BY created_at ASC LIMIT 1")"
  [ -z "$ORG_ID" ] && { echo "ERROR: no org found. Register a ZaloCRM user first."; exit 1; }
  echo "    -> orgId = $ORG_ID"
fi

API_KEY="zcrm_$(openssl rand -hex 24)"
WEBHOOK_SECRET="$(openssl rand -hex 32)"
WEBHOOK_URL="${N8N_BASE_URL%/}/webhook/zalocrm/events"

echo "[3b/4] Writing webhook + API key into app_settings..."
psql_run "$DB_NAME" "$SCRIPT_DIR/03-bootstrap-zalocrm.sql" \
  -v "org_id='$ORG_ID'" \
  -v "api_key='$API_KEY'" \
  -v "webhook_url='$WEBHOOK_URL'" \
  -v "webhook_secret='$WEBHOOK_SECRET'"

cat <<EOF

[4/4] Done. Save these into automation/.env:
ZALOCRM_ORG_ID=$ORG_ID
ZALOCRM_API_KEY=$API_KEY
ZALOCRM_WEBHOOK_SECRET=$WEBHOOK_SECRET

Then: docker compose --env-file .env up -d
EOF
