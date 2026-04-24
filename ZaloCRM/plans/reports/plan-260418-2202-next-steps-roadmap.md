# ZaloCRM — Kế hoạch hành động tiếp theo

**Ngày:** 2026-04-18 22:02 (Asia/Saigon)
**Trạng thái dự án:** Dev, chưa có khách production. Dashboard chưa hoạt động. Chat thiếu tính năng media nâng cao.
**Nguyên tắc:** YAGNI/KISS/DRY. Fix trước — build sau. Mỗi sprint ≤ 5 ngày, có demo được.

---

## 0. Root causes vừa phát hiện (quan trọng — chưa có trong báo cáo trước)

### 0.1 Dashboard hoàn toàn không chạy → **bug shape mismatch BE↔FE**
BE (`backend/src/modules/dashboard/dashboard-routes.ts`) trả về:
```js
// message-volume: { data: [...] }
// pipeline:      { data: [{status, count}] }
// sources:       { data: [{source, count}] }
// appointments:  { data: [{status, count}] }
// kpi:           { messagesToday, ... }  ← không có bọc { data }
```
FE (`frontend/src/composables/use-dashboard.ts`) đọc:
```js
pipeline.value = pipRes.data;      // ← toàn bộ {data:[...]}, không unwrap
sources.value  = srcRes.data;      // ← sai, phải là srcRes.data.data
appointments   = aptRes.data;      // ← sai
messageVolume  = volRes.data.data || volRes.data;  // đúng nhờ fallback
```
Thêm nữa interface FE khai báo `_count: {_all: number}` nhưng BE đã flatten thành `count: number` → chart nhận object rỗng → render fail silently.

**⇒ 3 endpoint (pipeline/sources/appointments) không bao giờ render đúng trên FE.** Đây là lý do dashboard "không hoạt động", không phải do data thiếu.

### 0.2 Chat không gửi được ảnh/file/quote — **pipeline upload không tồn tại**
- `backend/src/modules/chat/chat-routes.ts:190-250` endpoint `POST .../messages` chỉ nhận JSON `{content: string}`, hardcode `contentType:'text'`.
- Không có route upload multipart (dù `@fastify/multipart` đã cài).
- Không có gọi `api.sendImage / sendFile / sendVoice / sendSticker` của zca-js.
- Không có field `quote` / `quotedMsgId` trong DB schema → không thể reply tin cụ thể.
- FE `MessageThread.vue` chỉ **hiển thị** ảnh/file đã nhận (parse từ `msg.content` JSON), nhưng **không có** input upload.

### 0.3 Chưa có test → mỗi fix là risk regression.

---

## 1. Sprint map (6 tuần)

| # | Sprint | Thời gian | Mục tiêu demo-able |
|---|--------|-----------|--------------------|
| S0 | Foundation | 2 ngày | Vitest + 5 smoke test + CI guard |
| S1 | Fix Dashboard | 2-3 ngày | 5 widget render đúng số thực |
| S2 | Chat Media v1 | 5 ngày | Gửi ảnh + file + sticker + quote reply |
| S3 | Per-conv ACL (L1) | 3 ngày | User chỉ thấy conv được assign |
| S4 | Historical backfill | 4 ngày | Kéo 500 msg cũ/conv khi connect |
| S5 | Dashboard hardening | 2 ngày | Index + cache + timezone đúng |
| S6 | Observability | 2 ngày | /health deep + Sentry + struct log |

**Tổng: ~21 ngày làm việc thực.** Mỗi sprint = 1 branch + 1 PR + 1 demo.

---

## 2. Chi tiết từng sprint

### S0 — Foundation (2 ngày) — LÀM TRƯỚC TẤT CẢ

**Tại sao trước?** Không có test = fix dashboard/chat sẽ break silent.

