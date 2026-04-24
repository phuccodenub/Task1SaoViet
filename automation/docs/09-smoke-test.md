# Smoke test — schema + webhook contract

Mục đích: bắt sớm các lỗi "silent drift" giữa **schema Postgres**, **n8n workflow SQL**, **ZaloCRM webhook payload** và **public API contract**. Đây chính là bộ lỗi đã bị Codex phát hiện ở vòng review đầu tiên (`topic` column, `conversationId/message` vs `zaloAccountId/threadId/content`, `shadow_mode`/`verdict` vs `action_taken`/`staff_verdict`, v.v.).

Tất cả script nằm trong `automation/scripts/`.

## Khi nào chạy

| Thời điểm | Bắt buộc |
|---|---|
| Sau mỗi thay đổi `automation/scripts/02-content-schema.sql` | Có |
| Sau mỗi thay đổi workflow JSON trong `automation/n8n/workflows/` có truy vấn Postgres | Có |
| Sau mỗi thay đổi `ZaloCRM/backend/src/modules/chat/message-handler.ts` (webhook payload) | Có |
| Sau mỗi thay đổi `ZaloCRM/backend/src/modules/api/public-api-routes.ts` (public API) | Có |
| Trước mỗi lần cấu hình monitoring / dashboard Grafana đụng vào `content.*` hoặc `omni.*` | Nên |
| Trong CI pipeline (job riêng chạy db smoke-test trên schema vừa migrate) | Nên |

## Cách chạy

### Mọi OS có PowerShell 7+ (khuyến nghị)

```powershell
pwsh -File automation/scripts/smoke-test.ps1
```

Yêu cầu duy nhất: Docker đang chạy + container `zalo-crm-db` up. **Không cần** Git Bash / WSL / `openssl` / `jq` — toàn bộ HMAC-SHA256 sinh bằng `System.Security.Cryptography.HMACSHA256` của .NET.

Ba stage chạy tuần tự, bất kỳ stage nào fail là gate fail non-zero:

1. **Static graph lint** (`lint-workflows.ps1`): parse tất cả workflow JSON, kiểm mọi `connections.*.main[*].node` có tồn tại trong `nodes[].name`, kiểm mọi `$('Node Name')` expression reference, chặn duplicate node name, chặn `parameters.onError`, và chặn Postgres `ON CONFLICT ... DO NOTHING` nếu node không nằm trong allowlist dedupe rõ ràng. Đây là lớp đã được thêm trong vòng V sau khi Codex phát hiện dangling edge ở WF02; rule `DO NOTHING` được bổ sung sau vòng Y để ngăn tái phát class bug WF06/WF08 retry mất output.
2. **SQL schema smoke** (`smoke-test-schema.sql` qua `docker exec`): EXPLAIN mọi câu SQL mà workflow 01–09 + postgres_exporter dùng.
3. **Webhook/API contract smoke** (`smoke-test-webhooks.ps1`): shape + HMAC parity cho ZaloCRM webhook, ZaloCRM reply API, và Facebook `X-Hub-Signature-256`.

Flag tuỳ chọn:

| Flag | Hệ quả | Khi nào dùng |
|---|---|---|
| `-SkipWebhook` | Bỏ stage 3, in warning vàng | Khi muốn chạy nhanh chỉ để kiểm schema drift |
| `-SkipLint` | Bỏ stage 1 | Gần như không bao giờ; chỉ khi lint script chính nó hỏng |

### macOS / Linux không có pwsh

Script bash cũ (`smoke-test-webhooks.sh`) vẫn còn cho trường hợp Linux CI chưa cài PowerShell:

```bash
docker exec -i zalo-crm-db psql -U crmuser -d zalocrm \
  < automation/scripts/smoke-test-schema.sql

bash automation/scripts/smoke-test-webhooks.sh
```

Lưu ý: bản bash KHÔNG chạy stage 1 (static graph lint). Nếu dùng bash, hãy chạy thêm:

```bash
pwsh -File automation/scripts/lint-workflows.ps1
```

hoặc port logic lint sang một script Node/Python tương đương trước khi gộp PR.

## Những gì được kiểm tra

### 1) `smoke-test-schema.sql`

**Thực sự kiểm những gì (vòng R4, mở rộng so với vòng F5):**

- Tất cả schema/table bắt buộc (`content.items`, `content.drafts`, `content.publish_log`, `content.metrics`, `omni.external_messages`, `omni.intent_log`).
- Từng cột mà workflow 01–09 + `postgres-exporter` thực sự đọc/ghi (đã liệt kê cụ thể trong script, không phải "tất cả").
- Danh sách cột "cấm" (`content.items.topic`, `content.publish_log.created_at`, `omni.intent_log.shadow_mode|verdict|is_lead`). Nếu ai lỡ thêm lại, script fail ngay lập tức — đây là rào chắn cho hai quyết định kiến trúc:
  - Topic lưu trong `raw_payload` JSONB, không phải cột riêng.
  - Không thêm `is_lead BOOLEAN`; lead conversion tính qua `intent = 'lead_qualified'` + `action_taken = 'handoff'`.
