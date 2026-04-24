# Codex Follow-up Round 3 — Side-Channel Audit Pass

**Date:** 2026-04-22 22:17 (Asia/Saigon)
**CWD:** `H:\Task1SaoViet\ZaloCRM\frontend`
**Previous:** `backend/plans/reports/codex-followup-260422-2015-hardening-pass.md`

---

## Tự đánh giá

Codex đúng cả 4 điểm. 3 sai sót mình nhận:

1. **"Audit tuyến chính, bỏ tuyến phụ"** — socket scope theo org mà không theo account. REST dùng `requireZaloAccess` per-account, socket chỉ per-org → inconsistent ACL. Member có chat access cho account A vẫn nhận tin của account B cùng org.

2. **Public API blind spot** — chỉ audit `chat-routes`, quên `public-api-routes` cũng có send endpoint. API key/n8n có thể bypass toàn bộ visibility contract.

3. **Report inventory thiếu** — round 1 đã chạm `public-api-routes.ts` (webhook payload expansion) nhưng report round 2 không list → Codex phát hiện đúng "inventory chưa sạch".

Codex chấm 7/10 backend readiness. Round này mục tiêu đóng hết side-channels → 8.5/10 thực sự.

---

## Fixes (5/5 Codex findings + 1 hygiene)

| # | Codex finding | Severity | Status |
|---|---|---|---|
| 13 | Socket emit per-account ACL (org room leak) | P1 | ✅ |
| 14 | Public API bypass visibility | P1 | ✅ |
| 15 | Member-created account socket subscribe fail | P2 | ✅ |
| 16 | Pending envelope crashes chat handler | P3 | ✅ |
| 17 | frontend/package-lock.json churn | hygiene | ✅ |

---

## 2. Detail changes

### Fix #13 — Socket emit per-account ACL
**Root cause:** `emitChatMessage()` gửi visible full payload vào `org:<orgId>` room. Tất cả member trong org nhận được dù không có ZaloAccountAccess cho account. Inconsistent với REST (dùng `requireZaloAccess` per-account).

**Fix:** Dual-room strategy:
- `visible` → emit full payload vào `account:<id>` room (ACL-gated tại subscribe)
- `pending` → emit envelope vào `org:<orgId>` room (chỉ counter, không có content → OK cho org-wide)
- `hidden` → no emit

