# Research — Lịch sử chat trước khi login & Kiểm soát hội thoại hiển thị

**Ngày:** 2026-04-20 02:47 (Asia/Saigon)
**Phạm vi:** ZaloCRM v2.1, backend (Fastify + zca-js + Prisma) + frontend (Vue 3)
**Liên quan code:** `backend/src/modules/zalo/*`, `backend/src/modules/chat/*`, `backend/prisma/schema.prisma`, `frontend/src/views/ChatView.vue`

---

## 1. Vấn đề user nêu

1. **Không có lịch sử chat trước thời điểm login Zalo vào CRM** — đoạn chat chỉ xuất hiện kể từ khi `loginQR` / `reconnect` thành công.
2. **Không kiểm soát được tin nhắn của ai sẽ hiện lên CRM** — mọi hội thoại (cá nhân + nhóm) đều bị tự ingest → nhiễu, lộ tin nhắn riêng tư của chủ tài khoản Zalo.
3. **Vấn đề khác phát hiện thêm** — xem mục 5.

---

## 2. Cơ chế ingest hiện tại (đã đọc code)

| Nguồn dữ liệu | File | Cơ chế |
|---|---|---|
| Tin realtime mới | `zalo-listener-factory.ts` `listener.on('message')` | Mọi message → `handleIncomingMessage` → tạo conversation + contact + persist |
| Tin "miss" khi reconnect | `zalo-listener-factory.ts` `listener.on('old_messages')` | Do zca-js phát ra (≈50 tin gần nhất quanh thời điểm mất kết nối). KHÔNG phải lịch sử lâu dài |
| Backfill nhóm | `zalo-message-sync.ts` `syncGroupMessages()` | Polling mỗi 5 phút, gọi `api.getGroupChatHistory(groupId, 50)` cho 20 nhóm active gần nhất |
| Sync friend → contact | `zalo-sync-routes.ts` POST `/api/v1/zalo-accounts/:id/sync-contacts` | `api.getAllFriends()`, tạo `Contact`, link orphan conversation |

**Kết luận quan trọng về giới hạn zca-js:**

- **`getGroupChatHistory(groupId, count)`** — CÓ, hỗ trợ kéo lịch sử nhóm.
- **KHÔNG có** API tương đương `getUserChatHistory` cho hội thoại 1-1 trong toàn bộ danh sách `src/apis/` (đã verify với endpoint Github contents). Nguồn duy nhất cho tin 1-1 cũ là sự kiện `old_messages` mà Zalo server tự push khi reconnect — rất hạn chế (~vài chục tin gần nhất, không paginate được, server quyết định window).
- Có `getArchivedChatList()` → trả về danh sách hội thoại đã archive (metadata, không nội dung).
- Có `getHiddenConversations()`, `getPinConversations()` → có thể dùng để biết user pin/ẩn hội thoại nào.
- Có `getAllFriends()`, `getAllGroups()` → liệt kê threadId để build allowlist.

**Hệ quả:** vấn đề (1) chỉ giải quyết được **một phần** cho hội thoại nhóm. Với hội thoại 1-1, không thể "lấy về toàn bộ history" trước khi login — chỉ có thể kéo dần qua `old_messages` mỗi lần Zalo server phát.

---

## 3. Hướng giải quyết — Vấn đề (1): Lịch sử chat

### 3.1. Hội thoại nhóm — KHẢ THI rộng

Mở rộng `zalo-message-sync.ts`:

- Thêm endpoint **`POST /api/v1/zalo-accounts/:id/sync-history?threadId=...&depth=N`** chạy on-demand (user click "Tải lịch sử").
- `getGroupChatHistory` hỗ trợ `count` lớn hơn (mặc định 50 nhưng có thể request 200–500). Backfill theo batch.
- Pagination bằng cách dùng `lastActionId` từ response (xem `getGroupChatHistory.ts` types: `lastActionId`, `more`) → loop kéo cho tới `more === 0` hoặc đạt depth.
- Dedup vẫn dựa trên unique `(conversationId, zaloMsgId)` đã có.

### 3.2. Hội thoại 1-1 — KHÔNG khả thi qua zca-js public API

Hai lựa chọn thực tế:

**A. "Best-effort" backfill bằng `old_messages`**

- Khi login lần đầu, zca-js sẽ nhận `old_messages` với type=0 (user). Đã handle ở listener.
- Cải tiến: lưu `firstSeenAt` cho mỗi conversation; UI hiện banner "Lịch sử trước [ngày X] không có sẵn" để user hiểu lý do.

**B. Document tự thân + xuất Zalo data (manual)**

