# n8n workflows

## Import order

1. `99-error-alert.json` — shared error handler. Set it as the error workflow
   for every other workflow.
2. `01-content-ingest-rewrite.json` — RSS → guardrail → rewrite → review queue.
3. `02-content-publish-scheduler.json` — picks approved drafts and publishes.
4. `03-review-sync.json` — syncs Google Sheets verdicts back into Postgres.
5. `04-cskh-zalo-intent.json` — ZaloCRM webhook → intent → handoff or shadow reply.
6. (Phase 2) `05-content-fanout.json`, `06-cskh-fb-messenger.json`.

## Credentials n8n needs (create via UI → Credentials)

| Credential name                | Type                         | Notes                                                                                       |
| ------------------------------ | ---------------------------- | ------------------------------------------------------------------------------------------- |
| `Postgres — ZaloCRM`           | Postgres                     | host `db`, db `zalocrm`, user `${DB_USER}`, pwd `${DB_PASSWORD}`, sslMode `disable`         |
| `Redis`                        | Redis                        | host `redis`, port `6379`, password `${REDIS_PASSWORD}`                                     |
| `Google Sheets (service account)` | Google Sheets OAuth2      | Use service account JSON. Share the sheet with the service-account email.                   |
| `LiteLLM` (optional, unused)   | HTTP Header Auth             | Not required — we inject Bearer token via env in each HTTP Request node.                    |

## Environment variables referenced by the workflows

Sourced from `automation/.env` via `docker-compose`:

```
ZALOCRM_ORG_ID, ZALOCRM_BASE_URL, ZALOCRM_API_KEY, ZALOCRM_WEBHOOK_SECRET
LITELLM_KEY_CONTENT, LITELLM_KEY_CSKH        # per-workflow virtual keys from LiteLLM
CSKH_SHADOW_MODE                             # "true" | "false"
FB_PAGE_ID, FB_PAGE_ACCESS_TOKEN
GOOGLE_SHEETS_REVIEW_QUEUE_ID
TELEGRAM_BOT_TOKEN, TELEGRAM_ALERT_CHAT_ID, TELEGRAM_SALES_CHAT_ID
OPENCLAW_BASE_URL, OPENCLAW_API_KEY
```

## Toggling shadow mode

- Phase 1.6 runs with `CSKH_SHADOW_MODE=true`. Bot drafts are logged to
  `omni.intent_log.bot_draft` but never sent. Staff grades each row via the
  `staff_verdict` column (approved / rejected / edited).
- Once precision ≥ 85 % over a 7-day window (see `scripts/shadow-report.sql`),
  flip to `CSKH_SHADOW_MODE=false` and restart n8n. No workflow edit required.
