# Codex Follow-up Round 11 — Gate ACL Mutation Probes

**Date:** 2026-04-23 11:53 (Asia/Saigon)
**Previous:** `frontend/plans/reports/codex-followup-260423-1020-gate-negative-send-tests.md`

---

## Tự đánh giá

Codex đúng. Round 10 mình rút pattern "capability-based gating" cho POST send nhưng quên audit cùng surface — mutation probes (create/login/delete/sync-contacts) cũng cùng class, mỗi probe có expected 403 nhưng regression sẽ trigger thật:
- `POST create` → write ZaloAccount row
- `POST login` → kick Zalo session active
- `DELETE` → xoá account + cascade convs/messages
- `POST sync-contacts` → call Zalo getAllFriends + write contacts

Round 10 khẳng định "Classify by capability not intent" mà chính lại apply incomplete → contradict.

Bài học round 11: khi extract general pattern, audit toàn bộ script (grep mutation verbs) để apply uniformly. Không đủ chỉ apply cho category đầu tiên nhận ra.

---

## Fix #35 — Gate ACL mutation probes

**File:** `backend/scripts/contract-smoke-test.sh`

### Changes
- Thêm `ALLOW_LIVE_MUTATION` env (default `0`)
- Wrap 4 member mutation probes trong `if [[ "$ALLOW_LIVE_MUTATION" != "1" ]]; SKIP`
- Header docs: 3 sections rõ (read-side always-safe / live-send gate / live-mutation gate)
- Comment mỗi probe note explicit regression-side-effect ("regression: writes ZaloAccount row", "kicks Zalo session", etc.)
- 2 gate độc lập (send vs mutation) — user opt-in granular

### Default safe run
```
BASE=... ADMIN_TOKEN=... MEMBER_TOKEN=... API_KEY=... ACCOUNT_ID=... \
HIDDEN_CONV_ID=... INACCESSIBLE_ACCOUNT_ID=... \
bash backend/scripts/contract-smoke-test.sh
```
→ 6 read-side tests run. Send block + mutation block both SKIPPED.
**Truly zero side effect possible** (zero POST/DELETE that could mutate state).

### Full live run
```
ALLOW_LIVE_SEND=1 ALLOW_LIVE_MUTATION=1 \
THREAD_ID_VISIBLE=<smoke-thread> THREAD_ID_HIDDEN=<smoke-hidden-thread> \
<other vars> bash backend/scripts/contract-smoke-test.sh
```
→ 12 tests including 3 live sends + 4 mutation probes. Requires disposable resources.

---

## 2. Verification

```
bash -n contract-smoke-test.sh → exit 0
backend/frontend tsc unchanged
```

---

## 3. Files modified

| File | Change |
|---|---|
| `backend/scripts/contract-smoke-test.sh` | `ALLOW_LIVE_MUTATION` gate + wrap 4 probes; header docs split 3 sections |

1 file. ~50 LOC delta (bulk in header).

---

## 4. Final smoke gating matrix

| Test class | Default | ALLOW_LIVE_SEND=1 | ALLOW_LIVE_MUTATION=1 |
|---|---|---|---|
| Read-side GET (visibility, conversations, accounts) | ✅ | ✅ | ✅ |
| Body-level data leak guards (jq) | ✅ | ✅ | ✅ |
| Admin GET status | ✅ | ✅ | ✅ |
| POST send (positive + negative) | ⏭ | ✅ | ⏭ |
| Member mutation probes (create/login/delete/sync) | ⏭ | ⏭ | ✅ |

Default = 6 assertions, **0 mutation possible** under any regression scenario.

---

## 5. Pattern complete

Round 10 introduced "Classify by capability, not intent". Round 11 finishes
applying it uniformly to the script:

| Capability | Gate |
|---|---|
| GET (read) | none — no mutation possible |
| Backend ACL deny on read | none — request is read-only |
| **POST send (deliver Zalo message)** | `ALLOW_LIVE_SEND` |
| **POST/DELETE on org-resource (write/cascade)** | `ALLOW_LIVE_MUTATION` |

Two gates because the resources/disposable-pool requirements differ
(smoke threads vs smoke org/account). User can mix: send-only or
mutation-only validation as needed.

---

## 6. Unresolved

Không có technical blocker.

Pending non-AI:
- Run smoke against staging (default mode is now genuinely safe)
- PR split execution per `pr-split-plan-260423-0908.md`
- Optional vitest/supertest CI

**Self-score round 11:** 9.5 backend+frontend / 9.0 smoke maturity (gating pattern complete, zero side-effect default mode).
**Codex prev round 10:** 8.8 / 7.7 smoke. Single P3 closed, pattern uniformly applied.
