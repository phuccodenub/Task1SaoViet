-- Phase 1: Conversation visibility + allowlist enforcement + history-fetch tracking
-- Safe for existing deployments: all new columns have defaults that preserve v2.1 behavior.

-- 1. ZaloAccount.ingest_policy — default 'all' keeps legacy ingest untouched
ALTER TABLE "zalo_accounts"
    ADD COLUMN IF NOT EXISTS "ingest_policy" TEXT NOT NULL DEFAULT 'all';

-- 2. Conversation: visibility lifecycle + review audit + history backfill cursor
ALTER TABLE "conversations"
    ADD COLUMN IF NOT EXISTS "visibility"          TEXT NOT NULL DEFAULT 'visible',
    ADD COLUMN IF NOT EXISTS "hidden_at"           TIMESTAMP(3),
    ADD COLUMN IF NOT EXISTS "hidden_by_user_id"   TEXT,
    ADD COLUMN IF NOT EXISTS "reviewed_at"         TIMESTAMP(3),
    ADD COLUMN IF NOT EXISTS "reviewed_by_user_id" TEXT,
    ADD COLUMN IF NOT EXISTS "oldest_message_at"   TIMESTAMP(3),
    ADD COLUMN IF NOT EXISTS "history_exhausted"   BOOLEAN NOT NULL DEFAULT false;

-- Composite index for visibility-scoped conversation lists
CREATE INDEX IF NOT EXISTS "conversations_org_id_visibility_last_message_at_idx"
    ON "conversations" ("org_id", "visibility", "last_message_at");

-- 3. ZaloThreadAllowlist — per-account list of threads that bypass pending review
CREATE TABLE IF NOT EXISTS "zalo_thread_allowlist" (
    "id"                 TEXT PRIMARY KEY,
    "zalo_account_id"    TEXT NOT NULL,
    "external_thread_id" TEXT NOT NULL,
    "thread_type"        TEXT NOT NULL,
    "enabled"            BOOLEAN NOT NULL DEFAULT true,
    "added_by_user_id"   TEXT NOT NULL,
    "note"               TEXT,
    "created_at"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "zalo_thread_allowlist_zalo_account_id_fkey"
        FOREIGN KEY ("zalo_account_id") REFERENCES "zalo_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "zalo_thread_allowlist_added_by_user_id_fkey"
        FOREIGN KEY ("added_by_user_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "zalo_thread_allowlist_zalo_account_id_external_thread_id_key"
    ON "zalo_thread_allowlist" ("zalo_account_id", "external_thread_id");

CREATE INDEX IF NOT EXISTS "zalo_thread_allowlist_zalo_account_id_enabled_idx"
    ON "zalo_thread_allowlist" ("zalo_account_id", "enabled");
