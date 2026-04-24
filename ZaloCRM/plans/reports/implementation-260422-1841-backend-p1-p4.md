# Implementation Report — Chat History & Allowlist (Backend Phases 1-4)

**Date:** 2026-04-22 18:41 (Asia/Saigon)
**Plan:** `plans/260420-0631-chat-history-and-conversation-allowlist/`
**Branch:** main (working tree)
**Scope delivered:** P1 (schema), P2 (enforcement), P3 (CRUD API), P4 (group history fetch)
**Deferred:** P5 (1-1 history R&D), P6-P8 (frontend), P9 (docs)

---

## 1. Strategy rationale

Chọn backend-first vì:
- P1→P2→P3→P4 tạo thành chuỗi có thể test độc lập bằng curl, không phụ thuộc UI
- P5 risky (R&D cần DevTools người thật) — tách khỏi batch stable
- Frontend P6-P8 phụ thuộc API stable → làm sau khi backend xanh
- Docs P9 cuối cùng sau khi có UI để screenshot

---

## 2. Changes by phase

### P1 — Schema migration ✅

**Files:**
- `backend/prisma/schema.prisma` (edited)
- `backend/prisma/migrations/20260422184100_add_conversation_visibility_and_allowlist/migration.sql` (new)

**DDL:**
- `zalo_accounts` + `ingest_policy TEXT DEFAULT 'all'` — backward-compat default
- `conversations` + 7 cột: `visibility`, `hidden_at`, `hidden_by_user_id`, `reviewed_at`, `reviewed_by_user_id`, `oldest_message_at`, `history_exhausted`
- Index `conversations_org_id_visibility_last_message_at_idx`
- New table `zalo_thread_allowlist` (id, zalo_account_id FK, external_thread_id, thread_type, enabled, added_by_user_id FK, note, timestamps) + unique + index

**Schema model additions:**
- `Conversation.visibility/hiddenAt/hiddenByUserId/reviewedAt/reviewedByUserId/oldestMessageAt/historyExhausted`
- `ZaloAccount.ingestPolicy`
- `ZaloThreadAllowlist` model + relation `User.allowlistEntries` + `ZaloAccount.allowlist`

Migration follows project convention (hand-written SQL, `IF NOT EXISTS` idempotent).

### P2 — Allowlist enforcement ✅

**Files:**
- `backend/src/modules/zalo/zalo-allowlist-cache.ts` (new, 79 LOC)
- `backend/src/modules/chat/message-handler.ts` (edited)
- `backend/src/modules/chat/chat-routes.ts` (edited)
- `backend/src/modules/zalo/zalo-listener-factory.ts` (edited)

**Logic:**
- Cache: per-account `{ policy, allowedThreads: Set }` TTL 60s, `invalidateAllowlistCache(accountId)` for mutations
- `findOrCreateConversation` gate: policy='allowlist' + thread not allowed → new conv `visibility='pending'`; existing conv untouched
- Fail-open: nếu policy resolution lỗi → fallback 'visible' (không mất data)
- `handleIncomingMessage` trả thêm `visibility` trong `HandleMessageResult`
- Skip webhook + automation khi `visibility !== 'visible'` (pending/hidden both skip)
- `GET /conversations` + param `visibility` (default 'visible', `'all'` opt-out)
- `GET /conversations/counts` thêm field `pending` (scope: `visibility='pending'`, ignore tab)
- Socket `chat:message` emit thêm `visibility` trên cả 3 code path (realtime, old_messages, CRM-send)

### P3 — Allowlist CRUD API ✅

**Files:**
- `backend/src/modules/zalo/zalo-allowlist-routes.ts` (new, 230 LOC)
- `backend/src/modules/zalo/zalo-thread-listing.ts` (new, 125 LOC)
- `backend/src/app.ts` (register)