- Cấu trúc bắt buộc:
  - `content.drafts` phải có `UNIQUE INDEX (item_id, platform, variant_key)` — cả WF06 và WF08 đều dùng `ON CONFLICT (item_id, platform, variant_key) DO UPDATE SET updated_at = now() RETURNING …` (vòng X, Codex #8 P1); thiếu index thì upsert fail runtime và nhánh recovery retry mất output.
  - `content.items.id` phải là `UUID` — nếu lệch sang `bigint`/`text`, workflow 08 cast `::uuid[]` fail.
- `EXPLAIN (VERBOSE OFF, COSTS OFF)` lần lượt **toàn bộ** câu SQL ở các node Postgres sau:
  - Workflow 01: INSERT items + RETURNING topic từ JSONB, UPDATE filtered, UPDATE enriched. Workflow 01 không tạo draft; drafting/fan-out nằm ở workflow 06/08.
  - Workflow 02: WITH due + UPDATE drafts, UPD/LOG CTE (publish_log dùng `attempted_at`).
  - Workflow 03: 3 nhánh UPDATE drafts (approve / reject / approve-with-edit).
  - Workflow 04: INSERT intent_log (16 field, action_taken + staff_verdict contract).
  - Workflow 05: UPSERT external_messages trên `(channel, external_message_id)`.
  - Workflow 06: WITH ready + UPDATE items (`raw_payload->>'topic' AS topic`), INSERT drafts, UPDATE drafted.
  - Workflow 07: SELECT drafts pending-review quá hạn 2h.
  - Workflow 08: WITH ready + UPDATE items (RETURNING topic từ JSONB), INSERT drafts với `ON CONFLICT … DO UPDATE SET updated_at = now() RETURNING id, item_id, queued_at` (vòng X), UPDATE items với `ANY(string_to_array($1,',')::uuid[])` gated bởi `EXISTS` draft `batch-v1` có `queued_at IS NOT NULL`.
  - Workflow 09: 2 báo cáo tháng trong `zalocrm` DB (`content.publish_log.attempted_at`, `omni.intent_log.intent`/`action_taken`/`staff_verdict`).
  - Monitoring: 2 câu `postgres_exporter` chạy mỗi 15s.
- **Synthetic state invariants** (vòng W/X, bổ sung EXPLAIN vì EXPLAIN không validate runtime semantic):
  - `[W-a,b]`: WF06 retry path — draft đã insert nhưng `queued_at=NULL` phải vẫn re-push được và `Mark item drafted` chỉ flip khi count `queued_at IS NOT NULL >= plannedCount`.
  - `[W-c]`: WF08 mixed-state — chỉ flip `drafted` cho item nào thực sự có `batch-v1` draft với `queued_at IS NOT NULL`, item LLM skip phải ở lại `batch_rewriting`.
  - `[W-d]`: WF07 branch B — item `fanning_out`/`batch_rewriting` có `locked_at > 30 phút` phải bị surface làm alert (dead-letter recovery).
  - `[X-e]`: WF08 all-conflict retry — toàn bộ draft đã tồn tại từ run trước, `DO UPDATE RETURNING` phải emit đủ rows (không silent-skip như `DO NOTHING`), body editor không bị overwrite, và `Mark items drafted` vẫn flip được.
- **Backfill guard** (vòng Y, Codex #9 P2): hai `UPDATE` idempotent trong `02-content-schema.sql` chạy ngay sau `ADD COLUMN IF NOT EXISTS` cho `locked_at`/`queued_at`. Trên DB trắng match 0 row; trên DB legacy (chạy workflow trước vòng V), nó set `locked_at = COALESCE(updated_at, created_at, now())` cho item đang `fanning_out`/`batch_rewriting` và `queued_at = COALESCE(updated_at, created_at, now())` cho draft đã rời trạng thái local `draft`. Re-chạy migration không làm hỏng dữ liệu vì guard `IS NULL`.

**Chưa cover (và script ghi rõ):**

- Câu SELECT LiteLLM spend của workflow 09 (nằm ở database khác — `litellm`). Chạy thủ công theo hướng dẫn ở comment cuối script.
- Integration test thật (gửi webhook sống, LiteLLM sống, Zalo sống). Cần chạy shadow mode.

Script mở `BEGIN` và luôn `ROLLBACK`, nên chạy lại trên production cũng không để lại dữ liệu rác.

### 2) `smoke-test-webhooks.ps1` (và bản bash tương đương)

- Payload `message.received` phải chứa đủ 8 trường cốt lõi: `zaloAccountId`, `threadId`, `threadType`, `senderType`, `conversationId`, `contactId`, `content`, `senderName`. Nếu ZaloCRM đổi emitter mà quên trường nào, test fail.
- Body `POST /api/public/messages/send` phải có `zaloAccountId` + `threadId` + `content`, và **không được phép** có hai trường cũ (`conversationId`, `message`). Nếu ai đó rollback workflow 04 về contract cũ, test fail.
- Chữ ký HMAC-SHA256 được sinh lại (bằng .NET `HMACSHA256` trên bản PowerShell, `openssl` trên bản bash) để đảm bảo workflow 04 (ZaloCRM signature) và workflow 05 (Facebook `X-Hub-Signature-256`) vẫn dùng đúng secret + thuật toán. Hai bản phải cho ra cùng một hex signature với cùng input.

### 3) `lint-workflows.ps1` (bổ sung vòng V)

- Parse mọi `automation/n8n/workflows/*.json`, chặn node name trùng.
- Kiểm từng edge trong `connections.<src>.main[*].*.node` phải trỏ vào một `nodes[].name` tồn tại — chặn đúng lỗi class U3 rename node nhưng quên update edge.
- Quét mọi `$('Node Name')` expression trong toàn bộ field của workflow và chặn nếu target không tồn tại.
- Không kiểm được: static analysis của Code node JS (chúng tôi không chạy Code node để tránh side effect trong gate); vẫn cần integration/shadow test thật.

**Phạm vi thừa nhận có giới hạn:** smoke-test này kiểm parse/EXPLAIN + contract payload + graph integrity offline; nó KHÔNG thay cho integration test thật (gửi webhook sống tới n8n + reply qua Zalo OA), cũng không kiểm behaviour rate-limit/Redis/Socket.IO. Dùng làm **pre-merge gate**, không phải "go-live gate" duy nhất.
