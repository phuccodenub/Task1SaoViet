# Tải lịch sử chat cũ (v2.2)

**Mục đích:** cho user kéo tin nhắn cũ hơn cửa sổ đã sync, thay vì chỉ thấy tin nhắn từ lúc QR login trở đi.

ZaloCRM v2.2 hỗ trợ 2 cơ chế load-more song song, hiển thị chung 1 banner ở đầu khung chat:

1. **Cursor trên Message table (CRM-local)** — luôn an toàn, không gọi Zalo.
2. **`getGroupChatHistory` từ Zalo SDK (cho group)** — gọi Zalo để lấy tin nhắn chưa có trong DB.

Chat 1-1 (user thread) **chưa có** cơ chế fetch từ Zalo; đây là phase 5 R&D bị defer — xem mục "Giới hạn" bên dưới.

---

## Cơ chế 1: Cursor trên Message table

### API

```
GET /api/v1/conversations/:id/messages?before=<messageId>&limit=<n>
```

- `before` — id của message cũ nhất đang hiển thị trên UI. Server tra `sentAt` của message này, trả các message có `sentAt < pivot.sentAt` theo thứ tự mới → cũ, rồi `reverse()` trước khi trả về client (cũ → mới).
- `limit` — mặc định 50, tối đa 200.
- Response `{ messages, hasMore, oldestSentAt, limit }`.

Cursor ổn định dưới race condition: tin mới đến tail không ảnh hưởng paging ở head. Page-based `?page=N&limit=L` vẫn work cho initial load (backward-compat).

### UI flow

- `MessageThread` nút "Tải thêm tin cũ (CRM)" gọi `loadMoreLocal()` trong `use-chat.ts`.
- Scroll được **preserve** sau prepend (tính `scrollTop += newHeight - savedHeight` sau nextTick).
- Khi `hasMore=false` → set `localHistoryExhausted=true`, UI chuyển sang path 2 (nếu khả dụng).

### Giới hạn

- Chỉ trả về những tin đã được persist. Nếu user vừa login Zalo, DB chưa có tin cũ → cursor trả rỗng → UI chuyển sang Path 2.

---

## Cơ chế 2: Fetch từ Zalo SDK (group only)

### API

```
POST /api/v1/conversations/:id/fetch-history
Body: { batchSize?: number, maxBatches?: number }
```

- Caps: `batchSize ≤ 200`, `maxBatches ≤ 10`. Delay 500ms giữa batches.
- Chỉ hỗ trợ `threadType='group'`. User thread (1-1) trả **400** với message `"User (1-1) history fetch not yet available — waiting on phase 5"`.
- Response `{ added, exhausted, moreUpstream, oldestMessageAt }`.

### Semantics của `exhausted` vs `moreUpstream` (QUAN TRỌNG)

SDK `getGroupChatHistory(groupId, count)` **không có cursor** — mỗi batch có thể trả về cửa sổ gần đây lặp lại. Sau khi cron background sync đã insert xong, `added=0` KHÔNG đồng nghĩa với "đã hết lịch sử" — có thể chỉ là "cửa sổ giống nhau, dedup bỏ hết".

