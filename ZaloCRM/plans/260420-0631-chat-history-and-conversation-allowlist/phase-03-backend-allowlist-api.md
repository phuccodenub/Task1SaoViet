# Phase 3 — Backend Allowlist API

**Priority:** P0
**Status:** TODO
**Effort:** M (~4h)
**Depends:** Phase 1, 2

## Context Links
- Files mới: `backend/src/modules/zalo/zalo-allowlist-routes.ts`
- Files sửa: `backend/src/modules/zalo/zalo-routes.ts` (đăng ký routes), `backend/src/app.ts` (register module nếu cần)

## Endpoints

Tất cả prefix `/api/v1/zalo-accounts/:id`, requireZaloAccess('chat') (member trở lên).

### 1. GET `/allowlist`

Trả full allowlist của account.

**Response:**
```json
{
  "policy": "allowlist" | "all",
  "items": [
    { "externalThreadId": "...", "threadType": "user", "enabled": true, "addedAt": "...", "addedByName": "..." }
  ]
}
```

### 2. PATCH `/ingest-policy`

Đổi policy. Yêu cầu owner/admin (không phải member-chat).

**Body:** `{ policy: "all" | "allowlist" }`
**Response:** `{ policy }`
**Side effect:** invalidateAllowlistCache(accountId)

### 3. POST `/allowlist/bulk`

Add/remove nhiều thread cùng lúc.

**Body:**
```json
{
  "add": [{"externalThreadId":"...","threadType":"user"}],
  "remove": ["...threadId..."],
  "enable": ["...threadId..."],
  "disable": ["...threadId..."]
}
```

**Response:** `{ added, removed, updated }`

### 4. POST `/conversations/:convId/approve`

Duyệt 1 conversation pending → visibility='visible' + add allowlist.

**Body:** `{}` (đơn giản)
**Side effect:**
- Conversation: visibility='visible', reviewedAt=now, reviewedByUserId=user.id
- ZaloThreadAllowlist: upsert (zaloAccountId + externalThreadId từ conversation)
- invalidateAllowlistCache

### 5. POST `/conversations/:convId/reject`

Từ chối → visibility='hidden' (không xoá data).

**Side effect:** hiddenAt, hiddenByUserId, KHÔNG add allowlist (để future tin từ thread này tiếp tục pending → user có cơ hội duyệt lại).

### 6. GET `/zalo-accounts/:id/available-threads`

Lấy danh sách friend + group từ Zalo SDK để hiển thị trong UI quản lý allowlist.

```ts
const instance = zaloPool.getInstance(id);
const [friends, groups] = await Promise.all([
  instance.api.getAllFriends(),
  instance.api.getAllGroups(),
]);
// Map về format chung: { externalThreadId, threadType, displayName, avatar, inAllowlist: bool, hasConversation: bool }
```

Cache 5 phút per account để tránh spam Zalo API.

## Implementation Steps

1. Tạo `zalo-allowlist-routes.ts` (~150 LOC), import vào `app.ts` register
2. Tạo helper `zalo-thread-listing.ts` cho endpoint #6 (cache logic, kebab-case)
3. Implement 6 endpoints
4. Mỗi endpoint thay đổi state → gọi `invalidateAllowlistCache(accountId)`
5. Compile check

## Todo

- [ ] Tạo `zalo-allowlist-routes.ts`
- [ ] Tạo `zalo-thread-listing.ts` (helper với cache)
- [ ] Endpoint GET /allowlist
- [ ] Endpoint PATCH /ingest-policy (requireRole owner/admin)
- [ ] Endpoint POST /allowlist/bulk
- [ ] Endpoint POST /conversations/:convId/approve
- [ ] Endpoint POST /conversations/:convId/reject
- [ ] Endpoint GET /available-threads
- [ ] Register routes trong app.ts
- [ ] Compile check
- [ ] Manual test bằng curl/Postman

## Success Criteria

- Tất cả endpoint trả 200 + payload đúng spec
- Invalidate cache hoạt động (test: allow thread → tin tiếp theo từ thread đó visibility='visible' ngay, không chờ 60s)
- Permission đúng: member-chat → CRUD allowlist OK; member-read → 403; chỉ owner/admin đổi policy

## Risks

- `getAllFriends` + `getAllGroups` có thể chậm (Zalo API) → cache 5 phút bắt buộc
- Bulk operation có thể to → giới hạn 500 items/request

## Next Steps

→ Phase 6 (UI allowlist management)
