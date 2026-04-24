# Phase 7 — Frontend ChatView: Pending Tab + Load More History

**Priority:** P0
**Status:** TODO
**Effort:** M (~4h)
**Depends:** Phase 2 (visibility), Phase 4 (group history endpoint), Phase 5 (1-1 history endpoint)

## Context Links
- File chính: `frontend/src/views/ChatView.vue` (187 LOC), `frontend/src/views/MobileChatView.vue` (117 LOC)
- API: `GET /conversations?visibility=pending`, `POST /conversations/:id/fetch-history`, `POST /conversations/:id/approve|reject`

## Tasks

### 1. Pending tab trong ChatView

Sidebar conversation list — thêm tab thứ 3 sau "Chính" và "Khác":

```
[Chính] [Khác] [Chờ duyệt (5)]
```

`Chờ duyệt` chỉ hiện khi count > 0. Click → load `?visibility=pending`. Mỗi conversation có 2 nút inline: ✓ Duyệt — ✗ Bỏ qua.

### 2. Load More History button

Trong message panel (top), thêm:

```
┌────────────────────────────────────────────┐
│  ⏳ Lịch sử trước [01/03/2026] chưa sync   │
│  [↑ Tải thêm 50 tin cũ hơn]               │
└────────────────────────────────────────────┘
```

- Hiện khi `conversation.historyExhausted === false`
- Click → `POST /conversations/:id/fetch-history` với `{ batchSize: 50, maxBatches: 1 }`
- Sau khi response: prepend tin mới vào messages list, scroll position giữ nguyên (không nhảy)
- Disable nút khi `exhausted === true`, hiện text "Đã tải hết lịch sử khả dụng"

### 3. Banner cảnh báo cho 1-1 conversation

Khi conversation là 1-1 và `oldestMessageAt > [account.lastConnectedAt - 1 day]` (tức là chưa kéo được lịch sử trước login):

```
ℹ️ Lịch sử trước khi kết nối Zalo có thể không khả dụng.
   [Thử tải lịch sử cũ hơn] (gọi endpoint fetch-history)
```

Nếu phase 5 R&D fail → text đổi: "Lịch sử trước khi kết nối không thể fetch được do giới hạn Zalo."

### 4. Counts query cập nhật pending

Hook đã có gọi `GET /conversations/counts` → render thêm badge số pending trên tab.

### 5. MobileChatView mirror logic

Copy pending tab + load more sang mobile. Nếu logic to → extract composable `useConversationActions.ts`.

## Implementation Steps

1. Sửa `ChatView.vue` thêm tab pending, action buttons inline
2. Thêm load-more banner top of messages panel
3. Composable `useConversationActions.ts` (approve, reject, fetchHistory) để dùng chung mobile/desktop
4. API client: `frontend/src/api/conversations.ts` — add `approveConv`, `rejectConv`, `fetchHistory`
5. Update `MobileChatView.vue` dùng composable
6. Build check + manual test

## Todo

- [ ] Composable `useConversationActions.ts`
- [ ] API client mở rộng
- [ ] ChatView tab pending + counts badge
- [ ] ChatView load-more banner
- [ ] ChatView 1-1 history warning banner
- [ ] MobileChatView mirror
- [ ] Build check
- [ ] Manual test full flow

## Success Criteria

- Pending tab xuất hiện khi có pending conversation
- Approve → conversation sang main tab, ingest tin tiếp theo bình thường
- Reject → conversation hidden, không hiện ở đâu nữa (trừ khi user bật filter "Đã ẩn")
- Load more group: 50 tin cũ được prepend, scroll giữ nguyên
- Load more 1-1: hoạt động nếu phase 5 pass; graceful disabled nếu fail

## Risks

- Scroll position không giữ nguyên khi prepend → dùng kỹ thuật `scrollTop = newHeight - oldHeight` sau nextTick
- Message dedup: backend đã handle, frontend không cần lo, nhưng cần re-sort theo sentAt asc khi prepend

## Next Steps

→ Phase 8 (wizard)
