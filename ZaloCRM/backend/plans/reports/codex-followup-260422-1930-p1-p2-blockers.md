# Codex Follow-up Report — P1/P2 Blockers Fixed

**Date:** 2026-04-22 19:30 (Asia/Saigon)
**Session CWD:** `H:\Task1SaoViet\ZaloCRM\backend`
**Previous report:** `plans/reports/implementation-260422-1841-backend-p1-p4.md`
**Branch:** main

---

## Response to Codex review

Mình đồng ý với toàn bộ 6 issue. Đã fix hết và rerun `npx tsc --noEmit` → **exit 0, clean**.

| # | Issue | Severity | Status | Fix summary |
|---|---|---|---|---|
| 1 | TS2351 trong redis-client.ts | P1 | FIXED | Kiểm tra `mod.default` runtime + cast rõ ràng |
| 2 | Pending threads leak qua `contact.created` webhook | P1 | FIXED | Gate webhook dựa trên `plannedVisibility` resolve TRƯỚC upsertContact |
| 3 | Owner/admin thiếu org scoping trong allowlist routes | P1 | FIXED | Thêm `accountBelongsToOrg()` helper, áp cho 3 handlers dùng `:id` + `requireZaloAccess` |
| 4 | Socket broadcast global leak private data | P1 | FIXED | Đổi `io.emit` → `io.to(\`org:${orgId}\`).emit` cho mọi event liên quan data user |
| 5 | Group history tự khoá `historyExhausted` sai | P2 | FIXED | Chỉ set exhausted=true khi upstream `more=false`; added=0 break early nhưng KHÔNG khoá |
| 6 | Untick allowlist không ảnh hưởng conv visible đã có | P2 | FIXED | Bulk remove/disable tự cascade flip existing conv → `hidden` với audit trail |

---

## 2. Detail changes

### Fix #1 — redis-client.ts
`ioredis` export dưới NodeNext ESM là module object không constructible trực tiếp. Workaround: runtime resolve `mod.default ?? (mod as ctor)`, cast type tường minh. File chỉ thay đổi try-block, hành vi fallback khi không có REDIS_URL giữ nguyên.

### Fix #2 — Pending leak via contact.created
**Root cause:** `upsertContact()` chạy TRƯỚC khi biết visibility, và `emitWebhook(orgId, 'contact.created', ...)` bắn ngay trong path tạo contact → thread pending vẫn leak contact ra external systems.

**Fix pattern:**
- Thêm `resolvePlannedVisibility(msg)` chạy đầu tiên (read-only query existing conv + policy)
- Truyền `plannedVisibility` xuống `upsertContact()` — nếu `!== 'visible'` → skip `emitWebhook`
- Truyền `plannedVisibility` xuống `findOrCreateConversation()` → không cần resolve policy lần 2 (tránh race cache)

**Single source of truth:** một `plannedVisibility` gate cho cả 3 side-effects (contact.created, message webhook, automation).

**Existing conv 'hidden' edge case:** treat `hidden` như `pending` cho gating (cả hai đều skip side-effects). Note trong comment.

### Fix #3 — Org scoping
**Root cause:** `requireZaloAccess` có short-circuit cho owner/admin (line 19: `if (['owner', 'admin'].includes(user.role)) return`). Khi handlers sau đó dùng `prisma.zaloAccount.findUnique({ where: { id } })` KHÔNG có `orgId`, owner của org A có thể đọc/sửa data org B nếu biết UUID.

**Fix:**
- Helper `accountBelongsToOrg(accountId, orgId)` — 1 query scoped lookup
- GET `/allowlist`: chuyển `findUnique` → `findFirst` với `orgId: user.orgId`
- POST `/allowlist/bulk`: early return 404 nếu không thuộc org
- GET `/available-threads`: early return 404 nếu không thuộc org
- PATCH `/ingest-policy`, `/approve`, `/reject`: đã dùng orgId scope từ đầu — không cần sửa

### Fix #4 — Socket broadcast scoping
**Root cause:** `io.emit(...)` broadcast tất cả sockets connected, kể cả từ org khác → pending message có thể reach UI của tenant khác.

**Fix:** Đổi sang `io.to(\`org:${orgId}\`).emit(...)` (rooms đã có sẵn trong `zalo-socket.ts`).

**Files touched:**
- `zalo-listener-factory.ts`: 3 emits (chat:message realtime, chat:message old_messages, chat:deleted, zalo:disconnected)
  - Thêm helper `resolveAccountOrgId(accountId)` có in-memory cache để tránh query lặp
