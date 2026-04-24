# Zalo OA publish — known limitation (v1)

## Tóm tắt

Workflow `02 — Content Publish Scheduler v1` **không tự động broadcast nội dung
lên Zalo OA** trong phiên bản hiện tại. Khi một draft có `platform = 'zalo_oa'`
đến lịch đăng, scheduler sẽ:

1. Chạy node `Zalo OA — manual broadcast stub` (Code node).
2. Emit một "lỗi" có cấu trúc: `{ error: { code: 'MANUAL_BROADCAST_REQUIRED', … }, statusCode: 501 }`.
3. `Normalize response` phân loại thành `outcome='manual_required'` (tách hẳn khỏi
   `outcome='failed'`) dựa trên whitelist `MANUAL_CODES`.
4. `Log + mark outcome` mark draft `status='manual_required'` và ghi
   `publish_log.status='manual_required'` — **không** đếm vào failure rate.
5. `Route by outcome` bắn Telegram notice "Manual broadcast required" kèm SQL
   snippet để editor cập nhật sau khi broadcast thủ công.

Editor xử lý thủ công: mở Zalo Business dashboard, copy nội dung từ
`content.drafts.body` và broadcast. Sau khi broadcast xong, có thể chạy:

```sql
UPDATE content.drafts
SET status = 'published',
    published_at = now(),
    external_id = '<id hiển thị trong Zalo Business nếu có>',
    reject_reason = NULL
WHERE id = '<draft-id>';
```

## Tại sao không auto-publish?

Có ba lớp vấn đề:

1. **ZaloCRM public API không có endpoint broadcast.**
   `POST /api/public/messages/send` chỉ gửi text vào một thread đã tồn tại:
   `{ zaloAccountId, threadId, content }`. Không có API bắn message tới toàn
   bộ follower của OA.

2. **Zalo OpenAPI broadcast có nhiều rào cản chính sách.**
   Các endpoint broadcast thực sự (`message/promotion`, `broadcast/message`)
   yêu cầu:
   - OA đã được xác minh Zalo Business.
   - Template tin nhắn pre-approved bởi Zalo.
   - Một `ZALO_OA_ACCESS_TOKEN` riêng (khác `zca-js` cookie đang dùng cho chat
     cá nhân), và token này phải được refresh định kỳ qua OAuth của Zalo OA.
   - Một số kiểu tin nhắn chỉ cho phép bắn trong khung thời gian nhất định
     (ví dụ trong 48h sau khi user tương tác).

3. **Workflow 06 đã loại bỏ `zalo_oa` khỏi plan fan-out mặc định.**
   Nghĩa là trừ khi editor hoặc một workflow khác chủ động tạo draft
   `platform='zalo_oa'`, scheduler sẽ không bao giờ gặp branch này trong
   vòng đời bình thường. Branch stub tồn tại chủ yếu để ĐÚC thực trạng thay
   vì để draft kẹt vĩnh viễn ở `scheduled`.

## Cần gì để bật auto-broadcast thật?

Trước khi coi đây là tính năng "đầy đủ", cần chuẩn bị:

- [ ] Tài khoản Zalo OA đã verify Zalo Business.
- [ ] Đăng ký app Zalo OA để có `app_id` + `secret_key`.
- [ ] OAuth flow lấy `access_token` + `refresh_token`, lưu trong ZaloCRM hoặc
      secrets manager (không hard-code trong `.env`).
- [ ] Quy trình refresh token tự động trước khi hết hạn (khoảng 1h).
- [ ] Chọn rõ loại tin nhắn: `promotion`, `transaction`, hay
      `article` (post bài lên OA wall). Template phải được Zalo duyệt trước.
- [ ] Quota/rate limit của Zalo OA (mặc định ~100 tin/giây, nhưng cần confirm
      lại với plan đang dùng).

Khi đã sẵn sàng, thay node `Zalo OA — manual broadcast stub` bằng một
`HTTP Request` gọi endpoint thực, và thêm `zalo_oa` trở lại mảng `platforms`
trong workflow `06 — Content Fan-out Multi-platform v3`.

## Ảnh hưởng đến báo cáo chi phí / dashboard (đã xử lý ở vòng U)

- `content.publish_log` nay có `status='manual_required'` riêng. Các hành vi
  thay đổi so với vòng T:
  - `content_publish_success_ratio` (Grafana gauge) chỉ tính các hàng
    `status IN ('success','failed','retrying')` → Zalo OA không kéo ratio
    xuống dù có hàng trăm draft chờ broadcast thủ công.
  - Thêm metric `content_manual_required_24h` để dashboard có panel riêng cho
    backlog manual.
  - Workflow `09 — Monthly Cost Review` báo cáo `automated_attempts /
    successes / failures / manual_required` tách biệt, editor thấy ngay
    khối lượng công việc thủ công phải làm.
- `content.drafts.status='manual_required'` là terminal state của v1. Khi
  editor broadcast xong, họ chạy SQL snippet ở phần "Tóm tắt" để flip sang
  `published`.

Nếu Zalo OA được tự động hoá (xem phần "Cần gì để bật auto-broadcast thật"),
chỉ cần xoá entry `MANUAL_BROADCAST_REQUIRED` khỏi `MANUAL_CODES` set trong
node `Normalize response` là nhánh sẽ quay về luồng `success`/`failed` bình
thường mà không đụng schema.