Backend áp logic (Fix #5 round 2):

- `result.more === false` → `exhausted=true` (Zalo chính thức báo hết)
- `result.added === 0 && result.more === true` → break early, **KHÔNG** set exhausted (client có thể thử lại sau khi cursor-aware wrapper ra mắt ở phase 5)

Client phân biệt 2 trạng thái này qua `moreUpstream`:

- `exhausted=true` → UI hiện "Đã tải hết lịch sử khả dụng", disable nút.
- `exhausted=false, moreUpstream=true` → UI vẫn cho thử lại, kèm hint "Zalo chỉ trả cửa sổ gần đây nhất; tin đã lưu sẽ được bỏ qua".
- `exhausted=false, moreUpstream=false` → UI hiện "Zalo báo không còn lịch sử cũ hơn — nhấn để thử lại".

### UI flow

- `MessageThread` nút "Lấy thêm tin từ Zalo" gọi `fetchHistoryFromZalo()` trong `use-chat.ts`.
- Sau khi backend persist xong, client refetch `GET /conversations/:id/messages` để load lại toàn bộ list → re-render.
- Tin đã được dedup qua unique `(conversationId, zaloMsgId)` trong schema Prisma.

### Rate limit

Hard cap server-side: 500ms delay giữa 2 batches trong 1 request. Khuyến nghị UI:

- Không cho user click liên tục: disable button trong khi `fetchingHistory=true`.
- Có thể thêm throttle per-conversation (chưa implement).

---

## Banner UI trong `MessageThread`

Banner xuất hiện ở top khung tin nhắn khi:

```
conversation != null
&& !loading
&& messages.length > 0
&& (canLoadMoreLocal || canFetchZaloHistory || historyFullyExhausted)
```

Logic lựa chọn path khi user click:

```
if (canLoadMoreLocal) → loadMoreLocal (cursor DB)
else if (canFetchZaloHistory) → fetchHistoryFromZalo (Zalo SDK)
```

Copy trung thực cho từng state (xem `MessageThread.vue` computed `loadMoreButtonLabel` + `bannerHint`):

| State | Label | Hint |
|---|---|---|
| Local còn | `Tải thêm tin cũ (CRM)` | (không) |
| Local hết + Zalo group còn | `Lấy thêm tin từ Zalo` | `Zalo chỉ trả cửa sổ gần đây nhất; tin đã lưu sẽ được bỏ qua.` |
| Local hết + Zalo báo hết | `Lấy thêm tin từ Zalo` | `Zalo báo không còn lịch sử cũ hơn — nhấn để thử lại.` |
| User (1-1) thread | (disabled) | `Hội thoại 1-1 chưa hỗ trợ lấy lịch sử cũ (đang R&D).` |
| Tất cả exhausted | (disabled với icon ✓) | (không) |

---

## Giới hạn đã biết

### 1. User (1-1) history chưa hỗ trợ từ Zalo SDK

zca-js chưa có `getUserChatHistory` public. Phase 5 R&D reverse-engineer endpoint `chat.zalo.me` qua `api.custom()` đã được plan nhưng bị defer ra PR riêng với các lý do:

- **Risk cao:** gọi endpoint không chính thức có thể bị Zalo flag account.
- **Exit criteria rõ:** R&D phải capture endpoint thành công + test trên dev account ≥ 1 tuần không bị warn trước khi ship.
- **Feature flag:** `ENABLE_USER_HISTORY_FETCH=false` default off khi tính năng ra mắt — user phải bật chủ động và chịu risk.

Hiện tại, `use-chat` + `MessageThread` đã chuẩn bị sẵn mọi payload để đón feature — khi P5 land, chỉ cần server route cho `threadType='user'` + feature flag, UI không cần đổi.

### 2. `historyExhausted` không phải lúc nào cũng cuối cùng

Sau khi user thấy `exhausted=true` và UI disabled nút, nếu có user thứ 2 chạy `fetch-history` với batch lớn hơn và Zalo trả `more=true` — `exhausted` có thể flip lại `false`. Backend không reset tự động; UI chỉ refresh sau khi gọi lại `fetch-history` thành công.

### 3. Rate limit user thread chưa implement

Hiện guard chỉ có ở 400 response cho `threadType='user'`. Khi P5 land, cần enforce:
- 2s delay mỗi request/account
- 30 requests/hour/account
- Audit qua `zalo-rate-limiter` bucket `history_<accountId>`

---

## Tham chiếu

- Backend: [backend/src/modules/zalo/zalo-history-routes.ts](../backend/src/modules/zalo/zalo-history-routes.ts) (group fetch)
- Backend: [backend/src/modules/chat/chat-routes.ts](../backend/src/modules/chat/chat-routes.ts) line 175+ (cursor endpoint)
- Frontend: [frontend/src/components/chat/MessageThread.vue](../frontend/src/components/chat/MessageThread.vue) (banner)
- Frontend: [frontend/src/composables/use-chat.ts](../frontend/src/composables/use-chat.ts) (`loadMoreLocal`, `fetchHistoryFromZalo`)
- Plan gốc: [plans/260420-0631-chat-history-and-conversation-allowlist/phase-04-backend-group-history-fetch.md](../plans/260420-0631-chat-history-and-conversation-allowlist/phase-04-backend-group-history-fetch.md)
- Plan P5 R&D: [plans/260420-0631-chat-history-and-conversation-allowlist/phase-05-backend-user-history-rnd.md](../plans/260420-0631-chat-history-and-conversation-allowlist/phase-05-backend-user-history-rnd.md)
