# ZaloCRM `call_webhook` automation action

Extends the rule-based automation engine (`backend/src/modules/automation/automation-service.ts`)
with a generic outbound webhook action. Lets operators trigger n8n workflows
directly from a database-defined rule without writing code.

## Rule shape

Stored in `automation_rules.actions` (JSON). Example:

```json
{
  "type": "call_webhook",
  "url":  "https://n8n.internal/webhook/crm-lead-hot",
  "secret": "shared-secret-from-env",
  "headers": { "X-Source": "zalocrm-automation" },
  "timeoutMs": 8000,
  "payload": { "stage": "hot_lead", "score": 85 }
}
```

The engine automatically enriches `payload` with `trigger`, `contact`,
`conversation`, and `message` from the automation context, so workflows
receive the same shape as the outgoing webhook emitted by
`webhook-service.ts`.

## Security

- Signed with `HMAC-SHA256(secret, body)` in header `X-Webhook-Signature`,
  matching the scheme used elsewhere in ZaloCRM. Re-use n8n workflow
  `04-cskh-zalo-intent` verification logic — the algorithm is identical.
- URL must be `http://` or `https://`; anything else is skipped with a warn.
- Payload is truncated at 64 KB to avoid accidentally ferrying large
  attachments.
- Timeout defaults to 10 s. The action is fire-and-forget; failure is
  logged but never raises, preserving the guarantee that one bad rule
  cannot block the inbound message pipeline.

## Typical use cases

| Rule trigger        | Webhook target              | Purpose                                   |
| ------------------- | --------------------------- | ----------------------------------------- |
| `message_received`  | n8n `/webhook/lead-qualify` | Run premium LLM on high-intent phrases    |
| `contact_created`   | n8n `/webhook/crm-enrich`   | Lookup company/position via external APIs |
| `status_changed`    | n8n `/webhook/sales-alert`  | Notify sales Telegram on stage transitions |

## Next steps

1. UI form in ZaloCRM admin to edit `call_webhook` rules without JSON editing
   (Phase 2.5 is backend-only for now; UI is optional polish).
2. Add retry with exponential backoff once a `webhook_delivery` persistence
   table exists (kept out of scope to avoid schema churn).