**Deliverables:**
- `backend/package.json`: thêm `vitest`, `supertest`, script `test`, `test:watch`.
- `backend/src/__tests__/smoke.test.ts`: 5 test
  1. `POST /api/v1/auth/login` → 200 + jwt.
  2. `GET /api/v1/zalo-accounts` (authed) → 200 + array.
  3. `GET /api/v1/conversations` (authed) → 200.
  4. `GET /api/v1/dashboard/kpi` → 200 + có các field KPI.
  5. `requireZaloAccess('read')` unit test với member không có access → 403.
- `frontend/package.json`: `vitest` + `@vue/test-utils`.
- `frontend/src/composables/__tests__/use-dashboard.test.ts`: mock axios, check shape parsing.
- `.github/workflows/test.yml` (nếu dùng GitHub) hoặc pre-commit hook.

**Exit criteria:** `npm test` chạy xanh cả BE+FE.

---

### S1 — Fix Dashboard (2-3 ngày) — ưu tiên #1

**Task 1.1 — Chuẩn hoá response shape (0.5 ngày)**
- File: `backend/src/modules/dashboard/dashboard-routes.ts`
- Thống nhất: **mọi endpoint trả `{ data: ... }`** (cả KPI).
- Pipeline/Sources/Appointments đã flatten `count` — giữ nguyên, sửa FE.

**Task 1.2 — Sửa FE composable & chart components (0.5 ngày)**
- File: `frontend/src/composables/use-dashboard.ts`
  - Unwrap `.data.data` nhất quán.
  - Đổi interface: `{status: string, count: number}` (bỏ `_count`).
- Files: `PipelineChart.vue`, `SourceChart.vue`, `AppointmentChart.vue`, `KpiCards.vue`
  - Đổi prop type + template binding `item.count` thay vì `item._count._all`.

**Task 1.3 — Empty state + error state (0.5 ngày)**
- Mỗi chart component: nếu `data.length === 0` → show "Chưa có dữ liệu".
- `fetchAll()` catch lỗi từng endpoint riêng (Promise.allSettled) → một lỗi không giết cả dashboard.

**Task 1.4 — Seed dev data (0.5 ngày)**
- `backend/prisma/seed.ts`: tạo 1 org + 3 user + 5 contact + 20 conv + 200 msg giả + 3 appointment. Để dev có data test.

**Task 1.5 — Test (0.5 ngày)**
- Unit test cho composable (mock response).
- Snapshot test cho mỗi chart với data thật từ seed.

**Exit criteria:** Mở `/dashboard` thấy đủ 5 widget, số khớp DB, empty state hoạt động.

---

### S2 — Chat Media v1 (5 ngày) — impact user rõ rệt nhất

**Task 2.1 — Schema migration (0.5 ngày)**
- `backend/prisma/schema.prisma`: thêm vào `Message`:
  ```prisma
  quotedMsgId  String?  @map("quoted_msg_id")
  quotedContent String? @map("quoted_content")  // snapshot để tránh phụ thuộc
  quotedSender String? @map("quoted_sender")
  ```
- Migration name: `add_message_quote_fields`.

