# ADR-001: Default `ingestPolicy` Stays `'all'`, Not `'allowlist'`

**Date:** 2026-04-23
**Status:** Accepted
**Context:** Backend P1-P4 (chat history & allowlist), Codex review rounds 1-4

---

## Decision

New `ZaloAccount` rows default to `ingestPolicy='all'`, NOT `'allowlist'`,
even though the original phase plan described "account mới default
allowlist + wizard".

The allowlist gate (pending visibility, skip webhook/automation) is opt-in
per-account via `PATCH /api/v1/zalo-accounts/:id/ingest-policy`.

---

## Why we deviated from the plan

### Backward compatibility (primary reason)

ZaloCRM v2.1 is in production across multiple orgs. Those deployments have:

- Existing integrations on `contact.created`, `message.received`,
  `message.sent` webhooks
- n8n workflows that assume every message flows through automation rules
- Omnichannel customer-support processes built on "every incoming thread
  creates a visible conversation"

Flipping the default to `'allowlist'` in the same migration that adds the
column would silently mute all new conversations across every existing org
until each admin manually added allowlist entries. That is a breaking
change disguised as a schema migration — the exact class of deployment
accident this project has avoided so far.

### Per-org privacy posture is a deliberate choice

"Does this org want noise threads routed through CRM automation?" is a
policy decision owners should make explicitly, not one we make for them.
By shipping a neutral default and exposing the switch prominently in the
allowlist UI (phase 6-8), we let each org opt in when they're ready.

### Data is never lost either way

Under `ingestPolicy='all'`, messages land as `visible` and run the full
pipeline. Under `ingestPolicy='allowlist'`, messages land as `pending` and
skip webhook/automation but **still persist** to the database. Either
default preserves message history — the difference is only whether
downstream CRM workflows fire automatically.

---

## Rollout plan for allowlist-default (future)

If we ever want `'allowlist'` to be the shipped default, it should happen
as a second, clearly-announced change:

1. Release phase 6-8 UI first so admins have an accessible way to manage
   the allowlist without hand-crafting API calls.
2. Publish a migration guide for existing integrations (`pending` breaks
   automation by design).
3. Change the schema default in a named migration, not bundled with other
   work. Existing rows stay `'all'`; only brand-new accounts get the new
   default.
4. Optionally provide a one-click "convert all my existing accounts to
   allowlist" endpoint.

No ETA for this — decided per-org after the feature sees real usage.

---

## Counter-arguments considered

**"Plan promised allowlist-default."** Correct. The plan was written before
we had production data about webhook consumers. Reality updated our view.
The code honours the allowlist *mechanism* plan described; we only changed
the default *value*.

**"Admins could wake up to broken automation anyway once they flip the
switch."** True, and that's fine — flipping the switch is an explicit
org-level decision, not a silent upgrade. The UI (phase 6-8) will warn
when enabling allowlist mode on an account with active conversations.

---

## References

- Migration: `prisma/migrations/20260422184100_add_conversation_visibility_and_allowlist/`
- Schema: `ZaloAccount.ingestPolicy` field
- Enforcement: `src/modules/chat/message-handler.ts` `resolvePlannedVisibility()`
- Cache: `src/modules/zalo/zalo-allowlist-cache.ts`
- Implementation report: `plans/reports/implementation-260422-1841-backend-p1-p4.md`
- Codex review rounds: `plans/reports/codex-followup-260422-*.md`