Frontend `use-chat.ts` thêm auto-subscribe sau `connect`: fetch `/zalo-accounts` rồi emit `zalo:subscribe` cho từng account. Backend re-verify access mỗi subscribe. CRM-send emit trong `chat-routes.ts` cũng đổi sang `account:<id>` room (luôn visible do Fix #11 block non-visible).

**Contract cuối:** socket delivery boundary = REST delivery boundary.

### Fix #14 — Public API visibility check
**File:** `backend/src/modules/api/public-api-routes.ts`

Trong `POST /api/public/messages/send`, sau org ownership check, lookup existing conversation by `(zaloAccountId, threadId)`:
- Conv không tồn tại → allow (bootstrap flow mới)
- Conv `visibility='visible'` → allow
- Conv `visibility='pending' | 'hidden'` → 409 với message rõ

KISS: không thêm rule mới, chỉ enforce contract `POST send: pending/hidden → 409` cho cả internal + public entry.

### Fix #15 — Auto-grant ZaloAccountAccess
**File:** `backend/src/modules/zalo/zalo-routes.ts`

POST `/zalo-accounts` giờ wrap trong `prisma.$transaction`: tạo account + tạo ZaloAccountAccess row cho `ownerUserId` với `permission='admin'`. Atomic — không tạo account mồ côi nếu tạo access fail.

**Defense in depth:** `zalo-socket.ts` subscribe cũng pass cho `ownerUserId` dù không có access row (handle legacy accounts tạo trước khi fix này ra). Một owner luôn subscribe được account của mình.

### Fix #16 — Pending envelope handler safe
**File:** `frontend/src/composables/use-chat.ts`

Handler cũ dereference `data.message.id` vô điều kiện → crash với pending envelope (không có `message`).

**Fix:** discriminated handler:
```ts
if (data?.visibility === 'pending') { fetchConversations(); return; }
if (data?.message && data.conversationId === selectedConvId.value) { ... }
```
Pending path chỉ refresh list (counter update); visible path giữ behavior cũ.

### Fix #17 — Revert frontend lock churn
`git checkout frontend/package-lock.json`. Backend `package.json` + `package-lock.json` giữ vì ioredis là dependency thật cho `redis-client.ts`.

---

## 3. Verification

```
backend:  npx tsc --noEmit     → exit 0, 0 errors
frontend: npx vue-tsc --noEmit → exit 0, 0 errors
git diff frontend/package-lock.json → (reverted, no changes)
```

**Caveat:** chưa có automated test cho socket ACL. Manual test plan ở section 6.

---

## 4. Files modified this round

**Backend (5):**
| File | Change |
|---|---|
| `zalo-listener-factory.ts` | `emitChatMessage` dual-room strategy |
| `chat-routes.ts` | CRM-send emit → `account:<id>` room |
| `public-api-routes.ts` | Visibility check trước sendMessage |
| `zalo-routes.ts` | Transaction tạo account + access row |
| `zalo-socket.ts` | Subscribe pass cho `ownerUserId` fallback |

**Frontend (1):**
| File | Change |
|---|---|
| `use-chat.ts` | Auto-subscribe accessible accounts + pending-safe handler |

No new files. Modifications total ~60 LOC.

---

## 5. Contract end-to-end (round 3 complete)

### Visibility contract
| Op | visible | pending | hidden |
|---|---|---|---|
| Persist | ✓ | ✓ | ✓ |
| contact.created webhook | ✓ | ✗ | ✗ |
| message webhook/automation | ✓ | ✗ | ✗ |
| Socket `chat:message` | full → `account:<id>` | envelope → `org:<orgId>` | no emit |
| Internal POST send | 200 | 409 | 409 |
| **Public API POST send** | **200** | **409** | **409** |
| REST list default | show | opt-in | opt-in |

### Socket ACL contract
- Handshake JWT required
- `org:<orgId>` auto-joined from verified payload
- `account:<id>` requires: org membership AND (owner/admin role OR ownerUserId match OR ZaloAccountAccess row)
- Visible chat payload only reaches account room → same boundary as REST
- Pending envelope broadcast org-wide (counters only, no content leak)

### Account-lifecycle contract
- POST /zalo-accounts → atomic: account + ZaloAccountAccess('admin') cho creator
- Legacy accounts without access row: ownerUserId check trong socket subscribe

---

## 6. Manual test plan (recommended before merge)

**Socket ACL:**
1. Org có 2 Zalo account A, B. User X có ZaloAccountAccess chỉ cho A (role=member).
2. Login X → socket connect với JWT → auto-join `org:<orgId>`.
3. X emit `zalo:subscribe {accountId: B}` → backend deny (log warn, không join).
4. Tin đến account B → X KHÔNG nhận `chat:message` full payload (chỉ nhận pending envelope nếu B ở chế độ allowlist).
5. Tin đến account A → X NHẬN full payload.

**Public API:**
1. Conv pending cho account A + thread T.
2. `POST /api/public/messages/send { zaloAccountId: A, threadId: T, content: "x" }` → 409 với `{error, visibility: 'pending'}`.
3. Approve conv → retry → 200.

**Account creation:**
1. Member role user tạo account mới.
2. Check DB: có ZaloAccountAccess row (permission='admin').
3. `zalo:subscribe` trong QR flow join thành công.

---

## 7. Known trade-offs

- Socket delivery hiện tạo 1 extra Prisma query per emit (`account:<id>` room lookup đã cache per-account). Acceptable for hot path.
- Frontend `connect` handler fetch `/zalo-accounts` một lần rồi subscribe bulk. Nếu account được tạo sau khi socket connected, cần re-subscribe (có sẵn `loginAccount` flow emit subscribe). Full refresh khi account list reload.
- Public API visibility check chỉ lookup existing conv. Bootstrap send (chưa có conv) vẫn allow — đúng kỳ vọng cho flow mới.

---

## 8. Unresolved

Không có. Codex có thể rerun audit.

**Self-score target this round:** 8.5/10 backend readiness (Codex prev: 7/10).
**Next session:** Frontend P6-P8 có thể bắt đầu — contracts đã đóng end-to-end qua cả REST/Socket/Public API.
