# ZaloCRM — Báo cáo nghiên cứu tổng quan & phương hướng phát triển

**Ngày:** 2026-04-18 21:21 (Asia/Saigon)
**Nguồn dữ liệu:** code thực tế tại `H:\Task1SaoViet\ZaloCRM` + `plans/sprint-plan.md` + Prisma schema (412 dòng) + cấu trúc module BE/FE.
**Phạm vi:** đánh giá hiện trạng beta → đề xuất hướng đi tiếp.

---

## 1. Hiện trạng kiến trúc (snapshot)

### 1.1 Stack
- **Backend:** Fastify 5 + Prisma 7 + PostgreSQL + Socket.IO + `zca-js` 2.1 (client Zalo không chính thức) + `node-cron` + `exceljs`. TS, ESM, `tsx watch`.
- **Frontend:** Vue 3.5 + Vuetify 4 + Pinia + vue-router + chart.js + vite-plugin-pwa. TS strict.
- **Realtime:** Socket.IO room theo `account:{id}` + `org:{id}`.
- **Auth:** JWT (`@fastify/jwt`) + cookie + bcryptjs.
- **AI:** `modules/ai` có provider registry (anthropic/gemini) + `AiConfig`/`AiSuggestion`.

### 1.2 Module BE đã có
```
auth · zalo · chat · contacts · dashboard · analytics
automation · ai · integrations · notifications · search · api
```
- `zalo/`: pool singleton, listener factory, message-sync (group polling 5'), rate-limiter, health-check, access middleware/routes, sync-routes (`getAllFriends`).
- `contacts/`: lead-scoring, auto-tagger, duplicate-detector, merge-service, appointment-reminder, contact-intelligence.
- `automation/`: rules engine + actions + template-renderer (đã có code-review report 26-03-29).

### 1.3 Domain model (Prisma)
- **Multi-tenant** chuẩn: `Organization` là root, mọi entity scoped `orgId`.
- **ACL Zalo:** `ZaloAccountAccess(zaloAccountId, userId, permission: read|chat|admin)` — owner/admin role bypass.
- **Conversation:** unique `(zaloAccountId, externalThreadId)`, có `tab(main/other)`, `isReplied`, `unreadCount`.
- **Message:** unique `(conversationId, zaloMsgId)` → dedup tốt.
- **Có sẵn:** AutomationRule, MessageTemplate, AiConfig, AiSuggestion, DuplicateGroup, SavedReport, Integration/SyncLog, AppSetting (encrypted bytes).

---

## 2. Phân tích các điểm "beta" user nêu

### 2.1 Chưa giới hạn được hội thoại nào được đọc / không được đọc
**Nguyên nhân gốc:** ACL hiện chỉ dừng ở **cấp ZaloAccount** (`ZaloAccountAccess`), KHÔNG có cấp **Conversation/Contact**. `requireZaloAccess` chỉ kiểm `permission >= read|chat|admin` cho cả tài khoản.

→ Hệ quả:
- Sales A có quyền `read` trên account X = đọc **tất cả** hội thoại của X.
- Không có khái niệm "hội thoại private", "hội thoại của lead VIP chỉ manager xem".
- Không có khái niệm "hội thoại được assign cho user Y → user Y mới đọc được".

**Giải pháp đề xuất (3 lớp, tăng dần):**
| Lớp | Mô tả | Effort |
|-----|-------|--------|
| L1 | Filter theo **`Contact.assignedUserId`**: user chỉ thấy conv có contact assigned cho mình hoặc team mình. Có sẵn cột, chỉ thêm filter ở `chat-routes` & socket emit. | S |
| L2 | **`ConversationAccess`** table mới (giống `ZaloAccountAccess`): per-conversation grant/deny. Cho phép pin/unpin user vào hội thoại cụ thể. | M |
| L3 | **Visibility policy engine** (rule-based): "hội thoại có tag VIP → chỉ role manager", "thread group → mọi member team". Tích hợp với automation rules sẵn có. | L |

> Ưu tiên: làm L1 trước (tận dụng schema sẵn), L2 cho tổ chức lớn, L3 là long-tail.

### 2.2 Chưa load được hội thoại trước khi login Zalo vào ZaloCRM
**Nguyên nhân gốc:** `zca-js` chỉ stream message qua `selfListen` + sự kiện `old_messages` (5 sự kiện cuối khi connect). `backfillOrphanedConversations` (zalo-pool.ts:298) chỉ tạo conv shell + tên, **không kéo lịch sử tin nhắn**. `zalo-message-sync.ts` chỉ poll **group** mỗi 5' với 50 msg gần nhất — **không** kéo lịch sử user/1-1 và **không backfill sâu**.

**Giới hạn kỹ thuật của zca-js (cần xác minh từ docs lib):**
- Có `getGroupChatHistory(threadId, count, lastMsgId?)` cho group → có thể paginate.
- API user 1-1 history: cần kiểm `getChatHistory` / `getMessagesInfo` (zca-js v2.1 có hỗ trợ — nên scout).
- Không có cách lấy tin nhắn từ trước thời điểm cookie/imei hiện tại được tạo (Zalo server-side limit theo session).

**Giải pháp đề xuất:**
| Bước | Hành động | Effort |
|------|-----------|--------|
| B1 | Scout API zca-js: liệt kê hết method history user/group, threshold pagination, rate limit. | S |
| B2 | Tạo job `historical-backfill` (BullMQ hoặc cron 1-shot) khi connect: lặp `getChatHistory` đến khi `lastMsgId === null` hoặc đạt N msg/conv (vd 500). | M |
| B3 | UI: nút "Tải thêm tin nhắn cũ" trong `MessageThread.vue` → gọi `/api/v1/conversations/:id/load-more?before=<msgId>` để lazy-paginate từ DB; nếu DB hết → fallback gọi API live. | M |
| B4 | Persistent **session-anchor**: lưu `firstSyncedMsgId` per conversation để biết ranh giới đã backfill. | S |

> ⚠️ **Cảnh báo bản chất:** zca-js là client reverse-engineered, **không** phải SDK chính thức của Zalo. Việc backfill quá sâu / quá nhanh **gây risk khóa tài khoản**. Cần `zalo-rate-limiter` mở rộng để throttle history API riêng (vd 2 req/s, max 100 req/account/giờ).

### 2.3 Dashboard chưa ổn định
**Quan sát code (`dashboard-routes.ts`):**
- KPI dùng 6 query song song `Promise.all` — OK với org nhỏ, **không có cache**.
- Message-volume scan toàn bộ `messages` join `conversations` 30 ngày bằng raw SQL — chưa có index trên `messages.sent_at`. Schema thiếu `@@index([conversationId, sentAt])` cho msg.
- Pipeline groupBy `status` không có `where status IN (...)` whitelist → status custom làm chart hỗn loạn.
- Frontend `DashboardView.vue` chỉ 46 dòng → nhiều logic chắc nằm trong components con; UX khả năng còn thiếu skeleton/empty state.
- Timezone hardcode `+7h` thay vì `Intl` / pg `AT TIME ZONE` → bug khi server không UTC.

**Giải pháp đề xuất:**
| Item | Hành động |
|------|-----------|
| Index | Thêm `@@index([conversationId, sentAt])`, `@@index([orgId, status])` cho contact. |
| Cache | Redis (hoặc in-memory LRU `lru-cache`) TTL 60s cho KPI, 5' cho message-volume. |
| Materialized view | `dashboard_daily_volume_mv` refresh mỗi 5' qua node-cron. |
| Whitelist | Enum hard-coded status: `new/contacted/interested/converted/lost`. |
| Timezone | Dùng `AT TIME ZONE 'Asia/Ho_Chi_Minh'` trong raw SQL. |
| FE | Skeleton + empty state + error retry; chia widget thành lazy-load (Suspense). |

### 2.4 Các "beta" khác phát hiện thêm
- `AiConfig.model` default `claude-sonnet-4-6` — version naming **không khớp model ID Anthropic thực** (đáng ngờ là alias proxy như đã thấy trong `~/.claude/settings.json`). Cần kiểm cost-control thực tế (`maxDaily=500/org`).
- Không có **rate limit per Zalo account** ở route gửi tin (`zalo-rate-limiter.ts` có nhưng cần audit threshold).
- `Conversation.unreadCount` cập nhật ở đâu? Cần kiểm có race condition khi nhiều socket cùng emit.
- Self-message dedup window 30s (`message-handler.ts:75`) — fragile khi user gửi 2 tin giống nhau cố ý.
- Không thấy **test suite** (không có `vitest`/`jest` trong package.json) → mọi sprint mới rủi ro regression cao.
- Không thấy **migration ngoài**: `prisma/migrations/` có nhưng cần audit có ai chạy `db push` lên prod không (mất history).
- `node-cron` chạy in-process → **không scale ngang**. Phải BullMQ + Redis nếu muốn multi-instance.
- Frontend dùng Vuetify 4 (vẫn alpha/beta tại thời điểm) → nên cân nhắc hậu quả khi GA.

---

## 3. Phương hướng phát triển — đề xuất 3 chặng

### Chặng A — STABILIZATION (2-3 tuần) — ưu tiên cao nhất
**Mục tiêu:** đưa MVP ra khỏi "beta" trước khi xây tính năng mới.

1. **Per-conversation ACL** (mục 2.1, L1+L2).
2. **Historical backfill** (mục 2.2, B1→B4).
3. **Dashboard hardening** (mục 2.3): index + cache + timezone.
4. **Test foundation:** Vitest + supertest cho BE; Vitest + Vue Test Utils cho FE. Coverage tối thiểu cho `chat-routes`, `zalo-access-middleware`, `message-handler`.
5. **Observability:** structured logging (pino sẵn của Fastify), `/health` deep check (DB + zalo pool size + queue depth), Sentry hoặc OpenTelemetry export.
6. **Job queue migration:** node-cron → BullMQ (Redis) cho appointment-reminder, sync, backfill, AI batch.
7. **Rate-limit audit:** test giới hạn Zalo (gửi tin, history fetch) theo từng account để tránh ban.

### Chặng B — PRODUCTIZATION (3-4 tuần) — sau khi A xong
1. **AI nâng cấp:**
   - Streaming reply (SSE) thay vì request-response.
   - Prompt caching (giảm cost).
   - Auto-tag conversation theo intent (dùng `AiSuggestion.type=intent`).
   - Multi-tenant API key BYOK (org tự nhập key, không xài key chung).
2. **Workflow Automation 2.0:** visual builder (n8n-style) cho `AutomationRule`. Triggers thêm: `conversation.idle_24h`, `contact.status_changed`, `appointment.upcoming`.
3. **Reports:** scheduled email/Telegram report (tận dụng `Integration` + `SavedReport`).
4. **Mobile PWA polish:** đã có `vite-plugin-pwa`, `MobileChatView`, `BottomNav` — cần offline queue cho gửi tin (IndexedDB) + push notification (Web Push + service worker).
5. **Audit log UI:** `ActivityLog` đã ghi nhưng chưa có view để admin tra cứu.

### Chặng C — SCALE & MOAT (sau B)
1. **Multi-region:** tách Zalo pool sang worker riêng (Node cluster hoặc service riêng giao tiếp qua Redis pub/sub) để FE/API stateless, scale ngang được.
2. **Conversation intelligence:** vector embed message (pgvector) → semantic search trong `GlobalSearch.vue`, RAG cho AI reply lấy context lịch sử khách.
3. **Marketplace integration:** kết Sapo/Haravan/KiotViet (POS Việt Nam) → đồng bộ đơn hàng vào Contact timeline.
4. **Compliance:** mã hóa-at-rest cho `Message.content` (per-org KMS), GDPR-style data export/erase API.
5. **Migration sang Zalo Official Account API** nếu khách có ZOA → giảm phụ thuộc zca-js (rủi ro pháp lý + ban account).

---

## 4. Rủi ro lớn nhất cần biết

1. **zca-js là reverse-engineered:** Zalo có thể đổi protocol bất kỳ lúc nào → break toàn bộ hệ thống. Cần plan B (ZOA API hoặc browser-automation fallback).
2. **Không có test → mọi refactor đều risk.** Phải đầu tư test trước khi đụng vào `zalo-pool` hay `message-handler`.
3. **Single-instance lock-in:** pool & cron in-process → không HA. Một crash = mất kết nối toàn bộ tài khoản → user phải QR-login lại.
4. **AI cost runaway:** `maxDaily=500/org` nhưng không thấy throttle theo token / cảnh báo khi vượt. Một org spam AI có thể đốt budget.
5. **Schema drift:** Prisma 7 mới, migrations chưa audit. Production có thể đã `db push` (mất migration history).

---

## 5. Đề xuất action ngay trong tuần này

1. Bật issue tracker (GitHub Projects / Linear) — chuyển 4 nhóm beta thành 4 epic.
2. Chốt scope **per-conversation ACL** (L1) → ticket cụ thể cho `chat-routes` + `zalo-socket`.
3. Spike 1 ngày: scout zca-js v2.1 method history user 1-1 → confirm tính khả thi B2.
4. Setup Vitest + 3 test smoke (auth login, chat list, send msg) → CI guard.
5. Đo baseline: số org, số account/org, số message/ngày → để chọn cache strategy đúng quy mô.

---

## Câu hỏi chưa giải đáp

- Hiện đã có khách production chưa? Quy mô (org/account/msg/ngày)?
- ZOA (Zalo Official Account) có nằm trong roadmap không, hay 100% bám zca-js?
- Mô hình tính phí AI: org tự BYOK hay platform bao? (ảnh hưởng provider strategy.)
- Có cam kết SLA uptime không? (Quyết định mức độ ưu tiên HA cho pool.)
- `~/.claude/settings.json` đang trỏ model qua proxy `troll/...` — có phải môi trường dev cố tình hay nhầm config?
- Số liệu thực tế dashboard chậm bao nhiêu? (cần repro để chốt cache vs. index.)