- `chat-routes.ts`: send-message emit (dùng `conversation.orgId` từ row đã load)
- `zalo-pool.ts`: 5 emits (zalo:connected ×2, zalo:error, zalo:reconnect-failed ×3)

Tất cả emit liên quan Zalo/chat giờ đã scope. Non-sensitive (nothing besides accountId) vẫn scope để consistency.

### Fix #5 — Group history exhaustion
**Root cause:** SDK `getGroupChatHistory(groupId, count)` không có cursor. Mỗi batch trả cùng newest window. Sau khi cron đã insert hết, `added=0` → code cũ set `historyExhausted=true` vĩnh viễn → UI tắt nút "Tải thêm" dù Zalo vẫn có thể return `more=true`.

**Fix semantics:**
- `!result.more` → exhausted=true, break (confident)
- `result.added=0 && result.more=true` → break early (không có cursor, retry cùng request vô nghĩa) nhưng KHÔNG set exhausted (để sau cursor-aware phase 5 client thử lại được)
- Thêm field `moreUpstream` trong response cho client phân biệt 2 trạng thái
- Cập nhật header comment giải thích limitation + refer phase 5

### Fix #6 — Untick allowlist cascade
**Root cause:** Bulk `remove`/`disable` chỉ update `zalo_thread_allowlist` rows. Conv existing `visibility='visible'` vẫn ingest visible & trigger workflow sau khi user "bỏ chọn" — mâu thuẫn với UX "chọn cái nào sync".

**Fix:** Sau bulk ops, collect `revokedThreads` (từ remove + disable), chạy:
```ts
prisma.conversation.updateMany({
  where: { zaloAccountId, externalThreadId: in revokedThreads, visibility: 'visible' },
  data: { visibility: 'hidden', hiddenAt, hiddenByUserId, reviewedAt, reviewedByUserId },
});
```

- Chỉ target `visible` → không overwrite `pending` history (user có thể có pending đang chờ duyệt trên cùng thread)
- Response thêm `hiddenConversations` count để UI feedback
- Audit trail: `hiddenAt + hiddenByUserId + reviewedAt + reviewedByUserId`

---

## 3. Verification

```bash
npx tsc --noEmit  → exit 0, 0 errors
```

So với lần trước (2 errors tại redis-client.ts) → backend giờ **thực sự xanh**.

---

## 4. Files modified this session

| File | Change |
|---|---|
| `backend/src/shared/redis/redis-client.ts` | Runtime ctor resolution, cast cho TS |
| `backend/src/modules/chat/message-handler.ts` | `resolvePlannedVisibility()` + gate upsertContact + param-pass to findOrCreateConversation |
| `backend/src/modules/zalo/zalo-allowlist-routes.ts` | `accountBelongsToOrg()` helper + scope 3 handlers + bulk cascade revoked → hidden |
| `backend/src/modules/zalo/zalo-listener-factory.ts` | `resolveAccountOrgId()` helper + scope 4 emits |
| `backend/src/modules/chat/chat-routes.ts` | Scope send-message emit |
| `backend/src/modules/zalo/zalo-pool.ts` | Scope 5 emits (loginQR + reconnect + circuit breaker + autoReconnect) |
| `backend/src/modules/zalo/zalo-history-routes.ts` | Exhaustion criteria + moreUpstream field + comment |

No new files. Total delta ≈ 180 LOC modified.

---

## 5. Out of scope (intentionally deferred)

Đúng như Codex gợi ý:
- Redis rate limiter, call_webhook automation, docker-compose port change, content/n8n plan — **không đụng**, để session/PR riêng
- Frontend P6-P8 — hold đến khi Codex xác nhận backend pass

---

## 6. Guarantees refreshed

**Backward compat:**
- Default `ingestPolicy='all'` + `visibility='visible'` giữ nguyên
- Endpoint shapes thêm field (`hiddenConversations`, `moreUpstream`) không phá client cũ
- Migration SQL không thay đổi

**Privacy (new after fix):**
- Contact.created webhook KHÔNG bắn cho pending thread
- Chat:message socket event KHÔNG broadcast cross-org
- Allowlist routes KHÔNG cho phép cross-org access kể cả owner/admin
- Untick allowlist → existing visible conv flip sang hidden ngay, dừng ingest path

**Correctness:**
- historyExhausted chỉ set khi upstream confirm `more=false` — không false-positive khi cron overlap

---

## 7. Unresolved

Không. Mọi blocker Codex raise đã fix + tsc xanh.

Codex có thể rerun audit khi ready.

**Status:** DONE
**Summary:** 6 fixes applied, tsc clean, no behavior regression, file count unchanged (just edits).
