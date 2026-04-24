# Phase 8 — Frontend: Allowlist Wizard sau loginQR

**Priority:** P1
**Status:** TODO
**Effort:** S (~2h)
**Depends:** Phase 6

## Context Links
- File mới: `frontend/src/components/AllowlistWizardDialog.vue`
- File sửa: `frontend/src/views/ZaloAccountsView.vue` (175 LOC)
- Socket event: `zalo:connected` (đã emit ở backend zalo-pool)

## Mục tiêu

Sau khi user login QR thành công cho 1 Zalo account mới, hiện dialog wizard:
1. Hỏi user có muốn dùng allowlist không (recommended để bảo vệ riêng tư)
2. Nếu có → load `getAllFriends` + `getAllGroups`, để user tick chọn
3. Apply: PATCH /ingest-policy=allowlist + POST /allowlist/bulk

## UI Flow

### Step 1: Welcome screen
```
🎉 Đã kết nối Zalo: Anh Nguyễn

Bạn muốn quản lý hội thoại như thế nào?

◉ Chỉ sync hội thoại tôi chọn (Khuyến nghị)
   → Tin nhắn gia đình, bạn bè không lên CRM, sale yên tâm

◯ Sync tất cả hội thoại
   → Mọi tin nhắn đều vào CRM (giống v2.1)

[Bỏ qua]  [Tiếp tục →]
```

### Step 2 (nếu chọn allowlist): Pick threads
Embed component giống phase 6 (reuse `AllowlistThreadRow.vue`):
- Default tick: tất cả nhóm + friend đang có conversation trong CRM (nếu có)
- Hint: "Bạn có thể đổi sau trong Cài đặt → Quản lý hội thoại"

### Step 3: Confirm
```
Bạn đã chọn 23 hội thoại.
- 18 cá nhân
- 5 nhóm

Tin nhắn từ các hội thoại khác sẽ được đưa vào tab "Chờ duyệt".

[← Quay lại] [Hoàn tất]
```

## Implementation Steps

1. Tạo `AllowlistWizardDialog.vue` (3 step) — `<v-stepper>` Vuetify
2. Trong `ZaloAccountsView.vue`, listen socket event `zalo:connected` → check nếu account vừa connect là mới (xem `lastConnectedAt` null hoặc `createdAt` rất gần) → show wizard
3. Ngoài ra, thêm nút "Mở wizard" trong action menu cho user dùng lại bất cứ lúc nào
4. Reuse `AllowlistThreadRow.vue` từ phase 6
5. Build check

## Todo

- [ ] Component AllowlistWizardDialog.vue
- [ ] Trigger logic trong ZaloAccountsView
- [ ] Reuse row component
- [ ] Build check
- [ ] Manual test full wizard flow

## Success Criteria

- Login Zalo mới → dialog tự popup
- Chọn "Sync tất cả" → policy='all', đóng dialog, không thay đổi gì khác
- Chọn allowlist + tick 5 thread + Hoàn tất → policy='allowlist', allowlist có 5 entries, tin từ thread khác sang pending
- "Bỏ qua" → policy='all' (giữ behavior cũ), KHÔNG hiện wizard lần nữa cho account đó (lưu flag local hoặc check `lastConnectedAt`)

## Risks

- `getAllFriends` chậm khi friend nhiều → loading skeleton + cho user skip step 2 (chọn sau)
- User accidentally bấm "Bỏ qua" → cần nút "Mở wizard" trong settings để chạy lại

## Next Steps

→ Phase 9 (docs)
