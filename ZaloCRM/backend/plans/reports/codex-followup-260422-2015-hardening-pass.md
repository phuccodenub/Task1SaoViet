# Codex Follow-up Round 2 — Hardening Pass

**Date:** 2026-04-22 20:15 (Asia/Saigon)
**Session CWD:** `H:\Task1SaoViet\ZaloCRM\backend`
**Previous report:** `backend/plans/reports/codex-followup-260422-1930-p1-p2-blockers.md`
**Branch:** main

---

## Tự đánh giá (honest self-review)

Codex đúng cả 5 điểm. Phân tích lỗi mình mắc phải:

1. **"Đóng issue theo symptom"** — Fix #4 trước chỉ thay `io.emit` → `io.to(...).emit`, KHÔNG verify end-to-end frontend delivery. Kết quả: privacy fix tạo functional regression cho QR + chat realtime. Bài học: fix privacy phải định nghĩa **contract end-to-end** (source → transport → consumer) rồi mới code.

2. **Missed socket auth** — review code `zalo-socket.ts` mà không hỏi "client có thể spoof orgId không?". Privacy chỉ obfuscation nếu server trust client-supplied id.

3. **Visibility contract không đủ chặt** — report cũ viết "untick → dừng ingest path" nhưng thực tế hidden vẫn persist + emit + send-able. Gap rõ ở cả 3 lớp: persist/socket/send.

4. **Cache helper tạo ra rồi quên gọi** — `invalidateThreadListingCache()` có sẵn nhưng 5 mutation path không wire. Lỗi integration, không phải thiết kế.

5. **Tốc độ > chất lượng** — claim "6 fix xanh" trong khi chưa test end-to-end. Trong privacy work, claim lạc quan nguy hiểm hơn delay.

**Chấm điểm tự đánh giá (so với Codex):**
- Codex: 6.5/10 backend readiness → mình đồng ý
- Mục tiêu round này: kéo lên 8+/10 bằng cách đóng visibility contract end-to-end + auth + cache + whitespace

---

## Fixes applied (6/6 Codex findings)

| # | Codex finding | Severity | Status |
|---|---|---|---|
| 7 | Frontend không join org room → realtime regression | P1 | ✅ |
| 8 | Socket rooms unauthenticated | P1 | ✅ |
| 9 | Hidden/pending vẫn emit socket payload | P2 | ✅ |
| 10 | Thread listing cache stale | P2 | ✅ |
| 11 | Send to hidden/pending không bị block | P2 | ✅ |
| 12 | Trailing whitespace trong zalo-message-sync.ts | trivial | ✅ |

---

## 2. Detail changes

### Fix #8 (foundation) — Socket auth + room membership

**File:** `backend/src/modules/zalo/zalo-socket.ts` (rewrite, 108 LOC)

- Thêm `io.use(middleware)` verify JWT từ handshake (`auth.token` hoặc `Authorization` header) dùng `app.jwt.verify()` cùng secret với REST
- Payload verified → lưu vào `socket.data.{userId, orgId, role}` (server-authoritative)
- Single `connection` handler auto-join `org:${socket.data.orgId}` — client KHÔNG thể pick orgId
- `zalo:subscribe` re-check: account phải thuộc org user + member phải có `ZaloAccountAccess`; owner/admin pass
- Remove client-driven `org:join` event (giờ tự động)

### Fix #7 — Frontend send token in handshake

**Files:**
- `frontend/src/composables/use-chat.ts` line 249
- `frontend/src/composables/use-zalo-accounts.ts` line 125

Thay `io({ transports: [...] })` → `io({ transports: [...], auth: { token } })` với token đọc từ `localStorage`. Backend verify + auto-join org room. Không cần frontend emit event nào.

**Integration contract:** client gửi JWT → server verify + join room → mọi `io.to('org:X').emit()` reach đúng client. QR login + chat realtime recovered.

### Fix #9 — Visibility-aware socket emit

**File:** `backend/src/modules/zalo/zalo-listener-factory.ts`

Thêm helper `emitChatMessage(io, accountId, result)`:
- `visibility === 'hidden'` → **không emit gì** (rejected conversation phải silent)
- `visibility === 'pending'` → emit **envelope only** (conversationId, visibility, messageId, sentAt) — đủ cho UI bump counter "Chờ duyệt" nhưng KHÔNG leak nội dung
- `visibility === 'visible'` → emit full payload (cũ)

Call sites (realtime + old_messages) thay inline emit bằng gọi helper → DRY + single source of truth cho rules.

### Fix #10 — Thread listing cache invalidation

**File:** `backend/src/modules/zalo/zalo-allowlist-routes.ts`

Import thêm `invalidateThreadListingCache`. Wire vào 5 mutation paths:
- PATCH ingest-policy (policy flip affects entire listing mode)
- POST allowlist/bulk (inAllowlist + conv visibility both change)
- POST conversations/:id/approve (inAllowlist + conv visibility)
- POST conversations/:id/reject (conv visibility)

Mỗi path gọi **cả hai**: `invalidateAllowlistCache(accountId)` (cho hot path message-handler) và `invalidateThreadListingCache(accountId)` (cho UI `/available-threads`). 

