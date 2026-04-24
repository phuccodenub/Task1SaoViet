# ZaloCRM v2.2 — Quản lý nhiều tài khoản Zalo cá nhân

Hệ thống quản lý tập trung nhiều tài khoản Zalo cá nhân trên 1 giao diện web. Chat real-time, AI assistant, workflow tự động, tích hợp đa nền tảng, analytics nâng cao, PWA mobile.

**GitHub:** [https://github.com/locphamnguyen/ZaloCRM](https://github.com/locphamnguyen/ZaloCRM)

## Tính năng

### Cốt lõi (v1.0)
- **Quản lý nhiều Zalo** — Đăng nhập QR, tự kết nối lại, lưu phiên đăng nhập
- **Chat real-time** — Gửi/nhận tin nhắn, ảnh, file, sticker, nhóm chat
- **Quản lý khách hàng** — Pipeline (Mới → Đã liên hệ → Quan tâm → Chuyển đổi → Mất)
- **Lịch hẹn** — Tạo, theo dõi, nhắc nhở tự động hàng ngày
- **Dashboard** — Biểu đồ tin nhắn, KPI, nguồn khách hàng, trạng thái pipeline
- **Báo cáo** — Xuất Excel, lọc theo thời gian
- **Phân quyền** — Owner / Admin / Member, quản lý đội nhóm, phân quyền Zalo
- **API công khai** — REST API với xác thực API key cho tích hợp bên ngoài
- **Webhook** — Nhận thông báo khi có tin nhắn mới, khách hàng mới, Zalo kết nối/ngắt
- **Chống block Zalo** — Giới hạn 200 tin/ngày, phát hiện gửi quá nhanh
- **Thông báo** — Tin chưa trả lời >30 phút, lịch hẹn sắp tới, Zalo mất kết nối
- **Tìm kiếm toàn hệ thống** — Tìm khách hàng, tin nhắn, lịch hẹn
- **Giao diện** — Theme tối/sáng, thiết kế Liquid Silicon

### Mới trong v2.2

- **Allowlist hội thoại** — Chọn hội thoại nào sync vào CRM thay vì ingest toàn bộ; tin từ hội thoại chưa chọn nằm ở tab "Chờ duyệt" để sale kiểm tra trước. Backend có ACL đầy đủ (REST/Socket/Public API), webhook + automation bị gate theo `visibility`. Xem [docs/feature-conversation-allowlist.md](docs/feature-conversation-allowlist.md).
- **Wizard sau QR login** — Dialog 3-bước tự mở cho account mới, đăng ký per-account một lần; user có thể mở lại thủ công trong trang Tài khoản Zalo.
- **Tải lịch sử chat cũ** — Banner "Tải thêm" ở đầu khung chat với 2 path: cursor trên Message table (CRM-local, luôn an toàn) + gọi Zalo SDK cho group. UX copy trung thực về giới hạn SDK (không có cursor group upstream). Chat 1-1 R&D ở PR riêng với feature flag. Xem [docs/feature-chat-history-fetch.md](docs/feature-chat-history-fetch.md).
- **Bảo mật allowlist end-to-end** — JWT socket auth, `account:<id>` room ACL, pending envelope scrub (không leak metadata cross-account), cascade flip visible→hidden khi untick. 9 rounds Codex audit hardening.
- **Migration an toàn** — Default `ingestPolicy='all'` giữ hành vi v2.1; user bật allowlist per-account chủ động. Xem [ADR-001](backend/docs/adr-001-default-ingest-policy.md) + [hướng dẫn migration](docs/migration-v2.1-to-v2.2.md).

### Mới trong v2.1

- **📂 Tab "Khác"** — Ẩn hội thoại không quan trọng sang tab riêng, chuột phải để chuyển tab
- **✏️ Tên KH 2 lớp** — CRM Name (tên thật) + Zalo Name, hiển thị CRM Name ưu tiên, dùng trong template
- **🔍 Bộ lọc hội thoại** — Lọc theo chưa đọc, chưa trả lời, thời gian, tags
- **📝 Template nhanh** — Gõ `/` trong ô chat để chèn mẫu tin nhắn với biến động (tên, ngày, trạng thái)
- **💬 Tin nhắn đặc biệt** — Hiển thị sticker, hình ảnh, video, file, chuyển khoản, cuộc gọi, QR, nhắc hẹn
- **🔄 Đồng bộ tin nhắn** — Lấy 50 tin cũ khi kết nối Zalo, selfListen dedup, tự tạo contact mới
- **🐛 Fix: Tên "Unknown"** — Hiển thị đúng tên người gửi từ senderName Zalo
- **🐛 Fix: PWA setup** — Sửa lỗi vite-plugin-pwa không build được

### Mới trong v2.0

- **🤖 AI Assistant** — Gợi ý trả lời, tóm tắt hội thoại, phân tích cảm xúc khách hàng
- **⚡ Workflow Automation** — Tự động gửi tin nhắn, phân loại khách hàng, trigger theo sự kiện
- **🔗 Integration Hub** — Tích hợp Google Sheets, Telegram, Facebook, Zapier
- **📱 Mobile PWA** — Giao diện responsive, hoạt động offline, cài đặt trên điện thoại
- **🧠 Contact Intelligence** — Gộp trùng khách hàng, lead scoring, auto-tag
- **📊 Advanced Analytics** — Phân tích funnel, hiệu suất team, thời gian phản hồi, report builder
- **🔧 Multi-Provider AI** — Hỗ trợ Anthropic, OpenAI, Qwen, Kimi với cấu hình linh hoạt
- **🌐 Proxy per-account** — Cấu hình proxy HTTP riêng cho từng tài khoản Zalo, tránh block IP
- **🐛 Fix: Tin nhắn trùng lặp** — Loại bỏ tin nhắn hiển thị trùng khi gửi

## Yêu cầu hệ thống

| Thành phần | Tối thiểu | Khuyến nghị |
|-----------|----------|------------|
| CPU | 1 vCPU | 2-4 vCPU |
| RAM | 1 GB | 4 GB |
| Ổ cứng | 10 GB | 20 GB SSD |
| Hệ điều hành | Ubuntu 20.04+ | Ubuntu 22.04 LTS |
| Phần mềm | Docker + Docker Compose | Docker 24+ |

## Cài đặt nhanh

> Hướng dẫn chi tiết: [HUONG-DAN-CAI-DAT.md](HUONG-DAN-CAI-DAT.md)

```bash
git clone https://github.com/locphamnguyen/ZaloCRM.git
cd ZaloCRM
cp .env.example .env
# Sửa file .env — đặt mật khẩu và secret keys
docker compose up -d --build
```

Truy cập **http://IP-server:3080** → Tạo tài khoản admin lần đầu.

## Công nghệ sử dụng

| Thành phần | Công nghệ |
|-----------|----------|
| Backend | Node.js 20 / Fastify 5 / Prisma 7 |
| Frontend | Vue 3 / Vuetify 3 / Chart.js / Pinia |
| AI | Anthropic Claude / OpenAI / Qwen / Kimi |
| Cơ sở dữ liệu | PostgreSQL 16 |
| Real-time | Socket.IO |
| Zalo | zca-js 2.x |
| Mobile | PWA (Service Worker + Web App Manifest) |
| Triển khai | Docker Compose |

## API & Webhook

> Hướng dẫn chi tiết: [HUONG-DAN-SU-DUNG.md](HUONG-DAN-SU-DUNG.md)

### Xác thực API
```
Header: X-API-Key: your-api-key
```

### Endpoint chính

| Phương thức | Đường dẫn | Mô tả |
|------------|----------|-------|
| GET | `/api/public/contacts` | Danh sách khách hàng |
| POST | `/api/public/contacts` | Tạo khách hàng mới |
| POST | `/api/public/messages/send` | Gửi tin nhắn |
| GET | `/api/public/appointments` | Danh sách lịch hẹn |

### Sự kiện Webhook

| Sự kiện | Mô tả |
|---------|-------|
| `message.received` | Tin nhắn mới đến |
| `message.sent` | Tin nhắn gửi đi |
| `contact.created` | Khách hàng mới |
| `zalo.connected` | Zalo kết nối |
| `zalo.disconnected` | Zalo mất kết nối |

## Lịch sử phiên bản

### v2.2 (23/04/2026)
- Allowlist hội thoại: chọn hội thoại nào sync vào CRM, visibility lifecycle visible/pending/hidden
- Wizard cài đặt hội thoại sau QR login (per-account, một lần)
- Tải lịch sử chat cũ (cursor local + Zalo SDK cho group, UX trung thực về giới hạn SDK)
- JWT socket auth, account-room ACL parity REST/Socket/Public API
- ADR-001: default `ingestPolicy='all'` để giữ backward-compat v2.1
- Contract smoke test shell (12 assertions, body-level + live-send guard)

### v2.1 (16/04/2026)
- Tab "Khác": ẩn hội thoại không quan trọng, chuyển tab bằng chuột phải
- Tên KH 2 lớp: CRM Name + Zalo Name, ưu tiên CRM Name
- Bộ lọc hội thoại: chưa đọc, chưa trả lời, thời gian, tags
- Template nhanh: gõ `/` để chèn mẫu tin nhắn với biến động
- Tin nhắn đặc biệt: hiển thị sticker, ảnh, video, file, chuyển khoản, cuộc gọi
- Đồng bộ tin nhắn: lấy 50 tin cũ, selfListen dedup, tự tạo contact
- Fix: tên "Unknown", PWA setup, tin nhắn trùng lặp khi gửi

### v2.0 (31/03/2026)
- AI Assistant: gợi ý trả lời, tóm tắt, phân tích cảm xúc
- Workflow Automation: tự động gửi tin, phân loại khách
- Integration Hub: Google Sheets, Telegram, Facebook, Zapier
- Mobile PWA: offline, responsive, installable
- Contact Intelligence: gộp trùng, lead scoring, auto-tag
- Advanced Analytics: funnel, team perf, report builder
- Multi-Provider AI: Anthropic, OpenAI, Qwen, Kimi
- Proxy per-account: cấu hình proxy riêng cho từng Zalo
- Fix: loại bỏ tin nhắn hiển thị trùng

### v1.0 (29/03/2026)
- MVP: Quản lý nhiều Zalo, chat, CRM, lịch hẹn, dashboard, báo cáo, API, webhook
- Dự án gốc của tác giả Vuongnguyenbinh các bạn tham khảo tại đây: https://github.com/vuongnguyenbinh/ZaloCRM

## Giấy phép

MIT — Miễn phí sử dụng và chỉnh sửa.
