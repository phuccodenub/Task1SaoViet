-- Run once against the ZaloCRM Postgres container to provision
-- auxiliary databases for n8n and LiteLLM. Uses the same superuser
-- that is defined in ZaloCRM/.env (DB_USER).
--
-- Usage:
--   docker exec -i zalo-crm-db psql -U crmuser -d postgres \
--     < automation/scripts/01-create-databases.sql

SELECT 'CREATE DATABASE n8n OWNER crmuser ENCODING ''UTF8'''
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'n8n')
\gexec

SELECT 'CREATE DATABASE litellm OWNER crmuser ENCODING ''UTF8'''
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'litellm')
\gexec

-- Do NOT grant anything further — the DB_USER already owns everything in its own DBs.
