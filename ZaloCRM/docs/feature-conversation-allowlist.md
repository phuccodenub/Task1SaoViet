# Allowlist hội thoại (v2.2)

**Mục đích:** cho phép chủ tài khoản Zalo chọn *hội thoại nào được đồng bộ vào CRM* thay vì ingest toàn bộ. Tin từ hội thoại chưa chọn vẫn được lưu ở trạng thái "chờ duyệt" (không mất dữ liệu), không kích hoạt automation/webhook cho tới khi được duyệt.

Tham chiếu kiến trúc: [ADR-001: Default ingest policy](../backend/docs/adr-001-default-ingest-policy.md).

---

## Khái niệm

| Thuật ngữ | Ý nghĩa |
|---|---|
| `ingestPolicy = 'all'` | Mặc định kế thừa từ v2.1. Mọi hội thoại mới → `visibility='visible'`, chạy full pipeline (contact.created webhook, message webhook, automation). |
| `ingestPolicy = 'allowlist'` | Chế độ chọn lọc. Tin từ thread **không có** trong `ZaloThreadAllowlist` → conversation mới được tạo với `visibility='pending'`. Tin vẫn được persist nhưng KHÔNG bắn webhook/automation. |
| `visibility = 'visible'` | Hiển thị bình thường trong ChatView tab Chính/Khác. |
| `visibility = 'pending'` | Nằm trong tab "Chờ duyệt" ở ChatView. User bấm Duyệt → chuyển `visible` + thêm vào allowlist. Bấm Bỏ qua → `visibility='hidden'`. |
| `visibility = 'hidden'` | Đã bị user từ chối. Không xuất hiện trong UI mặc định, nhưng dữ liệu vẫn còn trong DB để phục vụ analytics / audit. |

> Default cho account mới là `'all'` (backward-compat), **không** phải `'allowlist'`. Lý do chi tiết xem ADR-001.

---

## Luồng người dùng

### 1. Sau khi kết nối Zalo mới (QR login lần đầu)

Sau sự kiện `zalo:connected`, hệ thống kiểm tra `localStorage` flag `zalocrm:wizard-shown:<accountId>`. Nếu chưa có, mở **`AllowlistWizardDialog`** 3 bước:

1. **Chọn chính sách** — radio "Chỉ đồng bộ hội thoại tôi chọn" (khuyến nghị) hay "Đồng bộ tất cả".
2. **(Nếu chọn allowlist)** — tick bạn bè / nhóm muốn sync. Mặc định tick những thread đã có conversation visible trong CRM + thread đã có trong allowlist (enabled).
3. **Xác nhận** — wizard gọi `PATCH /api/v1/zalo-accounts/:id/ingest-policy` rồi `POST /api/v1/zalo-accounts/:id/allowlist/bulk` với `add` entries.

Wizard có thể mở lại thủ công qua nút hình mũ phù thủy trong hàng tài khoản ở `/zalo-accounts`.

### 2. Duyệt / từ chối hội thoại chờ

Khi `ingestPolicy='allowlist'`, tab **"Chờ duyệt (N)"** xuất hiện trong `ChatView` khi có ít nhất 1 pending conversation. Mỗi dòng có 2 nút inline:

- **✓ Duyệt** — gọi `POST /api/v1/conversations/:id/approve`. Backend: flip `visibility='visible'`, upsert allowlist entry (enabled=true), invalidate 2 cache.
- **✗ Bỏ qua** — gọi `POST /api/v1/conversations/:id/reject`. Backend: flip `visibility='hidden'`, KHÔNG thêm allowlist (để user còn cơ hội đổi ý nếu tin từ thread đó đến sau).

Có thể duyệt hàng loạt ở trang `/zalo-accounts/:id/allowlist`.

### 3. Quản lý allowlist thường xuyên

Route `/zalo-accounts/:id/allowlist` có 3 tab:

