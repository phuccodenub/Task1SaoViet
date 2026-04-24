# Phase 4 — Backend Group History Fetch (On-Demand Paginated)

**Priority:** P1
**Status:** TODO
**Effort:** S (~3h)
**Depends:** Phase 1

## Context Links
- File chính sửa: `backend/src/modules/zalo/zalo-message-sync.ts` (extract pagination), `backend/src/modules/zalo/zalo-routes.ts`
- File mới: `backend/src/modules/zalo/zalo-history-routes.ts`

## Mục tiêu

User bấm "Tải thêm" trên ChatView (group conversation) → backend gọi `api.getGroupChatHistory(threadId, count)` lặp với pagination, dedup, persist tin mới, trả số tin đã thêm.

## API design

### POST `/api/v1/conversations/:convId/fetch-history`

**Body:**
```json
{ "batchSize": 100, "maxBatches": 5 }
```

- `batchSize`: tin/lần gọi Zalo (default 50, max 200)
- `maxBatches`: số lần gọi (default 1, max 10) → chống user spam

**Response:**
```json
{
  "added": 87,
  "exhausted": false,
  "oldestMessageAt": "2026-03-01T10:00:00Z"
}
```

`exhausted=true` khi Zalo trả `more=0` → frontend disable nút "Tải thêm".

## Implementation Steps

### 1. Refactor `zalo-message-sync.ts` — extract `fetchAndPersistGroupBatch`

Tách logic batch insert hiện tại thành function pure để tái sử dụng:

```ts
export async function fetchAndPersistGroupBatch(
  api: any,
  conv: { id: string; externalThreadId: string },
  accountId: string,
  count: number,
  beforeMsgId?: string,  // pagination cursor
): Promise<{ added: number; oldestMsgId: string | null; oldestTs: number | null; more: boolean }>
```

Logic:
- Gọi `api.getGroupChatHistory(threadId, count)` (chú ý: SDK chưa support `before` cursor → kiểm tra response có `lastActionId` không, nếu có thì pass qua `api.custom()` hoặc multiple call rồi filter)
- Reuse dedup (batch query existing zaloMsgIds) y như hiện tại
- Insert qua `handleIncomingMessage` với `isBackfill: true`
- Trả info để caller paginate

### 2. New file `zalo-history-routes.ts`

```ts
app.post('/api/v1/conversations/:convId/fetch-history', { preHandler: requireZaloAccess('chat') },
  async (req, reply) => {
    const { convId } = req.params;
    const { batchSize = 50, maxBatches = 1 } = req.body;
    const conv = await prisma.conversation.findFirst({
      where: { id: convId, orgId: user.orgId },
      select: { id: true, externalThreadId: true, threadType: true, zaloAccountId: true, historyExhausted: true },
    });
    if (!conv) return reply.status(404).send(...);
    if (conv.threadType !== 'group') {
      // Defer to phase 5 endpoint cho user 1-1
      return reply.status(400).send({ error: 'Use user-history endpoint for 1-1 chats' });
    }
    if (conv.historyExhausted) return { added: 0, exhausted: true };

    const instance = zaloPool.getInstance(conv.zaloAccountId);
    if (!instance?.api) return reply.status(400).send({ error: 'Account not connected' });

    let totalAdded = 0;
    let cursor: string | undefined;
    let exhausted = false;
    for (let i = 0; i < Math.min(maxBatches, 10); i++) {
      const result = await fetchAndPersistGroupBatch(instance.api, conv, conv.zaloAccountId, Math.min(batchSize, 200), cursor);
      totalAdded += result.added;
      if (!result.more || result.added === 0) {
        exhausted = true;
        break;
      }
      cursor = result.oldestMsgId ?? undefined;
      // Soft rate limit: 500ms giữa các batch
      await new Promise(r => setTimeout(r, 500));
    }

    // Update conversation tracking
    await prisma.conversation.update({
      where: { id: conv.id },
      data: {
        historyExhausted: exhausted,
        oldestMessageAt: /* min sentAt computed */,
      },
    });

    return { added: totalAdded, exhausted };
  }
);
```

### 3. Sửa cron sync hiện tại để cập nhật `oldestMessageAt`

`zalo-message-sync.ts` syncGroupMessages — sau loop, update conversation.oldestMessageAt nếu nhỏ hơn current.

## Todo

- [ ] Refactor `fetchAndPersistGroupBatch` từ syncGroupMessages
- [ ] Tạo `zalo-history-routes.ts`
- [ ] Verify pagination cursor (`lastActionId` từ getGroupChatHistory response — đọc zca-js source nếu cần)
- [ ] Rate limit 500ms giữa batches
- [ ] Update conversation.historyExhausted, oldestMessageAt
- [ ] Register routes trong app.ts
- [ ] Compile check
- [ ] Manual test: gọi endpoint với conversation group thật, verify tin được persist

## Success Criteria

- Endpoint trả `added` đúng số tin mới
- Pagination hoạt động: gọi nhiều batch không trùng tin
- Khi `more=0` → `exhausted=true`, conversation.historyExhausted=true
- Không crash khi account disconnect

## Risks

- Pagination của `getGroupChatHistory` chỉ hỗ trợ `count` không có `before` cursor rõ ràng (theo source zca-js đã xem) → có thể phải dùng `api.custom()` để gọi endpoint Zalo trực tiếp với param `lastActionId`. Nếu vậy, đào sâu trong phase 5.
- Nếu group có 50000 tin, user bấm liên tục → có thể nuke DB. Mitigate: `maxBatches` cap, có thể thêm daily quota per account ở phase sau.

## Next Steps

→ Phase 5 (1-1 history với api.custom)
→ Phase 7 (UI nút "Tải thêm")