**Task 2.2 — Backend upload pipeline (1.5 ngày)**
- File mới: `backend/src/modules/chat/upload-routes.ts`
  - `POST /api/v1/conversations/:id/upload` (multipart)
  - Validate: max 25MB, mime whitelist (image/*, video/mp4, audio/mpeg, application/pdf, msword, docx, excel).
  - Lưu tạm `uploads/tmp/<uuid>.<ext>`.
  - Trả `{ tempId, mime, size, filename }`.
- File mới: `backend/src/modules/chat/media-sender.ts`
  - Hàm `sendMedia(api, threadId, threadType, tempPath, mime)`:
    - image → `api.sendImage(path, threadId, type)`
    - file → `api.sendFile(path, threadId, type)`
    - voice → `api.sendVoice(path, threadId, type)` (nếu zca-js hỗ trợ — cần scout).
  - Dọn `tempPath` sau gửi.
- Sửa `chat-routes.ts POST .../messages` thêm param `tempId?` và `contentType?` — nếu có → gọi media-sender thay vì `sendMessage`.
- Rate limit: dùng lại `zalo-rate-limiter` với quota riêng cho media (khuyến nghị: 30 media/giờ/account).

**Task 2.3 — Quote/Reply (1 ngày)**
- Body có `quotedMsgId?`. Nếu có → query message đó → build `{quote: {...}}` param cho `api.sendMessage` (zca-js v2 có hỗ trợ qua TMessage / ttl — cần scout cụ thể).
- Lưu `quotedMsgId`, `quotedContent`, `quotedSender` vào `Message` mới.

**Task 2.4 — Frontend UI (1.5 ngày)**
- File: `frontend/src/components/chat/MessageInput.vue` (nếu chưa có, tách từ MessageThread).
  - Nút 📎 đính kèm → open file picker.
  - Preview trước khi gửi (ảnh thumbnail, file tên+size).
  - Emit `@send` với `{content, tempId?, quotedMsgId?}`.
- `MessageThread.vue`:
  - Click vào msg → nút "Trả lời" → set `quotedMsg` state → hiển thị mini-banner phía trên input.
  - Render `msg.quotedContent` trong bubble (giống Zalo).
- `use-chat.ts sendMessage`:
  - Nếu có file → upload trước (`POST /upload`) → nhận `tempId` → gửi message với `tempId`.

**Task 2.5 — Test + demo (0.5 ngày)**
- Smoke test: upload PNG 1MB → gửi → verify `contentType='image'` + msg xuất hiện.
- Demo: gửi ảnh, file PDF, reply quote.

**Out of scope S2:** voice recorder UI, sticker picker (để S2.1 sau), emoji picker nâng cao.

---

### S3 — Per-conversation ACL (L1) (3 ngày)

**Strategy:** Dùng `Contact.assignedUserId` có sẵn — **không thêm bảng mới**.

**Task 3.1 — Filter backend (1 ngày)**
- `chat-routes.ts GET /conversations`:
  - Thêm điều kiện: `OR: [{contact: {assignedUserId: user.id}}, {contact: null}]` cho role=member.
  - Owner/admin bypass.
- `GET /conversations/:id`: check tương tự, 403 nếu không match.
- `GET /conversations/:id/messages`: đã có `requireZaloAccess('read')`, thêm check assigned.

**Task 3.2 — Socket room refinement (0.5 ngày)**
- `zalo-socket.ts`: khi emit `chat:message`, thay vì broadcast `account:{id}` cho tất cả user có access Zalo account → emit vào room `user:{assignedUserId}` + `org-admin:{orgId}`.

**Task 3.3 — UI "Gán tôi" (1 ngày)**
- `ConversationList.vue`: filter chip "Của tôi" / "Tất cả" (chỉ admin thấy "Tất cả").
- `ChatContactPanel.vue`: dropdown "Phụ trách bởi" để admin gán lại.

**Task 3.4 — Test (0.5 ngày)**
- Test: user A gán conv X → user B không thấy conv X trong list → user B gọi `GET /conversations/X` → 403.

**L2/L3 defer** (bảng `ConversationAccess` + policy engine) — chỉ làm khi có khách lớn yêu cầu.

---

### S4 — Historical backfill (4 ngày)

**Task 4.1 — Scout zca-js API history user 1-1 (0.5 ngày)**
- File scout: `plans/reports/research-{date}-zca-js-history-api.md`
- Xác nhận: `api.getChatHistory(threadId, count, lastMsgId?)` có tồn tại? rate limit?
- Nếu không có → chỉ backfill được group; user 1-1 để cho `old_messages` tự lo.

**Task 4.2 — Backfill job (1.5 ngày)**
- File mới: `backend/src/modules/zalo/zalo-history-backfiller.ts`
- Trigger: gọi từ `zalo-pool.ts` sau khi login/reconnect thành công, **sau** `backfillOrphanedConversations`.
- Logic:
  1. Lấy N conversation gần đây nhất (LIMIT 50).
  2. Cho mỗi conv: vòng lặp `getChatHistory` đến khi đạt 500 msg hoặc `lastMsgId===null`.
  3. Throttle: 1 request / 2 giây / account (dùng `zalo-rate-limiter` thêm bucket `history`).
  4. Gọi `handleIncomingMessage` với `isBackfill: true` để skip automation.
  5. Lưu cột mới `Conversation.historyBackfilledAt` để không chạy lại.

**Task 4.3 — Schema (0.25 ngày)**
- `Conversation`: thêm `historyBackfilledAt DateTime?`, `firstSyncedMsgId String?`.

**Task 4.4 — UI "Tải thêm" (1 ngày)**
- `MessageThread.vue`: scroll lên đầu → trigger `loadMore(beforeMsgId)`.
- BE: `GET /conversations/:id/messages?before=<msgId>&limit=50` (đổi từ page-based sang cursor-based).

**Task 4.5 — Test + safety (0.75 ngày)**
- Integration test với zca-js mock.
- Kill switch: env `DISABLE_HISTORY_BACKFILL=true` để tắt khi Zalo ban risk.

---

### S5 — Dashboard hardening (2 ngày)

- **Index:** migration thêm `@@index([conversationId, sentAt])` cho Message; `@@index([orgId, status])` cho Contact.
- **Cache:** `lru-cache` 60s cho KPI, 300s cho message-volume. Key = `orgId + endpoint + query`.
- **Timezone:** thay hardcode `+7h` bằng `AT TIME ZONE 'Asia/Ho_Chi_Minh'` trong raw SQL.
- **Whitelist status:** enum `NEW/CONTACTED/INTERESTED/CONVERTED/LOST`.

### S6 — Observability (2 ngày)

- `/health` deep: check DB connect, pool instance count, queue depth.
- Pino structured log với `reqId`, `userId`, `orgId`.
- Sentry DSN env (optional, tắt nếu không cấu hình).
- Log rotation với pino-roll.

---

## 3. Backlog tạm gác (YAGNI)

- BullMQ migration → đợi có > 3 account cùng lúc & cron conflict xuất hiện.
- AI streaming → đợi khách thực xài AI.
- Multi-region / HA pool → đợi có SLA.
- ConversationAccess L2 → đợi khách >5 user/org.
- pgvector RAG, marketplace integration → Chặng C cũ.
- ZOA migration → nghiên cứu song song, không block.

---

## 4. Quy tắc làm việc

1. **1 sprint = 1 feature branch** `feat/s{N}-{slug}` → PR → merge main.
2. Mỗi PR phải có: test xanh + ít nhất 1 screenshot demo + update `CHANGELOG.md`.
3. Không viết code nếu chưa có test trước (từ S2 trở đi — TDD).
4. Không thêm dependency mới mà không note lý do vào PR description.
5. Schema migration phải có name mô tả (`add_*`, `fix_*`), không `db push` trực tiếp.
6. Commit message conventional: `fix(dashboard): unwrap data envelope`, `feat(chat): image upload`.

---

## 5. Bắt đầu từ đâu ngay HÔM NAY

**Step 1 (30 phút):** mở `use-dashboard.ts` + 4 chart component, fix shape mismatch → dashboard chạy ngay — không cần đợi S0.

**Step 2 (2 giờ):** setup Vitest + 3 smoke test → S0 xong.

**Step 3:** vào S2 (Chat Media) — tác động user nhìn thấy rõ nhất.

S3/S4/S5/S6 chạy tuần tự.

---

## Câu hỏi chưa giải đáp

- Voice message: có cần trong S2 v1 hay tách S2.1?
- Giới hạn file upload: 25MB có phù hợp hạ tầng hiện tại không (Fastify body limit, disk free, bandwidth)?
- Backfill 500 msg/conv × 50 conv × N account = bao nhiêu request/phút — cần benchmark zca-js rate ceiling thực tế trước khi bật mặc định.
- Có dùng object storage (S3/R2/MinIO) cho attachments không, hay lưu local disk `uploads/`? Ảnh hưởng backup + scale.
- Sticker picker: lấy sticker list từ zca-js hay hardcode set?
- Seed data: số lượng giả lập bao nhiêu cho đủ "thật" khi demo? (gợi ý 20 conv + 500 msg).