- **Bạn bè** — list từ `getAllFriends` Zalo SDK, checkbox để thêm/bỏ. 5 phút cache server-side.
- **Nhóm** — list từ `getAllGroups` SDK.
- **Chờ duyệt** — cards pending conversation của account này, duyệt/từ chối từng cái.

Nút **"Lưu thay đổi"** tính diff (selected − initial = add, initial − selected = remove), gọi `POST /allowlist/bulk` 1 lần. Khi remove, backend tự cascade flip các conversation `visible` sang `hidden` để dừng ingest — xem Fix #6 trong round 1.

---

## Permission model

| Thao tác | Yêu cầu |
|---|---|
| Xem allowlist + available threads | `requireZaloAccess('chat')` trên account |
| Add / remove / enable / disable entry | `requireZaloAccess('chat')` |
| Duyệt / từ chối conversation | `requireZaloAccess('chat')` |
| Đổi `ingestPolicy` (all ↔ allowlist) | `requireRole('owner', 'admin')` |

Lý do đổi policy cần role cao: đây là quyết định cấp org — ảnh hưởng mọi integration đang dùng webhook. Xem [pr-split-plan-260423-0908.md](../backend/plans/reports/pr-split-plan-260423-0908.md).

---

## API reference

Chi tiết đầy đủ trong `backend/src/modules/zalo/zalo-allowlist-routes.ts`.

| Method | Path | Permission | Ghi chú |
|---|---|---|---|
| GET | `/api/v1/zalo-accounts/:id/allowlist` | chat | Trả `{ policy, items: [...] }` |
| PATCH | `/api/v1/zalo-accounts/:id/ingest-policy` | owner/admin | Body `{ policy: 'all' \| 'allowlist' }` |
| POST | `/api/v1/zalo-accounts/:id/allowlist/bulk` | chat | Tối đa 500 ops/request. Body `{ add?, remove?, enable?, disable? }`. |
| POST | `/api/v1/conversations/:id/approve` | chat | Duyệt pending conversation. |
| POST | `/api/v1/conversations/:id/reject` | chat | Từ chối → hidden. |
| GET | `/api/v1/zalo-accounts/:id/available-threads` | chat | Live friends + groups, cache 5 phút/account, annotated `inAllowlist`/`hasConversation`/`conversationVisibility`. |

**Cache note:** mọi mutation → invalidate `allowlist-cache` (60s TTL, hot path message-handler) VÀ `thread-listing-cache` (5 phút TTL, UI `/available-threads`). User sẽ thấy state mới trong cùng 1 request, không phải chờ TTL.

---

## Kịch bản migration từ v2.1

Khi deploy v2.2:

1. Schema migration thêm cột `visibility`, `ingest_policy`, bảng `zalo_thread_allowlist` — **idempotent** (`IF NOT EXISTS`), default giá trị an toàn.
2. Mọi row cũ nhận `visibility='visible'`, mọi account cũ nhận `ingestPolicy='all'` → hành vi v2.1 giữ nguyên.
3. Không có webhook / automation nào bị im lặng.

Xem [migration-v2.1-to-v2.2.md](./migration-v2.1-to-v2.2.md) cho hướng dẫn triển khai.

---

## Giới hạn đã biết

1. **Pending không thể realtime cross-account.** Pending envelope qua socket sau Fix #19 chỉ carry `{accountId, visibility}` — member không có `ZaloAccountAccess` cho account X sẽ không nhận được pending event của X. UI compensate bằng REST poll `/conversations/counts` mỗi khi vào `/chat` hoặc sau mỗi mutation.
2. **Existing visible conversation không tự đổi sang pending khi policy flip.** Flip `'all' → 'allowlist'` chỉ ảnh hưởng conversation MỚI tạo sau đó. Conversation cũ giữ `visibility` hiện tại. Bulk untick trong allowlist UI → cascade sang `hidden` thì có (Fix #6 Round 1).
3. **Group vs user thread.** Allowlist lưu `threadType` nhưng cùng bảng `zalo_thread_allowlist`; không tách model `Group` vì phạm vi v2.2.
