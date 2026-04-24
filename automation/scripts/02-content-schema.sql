-- Content production auxiliary tables. Lives INSIDE the ZaloCRM Postgres database
-- (so Postgres-side joins against Contact/Conversation stay cheap) but in its
-- own schema `content` to avoid colliding with Prisma-managed tables.
--
-- Usage:
--   docker exec -i zalo-crm-db psql -U crmuser -d zalocrm \
--     < automation/scripts/02-content-schema.sql

CREATE SCHEMA IF NOT EXISTS content;

-- ── Raw items ingested from any source (RSS, scraper, manual)
CREATE TABLE IF NOT EXISTS content.items (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id         TEXT NOT NULL,
    source         TEXT NOT NULL,              -- 'rss:tuoitre', 'scraper:dantri', 'manual'
    canonical_url  TEXT,
    title          TEXT NOT NULL,
    body           TEXT NOT NULL,
    hero_image_url TEXT,
    published_at   TIMESTAMPTZ,
    dedupe_hash    TEXT NOT NULL,              -- SHA-256(canonical_url OR title+first200chars)
    raw_payload    JSONB NOT NULL DEFAULT '{}'::jsonb,
    status         TEXT NOT NULL DEFAULT 'ingested', -- ingested, filtered, enriched, fanning_out, batch_rewriting, drafted, done, failed
    enrich_result  JSONB,                      -- {topic, tone, audience, keypoints, brandFit, factualityScore}
    filter_reason  TEXT,
    locked_at      TIMESTAMPTZ,                -- non-NULL while a transitional status (fanning_out / batch_rewriting) is held; NULL in terminal states. WF07 uses this to surface items stuck >30m.
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE content.items ADD COLUMN IF NOT EXISTS locked_at TIMESTAMPTZ;
-- Backfill (round Y, Codex #9 P2): on a DB that already ran workflows BEFORE
-- round V introduced locked_at, transitional-state rows have locked_at=NULL
-- so WF07 Branch B (`WHERE locked_at IS NOT NULL AND locked_at < now()-30m`)
-- silently skips them — legacy stuck items become invisible dead-letters.
-- This UPDATE is idempotent (guarded by IS NULL + status filter) and safe to
-- re-run. On a fresh DB it matches zero rows.
UPDATE content.items
   SET locked_at = COALESCE(updated_at, created_at, now())
 WHERE status IN ('fanning_out', 'batch_rewriting')
   AND locked_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS ux_content_items_dedupe ON content.items (org_id, dedupe_hash);
CREATE INDEX IF NOT EXISTS ix_content_items_status ON content.items (org_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_content_items_stuck
    ON content.items (org_id, status, locked_at)
    WHERE status IN ('fanning_out','batch_rewriting');

-- ── Platform-specific drafts produced by AI rewrite (fan-out)
CREATE TABLE IF NOT EXISTS content.drafts (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    item_id        UUID NOT NULL REFERENCES content.items(id) ON DELETE CASCADE,
    org_id         TEXT NOT NULL,
    platform       TEXT NOT NULL,              -- facebook, zalo_oa, tiktok, linkedin, instagram
    variant_key    TEXT NOT NULL DEFAULT 'v1', -- for A/B testing: v1, v2, hook_a, hook_b
    body           TEXT NOT NULL,
    media_urls     JSONB NOT NULL DEFAULT '[]'::jsonb,
    hashtags       JSONB NOT NULL DEFAULT '[]'::jsonb,
    status         TEXT NOT NULL DEFAULT 'draft', -- draft, pending_review, approved, rejected, scheduled, published, failed, manual_required
    qa_result      JSONB,                      -- {policyOk, plagiarism, risk, notes}
    reject_reason  TEXT,
    scheduled_at   TIMESTAMPTZ,
    published_at   TIMESTAMPTZ,
    external_id    TEXT,                       -- platform post ID after publish
    queued_at      TIMESTAMPTZ,                -- non-NULL when the draft is editor-visible: either pushed to the Google Sheet review queue, or terminal without needing the sheet (rejected / failed-at-draft). WF06 Mark item drafted only counts rows with queued_at IS NOT NULL.
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE content.drafts ADD COLUMN IF NOT EXISTS queued_at TIMESTAMPTZ;
-- Backfill (round Y, Codex #9 P2): legacy drafts predate round V semantics
-- where queued_at = 'editor-visible' marker. Before V3, ANY draft row was
-- implicitly considered visible (the old gate counted rows, not queued_at),
-- so we honor that legacy assumption and backfill every non-'draft' status
-- (i.e. anything that left the local draft state and had an editorial
-- lifecycle) as editor-visible. 'draft' rows (pre-QA local) stay NULL so
-- they are not counted toward plannedCount until they reach pending_review.
--
-- Rationale for the specific status list: all of these states imply an
-- editor or downstream system has seen the row at least once — either via
-- the Google Sheet (pending_review → approved/rejected), via the admin UI
-- (batch-v1 → pending_review/approved), or via the publisher (scheduled →
-- published/failed). A draft that is 'rejected'/'failed'/'manual_required'
-- is terminal and visible via the editor's own decision log.
--
-- Idempotent: the IS NULL guard plus status filter means re-running this
-- never re-touches a row that already has queued_at set.
-- Fresh DB: matches zero rows.
UPDATE content.drafts
   SET queued_at = COALESCE(updated_at, created_at, now())
 WHERE status IN ('pending_review', 'approved', 'scheduled', 'published',
                  'rejected', 'failed', 'manual_required')
   AND queued_at IS NULL;

CREATE INDEX IF NOT EXISTS ix_content_drafts_due ON content.drafts (org_id, status, scheduled_at) WHERE status IN ('approved','scheduled');
CREATE INDEX IF NOT EXISTS ix_content_drafts_platform ON content.drafts (org_id, platform, status, scheduled_at DESC);
CREATE INDEX IF NOT EXISTS ix_content_drafts_item ON content.drafts (item_id);
-- Enforce one draft per (item, platform, variant). Both fan-out paths
-- (WF06 single-item, WF08 batch-rewrite) use ON CONFLICT ... DO UPDATE
-- SET updated_at = now() RETURNING ... (round X, Codex #8 P1 fix). The
-- DO UPDATE is deliberately a no-op on body/hashtags/status so editor
-- changes via the admin UI are preserved across workflow retries; the
-- RETURNING clause guarantees the Postgres node emits rows even on a
-- full-conflict retry, which is required so the downstream `Mark items
-- drafted` gate actually fires. This index is therefore not just a
-- dedupe guard — it is also the contract that makes the upsert
-- idempotent and retry-safe.
CREATE UNIQUE INDEX IF NOT EXISTS ux_content_drafts_variant
    ON content.drafts (item_id, platform, variant_key);

-- ── Audit log of every publish attempt
CREATE TABLE IF NOT EXISTS content.publish_log (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    draft_id      UUID NOT NULL REFERENCES content.drafts(id) ON DELETE CASCADE,
    platform      TEXT NOT NULL,
    attempt       INT NOT NULL,
    status        TEXT NOT NULL,               -- success, retrying, failed, manual_required
    external_id   TEXT,
    error_code    TEXT,
    error_message TEXT,
    duration_ms   INT,
    attempted_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_content_log_draft ON content.publish_log (draft_id, attempted_at DESC);
CREATE INDEX IF NOT EXISTS ix_content_log_failed ON content.publish_log (platform, status, attempted_at DESC) WHERE status = 'failed';

-- ── Periodic engagement metrics pulled from platform insights APIs
CREATE TABLE IF NOT EXISTS content.metrics (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    draft_id      UUID NOT NULL REFERENCES content.drafts(id) ON DELETE CASCADE,
    platform      TEXT NOT NULL,
    external_id   TEXT NOT NULL,
    reach         INT,
    impressions   INT,
    engagement    INT,
    clicks        INT,
    reactions     JSONB,
    snapshot_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_content_metrics_draft ON content.metrics (draft_id, snapshot_at DESC);

-- ── Cross-channel message normalization + intent cache for CSKH workflow.
-- This mirrors ZaloCRM's Conversation/Message for non-Zalo channels without
-- mutating the existing Prisma-managed schema.
CREATE SCHEMA IF NOT EXISTS omni;

CREATE TABLE IF NOT EXISTS omni.external_messages (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id             TEXT NOT NULL,
    channel            TEXT NOT NULL,          -- facebook, tiktok, instagram
    external_user_id   TEXT NOT NULL,
    external_thread_id TEXT NOT NULL,
    external_message_id TEXT NOT NULL,
    sender_type        TEXT NOT NULL,          -- contact, self
    sender_name        TEXT,
    content            TEXT,
    content_type       TEXT NOT NULL DEFAULT 'text',
    raw_payload        JSONB NOT NULL DEFAULT '{}'::jsonb,
    zalocrm_contact_id TEXT,                   -- FK to zalocrm.Contact.id once synced
    received_at        TIMESTAMPTZ NOT NULL,
    replied            BOOLEAN NOT NULL DEFAULT FALSE,
    replied_at         TIMESTAMPTZ,
    reply_mode         TEXT,                   -- auto_bot, auto_shadow, human
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_omni_ext_msg ON omni.external_messages (channel, external_message_id);
CREATE INDEX IF NOT EXISTS ix_omni_ext_msg_thread ON omni.external_messages (org_id, channel, external_thread_id, received_at DESC);

CREATE TABLE IF NOT EXISTS omni.intent_log (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id            TEXT NOT NULL,
    channel           TEXT NOT NULL,
    conversation_key  TEXT NOT NULL,           -- <channel>:<thread_id>
    message_hash      TEXT NOT NULL,           -- SHA-256 of normalized message text
    intent            TEXT NOT NULL,
    confidence        NUMERIC(3,2) NOT NULL,
    lead_score        INT,
    urgency           TEXT,
    language          TEXT,
    action_taken      TEXT NOT NULL,           -- auto_reply, handoff, shadow, skipped
    bot_draft         TEXT,                    -- what the bot would say (shadow mode)
    actual_reply      TEXT,                    -- what was actually sent (null if handoff)
    model             TEXT,
    tokens_in         INT,
    tokens_out        INT,
    cost_usd          NUMERIC(10,6),
    latency_ms        INT,
    staff_verdict     TEXT,                    -- approved, rejected, edited (filled during shadow review)
    staff_note        TEXT,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_intent_log_conv ON omni.intent_log (org_id, conversation_key, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_intent_log_verdict ON omni.intent_log (org_id, staff_verdict, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_intent_log_channel ON omni.intent_log (org_id, channel, created_at DESC);
