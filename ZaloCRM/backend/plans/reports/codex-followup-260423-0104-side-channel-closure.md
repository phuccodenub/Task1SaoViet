# Codex Follow-up Round 4 — Side-Channel Closure + ADR

**Date:** 2026-04-23 01:04 (Asia/Saigon)
**CWD:** `H:\Task1SaoViet\ZaloCRM\frontend`
**Previous:** `backend/plans/reports/codex-followup-260422-2217-side-channel-audit.md`

---

## Tự đánh giá

Codex đúng cả 4. Mỗi finding mình verify qua code:

1. **Public API read bypass** — confirmed. Round 3 chỉ check send path, miss read path → asymmetric. API key có thể GET pending/hidden conversation bodies.
2. **Pending envelope still org-wide với identifiers** — đúng, accountId+conversationId+messageId+sentAt đủ inference. Member không có account access vẫn biết "có account X có conv Y nhận tin lúc Z".
3. **REST account-management quá rộng** — đúng, member có thể trigger loginAccount/delete cho account không có access → disrupt session.
4. **Group history "safe placeholder"** — đúng, hiện chỉ recent window. Codex chấp nhận nếu document rõ là limitation.

**Plan deviation Codex chỉ ra:** plan ban đầu "default allowlist", code default 'all'. Lý do backward compat. Cần document → ADR.

Codex chấm 7.5/10 round 3. Round này close hết 4 findings + ADR.

---

## Fixes (4/4 + 1 doc)

| # | Codex finding | Severity | Status |
|---|---|---|---|
| 18 | Public API read bypass visibility | P1 | ✅ |
| 19 | Pending socket envelope identifier leak | P2 | ✅ |
| 20 | REST account-management ACL gap | P1 | ✅ |
| 21 | Group history not paginated | P2 | ✅ documented as limitation (already done in round 2 header) |
| 22 | ADR for ingestPolicy default | doc | ✅ |

---

## 2. Detail changes

### Fix #18 — Public API read visibility
**File:** `backend/src/modules/api/public-api-routes.ts`

- `GET /api/public/conversations`:
  - Default filter `visibility='visible'` (matches internal REST)
  - Query param `?visibility=pending|hidden|all` for explicit opt-in
  - Response includes `visibility` field per row so consumer can route
- `GET /api/public/conversations/:id/messages`:
  - Lookup conv visibility first
  - 409 if non-visible unless caller passes `?includeNonVisible=true` (explicit acknowledgement)
  - Response includes `visibility` so consumer knows what they got

KISS — không thêm permission model riêng cho public API key (auth đã scoped per-org). Default tight, opt-in explicit.

### Fix #19 — Pending envelope identifier scrub
**Files:**
- `backend/src/modules/zalo/zalo-listener-factory.ts` — `emitChatMessage` rewrite
- `frontend/src/composables/use-chat.ts` — handler updated

**Strategy:** đưa pending envelope sang `account:<id>` room (cùng ACL với visible) + strip identifiers.

Payload mới: `{ accountId, visibility: 'pending' }` (chỉ vậy). Client nhận event → refetch counts/conversations qua REST (đã có ACL). Không có conversationId/messageId/sentAt cross boundary.

**Trade-off accept:** member không có account access không nhận pending event của account đó → counter "Chờ duyệt" không update realtime cross-account. Acceptable: counter chỉ là badge, REST refetch trong polling/route enter là đủ. Quan trọng hơn là không leak metadata.

### Fix #20 — REST account-management ACL parity
**File:** `backend/src/modules/zalo/zalo-routes.ts`

| Endpoint | Old guard | New guard |
|---|---|---|
| GET list | org only | filtered: owner/admin see all; member see access rows OR ownerUserId match |
| POST create | org only | `requireRole('owner','admin')` |
| POST :id/login | org only | `requireZaloAccess('admin')` |
| POST :id/reconnect | org only | `requireZaloAccess('admin')` |
| DELETE :id | org only | `requireZaloAccess('admin')` |
| GET :id/status | org only | `requireZaloAccess('read')` |

Rationale comment ở header file: list filter = không discover account không có quyền; admin-level guard cho destructive ops = không kick session người khác.

**Compatibility note:** đổi POST create từ "any member" → "owner/admin". Member tạo account trong v2.1 sẽ bị 403. Acceptable vì creating account là decision org-level. Document trong ADR-001.

### Fix #21 (group history) — already documented
File `zalo-history-routes.ts` header (round 2) đã ghi rõ:
> "Pagination caveat (Fix #5): the SDK's getGroupChatHistory only takes `count`, not a cursor... only mark historyExhausted=true when upstream explicitly returns more=false"

Codex chấp nhận. Cursor work defer P5 (api.custom wrapper).

### Fix #22 — ADR-001
**File:** `backend/docs/adr-001-default-ingest-policy.md` (~80 lines)

Document:
- Quyết định: default `ingestPolicy='all'` (không phải `'allowlist'` như plan)
- Lý do chính: backward compat cho production v2.1 deployments với webhook consumers, n8n workflows
- "Data never lost either way" — pending vẫn persist, chỉ skip downstream
- Rollout plan future: nếu muốn allowlist-default thì release UI trước, migration guide, named migration riêng
- Counter-arguments + references đầy đủ

---

## 3. Verification