**Endpoints:**
| Method | Path | Guard | Purpose |
|---|---|---|---|
| GET | `/api/v1/zalo-accounts/:id/allowlist` | requireZaloAccess('chat') | List policy + entries |
| PATCH | `/api/v1/zalo-accounts/:id/ingest-policy` | requireRole('owner','admin') | Switch all↔allowlist |
| POST | `/api/v1/zalo-accounts/:id/allowlist/bulk` | requireZaloAccess('chat') | add/remove/enable/disable (max 500 ops) |
| POST | `/api/v1/conversations/:id/approve` | requireZaloAccess('chat') | Pending→visible + auto-add allowlist |
| POST | `/api/v1/conversations/:id/reject` | requireZaloAccess('chat') | Pending→hidden (no allowlist entry) |
| GET | `/api/v1/zalo-accounts/:id/available-threads` | requireZaloAccess('chat') | Live friends+groups, 5min cache, CRM-state annotated |

Mọi mutation → `invalidateAllowlistCache(accountId)` ngay để hot path đọc state mới trong 1 request.

Bulk uses Prisma `upsert` với composite unique `(zaloAccountId, externalThreadId)` — idempotent.

`listAvailableThreads` parallel-fetch `getAllFriends()` + `getAllGroups()`, defensive về shape (`gridInfoMap` vs flat), annotate từng thread với `inAllowlist/allowlistEnabled/hasConversation/conversationId/conversationVisibility/lastMessageAt`.

### P4 — Group history fetch (on-demand paginated) ✅

**Files:**
- `backend/src/modules/zalo/zalo-message-sync.ts` (refactored)
- `backend/src/modules/zalo/zalo-history-routes.ts` (new, 116 LOC)
- `backend/src/app.ts` (register)

**Logic:**
- Extract `fetchAndPersistGroupBatch(api, conv, accountId, count)` — single code path dùng cho cả cron và on-demand; trả `{ added, oldestTs, more }`
- Preserve dedup + `isBackfill=true` (skip automation/webhook)
- `POST /api/v1/conversations/:id/fetch-history` — body `{ batchSize, maxBatches }`
  - Caps: batchSize ≤200, maxBatches ≤10, delay 500ms/batch
  - Group only hiện tại — user threads trả 400 đợi P5
  - Short-circuit `historyExhausted=true` (không gọi SDK)
  - Update `oldestMessageAt` (min ts) + `historyExhausted` (khi `more=0` hoặc `added=0`)
  - 502 khi upstream lỗi, không mark exhausted để client retry

---

## 3. Verification

**Install:** `npm install` trong backend → 411 packages, exit 0
**Prisma generate:** `DATABASE_URL=<dummy> npx prisma generate` → exit 0, client v7.5.0 generated
**TypeScript compile:** `npx tsc --noEmit` → exit 0
- 2 pre-existing errors trong `redis-client.ts` (ioredis import — không liên quan code mới)
- **0 errors** trên 6 files mới + 5 files edited của tôi

**Migration SQL:** hand-written, idempotent (`IF NOT EXISTS` trên mọi ADD COLUMN / CREATE), default `visibility='visible'` cho row cũ → 0 regression cho deployment v2.1 hiện hữu.

---

## 4. Files inventory

**New (6):**
```
backend/src/modules/zalo/zalo-allowlist-cache.ts        79 LOC
backend/src/modules/zalo/zalo-allowlist-routes.ts      230 LOC
backend/src/modules/zalo/zalo-history-routes.ts        116 LOC
backend/src/modules/zalo/zalo-thread-listing.ts        125 LOC
backend/prisma/migrations/20260422184100_.../migration.sql
plans/reports/implementation-260422-1841-backend-p1-p4.md  (this file)
```

**Edited (5):**
```
backend/prisma/schema.prisma             — Conversation/ZaloAccount fields + ZaloThreadAllowlist model
backend/src/app.ts                       — register 2 new routes
backend/src/modules/chat/message-handler.ts    — visibility gate + skip pending automation
backend/src/modules/chat/chat-routes.ts        — visibility filter + pending count + socket emit
backend/src/modules/zalo/zalo-listener-factory.ts — socket emit visibility
backend/src/modules/zalo/zalo-message-sync.ts  — extract fetchAndPersistGroupBatch
```

