# PR Split Plan — Backend P1-P4 + Side Concerns

**Date:** 2026-04-23
**Status:** Recommendation
**Author:** Claude (in response to Codex round 2-7 repeated callouts)

Codex flagged 4 rounds in a row that the working tree mixes scope: core
allowlist/history/ACL work is bundled with Redis rate limiter, webhook
automation, docker port change, and content/n8n plan files. This document
proposes a concrete commit grouping so reviewers can land each scope
independently.

---

## PR-A — Core: Allowlist + History + Visibility + ACL hardening

**Scope:** Everything Codex review rounds 1-7 actually exercised. Self-contained
contract: visibility lifecycle, ACL parity, ADR.

**Files:**

```
backend/prisma/schema.prisma
backend/prisma/migrations/20260422184100_add_conversation_visibility_and_allowlist/
backend/src/app.ts
backend/src/modules/chat/message-handler.ts
backend/src/modules/chat/chat-routes.ts
backend/src/modules/api/public-api-routes.ts          (visibility + ACL bits only)
backend/src/modules/zalo/zalo-allowlist-cache.ts      (new)
backend/src/modules/zalo/zalo-allowlist-routes.ts     (new)
backend/src/modules/zalo/zalo-history-routes.ts       (new)
backend/src/modules/zalo/zalo-thread-listing.ts       (new)
backend/src/modules/zalo/zalo-message-sync.ts
backend/src/modules/zalo/zalo-listener-factory.ts
backend/src/modules/zalo/zalo-pool.ts                 (socket scoping only — keep rate limiter wiring out)
backend/src/modules/zalo/zalo-socket.ts
backend/src/modules/zalo/zalo-routes.ts
backend/src/modules/zalo/zalo-sync-routes.ts
backend/src/modules/zalo/zalo-access-middleware.ts
backend/scripts/contract-smoke-test.sh                (new)
backend/docs/adr-001-default-ingest-policy.md         (new)

frontend/src/composables/use-chat.ts
frontend/src/composables/use-zalo-accounts.ts
frontend/src/views/ZaloAccountsView.vue
```

**Schema delta:** only the visibility/allowlist columns. If schema currently
includes rate-limiter columns, split those into the migration for PR-B.

**Reports to ship with PR-A:**
- `backend/plans/reports/implementation-260422-1841-backend-p1-p4.md`
- `backend/plans/reports/codex-followup-260422-1930-*` through `260423-0908-*`

---

## PR-B — Redis rate limiter

**Scope:** Per-account send-rate enforcement using Redis. Independent of
visibility/allowlist work — rate limiter would exist with or without P1-P4.

**Files:**

```
backend/package.json                                  (ioredis dep)
backend/package-lock.json                             (matching lock)
backend/src/shared/redis/redis-client.ts              (new)
backend/src/modules/zalo/zalo-rate-limiter.ts         (rate-limiter additions)
backend/src/modules/zalo/zalo-pool.ts                 (rate-limiter call sites only — cherry-pick from PR-A baseline)
backend/src/modules/chat/chat-routes.ts               (rate-limiter wiring inside POST send only)
backend/src/modules/api/public-api-routes.ts          (rate-limiter wiring inside POST send only)
```

**Conflict risk:** `zalo-pool.ts` and `chat-routes.ts` are in both PRs. Land
PR-A first, then rebase PR-B on top — the rate-limiter call sites are
small additions to handlers that already exist after PR-A.

---

## PR-C — Webhook automation action

**Scope:** New `call_webhook` automation action type. Independent of all
above — pure addition to the automation catalog.

**Files:**

```
backend/src/modules/automation/actions/call-webhook-action.ts   (new)
backend/src/modules/automation/automation-service.ts            (action dispatch)
backend/src/modules/automation/actions/send-template-action.ts  (only if changes are related — otherwise split further)
```

---

## PR-D — Infra + planning artifacts

**Scope:** Non-code housekeeping; can land last (or first, low-risk).

**Files:**

```
docker-compose.yml                                                      (port change)
content_+_omnichannel_cskh_automation_3afce525.plan.md                  (planning)
plans/260419-1621-codebase-hygiene-alignment/
plans/260420-0631-chat-history-and-conversation-allowlist/
plans/reports/plan-260418-2202-next-steps-roadmap.md
plans/reports/research-260418-2121-zalocrm-overall-roadmap.md
plans/reports/research-260420-0247-historical-chat-and-conversation-allowlist.md
plans/reports/researcher-260419-1623-node-version-enforcement.md
plans/reports/researcher-260419-1623-test-lint-tooling-gap.md
```

**Note:** these are mostly untracked planning files at repo root. Could
also live in a docs-only PR, or be moved into `backend/plans/` /
`backend/docs/` first.

---

## Recommended landing order

1. **PR-A** (core P1-P4) — biggest, most reviewed
2. **PR-D** (infra + plans) — low risk, low conflict
3. **PR-B** (rate limiter) — rebase on PR-A
4. **PR-C** (webhook automation) — rebase on PR-A

---

## What this plan does NOT do

- Does not split git history. Each PR is a fresh branch cut from the
  current working tree, with non-belonging files stashed/reverted.
- Does not address the `frontend/package-lock.json` discipline issue
  (already cleaned in round 3).
- Does not introduce a test framework. PR-A includes the smoke shell
  script (`backend/scripts/contract-smoke-test.sh`) as bare-minimum
  contract verification; vitest/supertest setup is its own future PR.

---

## Open questions

- Does the team want `send-template-action.ts` in PR-C with webhook, or
  split further? Depends on whether the change is related to the new
  webhook action or independent.
- Should the migration be split too? Currently one migration file covers
  the visibility columns only — if rate-limiter added DB columns, those
  need a separate migration file in PR-B.
