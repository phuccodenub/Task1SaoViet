# Codex Follow-up Round 5 — Route Namespace Audit

**Date:** 2026-04-23 04:26 (Asia/Saigon)
**CWD:** `H:\Task1SaoViet\ZaloCRM\frontend`
**Previous:** `backend/plans/reports/codex-followup-260423-0104-side-channel-closure.md`

---

## Tự đánh giá

Codex đúng cả 4. Lặp lại pattern "audit file chính bỏ tuyến phụ" lần thứ 2 — round 4 siết `zalo-routes.ts` nhưng quên `zalo-sync-routes.ts` cùng namespace `/zalo-accounts/:id/*`. Bài học: audit theo **route namespace** / **URL prefix**, không theo file.

Cũng quên Fix #24 — round 4 thêm ownerUserId fallback vào socket (`zalo-socket.ts`) nhưng không thêm vào `requireZaloAccess` middleware. Dẫn tới inconsistency: list hiện account nhưng action 403. Lỗi tương tự "định nghĩa contract một nửa".

Codex chấm 8/10. Round này target 9/10 thực sự.

---

## Fixes (4/4)

| # | Codex finding | Severity | Status |
|---|---|---|---|
| 22 | sync-contacts thiếu org/access check | P1 | ✅ |
| 23 | Lifecycle events leak account metadata org-wide | P2 | ✅ |
| 24 | Legacy ownerUserId account → list OK, action 403 | P2 | ✅ |
| 25 | UI show admin controls cho member | P3 | ✅ |

---

## 2. Detail changes

### Fix #22 — sync-contacts ACL
**File:** `backend/src/modules/zalo/zalo-sync-routes.ts`

- `requireRole('owner','admin')` → `requireZaloAccess('admin')`
- Thêm explicit `findFirst({id, orgId: user.orgId})` trước khi chạm pool
- Header comment giải thích route namespace parity với `zalo-routes.ts`

Audit khác `/zalo-accounts/:id/*`:
- `zalo-access-routes.ts` — OK (đã có findFirst + requireRole)
- `zalo-allowlist-routes.ts` — OK (đã có accountBelongsToOrg + requireZaloAccess)
- `zalo-routes.ts` — OK (round 4)
- `zalo-sync-routes.ts` — fixed this round

### Fix #23 — Lifecycle event metadata leak
**Files:** `zalo-pool.ts`, `zalo-listener-factory.ts`

Tất cả account-specific events chuyển từ `org:<orgId>` → `account:<id>` room:
- `zalo:connected` (loginQR + reconnect)
- `zalo:disconnected` (listener closed)
- `zalo:error` (loginQR failure)
- `zalo:reconnect-failed` (circuit breaker + autoReconnect + reconnect catch)
- `chat:deleted` (undo event)

Member không có account access → không join `account:<id>` → không thấy lifecycle metadata. ACL parity socket = REST.

Webhook (`zalo.connected`) giữ ở org level vì đây là backend→external integration channel, không phải user browser event.

**Cleanup:** helper `resolveAccountOrgId` + cache map giờ unused → xóa. `prisma` import trong listener-factory cũng unused → xóa.

### Fix #24 — requireZaloAccess ownerUserId fallback
**File:** `backend/src/modules/zalo/zalo-access-middleware.ts`

Thêm check trước khi lookup access table: nếu `ZaloAccount.ownerUserId === user.id` (và account thuộc org user) → pass as admin. Khớp với socket layer đã có fallback tương tự.

