# Codex Follow-up Round 9 — Smoke Live-Send Guard

**Date:** 2026-04-23 10:08 (Asia/Saigon)
**CWD:** `H:\Task1SaoViet\ZaloCRM\frontend`
**Previous:** `backend/plans/reports/codex-followup-260423-0946-cancelqr-semantics-and-smoke-body-assertions.md`

---

## Tự đánh giá

Codex đúng. Round 8 mình thêm assertion "public send visible thread → 200" không gate → chạy smoke = gửi tin thật vào customer thread. Production safety gap: test infrastructure có thể gây harm.

Bài học: khi thêm test case có side effect ngoài system boundary (Zalo API gửi tin thật qua mạng Zalo), **default deny + explicit opt-in**. Bình thường mình apply pattern này cho write endpoints (POST send = 409 non-visible); quên apply cho test runner.

Không P1/P2 mới. Round 9 = single P3 close.

---

## Fix #33 — Live-send guard

**File:** `backend/scripts/contract-smoke-test.sh`

### Changes
- `THREAD_ID_VISIBLE` giờ **optional** (chỉ required khi `ALLOW_LIVE_SEND=1`)
- Thêm `ALLOW_LIVE_SEND` flag (default `0` = safe)
- Thêm `SMOKE_CONTENT` env (default `"[smoke test] please ignore"`)
- Test 3 wrap trong `if [[ "$ALLOW_LIVE_SEND" == "1" ]]`; skip với message khi tắt
- Fail-fast: `ALLOW_LIVE_SEND=1` mà không có `THREAD_ID_VISIBLE` → exit 2 với FATAL
- Header docs tách 2 usage modes rõ (safe default vs full live)
- `jq -Rs` escape `SMOKE_CONTENT` để không broken với special chars

### Default safe run
```
BASE=... ADMIN_TOKEN=... MEMBER_TOKEN=... API_KEY=... ACCOUNT_ID=... \
THREAD_ID_HIDDEN=... HIDDEN_CONV_ID=... INACCESSIBLE_ACCOUNT_ID=... \
bash backend/scripts/contract-smoke-test.sh
```
→ 10/11 tests run, visible-send SKIPPED với message. No Zalo side effect.

### Full live run (sends real message)
```
ALLOW_LIVE_SEND=1 THREAD_ID_VISIBLE=<smoke-thread> SMOKE_CONTENT="..." \
<other required vars> bash backend/scripts/contract-smoke-test.sh
```
→ Tất cả 11 tests bao gồm live send. User phải explicit chọn.

---

## 2. Verification

```
bash -n contract-smoke-test.sh → exit 0
backend tsc / frontend tsc     → unchanged (no source changes)
```

Not executed end-to-end (cần staging env).

---

## 3. Files modified round 9

| File | Change |
|---|---|
| `backend/scripts/contract-smoke-test.sh` | Live-send gate + default-safe mode + header docs |

1 file. ~30 LOC delta.

---

## 4. Smoke script coverage (9 rounds cumulative)

| # | Assertion | Body check | Live side effect |
|---|---|---|---|
| 1 | Internal send hidden → 409 | no | no |
| 2 | Public send hidden thread → 409 | no | no |
| 3 | Public send visible thread → 200 | no | **yes, gated** |
| 4 | Public GET hidden messages → 409 | no | no |
| 5 | Public GET hidden messages opt-in → 200 | no | no |
| 6 | Public GET conversations default → 200 + hidden absent | **yes** | no |
| 6b | Public GET ?visibility=hidden → 200 + hidden present | **yes** | no |
| 7 | Member GET zalo-accounts → 200 + inaccessible absent | **yes** | no |
| 8 | Member POST create → 403 | no | no |
| 9 | Member login no access → 403 | no | no |
| 10 | Member DELETE no access → 403 | no | no |
| 11 | Member sync-contacts no access → 403 | no | no |
| 12 | Admin GET status → 200 | no | no |

12 assertions, 3 body-level, 1 live-gated. Default run = 11 assertions, 0 side effect.

---

## 5. Pattern added to playbook

**Default safe for destructive test steps:** any test that mutates upstream state (sends email, fires webhook, pushes to third-party API) must default to skip + require explicit opt-in flag + document why. Same principle as Fix #11 (POST send defaults deny for non-visible) applied at test layer.

---

## 6. Unresolved

Không có technical blocker.

Pending non-AI (unchanged from round 8):
- Run smoke script against staging (now safe to run without live-send flag)
- PR split execution
- Optional vitest/supertest CI

**Self-score round 9:** 9.3 backend+frontend / 8.0 smoke maturity (gate + body assertions + docs).
**Codex prev round 8:** 8.7 / 7.2 smoke. Single P3 closed, smoke now safely runnable in CI-like environment.
