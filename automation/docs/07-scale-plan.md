# Phase 3.2 — Scale plan

## A. Zalo rate limiter → Redis (implemented)

The in-memory limiter at
`ZaloCRM/backend/src/modules/zalo/zalo-rate-limiter.ts` was rewritten to use
Redis whenever `REDIS_URL` (or `REDIS_HOST`) is present, falling back to the
original in-memory maps otherwise. Send paths now use `reserveSend()`, backed by
a Lua script that checks daily/burst limits and records the send token in one
atomic Redis operation. Shared state lets us:

- Run more than one backend replica behind a load balancer without one
  account exceeding the 200 msg/day cap or burst window by racing
  check-and-record calls.
- Centralise observability — Redis key `zalo:rl:daily:<accountId>:<YYYY-MM-DD>`
  is trivially inspectable for on-call staff.

Deploy steps:

1. Add to the backend env (use the automation stack Redis):
   ```env
   REDIS_HOST=redis
   REDIS_PORT=6379
   REDIS_PASSWORD=<same as automation/.env>
   ```
2. `cd ZaloCRM/backend && npm install` (brings in `ioredis`).
3. Rolling-restart the backend containers; the limiter resumes state from
   Redis automatically.

Rollback: unset `REDIS_HOST`/`REDIS_URL`; limiter falls back to in-memory.
No schema changes, no data migration. In production with more than one backend
replica, treat continuous Redis fallback logs as a quota-safety incident.

## B. Contact/Conversation scale plan (≥ 50K contacts)

The current `contacts` table keeps `lastActivity`, `leadScore`, `nextAppointment`,
`tags`, `metadata` all in one row. That's fine today, but two traffic patterns
make it heavy when contacts exceed ~50K:

1. `updateMany` on every inbound message updates `last_activity` → row
   rewrites dominate WAL.
2. Sales pipeline queries (`status`, `leadScore`, `lastActivity`) touch all
   rows even for the 10% active tail.

### Proposed split: `LeadActivity` table

Introduce a lean side-table that holds hot, high-write fields:

```prisma
model LeadActivity {
  contactId     String   @id @map("contact_id")
  orgId         String   @map("org_id")
  lastActivity  DateTime @default(now()) @map("last_activity")
  lastChannel   String   @default("zalo") @map("last_channel")
  msgCount7d    Int      @default(0) @map("msg_count_7d")
  leadScore     Int      @default(0) @map("lead_score")
  updatedAt     DateTime @updatedAt @map("updated_at")

  contact Contact @relation(fields: [contactId], references: [id], onDelete: Cascade)

  @@index([orgId, lastActivity])
  @@index([orgId, leadScore])
  @@map("lead_activity")
}
```

Migration sketch:

1. `CREATE TABLE lead_activity ...` (Prisma migration, additive only).
2. Backfill:
   ```sql
   INSERT INTO lead_activity (contact_id, org_id, last_activity, lead_score, updated_at)
   SELECT id, org_id, COALESCE(last_activity, created_at), lead_score, NOW()
   FROM contacts
   ON CONFLICT (contact_id) DO NOTHING;
   ```
3. Dual-write phase: when code updates `contacts.last_activity` or
   `contacts.lead_score`, also upsert into `lead_activity`.
4. Switch readers (dashboards, pipeline queries) to `lead_activity`.
5. Drop `contacts.last_activity` and `contacts.lead_score` once all code
   paths migrated (optional — keep for quick reverts).

### Other scale levers

- **Partition `messages`** by month once size passes ~10M rows (native Postgres
  range partitioning + `pg_partman`). Most dashboards only need the last 90 days.
- **Archive** resolved conversations older than 180 days to cold storage
  (Cloudflare R2) via `pg_dump --table=messages --where='created_at < ...'`.
- **Read replica** for the Grafana Postgres datasource once p95 latency
  exceeds 500 ms on production load.

### Decision gate

Do **not** execute the LeadActivity split until contacts reach **≥ 50K** AND
one of:

- p95 `contacts` UPDATE latency > 50 ms over a 1h window, OR
- WAL volume attributable to `contacts` > 30 GB/day, OR
- Pipeline dashboard load time > 3 s.

Below those thresholds the split costs more maintenance than it saves.