Tất cả file mới < 250 LOC — respect modularization rule.

---

## 5. Behavioral guarantees

**Backward compatibility (v2.1 → v2.2):**
- Default `ingestPolicy='all'` → behavior cũ 100% (mọi tin persist, automation chạy, webhook bắn)
- Default `visibility='visible'` cho row cũ → UI cũ không thay đổi
- `GET /conversations` default filter `visibility='visible'` → không xuất hiện pending conversation chưa có trong schema cũ
- Endpoints mới additive only, không thay method/path cũ

**Allowlist mode (ingestPolicy='allowlist'):**
- Thread đã có trong allowlist (enabled=true) → new conv `visibility='visible'`, behavior y như cũ
- Thread không trong allowlist → new conv `visibility='pending'`, KHÔNG trigger webhook, KHÔNG trigger automation, vẫn persist message để không mất
- Existing visible conv KHÔNG tự động chuyển pending khi policy đổi (chỉ áp dụng conv mới) — tránh phá data history user đã quen dùng

**Permission model:**
- member-read: chỉ list, không mutate
- member-chat: CRUD allowlist + approve/reject + fetch history
- owner/admin: thêm đổi ingestPolicy

---

## 6. Known limitations & deferred

1. **P5 chưa làm** — 1-1 history fetch trả 400 với message rõ ràng để frontend xử lý graceful
2. **Pagination cursor** cho `getGroupChatHistory` — SDK hiện chỉ support `count`, không có `before`. Mỗi batch có thể trùng đầu + Zalo chỉ trả `count` gần nhất. Nếu user bấm "Tải thêm" nhiều lần, batch thứ N chỉ thêm được tin nào chưa có trong DB (dedup). → Hạn chế thực tế: có thể không kéo sâu tuyệt đối được, nhưng dedup protect khỏi duplicate. Giải pháp chuẩn cần `api.custom()` gọi endpoint native với `lastActionId` — để P5 mở rộng
3. **Prisma config** yêu cầu `DATABASE_URL` để generate — đã test với dummy, production cần env thật
4. **Pre-existing TS errors** trong `redis-client.ts` không fix (ngoài scope)

---

## 7. Test plan (manual, cần env thật để chạy)

**Setup:**
```
npx prisma migrate deploy  # apply new migration
```

**Regression (policy='all'):**
- Gửi/nhận tin bình thường → visibility='visible', automation chạy, webhook bắn ✅

**Allowlist flow:**
1. `PATCH /ingest-policy` body `{"policy":"allowlist"}` → cache invalidated
2. Gửi tin từ thread mới chưa allow → `GET /conversations?visibility=pending` thấy xuất hiện, counts.pending=1, automation NOT run
3. `POST /conversations/:id/approve` → visibility='visible', allowlist có entry, cache invalidated
4. Gửi tin tiếp theo từ thread đó → visibility='visible', automation chạy
5. `POST /conversations/:id/reject` trên pending khác → visibility='hidden', không trong allowlist

**Group history fetch:**
1. `POST /conversations/:id/fetch-history` body `{"batchSize":50,"maxBatches":3}` trên group conv
2. Response `{added, exhausted, oldestMessageAt}`
3. Gọi lại tới khi `exhausted=true` → `historyExhausted=true` trong DB

**Bulk allowlist:**
```
POST /allowlist/bulk
{"add":[{"externalThreadId":"123","threadType":"user"}], "disable":["456"]}
```

**Available threads:**
- `GET /available-threads` → friends + groups annotated với inAllowlist/hasConversation

---

## 8. Unresolved questions

Không có — mọi quyết định kiến trúc đã chốt với user trước khi code.

---

## 9. Next session

Phase 5 (R&D 1-1 history) hoặc Phase 6-8 (frontend UI). Recommend làm frontend trước để user thấy feature hoạt động end-to-end, P5 có thể làm song song không block.

**Status:** DONE
**Summary:** 4 backend phases delivered, 6 new files + 5 edits, tsc clean (0 errors ở code mới), migration idempotent backward-compat.
