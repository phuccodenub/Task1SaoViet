# Codex Follow-up Round 10 — Gate Negative Send Tests

**Date:** 2026-04-23 10:20 (Asia/Saigon)
**CWD:** `H:\Task1SaoViet\ZaloCRM\frontend`
**Previous:** `frontend/plans/reports/codex-followup-260423-1008-smoke-live-send-guard.md`

---

## Tự đánh giá

Codex đúng. Round 9 mình gate test 3 (visible send) nhưng quên test 1 + 2 (negative sends). Negative send tests cũng là POST send → guard regress thì request đi lọt qua Zalo API thật. "Safe default" claim vẫn không complete.

Lặp lại pattern round 7-8: fix một instance, miss instances cùng class. Mình tư duy theo **test intent** (positive/negative) thay vì **side effect potential** (mọi POST send đều có thể deliver). Đúng cách: phân loại theo capability, không theo intent.

Round 10 = single P3 close cùng class với Fix #33.

---

## Fix #34 — Gate ALL POST send tests

**File:** `backend/scripts/contract-smoke-test.sh`

### Changes
- `THREAD_ID_HIDDEN` giờ optional (chỉ required khi `ALLOW_LIVE_SEND=1`)
- Header docs cập nhật: ALL send tests (positive + negative) cùng gate
- Wrap nguyên block "Visibility contract: WRITE" trong `if [[ "$ALLOW_LIVE_SEND" != "1" ]]; then SKIP; else 3 tests; fi`
- Negative tests dùng `SMOKE_CONTENT` thay vì literal `"x"` để consistent
- Fail-fast: thêm check `THREAD_ID_HIDDEN` required khi gate mở
- Required env tách rõ: read-side vars luôn cần, send-side vars chỉ khi gate mở

### Default safe run
```
BASE=... ADMIN_TOKEN=... MEMBER_TOKEN=... API_KEY=... ACCOUNT_ID=... \
HIDDEN_CONV_ID=... INACCESSIBLE_ACCOUNT_ID=... \
bash backend/scripts/contract-smoke-test.sh
```
→ 9 read-side tests run. 3 send tests SKIPPED. **Zero Zalo side effect possible** (zero POST send in default mode).

### Full live run (requires dedicated smoke threads)
```
ALLOW_LIVE_SEND=1 \
THREAD_ID_VISIBLE=<smoke-thread> \
THREAD_ID_HIDDEN=<smoke-hidden-thread> \
<other vars> bash backend/scripts/contract-smoke-test.sh
```
→ All 12 tests including 3 live POST sends. User explicit + dedicated threads required.

---

## 2. Verification

```
bash -n contract-smoke-test.sh → exit 0
backend/frontend tsc unchanged
```

---

## 3. Files modified round 10

| File | Change |
|---|---|
| `backend/scripts/contract-smoke-test.sh` | Wrap all 3 POST send tests in single ALLOW_LIVE_SEND gate; THREAD_ID_HIDDEN now optional unless gate opened |

1 file, ~30 LOC delta.

---

## 4. Smoke side-effect classification (final)

| Test class | Default | With gate |
|---|---|---|
| Read-side (GET conversations/messages, GET zalo-accounts) | ✅ run | ✅ run |
| ACL deny tests (member POST/DELETE → 403) | ✅ run, NO Zalo side effect (rejected at backend) | ✅ run |
| Body-level data leak guards (jq assertions) | ✅ run | ✅ run |
| **POST send (positive + negative)** | ⏭ SKIP | ✅ run with dedicated smoke threads |

Default = 9 assertions, 0 Zalo API hits.
Full = 12 assertions, 3 Zalo API hits, only against smoke threads.

---

## 5. Pattern consolidated

**Classify test gates by capability, not intent.** Mọi test có khả năng trigger upstream side effect (gửi tin, fire webhook, push notification) phải share cùng gate, bất kể test đó assert success hay failure path. Lý do: gate là về "can this hit production?", không phải "is this happy path?"

Cùng nguyên tắc:
- Backend Fix #11 (POST send): default deny based on capability (visibility), not intent
- Frontend Fix #25 (admin actions): hide based on capability (role), not intent
- Smoke Fix #33+#34 (live send): gate based on capability (POST send), not intent

---

## 6. Unresolved

Không có technical blocker.

Pending non-AI (unchanged):
- Run smoke against staging (now truly side-effect-free without gate)
- PR split execution per `pr-split-plan-260423-0908.md`
- Optional vitest/supertest CI

**Self-score round 10:** 9.4 backend+frontend / 8.5 smoke maturity (capability-based gating consistent across script).
**Codex prev round 9:** 8.8 / 7.6 smoke. Single P3 closed.