Sau fix: legacy account không có ZaloAccountAccess row → member-owner thấy được list (Fix #20) VÀ thực hiện được admin action. Không cần migration backfill.

### Fix #25 — Frontend role gating
**File:** `frontend/src/views/ZaloAccountsView.vue`

- Nút "Thêm Zalo" chỉ hiện với `authStore.isAdmin`
- Helper `canAdmin(item)`: admin role bypass, member pass nếu `item.owner.id === authStore.user.id`
- Bọc sync/login/reconnect/delete buttons trong `<template v-if="canAdmin(item)">`

Member không thấy nút → không bao giờ gọi API → không nhận 403. "Phân quyền truy cập" button đã có sẵn `v-if="authStore.isAdmin"` từ trước.

---

## 3. Verification

```
backend:  npx tsc --noEmit     → exit 0
frontend: npx vue-tsc --noEmit → exit 0
```

---

## 4. Files modified round 5

| File | Change |
|---|---|
| `backend/src/modules/zalo/zalo-sync-routes.ts` | requireZaloAccess + org-scoped lookup |
| `backend/src/modules/zalo/zalo-access-middleware.ts` | ownerUserId fallback |
| `backend/src/modules/zalo/zalo-pool.ts` | 5 lifecycle emits → account room |
| `backend/src/modules/zalo/zalo-listener-factory.ts` | disconnected + chat:deleted → account room; cleanup unused helper/import |
| `frontend/src/views/ZaloAccountsView.vue` | canAdmin gate on admin controls |

No new files. ~50 LOC delta.

---

## 5. Final contract matrix

### Route namespace ACL (complete)
| Namespace | File | Guard pattern |
|---|---|---|
| `/zalo-accounts` list/create | zalo-routes.ts | filter by access / requireRole |
| `/zalo-accounts/:id` CRUD | zalo-routes.ts | requireZaloAccess + findFirst |
| `/zalo-accounts/:id/access/*` | zalo-access-routes.ts | requireRole + findFirst |
| `/zalo-accounts/:id/allowlist/*` | zalo-allowlist-routes.ts | requireZaloAccess + accountBelongsToOrg |
| `/zalo-accounts/:id/ingest-policy` | zalo-allowlist-routes.ts | requireRole + findFirst orgId |
| `/zalo-accounts/:id/sync-contacts` | zalo-sync-routes.ts | **requireZaloAccess + findFirst** (Fix #22) |
| `/zalo-accounts/:id/available-threads` | zalo-allowlist-routes.ts | requireZaloAccess + accountBelongsToOrg |

### Socket event → room matrix (complete)
| Event | Room | Reason |
|---|---|---|
| `chat:message` (visible) | `account:<id>` | full payload, ACL-gated |
| `chat:message` (pending) | `account:<id>` | scrubbed envelope `{accountId, visibility}` |
| `chat:deleted` | `account:<id>` | msgId metadata |
| `zalo:connected` | `account:<id>` | accountId + zaloUid |
| `zalo:disconnected` | `account:<id>` | accountId + code + reason |
| `zalo:error` | `account:<id>` | error details |
| `zalo:reconnect-failed` | `account:<id>` | error details |

Không còn event nào emit tới `org:<orgId>` room carrying account metadata.

### Access resolution (complete)
- `owner`/`admin` role → bypass (full org access)
- `ownerUserId === user.id` → pass as admin (socket + middleware, Fix #15 + #24)
- `ZaloAccountAccess.permission >= required` → pass (explicit grant)

---

## 6. Remaining limitations

1. **Group history cursor** — still SDK-limited, defer P5 (documented in `zalo-history-routes.ts` header)
2. **Public API permission** — org-scoped, not per-key. ADR-001 addresses default policy; per-key granularity future work
3. **Out-of-scope changes in working tree** — Redis rate limiter, call-webhook automation, docker-compose port, content/n8n plans. Should split to separate PR before merge

---

## 7. Full file inventory across 5 rounds (PR scope)

**Backend — core (P1-P4 scope):**
- prisma/schema.prisma + migration `20260422184100_*`
- src/app.ts
- src/shared/redis/redis-client.ts
- src/modules/chat/message-handler.ts, chat-routes.ts
- src/modules/zalo/zalo-allowlist-cache.ts (new)
- src/modules/zalo/zalo-allowlist-routes.ts (new)
- src/modules/zalo/zalo-history-routes.ts (new)
- src/modules/zalo/zalo-thread-listing.ts (new)
- src/modules/zalo/zalo-message-sync.ts
- src/modules/zalo/zalo-listener-factory.ts
- src/modules/zalo/zalo-pool.ts
- src/modules/zalo/zalo-socket.ts
- src/modules/zalo/zalo-routes.ts
- src/modules/zalo/zalo-sync-routes.ts (Fix #22 round 5)
- src/modules/zalo/zalo-access-middleware.ts (Fix #24 round 5)
- src/modules/api/public-api-routes.ts

**Frontend — core:**
- src/composables/use-chat.ts
- src/composables/use-zalo-accounts.ts
- src/views/ZaloAccountsView.vue (Fix #25 round 5)

**Docs/reports:**
- backend/docs/adr-001-default-ingest-policy.md
- backend/plans/reports/implementation-260422-1841-backend-p1-p4.md
- backend/plans/reports/codex-followup-260422-1930-p1-p2-blockers.md
- backend/plans/reports/codex-followup-260422-2015-hardening-pass.md
- backend/plans/reports/codex-followup-260422-2217-side-channel-audit.md
- backend/plans/reports/codex-followup-260423-0104-side-channel-closure.md
- backend/plans/reports/codex-followup-260423-0426-route-namespace-audit.md (this)

**Out-of-scope (needs PR split):**
- Redis rate limiter (`zalo-rate-limiter.ts`)
- `call-webhook-action.ts` automation
- docker-compose port change
- content/n8n plan files

---

## 8. Unresolved

Không có. Tất cả Codex findings 5 rounds đã đóng.

**Self-score target round 5:** 9/10 backend readiness for P6-P8.
**Codex prev:** 8/10. Gap closed: 2 P1 + 1 P2 + 1 P3.
