# Phase 1 — Schema Migration

**Priority:** P0 (blocker cho mọi phase khác)
**Status:** TODO
**Effort:** S (~2h)

## Context Links
- Plan: `../plan.md`
- Research: `../../reports/research-260420-0247-historical-chat-and-conversation-allowlist.md`
- File chính: `backend/prisma/schema.prisma`

## Mục tiêu

Thêm trường/bảng phục vụ allowlist + visibility + ingest policy mà không phá hành vi v2.1.

## Schema changes

### `Conversation` — thêm fields

```prisma
model Conversation {
  ...existing fields...
  visibility       String    @default("visible") @map("visibility")
  // visible | hidden | pending
  hiddenAt         DateTime? @map("hidden_at")
  hiddenByUserId   String?   @map("hidden_by_user_id")
  reviewedAt       DateTime? @map("reviewed_at")
  reviewedByUserId String?   @map("reviewed_by_user_id")
  oldestMessageAt  DateTime? @map("oldest_message_at")
  // Track sâu nhất history đã fetch — dùng cho "Tải thêm"
  historyExhausted Boolean   @default(false) @map("history_exhausted")
  // true khi Zalo trả `more=0` hoặc đã đạt limit

  @@index([orgId, visibility, lastMessageAt])
  ...existing indexes...
}
```

### `ZaloAccount` — thêm field

```prisma
model ZaloAccount {
  ...existing fields...
  ingestPolicy String @default("all") @map("ingest_policy")
  // all | allowlist
  // 'all' = backward-compat default; 'allowlist' = chỉ thread trong ZaloThreadAllowlist
}
```

### `ZaloThreadAllowlist` — bảng mới

```prisma
model ZaloThreadAllowlist {
  id               String   @id @default(uuid())
  zaloAccountId    String   @map("zalo_account_id")
  externalThreadId String   @map("external_thread_id")
  threadType       String   // user | group
  enabled          Boolean  @default(true)
  addedByUserId    String   @map("added_by_user_id")
  note             String?
  createdAt        DateTime @default(now()) @map("created_at")
  updatedAt        DateTime @updatedAt @map("updated_at")

  zaloAccount ZaloAccount @relation(fields: [zaloAccountId], references: [id], onDelete: Cascade)
  addedBy     User        @relation("AllowlistAddedBy", fields: [addedByUserId], references: [id])

  @@unique([zaloAccountId, externalThreadId])
  @@index([zaloAccountId, enabled])
  @@map("zalo_thread_allowlist")
}
```

### Relations cần thêm vào `User`, `ZaloAccount`

- `User.allowlistEntries ZaloThreadAllowlist[] @relation("AllowlistAddedBy")`
- `ZaloAccount.allowlist ZaloThreadAllowlist[]`

## Implementation Steps

1. Sửa `backend/prisma/schema.prisma` theo block trên
2. Chạy `npx prisma migrate dev --name add_conversation_visibility_and_allowlist`
3. Verify migration SQL trong `backend/prisma/migrations/*/migration.sql` — đảm bảo:
   - DEFAULT `'visible'` cho `visibility` → row cũ tự động nhận giá trị an toàn
   - DEFAULT `'all'` cho `ingestPolicy` → account cũ giữ behavior cũ
   - INDEX mới được tạo
4. Chạy `npx prisma generate` (auto từ migrate dev nhưng confirm)
5. Smoke test: `npm run dev` backend, kiểm tra log không lỗi schema mismatch

## Todo

- [ ] Sửa schema.prisma
- [ ] Generate migration
- [ ] Verify SQL output
- [ ] Run migrate + generate
- [ ] Smoke test backend startup

## Success Criteria

- `prisma migrate dev` thành công, không lỗi
- DB có cột `conversations.visibility` = 'visible' cho tất cả row cũ
- Bảng `zalo_thread_allowlist` tồn tại, rỗng
- Backend khởi động được không lỗi Prisma client

## Risks

- Index `[orgId, visibility, lastMessageAt]` có thể trùng concept với index `[orgId, zaloAccountId, lastMessageAt]` đã có → giữ cả hai vì query path khác (visibility filter sẽ chạy ở mọi list query)
- Field `oldestMessageAt`, `historyExhausted` chỉ dùng từ phase 4/5 — thêm sẵn để tránh migration thứ 2

## Next Steps

→ Phase 2 (enforce allowlist trong message-handler)
→ Phase 4 (sử dụng `oldestMessageAt`, `historyExhausted`)
