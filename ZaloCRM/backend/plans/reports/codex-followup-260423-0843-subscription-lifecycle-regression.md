# Codex Follow-up Round 6 — Subscription Lifecycle Regression

**Date:** 2026-04-23 08:43 (Asia/Saigon)
**CWD:** `H:\Task1SaoViet\ZaloCRM\frontend`
**Previous:** `backend/plans/reports/codex-followup-260423-0426-route-namespace-audit.md`

---

## Tự đánh giá

Codex đúng. Đây là regression mình tự tạo ở Fix #23 (round 5) — chuyển lifecycle events từ `org:<orgId>` sang `account:<id>` mà quên update `use-zalo-accounts.ts` consumer. Round 3 đã fix `use-chat.ts` cùng pattern (bulk subscribe on connect), nhưng quên áp cho composable account page.

**Lặp lại lần 3** pattern "thay đổi backend transport, miss consumer". Bài học: mỗi lần đổi room target → grep tất cả `socket.on('event-name')` cross codebase, không chỉ file backend.

Codex chấm 8.5/10 round 5, không gọi P1. Đây là single P2 fix cho frontend regression.

---

## Fix

| # | Issue | Status |
|---|---|---|
| 26 | Account page miss lifecycle events sau khi đổi room | P2 | ✅ |

### Detail

**File:** `frontend/src/composables/use-zalo-accounts.ts`

Thêm:
- `subscribedAccountIds: Set<string>` — track subscribed rooms để không emit lặp
- `subscribeToAccount(accountId)` — idempotent helper
- `subscribeToAccessibleAccounts()` — fetch `/zalo-accounts` rồi subscribe bulk
- `socket.on('connect')` handler: clear set + bulk subscribe (re-subscribe sau reconnect vì rooms per-socket)
- `fetchAccounts()`: subscribe newly-visible accounts (created in another tab)
- `loginAccount(id)`: dùng helper thay vì raw emit
- `reconnectAccount(id)`: subscribe TRƯỚC POST reconnect để không miss event đầu tiên
- `onUnmounted`: clear set khi disconnect

KISS: single source of truth (`subscribeToAccount`) cho mọi entry point. DRY: không emit lặp.

### Verification
```
frontend: npx vue-tsc --noEmit → exit 0
```
Backend không đổi → giữ exit 0 round 5.

---

## 2. Files modified

| File | Change |
|---|---|
| `frontend/src/composables/use-zalo-accounts.ts` | Bulk subscribe on connect + idempotent subscribe in fetchAccounts/loginAccount/reconnectAccount |

1 file, ~40 LOC.

---

## 3. Subscription lifecycle (complete)

| Event | Where subscribed | Idempotent? |
|---|---|---|
| Initial socket `connect` | bulk fetch + subscribe | yes (Set guard) |
| `fetchAccounts()` reload | subscribe new accounts | yes |
| `loginAccount(id)` | helper subscribes id | yes |
| `reconnectAccount(id)` | helper BEFORE POST | yes |
| Disconnect/unmount | clear Set | — |

Helper `subscribeToAccount` short-circuits if id is already in `subscribedAccountIds` → safe to call from any path.

---

## 4. Final readiness checklist

| Item | Status |
|---|---|
| Backend tsc | ✅ |
| Frontend tsc | ✅ |
| ACL parity (REST = socket = public API) | ✅ rounds 4-5 |
| Visibility contract (read + write) | ✅ rounds 3-4 |
| Account lifecycle subscription | ✅ this round |
| ADR for ingestPolicy default | ✅ round 4 |
| Group history limitation documented | ✅ round 2 header |
| Out-of-scope PR split | ⏳ pending (Codex flagged round 2-5) |

---

## 5. Out-of-scope split (still pending — required before merge)

Codex đã nhắc 4 round liên tiếp. Mình không tự split trong session này vì:
1. Chạm rộng: cần touch git history
2. Cần coordinate với người maintain các module bên (rate limiter, automation, n8n)

**Items cần split:**
- Redis rate limiter (`zalo-rate-limiter.ts` + redis client wiring)
- `call-webhook-action.ts` automation
- docker-compose port change
- content/n8n plan markdown files

**Recommendation:** chia ít nhất 2 PR:
- PR-A: P1-P4 core (allowlist + history + visibility contract + ACL hardening + ADR + frontend gating)
- PR-B: rate limiter + webhook automation
- PR-C (optional): docker + plans

---

## 6. Unresolved

Không có technical blocker. Out-of-scope PR split là organisational task, không affect contract correctness.

**Self-score:** 9/10 backend + frontend readiness.
**Codex prev:** 8.5/10. Single P2 closed.

P6-P8 frontend phases có thể bắt đầu — composable patterns cho cả chat + account page giờ đã consistent (bulk subscribe on connect, idempotent helpers, clear on unmount).
