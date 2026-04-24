# Phase 5 — Backend R&D: User 1-1 History via api.custom()

**Priority:** P1 (giá trị cao cho sale, nhưng risky)
**Status:** TODO
**Effort:** L (~2-3 ngày R&D + code)
**Depends:** Phase 1
**Có thể chạy song song:** Phase 2-4

## Context Links
- File mới: `backend/src/modules/zalo/zalo-user-history-fetcher.ts`, `backend/src/modules/zalo/zalo-history-routes.ts` (đã tạo phase 4)
- Reference: `api.custom()` trong zca-js — `src/apis/custom.ts`

## Mục tiêu

Reverse-engineer endpoint Zalo Web fetch lịch sử chat 1-1, wrap qua `api.custom()`, expose endpoint backend cho user bấm "Tải thêm" trên 1-1 conversation.

## R&D phase (BẮT BUỘC trước khi code)

### Step R1: Capture endpoint từ Zalo Web

1. Mở `chat.zalo.me` trong Chrome
2. Mở DevTools → Network tab → filter XHR
3. Mở 1 đoạn chat 1-1 cũ → scroll lên trên (load more)
4. Tìm request có response chứa array messages
5. Ghi lại:
   - URL pattern (dạng `https://chat.zalo.me/api/...`)
   - Method (GET/POST)
   - Query params hoặc body (`uid`, `lastMsgId`, `count`, ...)
   - Headers cần thiết (cookie auth zca-js đã handle)
   - Response shape

### Step R2: Identify encryption

Zalo encrypt params với AES (xem `getGroupChatHistory.ts`). Wrapper qua `api.custom()` cần:
- Truy cập `ctx.secretKey` qua `props.ctx`
- Dùng `utils.encodeAES()` (nếu có), hoặc tự encode

Đọc `getGroupChatHistory.ts` source làm template:
```
https://raw.githubusercontent.com/RFS-ADRENO/zca-js/main/src/apis/getGroupChatHistory.ts
```

### Step R3: Document trong file `phase-05-research-notes.md` (sibling)

Trước khi code production, viết notes file ghi:
- Endpoint URL, params, response
- Cách decrypt
- Test thủ công đã chạy thành công (curl hoặc node script)

### Exit criteria R&D

- ✅ Có request mẫu chạy thành công, trả lịch sử thật
- ❌ Nếu không tìm được endpoint hoặc encrypt quá phức tạp → SKIP phase 5, fallback best-effort `old_messages`, document trong notes

## Implementation Steps (sau khi R&D pass)

### 1. New file `zalo-user-history-fetcher.ts`

```ts
// Wrap api.custom() để gọi endpoint user history
export function attachUserHistoryFetcher(api: any) {
  api.custom('getUserChatHistory', async ({ ctx, utils, props }) => {
    const { userId, lastMsgId, count = 50 } = props;
    // Build params, encrypt, fetch, parse — theo R&D notes
    return { messages: [...], more: boolean, lastMsgId: '...' };
  });
}
```

Gọi `attachUserHistoryFetcher(api)` ngay sau login trong `zalo-pool.ts` (cả `loginQR` và `reconnect`).

### 2. Endpoint `POST /api/v1/conversations/:convId/fetch-history` (dùng chung phase 4)

Mở rộng để xử lý threadType='user':

```ts
if (conv.threadType === 'user') {
  // Rate limit cứng: 1 request / 2s per account
  if (!rateLimit.tryConsume(`history_${accountId}`, 1, 2000)) {
    return reply.status(429).send({ error: 'Rate limit, retry sau 2s' });
  }

  let totalAdded = 0;
  let cursor: string | undefined;
  let exhausted = false;
  for (let i = 0; i < Math.min(maxBatches, 5); i++) {  // cap 5 cho 1-1 (an toàn hơn)
    const result = await api.getUserChatHistory({
      userId: conv.externalThreadId,
      lastMsgId: cursor,
      count: Math.min(batchSize, 100),  // cap 100 cho 1-1
    });

    // Persist qua handleIncomingMessage với isBackfill=true (giống group)
    let added = 0;
    for (const msg of result.messages) {
      const r = await handleIncomingMessage({ ...mapMsg(msg), isBackfill: true });
      if (r) added++;
    }
    totalAdded += added;

    if (!result.more || added === 0) { exhausted = true; break; }
    cursor = result.lastMsgId;
    await sleep(2000);  // 2s giữa batch — RẤT QUAN TRỌNG để không bị Zalo flag
  }

  await prisma.conversation.update(...); // historyExhausted, oldestMessageAt
  return { added: totalAdded, exhausted };
}
```

### 3. Rate limit module

Tận dụng `zalo-rate-limiter.ts` đã có hoặc thêm bucket riêng cho history fetch:
- Per account: max 30 history requests / hour
- Per conversation: max 5 fetch / hour (chống user click "Tải thêm" liên tục)

### 4. Logging + monitoring

Log mỗi history fetch với: accountId, convId, batches, added, latency. Theo dõi xem Zalo có throttle/block không.

## Todo

- [ ] R&D step R1-R3, viết `phase-05-research-notes.md`
- [ ] Quyết định proceed hay skip dựa trên exit criteria
- [ ] Tạo `zalo-user-history-fetcher.ts`
- [ ] Attach vào api sau login (zalo-pool.ts loginQR + reconnect)
- [ ] Mở rộng endpoint fetch-history cho threadType='user'
- [ ] Rate limit cứng 2s + per-account hourly cap
- [ ] Logging
- [ ] Compile check
- [ ] Test on 1 tài khoản dev (KHÔNG test trên tài khoản production)

## Success Criteria

- R&D phase: tìm được endpoint, gọi thành công ít nhất 1 lần
- Production: fetch 100 tin lịch sử của 1 conversation 1-1 không bị Zalo block trong 24h test
- Pagination hoạt động cho ít nhất 5 batches liên tiếp

## Risks (CAO)

| Risk | Mitigation |
|---|---|
| Zalo block account khi gọi quá nhiều | Rate limit 2s + max 5 batches/request + 30 requests/hour |
| Endpoint thay đổi sau update Zalo | Wrap trong try/catch, fallback graceful, alert log |
| Encrypt key thay đổi | Dependency vào zca-js — update khi zca-js update |
| Vi phạm ToS Zalo nặng hơn | User phải tự chịu trách nhiệm — document rõ trong UI |

## Acceptance trên dev account

Test trên 1 tài khoản dev cá nhân, KHÔNG dùng tài khoản business của khách hàng. Nếu sau 1 tuần test:
- Account không bị block → phase pass, ship vào production với feature flag mặc định OFF
- Account bị warning/restrict → revert, document failure, dùng best-effort old_messages

## Next Steps

→ Phase 7 (UI tải thêm history)
→ Document warning rõ ràng cho user trong phase 9
