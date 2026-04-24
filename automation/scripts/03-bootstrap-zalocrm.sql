-- Phase 1.3 bootstrap — directly provisions:
--   1. A public API key for n8n (`app_settings.public_api_key`)
--   2. Webhook URL + HMAC secret pointing at n8n
--
-- Safer than exposing the admin REST API to external scripts. Idempotent:
-- re-running updates the existing settings instead of duplicating rows.
--
-- Usage:
--   # 1. Find the target org id (skip if you only have one organization)
--   docker exec -it zalo-crm-db psql -U crmuser -d zalocrm \
--     -c "SELECT id, name FROM organizations;"
--
--   # 2. Export env vars and run
--   export TARGET_ORG_ID=<paste org id>
--   export N8N_BASE_URL=https://n8n.yourdomain.com
--   export ZCRM_API_KEY=zcrm_$(openssl rand -hex 24)
--   export ZCRM_WEBHOOK_SECRET=$(openssl rand -hex 32)
--
--   docker exec -i zalo-crm-db psql -U crmuser -d zalocrm \
--     -v org_id="'$TARGET_ORG_ID'" \
--     -v api_key="'$ZCRM_API_KEY'" \
--     -v webhook_url="'$N8N_BASE_URL/webhook/zalocrm/events'" \
--     -v webhook_secret="'$ZCRM_WEBHOOK_SECRET'" \
--     < automation/scripts/03-bootstrap-zalocrm.sql
--
--   # 3. Save ZCRM_API_KEY / ZCRM_WEBHOOK_SECRET into automation/.env as
--      ZALOCRM_API_KEY and ZALOCRM_WEBHOOK_SECRET.

BEGIN;

-- api key
INSERT INTO app_settings (id, org_id, setting_key, value_plain, created_at, updated_at)
VALUES (gen_random_uuid()::text, :org_id, 'public_api_key', :api_key, now(), now())
ON CONFLICT (org_id, setting_key)
DO UPDATE SET value_plain = EXCLUDED.value_plain, updated_at = now();

-- webhook URL
INSERT INTO app_settings (id, org_id, setting_key, value_plain, created_at, updated_at)
VALUES (gen_random_uuid()::text, :org_id, 'webhook_url', :webhook_url, now(), now())
ON CONFLICT (org_id, setting_key)
DO UPDATE SET value_plain = EXCLUDED.value_plain, updated_at = now();

-- webhook HMAC-SHA256 secret
INSERT INTO app_settings (id, org_id, setting_key, value_plain, created_at, updated_at)
VALUES (gen_random_uuid()::text, :org_id, 'webhook_secret', :webhook_secret, now(), now())
ON CONFLICT (org_id, setting_key)
DO UPDATE SET value_plain = EXCLUDED.value_plain, updated_at = now();

COMMIT;

-- Verify
SELECT setting_key,
       CASE
         WHEN setting_key IN ('webhook_secret', 'public_api_key')
              THEN substring(value_plain FROM 1 FOR 8) || '…' || substring(value_plain FROM length(value_plain) - 3)
         ELSE value_plain
       END AS value_masked,
       updated_at
FROM app_settings
WHERE org_id = :org_id
  AND setting_key IN ('public_api_key', 'webhook_url', 'webhook_secret')
ORDER BY setting_key;
