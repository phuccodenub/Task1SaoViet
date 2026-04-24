# State machine `content.items` sau vòng Y

_Ghi chú: tài liệu này được tạo ở vòng Codex review #3 (fix S2 + S3) để làm rõ
luồng items giữa workflow 01 / 06 / 08. Nếu sau này thay đổi state, nhớ cập
nhật `scripts/02-content-schema.sql` (comment enum) + `smoke-test-schema.sql`
cùng lúc._

## 1. Trạng thái và transition

```
                    (RSS / Atom)                 (Guardrail duyệt?)
ingested  ──── workflow 01 ───▶ enriched ─────┬─▶ fanning_out  ── WF 06 ──▶ drafted
                                              │                            (per-platform)
                                              └─▶ batch_rewriting ─ WF 08 ▶ drafted
                                                                           (variant batch-v1)
                     │
                     └─▶ filtered   (guardrail từ chối, dừng hẳn)

drafted ── WF 06 push Google Sheets ───▶ (editorial verdict) ──▶ approved
                                                                 │
                                                         (scheduled_at reached)
                                                                 ▼
                                           WF 02 ──▶ published   (thành công)
                                              │
                                              └─▶ failed         (retry sau)
```

### Ý nghĩa từng trạng thái `content.items.status`

| Trạng thái        | Ai set                   | Ý nghĩa                                                                                           |
| ----------------- | ------------------------ | ------------------------------------------------------------------------------------------------- |
| `ingested`        | WF 01 bước Insert item   | Mới chui qua dedupe, chưa chạy guardrail.                                                         |
| `filtered`        | WF 01 bước Mark filtered | Guardrail loại (ví dụ clickbait, mismatch claim).                                                 |
| `enriched`        | WF 01 bước Mark enriched | Guardrail duyệt; **đang chờ** WF 06 hoặc WF 08 claim.                                             |
| `fanning_out`     | WF 06 claim              | Đang rewrite + QA + draft per-platform. Transitional, không ai khác được đụng.                    |
| `batch_rewriting` | WF 08 claim              | Đang batch rewrite 5 item/1 LLM call. Transitional, không ai khác được đụng.                      |
| `drafted`         | WF 06 hoặc WF 08         | Đã tạo draft editor-visible: WF06 yêu cầu đủ planned platform có `queued_at IS NOT NULL`; WF08 yêu cầu draft `batch-v1` có `queued_at IS NOT NULL`. |
| `failed`          | Tương lai / manual       | Dự phòng cho lỗi ingest không phục hồi (chưa có workflow tự set).                                  |

### Ý nghĩa từng trạng thái `content.drafts.status`

- `pending_review`: WF 06/08 vừa tạo, đang chờ verdict Google Sheets.
- `approved`: editorial duyệt; WF 03 đẩy về khi `verdict=approved`.
- `rejected`: editorial từ chối; `reject_reason` ghi lý do.
- `scheduled`: WF 02 đã claim, sắp publish.
- `published`: WF 02 publish thành công; `external_id` có giá trị, `published_at` set.
- `failed`: WF 02 publish lỗi thực sự (HTTP 4xx/5xx của API nền tảng). Xem `publish_log.error_message`.
- `manual_required`: kênh chưa được tự động hoá (hiện tại: Zalo OA). WF 02 nhận ra
  qua `error.code = 'MANUAL_BROADCAST_REQUIRED'`, log vào `publish_log` với
  `status='manual_required'`. **Không đếm vào failure metrics.** Editor broadcast
  thủ công xong thì chạy `UPDATE content.drafts SET status='published',
  external_id=<post_id> WHERE id=...`.

## 2. Vì sao tách `enriched` khỏi `ingested`?

Codex review #3 chỉ ra: vòng trước WF 01 đang tự rewrite + draft riêng
Facebook rồi mark `drafted`, còn WF 06 thì chờ `ingested AND keep=true`.
Kết quả là 06 không bao giờ thấy item vì 01 đã nhảy qua luôn sang `drafted`.
Đồng thời, nếu bật 08 song song, cả 2 đều claim `enriched` nhưng không có
barrier, dễ đè nhau.

Giải pháp (S2 + S3):

1. **Cắt rewrite FB khỏi 01**. Workflow 01 chỉ làm ingest + dedupe + guardrail,
   rồi set `status='enriched'` hoặc `status='filtered'`. Không tự tạo draft
   FB nữa.
2. **Tách transitional status cho 06 và 08**. Khi claim, 06 flip `enriched →
   fanning_out`; 08 flip `enriched → batch_rewriting`. Cả hai dùng
   `FOR UPDATE SKIP LOCKED LIMIT N`, nên 2 instance không bao giờ giữ cùng
   một row. Cuối workflow mới flip về `drafted`.
3. **Retry-safe upsert trên `(item_id, platform, variant_key)`**. WF06/WF08
   dùng `ON CONFLICT ... DO UPDATE SET updated_at = now() RETURNING ...`, không
   dùng `DO NOTHING`, để retry vẫn emit row downstream và không kẹt ở trạng thái
   transitional. Unique index thêm ở R2 là contract bắt buộc cho upsert này.

## 3. WF 06 vs WF 08 — thay thế hay song song?

**Song song, bổ sung, không thay thế.** Cả hai hiện chạy cron riêng:

- WF 06 cron 10 phút, ưu tiên per-platform rewrite (Facebook + TikTok +
  LinkedIn), QA và push Google Sheets. Đây là đường chính. Zalo OA hiện là
  manual-required ở publisher, không nằm trong auto fan-out v1.
- WF 08 cron theo giờ, gom 5 item /1 LLM call, chỉ tạo draft FB variant
  `batch-v1` để giảm chi phí. Khi quota LLM còn, WF 08 "vớt" các item còn sót
  lại (ví dụ WF 06 đang chạy chậm, hoặc LLM timeout).

Nếu muốn tắt WF 08 hẳn, chỉ cần disable cron trong n8n UI; WF 06 vẫn phủ
đủ pipeline. Nếu muốn dùng **chỉ** WF 08 (cực kỳ ngân sách hẹp), disable WF
06 nhưng phải chấp nhận chỉ có FB drafts. Khuyến nghị mặc định là bật cả
hai với 06 là đường chính.

## 4. Runbook (dev checklist)

Bật thứ tự này trên dev trước khi bật prod:

1. Bootstrap DB + apply `02-content-schema.sql` (bao gồm unique index).
2. `smoke-test.ps1` pass.
3. Bật WF 01 (chỉ guardrail). Xác nhận sau 10 phút: `SELECT status, count(*) FROM content.items GROUP BY 1;` thấy rows mới ở `enriched` và/hoặc `filtered`.
4. Bật WF 06. Xác nhận: `SELECT platform, status, count(*) FROM content.drafts GROUP BY 1,2;` thấy drafts `pending_review` mới cho các platform.
5. Để chạy ít nhất 24h, kiểm editorial queue trên Google Sheets.
6. Bật WF 08. Xác nhận có draft `variant_key='batch-v1'` xuất hiện và không có duplicate `(item_id, platform, variant_key)`.
7. Chỉ khi 2 ngày trôi qua mà không có lỗi mới bật WF 02 (publisher). Trước
   đó giữ drafts ở `approved` nhưng không `scheduled_at`.
