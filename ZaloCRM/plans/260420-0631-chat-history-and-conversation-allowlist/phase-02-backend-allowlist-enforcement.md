# Phase 2 — Backend Allowlist Enforcement

**Priority:** P0
**Status:** TODO
**Effort:** M (~4h)
**Depends:** Phase 1

## Context Links
- File chính: `backend/src/modules/chat/message-handler.ts`
- Liên quan: `backend/src/modules/chat/chat-routes.ts`, `backend/src/modules/zalo/zalo-message-sync.ts`

## Mục tiêu

Khi `ZaloAccount.ingestPolicy='allowlist'`, tin nhắn từ thread chưa duyệt → tạo conversation với `visibility='pending'` thay vì `'visible'`. Không drop tin để tránh mất dữ liệu sale quan trọng.

## Architecture

```
incoming message
  └─> handleIncomingMessage
        ├─> resolve account.ingestPolicy (cached 60s)
        ├─> if 'all': behavior cũ (visibility='visible')
        └─> if 'allowlist':
              ├─> isThreadAllowed(accountId, threadId)?
              │     ├─> yes → visibility='visible'
              │     └─> no  → visibility='pending'
              └─> persist + emit socket event với visibility flag
```

## Implementation Steps

### 1. Module mới: `backend/src/modules/zalo/zalo-allowlist-cache.ts`

In-memory cache (60s TTL) để tránh DB hit mỗi message:

```ts
// Cache: accountId -> { policy, allowedThreads: Set<string>, cachedAt }
// Invalidation: gọi từ allowlist CRUD endpoints khi user thay đổi
export async function getIngestPolicy(accountId: string): Promise<'all' | 'allowlist'>
export async function isThreadAllowed(accountId: string, threadId: string): Promise<boolean>
export function invalidateAllowlistCache(accountId: string): void
```

File <100 LOC, kebab-case theo convention.

### 2. Sửa `message-handler.ts`

Trong `findOrCreateConversation`:

```ts
// Compute visibility cho conversation MỚI (không động conversation đã có)
let visibility: 'visible' | 'pending' = 'visible';
const policy = await getIngestPolicy(msg.accountId);
if (policy === 'allowlist') {
  const allowed = await isThreadAllowed(msg.accountId, msg.threadId);
  if (!allowed) visibility = 'pending';
}

return prisma.conversation.create({
  data: { ...existing, visibility },
  ...
});
```

### 3. Skip automation cho pending

Trong `handleIncomingMessage`, sau khi tạo message:

```ts
const conv = await prisma.conversation.findUnique({
  where: { id: conversation.id },
  select: { visibility: true },
});
if (conv?.visibility === 'pending') {
  // Skip webhook + automation cho pending conversation
  return { message, conversationId, orgId, contactId };
}
```

(Hoặc query visibility 1 lần lúc findOrCreate, pass xuống)

### 4. Filter visibility trong list endpoints

`chat-routes.ts` — `GET /api/v1/conversations`:

```ts
const { visibility = 'visible' } = request.query;
// Default 'visible' để UI cũ không thấy pending
if (visibility) where.visibility = visibility;
```

`GET /api/v1/conversations/counts` — thêm count cho pending:

```ts
const [unread, unreplied, total, pending] = await Promise.all([
  ...,
  prisma.conversation.count({ where: { ...baseWhere, visibility: 'pending' } }),
]);
return { unread, unreplied, total, pending };
```

### 5. Socket emit — thêm visibility vào payload

`zalo-listener-factory.ts` line 137-141 + `message-handler.ts` return type:
emit `chat:message` cần kèm `visibility` để frontend biết conversation thuộc tab nào.

## Todo

- [ ] Tạo `zalo-allowlist-cache.ts` (kebab-case, <100 LOC, có unit comment)
- [ ] Sửa `message-handler.ts` — gate visibility lúc create conversation
- [ ] Skip automation+webhook cho pending
- [ ] Sửa `chat-routes.ts` — filter visibility, count pending
- [ ] Sửa `zalo-listener-factory.ts` — emit visibility trong socket event
- [ ] Compile check: `npx tsc --noEmit` trong backend
- [ ] Manual test: bật ingestPolicy='allowlist' trên 1 account, gửi tin từ thread không có trong allowlist → conversation phải pending

## Success Criteria

- ingestPolicy='all' → behavior y hệt v2.1 (regression test)
- ingestPolicy='allowlist' + thread allowed → visibility='visible', automation chạy
- ingestPolicy='allowlist' + thread NOT allowed → visibility='pending', automation KHÔNG chạy, webhook KHÔNG bắn
- Counts endpoint trả thêm `pending` field

## Risks

- Cache TTL 60s → user thêm vào allowlist xong vẫn thấy tin pending tới 60s. Mitigate: invalidateAllowlistCache trong CRUD (phase 3).
- Conversation đã `visible` trước đó nhưng giờ không còn trong allowlist → KHÔNG tự đổi sang pending (chỉ áp dụng cho conversation mới). Người dùng phải chủ động ẩn (phase 6).

## Next Steps

→ Phase 3 (CRUD allowlist)
→ Phase 7 (frontend pending tab)