- Hướng dẫn user export lịch sử Zalo bằng tính năng "Sao lưu trò chuyện" của app Zalo → import file vào CRM (parse JSON/SQLite tuỳ định dạng).
- Đây là roadmap dài, không nên làm trong sprint này.

**C. Custom endpoint qua `api.custom()`** (nâng cao, rủi ro)

- zca-js export `customFactory` cho phép gọi tuỳ ý endpoint Zalo Web internal.
- Reverse-engineer endpoint `/api/conversation/recentmsg` hoặc `/api/message/getmsgs` từ Zalo Web. **Rủi ro cao**: Zalo có thể đổi endpoint, dễ block account, vi phạm ToS thêm. **Không khuyến nghị** trong sprint đầu — để dành phase sau nếu user mạnh dạn.

**Khuyến nghị:** chọn **A** trước. Tài liệu hoá rõ giới hạn cho user. Group dùng 3.1.

---

## 4. Hướng giải quyết — Vấn đề (2): Allowlist hội thoại hiển thị

### 4.1. Mô hình dữ liệu

Hiện trạng: `Conversation.tab` chỉ có `main`/`other` (v2.1). Không có khái niệm "không hiển thị".

Đề xuất mở rộng (additive, không phá schema):

```prisma
model Conversation {
  ...
  visibility      String   @default("visible") @map("visibility")
  // visible | hidden | pending  (pending = chưa duyệt, mặc định cho thread mới)
  isPinned        Boolean  @default(false) @map("is_pinned")
  hiddenAt        DateTime? @map("hidden_at")
  hiddenByUserId  String?  @map("hidden_by_user_id")
  @@index([orgId, visibility, lastMessageAt])
}

model ZaloAccount {
  ...
  ingestPolicy    String   @default("allowlist") @map("ingest_policy")
  // allowlist | denylist | all
  // allowlist (đề xuất default mới): chỉ thread nằm trong ConversationAllowlist mới được persist
  // denylist: persist tất, trừ thread bị ẩn
  // all: behavior cũ
}

// Bảng config danh sách contact/group được phép sync per account
model ZaloThreadAllowlist {
  id              String   @id @default(uuid())
  zaloAccountId   String   @map("zalo_account_id")
  externalThreadId String  @map("external_thread_id")
  threadType      String   // user | group
  enabled         Boolean  @default(true)
  addedByUserId   String   @map("added_by_user_id")
  createdAt       DateTime @default(now())
  @@unique([zaloAccountId, externalThreadId])
  @@index([zaloAccountId, enabled])
  @@map("zalo_thread_allowlist")
}
```

### 4.2. Logic ingest — sửa `handleIncomingMessage`

Trước khi `findOrCreateConversation`, kiểm tra:

```ts
const policy = await getIngestPolicy(msg.accountId); // cache 60s
if (policy === 'allowlist') {
  const allowed = await isThreadAllowed(msg.accountId, msg.threadId);
  if (!allowed) {
    // Tuỳ chọn: vẫn tạo conversation với visibility='pending'
    // để user có UI duyệt; HOẶC drop hẳn không persist
    return null;
  }
}
```

Giữ thêm nhánh `visibility='pending'` cho phép user thấy "Hội thoại chờ duyệt" → bấm Duyệt → chuyển `visible` + add allowlist; bấm Bỏ qua → `hidden` + add denylist.

### 4.3. Backfill / Migration cho dữ liệu cũ

- Migration set tất cả `Conversation.visibility = 'visible'` để không phá hành vi cho user cũ.
- Default `ZaloAccount.ingestPolicy = 'all'` để backward-compat. User vào Settings tự đổi sang `allowlist`.

### 4.4. UI / UX (frontend)

- **Trang "Quản lý hội thoại Zalo"** mới (hoặc tab trong `ZaloAccountsView`):
  - Danh sách friend (`getAllFriends` đã có) + danh sách group (`getAllGroups`) với checkbox "Hiển thị trong CRM".
  - Bulk action: chọn tất / bỏ chọn tất / đảo chọn.
  - Lọc theo: đã có hội thoại trong CRM / chưa có / được pin trên Zalo (`getPinConversations`).
- **ChatView**: thêm filter "Đang chờ duyệt" trong filter panel hiện tại (chỉ hiện khi có ≥1 conversation pending).
- **Right-click menu** trên conversation list: thêm "Ẩn khỏi CRM" / "Thêm vào danh sách bỏ qua".

### 4.5. Điều kiện chuyển sang allowlist mặc định

Khi user lần đầu bật `allowlist`, CRM cần wizard:

