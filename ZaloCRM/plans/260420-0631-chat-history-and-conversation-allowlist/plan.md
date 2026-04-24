# Plan — Chat History & Conversation Allowlist

**Ngày:** 2026-04-20 06:31 (Asia/Saigon)
**Branch:** main
**Báo cáo gốc:** `plans/reports/research-260420-0247-historical-chat-and-conversation-allowlist.md`

## Mục tiêu

1. Cho phép user fetch lịch sử chat (1-1 và nhóm) trước thời điểm login Zalo vào CRM
2. Cho phép user kiểm soát những hội thoại nào được hiển thị/persist trong CRM (allowlist + pending review)

## Quyết định kiến trúc đã chốt với user

| # | Quyết định |
|---|---|
| 1 | Tin từ thread chưa duyệt → **lưu pending** (visibility='pending'), không drop |
| 2 | Default policy cho account mới → **allowlist** + wizard sau loginQR |
| 3 | Group **không tách model**, vẫn lưu trong `Contact` với `metadata.isGroup=true` |
| 4 | Quyền duyệt allowlist → **member có permission='chat'** trở lên |
| 5 | Lịch sử nhóm → **on-demand không giới hạn** (paginate qua `lastActionId`), user bấm nút "Tải thêm" |
| 6 | Lịch sử 1-1 → **R&D `api.custom()`** wrapper endpoint Zalo Web, rate limit nghiêm, on-demand only |

## Phases

| # | Phase | File | Effort | Status |
|---|---|---|---|---|
| 1 | Schema migration: visibility, ingestPolicy, allowlist table | `phase-01-schema-migration.md` | S | TODO |
| 2 | Backend: enforce allowlist + pending state trong message-handler | `phase-02-backend-allowlist-enforcement.md` | M | TODO |
| 3 | Backend: CRUD allowlist endpoints + ingest policy settings | `phase-03-backend-allowlist-api.md` | M | TODO |
| 4 | Backend: on-demand group history endpoint paginated | `phase-04-backend-group-history-fetch.md` | S | TODO |
| 5 | Backend R&D: api.custom() wrapper cho user 1-1 history | `phase-05-backend-user-history-rnd.md` | L | TODO |
| 6 | Frontend: trang quản lý hội thoại Zalo (allowlist UI) | `phase-06-frontend-allowlist-management.md` | M | TODO |
| 7 | Frontend: pending tab + load more history button trong ChatView | `phase-07-frontend-chat-pending-and-history.md` | M | TODO |
| 8 | Frontend: wizard chuyển sang allowlist sau loginQR | `phase-08-frontend-allowlist-wizard.md` | S | TODO |
| 9 | Docs + migration guide | `phase-09-docs-and-migration-guide.md` | S | TODO |

## Dependencies

```
P1 (schema) ─┬─> P2 (enforce) ─┬─> P3 (api) ──> P6 (UI mgmt)
             │                  └─> P7 (UI chat) ──> P8 (wizard)
             └─> P4 (group history)
P5 (1-1 R&D) độc lập, có thể chạy song song
P9 (docs) cuối cùng
```

## Files chính sẽ chạm

- `backend/prisma/schema.prisma` — thêm field/model
- `backend/src/modules/chat/message-handler.ts` — gate allowlist
- `backend/src/modules/chat/chat-routes.ts` — filter visibility
- `backend/src/modules/zalo/zalo-message-sync.ts` — paginate group
- `backend/src/modules/zalo/zalo-routes.ts` + new `zalo-allowlist-routes.ts`, `zalo-history-routes.ts`
- `backend/src/modules/zalo/zalo-pool.ts` — wizard hook sau login
- `frontend/src/views/ChatView.vue` — pending filter, load more
- `frontend/src/views/ZaloAccountsView.vue` — link sang trang allowlist
- New: `frontend/src/views/ZaloAllowlistView.vue`, `frontend/src/components/AllowlistWizardDialog.vue`

## Risks

- R&D phase 5 không guarantee work — có exit criteria rõ
- Migration default ingestPolicy='all' để không phá hành vi user cũ; chỉ wizard dẫn user opt-in allowlist
- Pending conversations có thể tích tụ → cần cron cleanup hoặc auto-archive sau N ngày
