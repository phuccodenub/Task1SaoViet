# Migration từ ZaloCRM v2.1 → v2.2

**Status:** Idempotent, backward-compat. Không phá integration hiện có.

---

## TL;DR

1. `git pull` code mới, `npm install` cả `backend/` và `frontend/`.
2. Chạy `npx prisma migrate deploy` trong `backend/` → apply migration `20260422184100_add_conversation_visibility_and_allowlist`.
3. Restart backend. Frontend build lại.
4. **Không có bước cấu hình bắt buộc** — mặc định `ingestPolicy='all'` giữ hành vi v2.1. User từng account có thể **chủ động** bật allowlist qua wizard hoặc `/zalo-accounts/:id/allowlist`.

---

## Những gì đổi

### Schema (migration tự động)

```
conversations + visibility TEXT NOT NULL DEFAULT 'visible'
conversations + hidden_at TIMESTAMP NULL
conversations + hidden_by_user_id TEXT NULL
conversations + reviewed_at TIMESTAMP NULL
conversations + reviewed_by_user_id TEXT NULL
conversations + oldest_message_at TIMESTAMP NULL
conversations + history_exhausted BOOLEAN NOT NULL DEFAULT false
conversations + INDEX (org_id, visibility, last_message_at)

zalo_accounts + ingest_policy TEXT NOT NULL DEFAULT 'all'

zalo_thread_allowlist (NEW TABLE)
  id TEXT PK
  zalo_account_id TEXT FK
  external_thread_id TEXT
  thread_type TEXT
  enabled BOOLEAN DEFAULT true
  added_by_user_id TEXT FK
  note TEXT NULL
  created_at, updated_at TIMESTAMP
  UNIQUE (zalo_account_id, external_thread_id)
  INDEX (zalo_account_id, enabled)
```

Migration sử dụng `IF NOT EXISTS` — an toàn chạy lại nhiều lần. Row cũ nhận default `visibility='visible'` + account cũ nhận `ingest_policy='all'`.

### Hành vi

| Thành phần | v2.1 | v2.2 mặc định | v2.2 khi bật allowlist |
|---|---|---|---|
| Hội thoại mới từ Zalo | `visibility='visible'` (implicit) | Giữ nguyên | `visibility='pending'` nếu thread chưa allow |
| `contact.created` webhook | Bắn mọi lần | Bắn mọi lần | **Không** bắn cho pending/hidden |
| `message.*` webhook | Bắn mọi lần | Bắn mọi lần | **Không** bắn cho pending/hidden |
| Automation rules | Chạy mọi tin | Chạy mọi tin | **Không** chạy cho pending/hidden |
| `GET /api/v1/conversations` | Trả tất cả | Default `visibility='visible'` | Cần `?visibility=pending` để thấy pending |
| Public API `POST /api/public/messages/send` | 200 | 200 visible; 409 cho pending/hidden | Giữ nguyên 409 khi không visible |

### Endpoint mới

- `GET /api/v1/zalo-accounts/:id/allowlist`
- `PATCH /api/v1/zalo-accounts/:id/ingest-policy`
- `POST /api/v1/zalo-accounts/:id/allowlist/bulk`
- `POST /api/v1/conversations/:id/approve`
- `POST /api/v1/conversations/:id/reject`
- `GET /api/v1/zalo-accounts/:id/available-threads`
- `POST /api/v1/conversations/:id/fetch-history` (group only)
- `GET /api/v1/conversations/:id/messages?before=<msgId>` (cursor pagination, backward-compat)

Socket emit thêm field `visibility` trong mọi `chat:message` event. Chi tiết xem [ADR-001](../backend/docs/adr-001-default-ingest-policy.md) + `backend/plans/reports/codex-followup-*.md`.

---

## Bước triển khai

### 1. Backup (luôn làm)

```
pg_dump -U <user> <db> > backup_before_v22.sql
```

Hoặc dùng container `postgres-backup-local` đã có sẵn trong `docker-compose.yml`.

