# Codex Follow-up Round 8 — Semantics + Smoke Body Assertions

**Date:** 2026-04-23 09:46 (Asia/Saigon)
**CWD:** `H:\Task1SaoViet\ZaloCRM`
**Previous:** `backend/plans/reports/codex-followup-260423-0908-subscribe-symmetry-and-tests.md`

---

## Tự đánh giá

Codex đúng cả 3. Round 7 fix asymmetric helper (cache desync) nhưng miss **semantic mismatch** ở tầng cao hơn: account room giờ phục vụ 2 mục đích (QR delivery + lifecycle events) sau Fix #23, mà `cancelQR` vẫn treat như QR-only. Fix implementation ≠ fix semantics.

Smoke script cũng đúng — mình gọi "contract test" mà chỉ check status, không check body. Test fail chính purpose: catch data leak. Test cho public send còn treat 200/409 đều là acceptable → không bắt được regression.

**Lesson chính round 8:** mỗi room/endpoint phục vụ multiple purposes phải define semantic ownership rõ ràng. Cancel cho UI dialog ≠ leave socket room.

---

## 3 fixes

| # | Item | Status |
|---|---|---|
| 30 | cancelQR semantics (không leave room) | ✅ |
| 31 | Smoke send assertion explicit | ✅ |
| 32 | Smoke body-level assertions | ✅ |

### Fix #30 — cancelQR semantics

**File:** `frontend/src/composables/use-zalo-accounts.ts`

`cancelQR` giờ chỉ reset UI state (`showQRDialog=false`, `currentLoginAccountId=''`), KHÔNG emit unsubscribe. Account room subscription giữ nguyên cho lifecycle events.

QR socket handlers đã sẵn gate trên `currentLoginAccountId === data.accountId` → sau cancel, accountId rỗng → không match → silent drop QR-specific events. Lifecycle events tiếp tục flow vì subscription còn.

`unsubscribeFromAccount` helper giữ lại + comment update: reserved cho explicit tear-down (account deleted, logout). Wire vào `deleteAccount` để release cache khi account thực sự bị xóa.

**Semantic ownership giờ rõ:**
- Subscribe lifetime = page mount → unmount (hoặc account deleted)
- QR dialog lifetime = open → cancel/connect (orthogonal to room)

### Fix #31 — Public send 409 explicit assertion

`backend/scripts/contract-smoke-test.sh`:
- Tách `THREAD_ID_VISIBLE` vs `THREAD_ID_HIDDEN` env vars (required, không default)
- Test 2: `POST send THREAD_ID_HIDDEN` → assert 409 (not "INFO accept either")
- Test 3: `POST send THREAD_ID_VISIBLE` → assert 200 (success path explicit)

Regression làm thủng visibility ở public API giờ sẽ FAIL test 2.

### Fix #32 — Body-level assertions

Same script:
- Test 6: `GET /api/public/conversations` default → 200 AND `jq` assert `HIDDEN_CONV_ID` NOT in body
- Test 6b: `GET /api/public/conversations?visibility=hidden` → 200 AND `jq` assert `HIDDEN_CONV_ID` IS in body (filter sanity check — không filter sai chiều)
- Test 7: `GET /api/v1/zalo-accounts` member → 200 AND `jq` assert `INACCESSIBLE_ACCOUNT_ID` NOT in body

Regression leak hidden conv hoặc inaccessible account vào response → FAIL.

**Tightened env requirements:** giờ tất cả vars required (không default), bao gồm `INACCESSIBLE_ACCOUNT_ID` để verify ACL filter thực sự loại trừ. Set với `:?` để fail fast.

---

## 2. Verification

```
frontend: npx vue-tsc --noEmit         → exit 0
bash -n contract-smoke-test.sh         → exit 0 (syntax clean — Codex couldn't run locally)
backend tsc unchanged                  → exit 0
```

Smoke script not executed (cần live env + tokens + jq). Tested syntax only.

---

## 3. Files modified round 8

| File | Change |
|---|---|
| `frontend/src/composables/use-zalo-accounts.ts` | cancelQR no-op on subscription; deleteAccount unsubscribes |
| `backend/scripts/contract-smoke-test.sh` | Body-level jq assertions, explicit 409/200 split, tighter env requirements |

2 files. ~80 LOC delta on script.

---

## 4. Final contract guarantees (after 8 rounds)

### Account room (`account:<id>`)
- Carries: chat:message visible+pending, chat:deleted, zalo:connected/disconnected/error/reconnect-failed
- Subscribed: page mount + bulk fetch + on-demand login/reconnect
- Unsubscribed: explicit account delete only
- QR dialog open/close orthogonal — gates only UI state via `currentLoginAccountId`

### Smoke script coverage
| Assertion | Type |
|---|---|
| Internal send hidden → 409 | status |
| Public send hidden thread → 409 | status |
| Public send visible thread → 200 | status |
| Public GET hidden messages → 409 | status |
| Public GET hidden messages opt-in → 200 | status |
| Public GET conversations default → 200 + body excludes hidden | status + body |
| Public GET conversations ?visibility=hidden → 200 + body includes hidden | status + body |
| Member GET zalo-accounts → 200 + body excludes inaccessible | status + body |
| Member create/login/delete/sync → 403 | status |
| Admin GET status → 200 | status |

11 assertions, 3 of which are body-level data leak guards.

---

## 5. Patterns reinforced

1. **Semantic ownership** — when one channel serves N purposes, define which lifetime owns each tear-down. Fix the abstraction, not the symptom.
2. **Body assertions for data leak risks** — status code only proves endpoint exists, not that filter actually filtered.
3. **`set -u` + `${VAR:?}`** — fail fast on missing env beats default-and-pretend.

---

## 6. Unresolved

Không có technical blocker.

Pending non-AI:
- Run smoke script against staging with `jq` installed
- PR split execution per `pr-split-plan-260423-0908.md`
- Optional vitest/supertest harness for CI

**Self-score round 8:** 9.3/10 backend + frontend; smoke 7.5/10 (still no CI integration but body-level assertions in place).
**Codex prev round 7:** 8.4 backend / 7.4 frontend / 5.5 test maturity. Test maturity gap closed materially.