1. Hiển thị toàn bộ contact/group đang có conversation trong CRM.
2. Cho user chọn cái nào giữ. Mặc định tick những conversation có `lastMessageAt` trong 30 ngày.
3. Apply: xoá / ẩn (`visibility='hidden'`) các conversation không tick. **Khuyến nghị ẩn thay vì xoá** để dữ liệu lịch sử (phục vụ analytics) còn nguyên.

---

## 5. Vấn đề khác phát hiện trong code

| # | Vấn đề | File | Mức độ |
|---|---|---|---|
| a | `selfListen=true` luôn bật → mọi tin user gửi từ điện thoại Zalo cá nhân vào CRM, không phân biệt được | `zalo-pool.ts:51,124` | High — trộn việc cá nhân/CRM |
| b | `upsertContact` luôn tạo contact mới cho mọi UID lạ, không có hàng rào → contact pollution | `message-handler.ts:240` | High — sẽ bùng dữ liệu khi v2.x scale |
| c | Group được lưu thành `Contact` với `metadata.isGroup=true` — gây nhập nhằng ở module CRM (Pipeline / Lead score chạy cả vào group) | `message-handler.ts:202-228` | Med — nên tách `Group` model riêng |
| d | `runAutomationRules` chạy luôn cho mọi tin trừ backfill → nếu allowlist drop tin, automation cũng dừng theo (đúng); nhưng cần đảm bảo `pending` tin không trigger | `message-handler.ts:169` | Med |
| e | Sync nhóm cố định 20 nhóm × 50 tin × 5 phút — sẽ chạm rate limit khi org có nhiều nhóm | `zalo-message-sync.ts:13-15` | Med |
| f | Không có endpoint "Force resync history" exposed cho user | — | Med |
| g | Không phân quyền ai được duyệt allowlist (chỉ owner/admin? hay member sở hữu Zalo account?) | — | Cần quyết |
| h | `ZaloAccountAccess` đã có `permission` (read/chat/admin) nhưng allowlist không tận dụng — member có quyền `chat` nên có quyền duyệt? | `zalo-access-middleware.ts` | Cần quyết |

---

## 6. Đề xuất phase plan (tóm tắt)

| Phase | Nội dung | Effort |
|---|---|---|
| P1 | Schema migration: `Conversation.visibility`, `ZaloAccount.ingestPolicy`, `ZaloThreadAllowlist` table | S |
| P2 | Backend: enforce allowlist trong `message-handler.ts`; CRUD allowlist endpoints | M |
| P3 | Backend: endpoint on-demand `getGroupChatHistory` paginated; cải tiến `zalo-message-sync.ts` cho 1-1 dùng `old_messages` opportunistically | M |
| P4 | Frontend: trang quản lý hội thoại + checkbox chọn từ `getAllFriends/getAllGroups` | M |
| P5 | Frontend: nhánh "Pending" trong ChatView, banner "Lịch sử trước ngày X không có sẵn" | S |
| P6 | Wizard chuyển sang allowlist khi user bật policy lần đầu | S |
| P7 | Docs + migration guide cho user hiện hữu (`docs/feature-conversation-allowlist.md`) | S |

---

## 7. Câu hỏi chưa giải quyết (cần user chốt)

1. Khi `ingestPolicy=allowlist`, tin từ thread chưa duyệt → **drop hẳn** hay **lưu pending**? (Mặc định đề xuất: pending để khỏi mất tin quan trọng do user quên duyệt.)
2. Default policy cho **account mới đăng nhập** từ giờ trở đi → `allowlist` (an toàn) hay vẫn `all` (giữ behavior cũ)? Đề xuất: hiện wizard ngay sau loginQR hỏi user.
3. **Group**: có muốn tách hẳn ra `Group` model thay vì gắn `metadata.isGroup` trong `Contact` không? (Refactor lớn — có thể để v2.3.)
4. Quyền duyệt allowlist: owner/admin only, hay member-có-quyền-`chat` cũng được?
5. Lịch sử nhóm: backfill bao sâu? 200, 500, 2000 tin? Có cần limit theo thời gian (vd ≤90 ngày) để tránh DB phình to?
6. Có muốn investigate hướng `api.custom()` reverse-engineer endpoint user history không? (rủi ro Zalo block account)

---

**Status:** DONE
**Summary:** Đã map cơ chế ingest hiện tại, xác nhận giới hạn zca-js (không có user chat history API), đề xuất allowlist + visibility model + wizard, liệt kê 8 vấn đề phụ và 7 phase plan.
**Concerns:** Hướng giải quyết hoàn chỉnh cho 1-1 history bị giới hạn bởi Zalo SDK — chỉ best-effort qua `old_messages`. Cần user chốt 6 câu hỏi trước khi viết plan chi tiết.
