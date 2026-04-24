# Operations runbook

## Standard cadence

| Task                              | Frequency   | Owner    | How                                                        |
| --------------------------------- | ----------- | -------- | ---------------------------------------------------------- |
| Shadow-mode report                | Daily       | CSKH TL  | `shadow-report.sql` → ops channel                          |
| Backup restore drill              | Weekly      | DevOps   | `scripts/backup-restore-drill.sh`                          |
| Cost review (LiteLLM)             | Weekly      | DevOps   | LiteLLM UI → `/spend/keys`                                 |
| Prompt A/B review                 | Bi-weekly   | Content  | `omni.intent_log` grouped by `variant_key`                 |
| Token / RPM limits review         | Monthly     | DevOps   | `/key/info` via LiteLLM master key                         |
| ZCA-JS version bump               | As released | DevOps   | Regression test on staging before pushing to prod          |

## Alert routing

- Uptime Kuma → Telegram `$TELEGRAM_ALERT_CHAT_ID` (ops channel).
- n8n workflow failure → `99-error-alert.json` → same Telegram channel.
- LiteLLM budget > 80 % → LiteLLM alert webhook → Telegram.
- ZaloCRM circuit breaker fires (≥5 disconnects/5 min) → SSE on ZaloCRM UI +
  Telegram via `call_webhook` automation rule (Phase 2.5).

## First-response playbook

### Zalo account disconnected (circuit breaker tripped)

1. Check Uptime Kuma for ZaloCRM status.
2. Open ZaloCRM → Zalo Accounts → find account with status `DISCONNECTED`.
3. Re-scan QR from the mobile device used to register.
4. Verify the first inbound message appears in `conversations` table.

### n8n workflow stuck / queue depth growing

1. `docker compose logs --tail=200 n8n n8n-worker`.
2. `docker exec automation-redis redis-cli -a $REDIS_PASSWORD LLEN bull:jobs:waiting`
3. Scale workers:
   `docker compose up -d --scale n8n-worker=3`.
4. If executions older than 24 h are waiting → investigate LLM/3rd-party outage.

### LiteLLM 5xx spikes

1. Check `/health` and provider status pages (Moonshot, Gemini).
2. Edit `litellm/config.yaml` to promote a healthy fallback as primary.
3. `docker compose kill -s SIGHUP litellm`.

### Facebook Graph API publish failures

1. Inspect `content.publish_log` filtered `status='failed'`.
2. Common: `OAuthException 190` — token expired → rotate Page access token.
3. Common: `rate limit` → back off the scheduler (reduce batch size in
   workflow 02 from 20 → 5).

## Deployment order (clean box)

```bash
# 0. Clone repos
git clone … ZaloCRM
git clone … automation

# 1. Bring up ZaloCRM (existing docker-compose)
cd ZaloCRM && cp .env.example .env && $EDITOR .env
docker compose up -d

# 2. First-run: register the first org + user via the UI, then:
cd ../automation && cp .env.example .env && $EDITOR .env

# 3. Bootstrap shared DB, webhook config and API key
./scripts/bootstrap.ps1        # Windows
# ./scripts/bootstrap.sh       # Linux/mac

# 4. Ensure ZALOCRM_* variables in .env match the bootstrap output
$EDITOR .env

# 5. Bring up automation stack
docker compose --env-file .env up -d

# 6. Log into n8n (http://localhost:5678), create credentials, import workflows
# 7. Configure LiteLLM keys per Phase 1.2 README
# 8. Import Uptime Kuma monitors (Settings → Backup → Restore)
# 9. Seed a few RSS feeds in workflow 01 and activate it
# 10. Keep CSKH_SHADOW_MODE=true for the 7-day shadow window
```