### 2. Pull code và install

```
cd ZaloCRM
git pull
cd backend && npm install
cd ../frontend && npm install
```

### 3. Chạy migration

```
cd backend
DATABASE_URL=<postgres-url> npx prisma migrate deploy
```

Output kỳ vọng:
```
Applying migration `20260422184100_add_conversation_visibility_and_allowlist`
The following migration(s) have been applied: 1
```

Verify:
```sql
SELECT column_name FROM information_schema.columns
WHERE table_name='conversations' AND column_name IN ('visibility', 'history_exhausted');
-- Should return 2 rows
```

### 4. Regenerate Prisma client

Tự động qua `prisma migrate deploy`. Nếu cần chạy tay: `npx prisma generate`.

### 5. Build & restart

```
cd backend && npm run build
cd ../frontend && npm run build
docker compose up -d --build   # nếu dùng Docker
```

### 6. Smoke test

Chạy contract smoke script (cần staging env + tokens):

```
BASE=... ADMIN_TOKEN=... MEMBER_TOKEN=... API_KEY=... \
ACCOUNT_ID=... THREAD_ID_HIDDEN=... HIDDEN_CONV_ID=... \
INACCESSIBLE_ACCOUNT_ID=... \
bash backend/scripts/contract-smoke-test.sh
```

11/12 assertion chạy được không cần live send. Thêm `ALLOW_LIVE_SEND=1 THREAD_ID_VISIBLE=<smoke-thread>` để test send thật (cảnh báo: gửi tin nhắn vào khách).

Expected: all assertions pass.

---

## Bật allowlist mode cho account hiện có

Chỉ chạy khi bạn thực sự muốn filter. Nếu đang hài lòng với hành vi v2.1, **không cần làm gì**.

### Qua UI (khuyến nghị)

1. Login với role `owner` hoặc `admin`.
2. Vào `/zalo-accounts`.
3. Với account muốn bật allowlist, bấm icon mũ phù thủy (🧙) → mở wizard.
4. Wizard mặc định tick tất cả thread đã có conversation visible → bấm Hoàn tất.

### Qua API

```bash
# 1. Đổi policy
curl -X PATCH $BASE/api/v1/zalo-accounts/<account-id>/ingest-policy \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"policy": "allowlist"}'

# 2. Thêm thread vào allowlist
curl -X POST $BASE/api/v1/zalo-accounts/<account-id>/allowlist/bulk \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"add":[{"externalThreadId":"<zalo-uid>","threadType":"user"}]}'
```

---

## Rollback plan

Nếu cần revert về v2.1:

1. Downgrade code về tag/commit v2.1.
2. Schema mới **không** cản trở v2.1 chạy — v2.1 code không đọc cột mới, không break.
3. Nếu muốn xóa schema (không khuyến nghị — mất data pending):
   ```sql
   ALTER TABLE conversations DROP COLUMN visibility;
   ALTER TABLE conversations DROP COLUMN hidden_at;
   -- ... 5 cột còn lại
   ALTER TABLE zalo_accounts DROP COLUMN ingest_policy;
   DROP TABLE zalo_thread_allowlist;
   ```

Tốt hơn: giữ schema mới, downgrade code — schema lành cho cả 2 version.

---

## Checklist sau khi migrate

- [ ] Backend `/health` trả `status: ok`.
- [ ] `GET /api/v1/conversations` trả response cũ (không có `visibility` trong filter) vẫn work.
- [ ] Webhook consumer nhận được `message.received` bình thường cho conversation mới.
- [ ] Automation rules chạy bình thường.
- [ ] Frontend `/chat` load được list + gửi tin.
- [ ] Frontend `/zalo-accounts/:id/allowlist` truy cập được (với user có `chat` permission).
- [ ] Socket reconnect không bị reject do JWT auth middleware (Fix #8 round 2).

Nếu bất kỳ check nào fail, dùng rollback plan hoặc rerun migration deploy.