```
backend:  npx tsc --noEmit     → exit 0
frontend: npx vue-tsc --noEmit → exit 0
```

---

## 4. Files modified this round

**Backend (3):**
| File | Change |
|---|---|
| `public-api-routes.ts` | Visibility filter + 409 on non-visible read |
| `zalo-listener-factory.ts` | Pending envelope → account room, strip identifiers |
| `zalo-routes.ts` | ACL guards on every endpoint (list filter + role/access) |

**Frontend (1):**
| File | Change |
|---|---|
| `use-chat.ts` | Pending handler updated for stripped payload |

**Docs (1):**
| File | Change |
|---|---|
| `backend/docs/adr-001-default-ingest-policy.md` | New ADR |

No new TS modules. ~120 LOC total delta.

---

## 5. Final contract matrix (round 4 complete)

### Visibility
| Op | visible | pending | hidden |
|---|---|---|---|
| Persist | ✓ | ✓ | ✓ |
| contact.created webhook | ✓ | ✗ | ✗ |
| message webhook/automation | ✓ | ✗ | ✗ |
| Socket `chat:message` | full → `account:<id>` | scrubbed envelope → `account:<id>` | no emit |
| Internal POST send | 200 | 409 | 409 |
| Public API POST send | 200 | 409 | 409 |
| Public API GET list | shown | opt-in via `?visibility=pending` | opt-in via `?visibility=hidden` |
| **Public API GET messages** | **200** | **409 unless `?includeNonVisible=true`** | **same** |
| REST list default | shown | opt-in | opt-in |

### REST account-management (parity với socket)
| Op | Permission |
|---|---|
| GET list | filtered to accessible |
| GET :id/status | `requireZaloAccess('read')` |
| POST create | `requireRole('owner','admin')` |
| POST :id/login | `requireZaloAccess('admin')` |
| POST :id/reconnect | `requireZaloAccess('admin')` |
| DELETE :id | `requireZaloAccess('admin')` |

### Socket ACL
- `org:<orgId>` chỉ dùng cho non-sensitive events (zalo:connected/disconnected/etc)
- `account:<id>` carry mọi chat content + pending counter, ACL-gated tại subscribe
- Pending payload chỉ có `{accountId, visibility}` — không có conv/msg id

### Account lifecycle
- Create → atomic account + access row + `requireRole`
- Legacy account → ownerUserId fallback trong subscribe

### Default policy
- `ingestPolicy='all'` per ADR-001 (backward compat)
- Allowlist mode opt-in per-account

---

## 6. Remaining limitations (documented, defer to P5+)

1. **Group history cursor** — SDK không support cursor; recent window only. `historyExhausted` chỉ confident khi upstream `more=false`. Cursor wrapper ở `api.custom()` defer P5.
2. **1-1 history** — defer P5 (cùng lý do api.custom).
3. **Pending counter cross-account realtime** — member không thấy account ngoài quyền có pending; counter update qua REST poll. Trade-off để strip metadata.
4. **Public API permission granularity** — chỉ org-scoped, chưa per-key. Nếu cần "n8n key chỉ đọc visible" vs "internal key đọc tất cả" thì cần API key role model. Defer cho đến khi thực sự cần.

---

## 7. Files modified across all 4 rounds (for PR scope review)

**Backend (15):**
- `prisma/schema.prisma`, migration `20260422184100_*`
- `src/app.ts`
- `src/shared/redis/redis-client.ts`
- `src/modules/chat/message-handler.ts`, `chat-routes.ts`
- `src/modules/zalo/zalo-allowlist-cache.ts` (new)
- `src/modules/zalo/zalo-allowlist-routes.ts` (new)
- `src/modules/zalo/zalo-history-routes.ts` (new)
- `src/modules/zalo/zalo-thread-listing.ts` (new)
- `src/modules/zalo/zalo-message-sync.ts`
- `src/modules/zalo/zalo-listener-factory.ts`
- `src/modules/zalo/zalo-pool.ts`
- `src/modules/zalo/zalo-socket.ts`
- `src/modules/zalo/zalo-routes.ts`
- `src/modules/api/public-api-routes.ts`

**Frontend (2):**
- `src/composables/use-chat.ts`
- `src/composables/use-zalo-accounts.ts`

**Docs (1):**
- `backend/docs/adr-001-default-ingest-policy.md`

**Reports (4):**
- `implementation-260422-1841-backend-p1-p4.md`
- `codex-followup-260422-1930-p1-p2-blockers.md`
- `codex-followup-260422-2015-hardening-pass.md`
- `codex-followup-260422-2217-side-channel-audit.md`
- `codex-followup-260423-0104-side-channel-closure.md` (this)

**Out-of-scope changes still present in working tree** (Codex flagged in round 2):
Redis rate limiter (`zalo-rate-limiter.ts`), `call-webhook-action.ts`, docker-compose port change, content/n8n plan files, automation-service edits. Those should be split into separate PR before backend P1-P4 merge.

---

## 8. Unresolved

Không có. Tất cả P1/P2 Codex đã đóng. P5 cursor work + out-of-scope PR split là next-session items.

**Self-score target round 4:** 9/10 backend readiness for P6-P8 frontend.
**Codex prev:** 7.5/10. Gap closed: 4 P1 + 1 doc.
