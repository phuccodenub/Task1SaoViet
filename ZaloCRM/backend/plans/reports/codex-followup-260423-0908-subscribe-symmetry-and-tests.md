# Codex Follow-up Round 7 — Subscribe/Unsubscribe Symmetry + Test/PR Plan

**Date:** 2026-04-23 09:08 (Asia/Saigon)
**CWD:** `H:\Task1SaoViet\ZaloCRM\frontend`
**Previous:** `backend/plans/reports/codex-followup-260423-0843-subscription-lifecycle-regression.md`

---

## Tự đánh giá

Codex đúng. Bug Fix #27 ngay trong helper mình tạo round 6 — `cancelQR` emit unsubscribe nhưng không sync `subscribedAccountIds` Set → next subscribe short-circuit, miss event. Asymmetric helper: subscribe có centralized helper với guard, unsubscribe inline raw emit → state drift.

Bài học mình tự dạy round 6 (centralize state mutation) lại không apply triệt để cho cùng module trong cùng round. Đây là discipline gap.

Codex nâng vấn đề lên process level: typecheck pass ≠ contract security pass. Cần integration test cho ACL/visibility. Mình thiết lập smoke shell script (KISS, không cần thêm test framework) như bare minimum; vitest/supertest setup là decision lớn defer.

PR split Codex flag 4 round liên tiếp → document concrete commit groupings.

---

## Fixes round 7

| # | Item | Status |
|---|---|---|
| 27 | cancelQR cache desync | ✅ |
| 28 | Contract smoke tests | ✅ shell script (bare minimum) |
| 29 | PR split plan | ✅ document |

### Fix #27 — cancelQR cache sync

**File:** `frontend/src/composables/use-zalo-accounts.ts`

Thêm `unsubscribeFromAccount(id)` helper (mirror của `subscribeToAccount`):
- Idempotent (`!subscribedAccountIds.has(id)` → return)
- Emit `zalo:unsubscribe` + `subscribedAccountIds.delete(id)` atomic

`cancelQR` giờ gọi helper. Symmetry: mọi state mutation đi qua helper duy nhất.

### Fix #28 — Contract smoke tests

**File:** `backend/scripts/contract-smoke-test.sh`

Bash script với 10 assertions (HTTP status code based) cover:
- Visibility: internal send hidden→409, public GET hidden→409, public GET hidden+opt-in→200, public GET conversations default→visible
- ACL parity: member list (filtered), member create→403, member login no-access→403, member delete no-access→403, member sync-contacts no-access→403, admin status→200

Usage: env vars `BASE`, `ADMIN_TOKEN`, `MEMBER_TOKEN`, `API_KEY`, `ACCOUNT_ID`, `THREAD_ID`, optional `HIDDEN_CONV_ID`.

KISS: shell + curl; no new framework dep. Ship as bare-minimum regression guard. Replace with vitest/supertest later (separate decision).

### Fix #29 — PR split plan

**File:** `backend/plans/reports/pr-split-plan-260423-0908.md`

Concrete file enumeration cho 4 PRs:
- **PR-A** (core P1-P4): allowlist + history + visibility + ACL + ADR + smoke script + frontend gating + composables
- **PR-B** (rate limiter): redis-client, zalo-rate-limiter, ioredis dep + call sites in pool/chat-routes/public-api
- **PR-C** (webhook automation): call-webhook-action + automation-service dispatch
- **PR-D** (infra): docker-compose port + content/n8n plans

Conflict notes (zalo-pool/chat-routes overlap PR-A vs PR-B), landing order, open questions.

---

## 2. Verification

```
backend:  unchanged from round 5 → exit 0 (tsc)
frontend: npx vue-tsc --noEmit  → exit 0
```

Smoke script not run (requires live env + tokens). Documented as manual verification step.

---

## 3. Files modified round 7

| File | Change |
|---|---|
| `frontend/src/composables/use-zalo-accounts.ts` | `unsubscribeFromAccount` helper, cancelQR uses helper |
| `backend/scripts/contract-smoke-test.sh` | New: 10 contract assertions |
| `backend/plans/reports/pr-split-plan-260423-0908.md` | New: 4-PR split plan |

---

## 4. Final scorecard (cumulative across 7 rounds)

| Concern | Status | Notes |
|---|---|---|
| Backend tsc | ✅ | round 1 baseline + every round since |
| Frontend tsc | ✅ | rounds 3-7 |
| Visibility contract (write) | ✅ | rounds 1-2 (internal), 3 (public API send) |
| Visibility contract (read) | ✅ | round 4 (public API GET) |
| Socket ACL = REST ACL | ✅ | rounds 4-5 (account room migration) |
| Lifecycle event scoping | ✅ | round 5 |
| Route namespace ACL parity | ✅ | round 5 (sync-contacts caught) |
| Pending envelope identifier scrub | ✅ | round 4 |
| ownerUserId fallback (3 layers) | ✅ | round 5 (middleware), prev rounds (socket + frontend) |
| Frontend role gating | ✅ | round 5 |
| Account page subscription lifecycle | ✅ | round 6 |
| Subscribe/unsubscribe symmetry | ✅ | round 7 |
| ADR for default ingestPolicy | ✅ | round 4 |
| Group history limitation documented | ✅ | round 2 header |
| Contract smoke tests | ⚠️ shell script only | round 7; vitest TBD |
| PR scope split | 📋 plan only | round 7; execution TBD |

---

## 5. What's left before merge (organisational)

1. **Execute PR split** per `pr-split-plan-260423-0908.md` — needs human to cut branches
2. **Run smoke script** against staging with real tokens — needs env access
3. **Optional:** add vitest + supertest harness for automated CI runs

None of these are blockers Codex would re-flag in the codebase; they are
process/infra steps outside the AI loop.

---

## 6. Patterns I keep falling into (for next session memory)

These have come up 2-3 times each across 7 rounds. Worth posting in
session start-of-day notes:

1. **"Audit file chính bỏ tuyến phụ"** — privacy fixes must enumerate
   *all* call sites of the affected event/payload/route namespace, not
   just the file being edited. Lesson: grep first, edit second.
2. **"Asymmetric helper"** — when introducing a helper for one direction
   (subscribe, allow), also add the inverse (unsubscribe, deny) and route
   every existing call through them. Otherwise state drifts the moment
   anyone forgets.
3. **"Typecheck = correctness"** — false. tsc only proves shapes line up;
   contract correctness needs explicit assertions. Smoke script is the
   minimum.
4. **"Inventory truthful"** — list every file touched, including ones
   touched in prior rounds. Codex caught this twice.

---

## 7. Unresolved

Không có technical blocker.

Pending non-AI tasks: PR split execution, smoke script run against staging.

**Self-score round 7:** 9.2/10 backend + frontend readiness for P6-P8 frontend phases.
**Codex prev:** 8.3/10 backend, 7.8/10 frontend. Single P2 + tooling gap closed.
