#!/usr/bin/env bash
# Backup restore drill (Phase 1.7). Proves the daily ZaloCRM Postgres
# backup is actually usable. Run once per week; fail loudly if restore fails.
#
# Requirements:
#   - ZaloCRM's `backup` service produces dumps in ./ZaloCRM/backups/ (mounted volume).
#   - This host has `docker` installed.
#
# Steps:
#   1. Pick the latest *.sql.gz in ZaloCRM/backups/.
#   2. Spin up a throwaway Postgres container.
#   3. Restore into it.
#   4. Run sanity queries (row counts, schemas present).
#   5. Tear down.
#
# Usage:
#   ./automation/scripts/backup-restore-drill.sh
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-$PWD/ZaloCRM/backups}"
IMAGE="${IMAGE:-postgres:16-alpine}"
TEST_CONTAINER="zcrm-restore-drill"
TEST_DB="zalocrm_drill"
TEST_USER="drill"
TEST_PASSWORD="drill-$(openssl rand -hex 8)"

latest_backup="$(ls -1t "$BACKUP_DIR"/*.sql.gz 2>/dev/null | head -n1 || true)"
[ -z "$latest_backup" ] && { echo "ERROR: no backup found in $BACKUP_DIR"; exit 1; }
age_hours="$(( ($(date +%s) - $(stat -c %Y "$latest_backup")) / 3600 ))"
echo "Drill target: $latest_backup (age: ${age_hours}h)"
[ "$age_hours" -gt 48 ] && { echo "FAIL: backup older than 48h"; exit 2; }

cleanup() { docker rm -f "$TEST_CONTAINER" >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo "[1/4] Starting throwaway Postgres..."
docker run -d --rm --name "$TEST_CONTAINER" \
  -e POSTGRES_USER="$TEST_USER" \
  -e POSTGRES_PASSWORD="$TEST_PASSWORD" \
  -e POSTGRES_DB="$TEST_DB" \
  "$IMAGE" >/dev/null

for i in $(seq 1 20); do
  docker exec "$TEST_CONTAINER" pg_isready -U "$TEST_USER" -d "$TEST_DB" >/dev/null 2>&1 && break
  sleep 1
done

echo "[2/4] Restoring dump..."
gunzip -c "$latest_backup" | docker exec -i "$TEST_CONTAINER" psql -U "$TEST_USER" -d "$TEST_DB" -v ON_ERROR_STOP=1 >/dev/null

echo "[3/4] Sanity checks..."
docker exec "$TEST_CONTAINER" psql -U "$TEST_USER" -d "$TEST_DB" -v ON_ERROR_STOP=1 <<'SQL'
DO $$
DECLARE
  n_orgs int; n_contacts int; n_messages int; n_schemas int;
BEGIN
  SELECT count(*) INTO n_orgs      FROM organizations;
  SELECT count(*) INTO n_contacts  FROM contacts;
  SELECT count(*) INTO n_messages  FROM messages;
  SELECT count(*) INTO n_schemas   FROM information_schema.schemata
    WHERE schema_name IN ('public', 'content', 'omni');

  RAISE NOTICE 'orgs=%, contacts=%, messages=%, schemas=%', n_orgs, n_contacts, n_messages, n_schemas;
  IF n_orgs = 0   THEN RAISE EXCEPTION 'restore drill: 0 organizations'; END IF;
  IF n_schemas < 3 THEN RAISE EXCEPTION 'restore drill: content/omni schemas missing'; END IF;
END $$;
SQL

echo "[4/4] OK — backup is restorable."
