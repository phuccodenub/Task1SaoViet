# Phase 6 — Frontend Allowlist Management UI

**Priority:** P0
**Status:** TODO
**Effort:** M (~5h)
**Depends:** Phase 3

## Context Links
- Files mới: `frontend/src/views/ZaloAllowlistView.vue`
- Files sửa: `frontend/src/router/index.ts` (route mới), `frontend/src/views/ZaloAccountsView.vue` (link sang trang)
- API mới: phase 3 endpoints

## Mục tiêu

Trang quản lý danh sách hội thoại được phép sync vào CRM, per Zalo account. User có thể tick/untick từng hội thoại từ list bạn bè + nhóm Zalo của mình.

## Route

`/zalo-accounts/:id/allowlist` → `ZaloAllowlistView.vue`

## UI Layout

```
┌────────────────────────────────────────────────────────────┐
│  ← Quay lại  [Account: Anh Nguyễn — UID 12345]            │
│  Chính sách: ◯ Tất cả  ◉ Chỉ danh sách (Allowlist)        │
├────────────────────────────────────────────────────────────┤
│  [Tab: Bạn bè (245)] [Tab: Nhóm (32)] [Tab: Đang chờ (5)]│
│  🔍 [Tìm kiếm...]    Bộ lọc: ☐ Đã có hội thoại  ☐ Pin    │
│  [Chọn tất] [Bỏ chọn] [Đảo chọn]                          │
├────────────────────────────────────────────────────────────┤
│  ☑ 🟢 [Avatar] Nguyễn Văn A — Đã có 23 tin                │
│  ☑ 🟢 [Avatar] Khách hàng X — Đã có 5 tin                 │
│  ☐ ⚪ [Avatar] Bạn cũ Y — Chưa sync                       │
│  ...                                                       │
├────────────────────────────────────────────────────────────┤
│  Đã chọn: 87 / 245     [Lưu thay đổi]                     │
└────────────────────────────────────────────────────────────┘
```

## Components

### `ZaloAllowlistView.vue` (~200 LOC, có thể tách)

State:
```ts
const policy = ref<'all' | 'allowlist'>('all');
const friends = ref<Thread[]>([]);
const groups = ref<Thread[]>([]);
const allowlist = ref<Set<string>>(new Set());
const pendingConvs = ref<Conversation[]>([]);
const search = ref('');
const tab = ref<'friends' | 'groups' | 'pending'>('friends');
```

Methods:
- `loadData()`: parallel call `GET /allowlist`, `GET /available-threads`, `GET /conversations?visibility=pending`
- `togglePolicy()`: confirm dialog → PATCH /ingest-policy
- `toggleThread(threadId)`: chỉnh `allowlist` set local
- `saveChanges()`: diff → POST /allowlist/bulk
- `approveConversation(convId)`: POST /conversations/:id/approve
- `rejectConversation(convId)`: POST /conversations/:id/reject

### Subcomponent (nếu file >200 LOC):
- `frontend/src/components/AllowlistThreadRow.vue` — render 1 row checkbox (thread + counts)
- `frontend/src/components/PendingConversationCard.vue` — card duyệt/từ chối

## Implementation Steps

1. Add route `/zalo-accounts/:id/allowlist` trong `frontend/src/router/index.ts`
2. Tạo `ZaloAllowlistView.vue` với layout trên
3. Tạo API helpers trong `frontend/src/api/` (file `zalo-allowlist.ts`)
4. Tạo subcomponents nếu file vượt 200 LOC
5. Thêm nút "Quản lý hội thoại" vào `ZaloAccountsView.vue` row action
6. Vuetify components: `v-data-table` hoặc `v-list` với `v-checkbox`, `v-tabs`, `v-text-field` (search)
7. Build check: `npm run build` frontend

## Todo

- [ ] Route + ZaloAllowlistView.vue skeleton
- [ ] API client `zalo-allowlist.ts`
- [ ] Tabs friends/groups/pending
- [ ] Search + filter + bulk actions
- [ ] Save changes diff logic
- [ ] Approve/reject pending conversation
- [ ] Confirm dialog khi đổi policy (cảnh báo tin từ thread khác sẽ pending)
- [ ] Link từ ZaloAccountsView.vue
- [ ] Modularize nếu >200 LOC
- [ ] Build check

## Success Criteria

- Hiển thị đầy đủ friends + groups từ Zalo SDK
- Tick → Save → reload → state persist đúng
- Pending tab hiện conversation đang chờ duyệt; bấm Duyệt → biến mất khỏi pending, xuất hiện trong ChatView main
- Loading + error states tử tế (skeleton, retry button)

## Risks

- Account có 5000 friends → render chậm. Mitigate: virtual scroll (`v-virtual-scroll`) hoặc pagination 100/page.
- User tick 1000 thread rồi save → bulk request to. Mitigate: chunk 500 items/request.

## Next Steps

→ Phase 7 (ChatView pending integration)
→ Phase 8 (wizard sau loginQR auto chuyển sang đây)