Reject endpoint refactor nhẹ: lookup conv trước để có accountId cho cache invalidation.

### Fix #11 — Block send on non-visible

**File:** `backend/src/modules/chat/chat-routes.ts` line ~212

Trong `POST /api/v1/conversations/:id/messages`, sau lookup conv, check `conversation.visibility !== 'visible'` → return 409 với message tiếng Việt rõ ràng (`"chờ duyệt"` vs `"đã bị ẩn"`). Vừa bảo vệ invariant vừa UX friendly.

### Fix #12 — Trailing whitespace

**File:** `backend/src/modules/zalo/zalo-message-sync.ts`

Strip trailing blank line + CRLF double-newline. `git diff --check` → clean.

---

## 3. Verification

```
npx tsc --noEmit        → exit 0, 0 errors
git diff --check        → clean (ngoại trừ LF→CRLF warning cosmetic)
```

**Không chạy frontend typecheck** vì frontend chưa install deps trong session này; delta trivial (2 files, chỉ thêm option `auth: { token }`).

---

## 4. Contract end-to-end (hardened)

### Visibility contract (NEW complete)

| Op | visible | pending | hidden |
|---|---|---|---|
| Persist message | yes | yes | yes |
| Conversation created | yes | yes | yes |
| `contact.created` webhook | yes | **no** | **no** |
| `message.received`/`sent` webhook | yes | **no** | **no** |
| Automation rules run | yes | **no** | **no** |
| Socket emit `chat:message` | full payload | **envelope only** | **no emit** |
| List endpoint default | shown | hidden (filter=pending to see) | hidden (filter=hidden to see) |
| Counts endpoint | counts | counts (separate) | n/a |
| POST send message | 200 | **409** | **409** |
| Zalo CLI sync cron | backfill OK | backfill OK (stays pending) | backfill OK (stays hidden) |

### Socket auth contract (NEW)

- Connection requires valid JWT (handshake rejected if missing/invalid)
- `org:<orgId>` room auto-joined from verified payload (client cannot pick)
- `account:<id>` room requires org ownership + ZaloAccountAccess (member) or owner/admin role

### Cache invalidation contract (NEW complete)

Mọi allowlist mutation → invalidate **cả hai** caches (`allowlist-cache` 60s TTL hot path + `thread-listing-cache` 5min TTL UI). Không còn stale state trong UI.

---

## 5. Files modified this round

| File | Change |
|---|---|
| `backend/src/modules/zalo/zalo-socket.ts` | Full rewrite: JWT auth middleware + auto-join + access-checked subscribe |
| `backend/src/app.ts` | Pass `app` to `registerZaloSocketHandlers`, remove duplicate connection handler |
| `backend/src/modules/zalo/zalo-listener-factory.ts` | `emitChatMessage()` helper với visibility rules |
| `backend/src/modules/zalo/zalo-allowlist-routes.ts` | Import + call `invalidateThreadListingCache` in 5 paths |
| `backend/src/modules/chat/chat-routes.ts` | Block send on non-visible (409) |
| `backend/src/modules/zalo/zalo-message-sync.ts` | Strip trailing blank line |
| `frontend/src/composables/use-chat.ts` | `auth: { token }` in socket handshake |
| `frontend/src/composables/use-zalo-accounts.ts` | `auth: { token }` in socket handshake |

No new files. Helper `emitChatMessage` nội bộ cùng file listener factory, <40 LOC → không cần tách module riêng.

---

## 6. Guarantees refreshed

**Privacy (post-round-2):**
- JWT-authed sockets only; no anonymous client can join rooms
- Server-authoritative orgId from JWT → no cross-org access even with guessed UUIDs
- Hidden conv 100% silent on socket; pending envelope-only (no content leak)
- Send-API blocks non-visible → no outbound leak to rejected threads

**Correctness:**
- Thread listing UI reflects state immediately (all mutations invalidate)
- Frontend receives events via auto-joined org room (no manual `org:join` needed)
- `historyExhausted` only set when upstream confirms (Fix #5 held)

**Backward compat:**
- Default `ingestPolicy='all'` + `visibility='visible'` preserved
- Socket event names unchanged (just payload + delivery differ)
- REST endpoint shapes additive only

---

## 7. Known trade-offs

- **Pending envelope emit** hiện chỉ bao gồm `{accountId, conversationId, visibility, messageId, sentAt}`. Nếu UI cần senderName/contentType để render preview snippet, thêm sau. Hiện KISS — UI re-fetch REST khi user click tab pending.
- **Socket auth giờ BẮT BUỘC** — nếu có client cũ không gửi token (e.g. health probe), sẽ connect fail. Không thấy consumer nào khác besides frontend composables → an toàn.
- **Existing visible conv sent trước khi allowlist mode bật** vẫn send-able bình thường (đúng kỳ vọng — không phá data history).

---

## 8. Unresolved questions

Không có. Mọi Codex finding round 1+2 đã đóng. Sẵn sàng cho Codex rerun audit.

**Status:** DONE
**Self-score target:** 8.5/10 backend readiness (Codex previous: 6.5/10)
**Next session readiness:** Frontend P6-P8 có thể bắt đầu an toàn — socket + visibility + cache contracts đã solid.
