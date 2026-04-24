# Phase 9 — Docs & Migration Guide

**Priority:** P2
**Status:** TODO
**Effort:** S (~1.5h)
**Depends:** All previous phases

## Context Links
- Tạo mới: `docs/feature-conversation-allowlist.md`, `docs/feature-chat-history-fetch.md`
- Sửa: `README.md` (mục "Mới trong v2.2"), `HUONG-DAN-SU-DUNG.md`

## Tasks

### 1. `docs/feature-conversation-allowlist.md`

Nội dung:
- Mục đích: bảo vệ riêng tư, kiểm soát hội thoại lên CRM
- 3 chế độ: `all` (cũ), `allowlist`, và pending workflow
- UI walkthrough với screenshot placeholder
- Permission: member-chat trở lên duyệt được; chỉ owner/admin đổi policy
- API reference (link sang phase 3 endpoints)

### 2. `docs/feature-chat-history-fetch.md`

Nội dung:
- Group history: on-demand không giới hạn, paginate
- 1-1 history: thử nghiệm (nếu phase 5 pass), rate limit nghiêm
- ⚠️ **Cảnh báo rủi ro**: gọi quá nhiều có thể bị Zalo block account
- Hướng dẫn user dùng có trách nhiệm: đừng spam, dùng cho lịch sử quan trọng
- Endpoint reference: `POST /api/v1/conversations/:id/fetch-history`

### 3. README.md update

Thêm mục:
```
### Mới trong v2.2

- **🛡️ Allowlist hội thoại** — Chọn hội thoại nào sync vào CRM, tin còn lại sang tab "Chờ duyệt"
- **📜 Tải lịch sử cũ** — Bấm nút "Tải thêm" trong chat để fetch tin nhắn trước login
- **🧙 Wizard sau login** — Hướng dẫn setup allowlist ngay sau khi quét QR
```

### 4. HUONG-DAN-SU-DUNG.md update

Thêm section "Quản lý hội thoại Zalo" với hướng dẫn user thao tác.

### 5. (Nếu phase 5 pass) Migration note cho user hiện hữu

`docs/migration-v2.1-to-v2.2.md`:
- Schema migration tự động qua `prisma migrate deploy`
- Default policy='all' → không break behavior
- Khuyến nghị user mở wizard để bật allowlist

## Todo

- [ ] feature-conversation-allowlist.md
- [ ] feature-chat-history-fetch.md
- [ ] README v2.2 section
- [ ] HUONG-DAN-SU-DUNG.md update
- [ ] Migration guide (conditional)
- [ ] Cross-link tất cả files

## Success Criteria

- Người dùng cuối đọc được flow allowlist trong <5 phút
- Dev mới onboard hiểu rõ schema mới + endpoints
- Cảnh báo về 1-1 history rõ ràng, không che giấu rủi ro

## Next Steps

→ Tag release v2.2
→ Run regression test full flow
