# Shadow mode runbook (Phase 1.6)

## Goal

Measure the CSKH bot's real-world intent accuracy and reply quality on live
traffic **without** exposing customers to bot replies until precision clears
85 %. This is the single gatekeeper between MVP and go-live.

## Mechanics

- Workflow `04-cskh-zalo-intent.json` classifies every inbound message and
  drafts a reply, but only sends it when `CSKH_SHADOW_MODE=false`.
- Every classification + draft is logged to `omni.intent_log`.
- Staff reviews drafts in a dashboard (or a filtered Google Sheet) and writes
  back one of three verdicts into the row:
  - `approved` — the draft was correct and could have been sent as-is.
  - `edited`   — the draft was close but needed wording tweaks (also includes
    a small correction in `staff_note`).
  - `rejected` — the draft was wrong, off-topic, or risky.

## Daily routine (7 consecutive days)

1. **Morning (09:00)** — Run the shadow report:
   ```bash
   docker exec -i zalo-crm-db psql -U crmuser -d zalocrm \
     < automation/scripts/shadow-report.sql > out/shadow-$(date +%F).txt
   ```
   Record in the operations channel.
2. **Staff grading (continuous, SLA ≤ 4 h per message)** — Open the review
   UI (or `\e SELECT * FROM omni.intent_log WHERE action_taken='shadow' AND
   staff_verdict IS NULL ORDER BY created_at DESC LIMIT 50`) and grade each
   row.
3. **Evening (18:00)** — If overall precision drops below 80 % in any 24-h
   window, pause onboarding of new FAQ intents and fix the worst category
   before resuming.

## Go-live gate (must ALL pass before flipping shadow off)

| Metric                                   | Threshold           | Source                                    |
| ---------------------------------------- | ------------------- | ----------------------------------------- |
| Graded rows in last 7 days               | ≥ 200               | Query #3 in `shadow-report.sql`           |
| Overall precision (approved + edited)    | ≥ 85 %              | Query #3                                  |
| Exact-match precision (approved only)    | ≥ 60 %              | Query #3                                  |
| Per-intent precision (each bucket)       | ≥ 75 %              | Query #2                                  |
| Handoff false-negative rate (complaint)  | 0 in last 7 days    | Manual review of `intent='complaint'`     |
| Known regressions logged & triaged       | All cleared         | Ops backlog                               |

## Flip-the-switch procedure

1. Make sure the gate above passes.
2. Take a Postgres backup (the ZaloCRM `backup` service already runs daily;
   confirm the latest file is < 24 h old).
3. In `automation/.env` set `CSKH_SHADOW_MODE=false`.
4. `docker compose restart n8n n8n-worker`.
5. Watch `omni.intent_log.action_taken='auto_reply'` rows for the next 2 hours.
6. Stay on-call with the Telegram alert channel for 24 hours.

## Rollback

If auto-replies cause trouble:

```bash
# Flip back to shadow instantly
sed -i 's/^CSKH_SHADOW_MODE=.*/CSKH_SHADOW_MODE=true/' automation/.env
docker compose restart n8n n8n-worker
```

Root-cause via `omni.intent_log` filtered by `action_taken='auto_reply'` +
staff verdict once added.

## Staff grading UI (lightweight option)

If a full review UI is not yet built, use a shared Google Sheet backed by a
`read-only` view of `omni.intent_log`:

```sql
CREATE OR REPLACE VIEW omni.v_shadow_review AS
SELECT id,
       created_at AT TIME ZONE 'Asia/Ho_Chi_Minh' AS at_vn,
       channel, conversation_key, intent, confidence,
       bot_draft,
       staff_verdict, staff_note
FROM omni.intent_log
WHERE action_taken = 'shadow'
ORDER BY created_at DESC
LIMIT 500;
```

Expose it via n8n's Postgres node → Google Sheets append (nightly) and let
staff grade in the sheet; a reverse-sync workflow (mirroring `03-review-sync`)
writes `staff_verdict` back.
