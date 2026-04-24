-- ============================================================================
-- smoke-test-schema.sql
--
-- Fail-loud dry run that every workflow SQL query must survive BEFORE enabling
-- the corresponding n8n workflow or cron in production.
--
-- Runs inside a transaction and ROLLBACKs at the end, so it touches no real
-- data and is safe to re-run. Uses `EXPLAIN (VERBOSE OFF, COSTS OFF)` to force
-- Postgres to parse + plan each statement; any column/type/constraint drift
-- raises an error and aborts the script.
--
-- Scope: workflows 01..09 (all postgres nodes), monitoring exporter queries,
-- and the structural invariants the plan depends on (UNIQUE indexes, enum-ish
-- values, legacy/forbidden column absence).
--
-- Usage:
--   docker exec -i zalo-crm-db psql -U crmuser -d zalocrm \
--     < automation/scripts/smoke-test-schema.sql
-- ============================================================================

\set ON_ERROR_STOP on

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Schemas / tables must exist.
-- ---------------------------------------------------------------------------
DO $$
DECLARE missing TEXT;
BEGIN
  SELECT string_agg(f.fqname, ', ')
    INTO missing
  FROM (VALUES
    ('content', 'items'),
    ('content', 'drafts'),
    ('content', 'publish_log'),
    ('content', 'metrics'),
    ('omni',    'external_messages'),
    ('omni',    'intent_log')
  ) AS t(schema, tbl)
  CROSS JOIN LATERAL (SELECT format('%I.%I', t.schema, t.tbl) AS fqname) f
  WHERE NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = t.schema AND table_name = t.tbl
  );
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'Missing tables: %', missing;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2. Column contract — every column referenced by workflows/monitoring.
-- ---------------------------------------------------------------------------
DO $$
DECLARE missing TEXT;
BEGIN
  SELECT string_agg(format('%s.%s.%s', schema, tbl, col), ', ')
    INTO missing
  FROM (VALUES
    -- workflow 01 (content ingest + rewrite)
    ('content','items','raw_payload'),
    ('content','items','enrich_result'),
    ('content','items','dedupe_hash'),
    ('content','items','status'),
    ('content','items','filter_reason'),
    ('content','items','org_id'),
    ('content','items','source'),
    ('content','items','canonical_url'),
    ('content','items','hero_image_url'),
    ('content','items','published_at'),
    ('content','items','locked_at'),
    -- workflow 02 + 06 + 07 + 08 (drafts lifecycle)
    ('content','drafts','org_id'),
    ('content','drafts','item_id'),
    ('content','drafts','platform'),
    ('content','drafts','variant_key'),
    ('content','drafts','body'),
    ('content','drafts','media_urls'),
    ('content','drafts','hashtags'),
    ('content','drafts','status'),
    ('content','drafts','qa_result'),
    ('content','drafts','reject_reason'),
    ('content','drafts','scheduled_at'),
    ('content','drafts','published_at'),
    ('content','drafts','external_id'),
    ('content','drafts','queued_at'),
    -- workflow 02 + 09 + monitoring (publish log uses attempted_at, NOT created_at)
    ('content','publish_log','attempted_at'),
    ('content','publish_log','status'),
    ('content','publish_log','platform'),
    ('content','publish_log','duration_ms'),
    ('content','publish_log','draft_id'),
    ('content','publish_log','attempt'),
    ('content','publish_log','external_id'),
    ('content','publish_log','error_code'),
    ('content','publish_log','error_message'),
    -- workflow 04 + 09 + monitoring (intent log uses action_taken + staff_verdict)
    ('omni','intent_log','action_taken'),
    ('omni','intent_log','staff_verdict'),
    ('omni','intent_log','intent'),
    ('omni','intent_log','conversation_key'),
    ('omni','intent_log','message_hash'),
    ('omni','intent_log','lead_score'),
    ('omni','intent_log','bot_draft'),
    ('omni','intent_log','actual_reply'),
    ('omni','intent_log','model'),
    ('omni','intent_log','tokens_in'),
    ('omni','intent_log','tokens_out'),
    ('omni','intent_log','cost_usd'),
    ('omni','intent_log','latency_ms'),
    -- workflow 05 (facebook messenger)
    ('omni','external_messages','external_message_id'),
    ('omni','external_messages','received_at'),
    ('omni','external_messages','channel'),
    ('omni','external_messages','sender_type'),
    ('omni','external_messages','external_user_id'),
    ('omni','external_messages','external_thread_id'),
    ('omni','external_messages','content_type'),
    ('omni','external_messages','raw_payload')
  ) AS t(schema, tbl, col)
  WHERE NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = t.schema AND table_name = t.tbl AND column_name = t.col
  );
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'Missing columns (workflow/metrics contract broken): %', missing;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 3. Column absence — invariants the plan relies on.
--    These columns MUST NOT exist; if any appear it means somebody added legacy
--    schema back instead of using raw_payload/action_taken/staff_verdict.
-- ---------------------------------------------------------------------------
DO $$
DECLARE unwanted TEXT;
BEGIN
  SELECT string_agg(format('%s.%s.%s', table_schema, table_name, column_name), ', ')
    INTO unwanted
  FROM information_schema.columns
  WHERE (table_schema = 'content' AND table_name = 'items'       AND column_name = 'topic')
     OR (table_schema = 'content' AND table_name = 'publish_log' AND column_name = 'created_at')
     OR (table_schema = 'omni'    AND table_name = 'intent_log'  AND column_name IN ('shadow_mode','verdict','is_lead'));
  IF unwanted IS NOT NULL THEN
    RAISE EXCEPTION
      'Legacy/forbidden columns present — update workflows or drop column: %', unwanted;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 4. Structural invariants the workflows depend on.
--    - content.drafts MUST have UNIQUE (item_id, platform, variant_key) so that
--      WF06/WF08 ON CONFLICT ... DO UPDATE ... RETURNING matches a constraint
--      and retry paths keep emitting rows downstream.
--    - content.items.id MUST be UUID so workflow 08's
--      ANY(string_to_array($1, ',')::uuid[]) is type-correct.
-- ---------------------------------------------------------------------------
DO $$
DECLARE has_unique BOOLEAN;
DECLARE items_id_type TEXT;
BEGIN
  SELECT EXISTS (
    SELECT 1
    FROM pg_indexes
    WHERE schemaname = 'content'
      AND tablename  = 'drafts'
      AND indexdef   ILIKE 'CREATE UNIQUE INDEX%'
      AND indexdef   ILIKE '%(item_id, platform, variant_key)%'
  ) INTO has_unique;
  IF NOT has_unique THEN
    RAISE EXCEPTION
      'content.drafts is missing UNIQUE index on (item_id, platform, variant_key); workflow 08 ON CONFLICT cannot match.';
  END IF;

  SELECT data_type INTO items_id_type
  FROM information_schema.columns
  WHERE table_schema = 'content' AND table_name = 'items' AND column_name = 'id';
  IF items_id_type IS DISTINCT FROM 'uuid' THEN
    RAISE EXCEPTION
      'content.items.id expected UUID, got %; workflow 08 uuid[] cast will fail.', items_id_type;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 5. Dry-run every non-trivial SQL emitted by workflows 01..09.
--    EXPLAIN forces parse + planner so column / type / constraint mistakes
--    fail the script.
--
--    We use literal sentinel values instead of bind parameters because psql
--    does not accept $1 placeholders outside of prepared statements, and the
--    goal here is semantic validation, not data mutation.
-- ---------------------------------------------------------------------------

-- ── workflow 01: content-ingest-rewrite
EXPLAIN (VERBOSE OFF, COSTS OFF)
INSERT INTO content.items
  (org_id, source, canonical_url, title, body, hero_image_url,
   published_at, dedupe_hash, raw_payload, status)
VALUES
  ('org_smoke','rss:smoke','https://ex/1','t','b',NULL,now(),'hash_wf01','{"topic":"x"}'::jsonb,'ingested')
ON CONFLICT (org_id, dedupe_hash) DO NOTHING
RETURNING id, title, body, source, raw_payload->>'topic' AS topic, canonical_url, hero_image_url;

EXPLAIN (VERBOSE OFF, COSTS OFF)
UPDATE content.items SET status='filtered', filter_reason='smoke', updated_at=now()
WHERE id='00000000-0000-0000-0000-000000000000';

-- Workflow 01 now stops after guardrail and hands the item to 06 / 08 as
-- status='enriched'. Drafting + fan-out was moved entirely to workflow 06.
EXPLAIN (VERBOSE OFF, COSTS OFF)
UPDATE content.items
SET status = 'enriched', enrich_result = '{}'::jsonb, updated_at = now()
WHERE id = '00000000-0000-0000-0000-000000000000';

-- ── workflow 02: content-publish-scheduler
EXPLAIN (VERBOSE OFF, COSTS OFF)
WITH due AS (
  SELECT id FROM content.drafts
  WHERE org_id = 'org_smoke'
    AND status IN ('approved', 'scheduled')
    AND scheduled_at <= now()
  ORDER BY scheduled_at ASC
  LIMIT 1 FOR UPDATE SKIP LOCKED
)
UPDATE content.drafts d
SET status = 'scheduled', updated_at = now()
FROM due
WHERE d.id = due.id
RETURNING d.id, d.platform, d.body, d.media_urls, d.hashtags, d.item_id;

-- Workflow 02 v2 uses a three-valued outcome ('success' | 'failed' |
-- 'manual_required'). The UPDATE maps outcome → draft status, the INSERT
-- persists the outcome verbatim as publish_log.status so dashboards can
-- distinguish manual work from real failures.
EXPLAIN (VERBOSE OFF, COSTS OFF)
WITH upd AS (
  UPDATE content.drafts
  SET status = CASE 'success'
                 WHEN 'success'         THEN 'published'
                 WHEN 'manual_required' THEN 'manual_required'
                 ELSE 'failed'
               END,
      external_id   = COALESCE('fb_1', external_id),
      published_at  = CASE WHEN 'success' = 'success' THEN now() ELSE published_at END,
      reject_reason = CASE WHEN 'success' = 'success' THEN NULL ELSE 'err' END,
      updated_at    = now()
  WHERE id = '00000000-0000-0000-0000-000000000000'
  RETURNING id
)
INSERT INTO content.publish_log
  (draft_id, platform, attempt, status, external_id, error_code, error_message, attempted_at)
SELECT '00000000-0000-0000-0000-000000000000','facebook', 1,
       'success', 'fb_1', NULL, NULL, now()
FROM upd;

-- ── workflow 03: review-sync (three branches, mirror the real UPDATE shape)
EXPLAIN (VERBOSE OFF, COSTS OFF)
UPDATE content.drafts SET status='approved', updated_at=now()
WHERE id='00000000-0000-0000-0000-000000000000' AND status='pending_review'
RETURNING id;

EXPLAIN (VERBOSE OFF, COSTS OFF)
UPDATE content.drafts SET status='rejected', reject_reason='editor_rejected', updated_at=now()
WHERE id='00000000-0000-0000-0000-000000000000' AND status='pending_review'
RETURNING id;

EXPLAIN (VERBOSE OFF, COSTS OFF)
UPDATE content.drafts
SET status='approved', body=COALESCE(NULLIF('new body', ''), body), updated_at=now()
WHERE id='00000000-0000-0000-0000-000000000000' AND status='pending_review'
RETURNING id;

-- ── workflow 04: cskh-zalo-intent (intent log insert, 15 params in real run)
EXPLAIN (VERBOSE OFF, COSTS OFF)
INSERT INTO omni.intent_log
  (org_id, channel, conversation_key, message_hash, intent, confidence, lead_score,
   urgency, language, action_taken, bot_draft, actual_reply,
   model, tokens_in, tokens_out, latency_ms)
VALUES ('org_smoke','zalo','zalo:t1','hash','greeting',0.95,10,'low','vi',
        'shadow','hi','',
        'kimi-k2',10,20,300);

-- ── workflow 05: facebook-messenger (external_messages upsert)
EXPLAIN (VERBOSE OFF, COSTS OFF)
INSERT INTO omni.external_messages
  (org_id, channel, external_user_id, external_thread_id, external_message_id,
   sender_type, sender_name, content, content_type, raw_payload, received_at)
VALUES ('org_smoke','facebook','fbuser_1','fbuser_1','mid_1',
        'contact', NULL, 'hello', 'text',
        '{}'::jsonb, to_timestamp(1700000000::bigint / 1000.0))
ON CONFLICT (channel, external_message_id) DO NOTHING
RETURNING id;

-- ── workflow 06 v4: content-fanout (one item per cron tick, idempotent draft
--    insert per platform, flip item drafted only when ALL planned platforms
--    have a draft that is actually editor-visible — queued_at IS NOT NULL).
--    Matches automation/n8n/workflows/06-content-fanout.json.
EXPLAIN (VERBOSE OFF, COSTS OFF)
WITH ready AS (
  SELECT id FROM content.items
  WHERE org_id = 'org_smoke'
    AND status = 'enriched'
    AND (enrich_result->>'keep')::boolean = true
  ORDER BY created_at ASC
  LIMIT 1 FOR UPDATE SKIP LOCKED
)
UPDATE content.items i
SET status = 'fanning_out', locked_at = now(), updated_at = now()
FROM ready
WHERE i.id = ready.id
RETURNING i.id, i.title, i.body, i.canonical_url, i.hero_image_url, i.source,
         i.raw_payload->>'topic' AS topic,
         i.enrich_result;

-- Round W: WF06 Save draft now uses DO UPDATE SET updated_at = now() instead
-- of DO NOTHING. The prior DO NOTHING returned 0 rows on conflict, so the
-- Needs-sheet-push? IF could not tell "first successful insert" apart from
-- "retry after Sheet fail". The no-op UPDATE always returns the row,
-- preserving editor edits (body/hashtags/status/qa_result NOT re-written on
-- conflict) while exposing queued_at for the routing decision downstream.
EXPLAIN (VERBOSE OFF, COSTS OFF)
INSERT INTO content.drafts
  (item_id, org_id, platform, variant_key, body, media_urls, hashtags, status, qa_result, scheduled_at, queued_at)
VALUES ('00000000-0000-0000-0000-000000000000','org_smoke','facebook','v1','body',
        '[]'::jsonb, '[]'::jsonb, 'pending_review', '{}'::jsonb, now() + interval '2 hours', NULL)
ON CONFLICT (item_id, platform, variant_key) DO UPDATE
  SET updated_at = now()
RETURNING id, status, scheduled_at, queued_at;

-- Mark draft queued after Google Sheet push succeeds; COALESCE guards re-runs.
EXPLAIN (VERBOSE OFF, COSTS OFF)
UPDATE content.drafts
SET queued_at = COALESCE(queued_at, now()),
    updated_at = now()
WHERE id = '00000000-0000-0000-0000-000000000000'
RETURNING id, queued_at;

-- Mark item drafted ONLY after every planned platform has a draft that
-- reached the review queue. COUNT(*) filters on queued_at IS NOT NULL so a
-- platform that inserted a row but failed to push to the Google Sheet does
-- NOT count toward plannedCount, and the item stays in 'fanning_out' until
-- WF07 surfaces it via the locked_at watchdog (status='fanning_out'
-- AND locked_at < now() - 30m). locked_at is cleared here on the happy path.
EXPLAIN (VERBOSE OFF, COSTS OFF)
UPDATE content.items i
SET status = 'drafted', locked_at = NULL, updated_at = now()
WHERE i.id = '00000000-0000-0000-0000-000000000000'
  AND i.status = 'fanning_out'
  AND (
    SELECT COUNT(*) FROM content.drafts d
    WHERE d.item_id = i.id
      AND d.variant_key = 'v1'
      AND d.queued_at IS NOT NULL
  ) >= 3;

-- ── workflow 07 v2: editorial-sla + fan-out watchdog (30m cron)
--    Branch A — pending_review drafts older than 2h AND already visible in
--    the editorial queue (queued_at IS NOT NULL). Drafts that never made it
--    into the queue are handled by Branch B through the item-level watchdog,
--    not by pinging editors who cannot see them.
EXPLAIN (VERBOSE OFF, COSTS OFF)
SELECT id, platform, created_at, scheduled_at, left(body, 120) AS preview
FROM content.drafts
WHERE org_id = 'org_smoke'
  AND status = 'pending_review'
  AND queued_at IS NOT NULL
  AND created_at < now() - interval '2 hours'
ORDER BY created_at ASC
LIMIT 50;

-- Branch B — items stuck in a transitional status (fanning_out |
-- batch_rewriting) for > 30 minutes. This closes the dead-letter path that
-- existed before round V: if any WF06/WF08 step between the status claim and
-- the terminal transition threw, the item would sit in 'fanning_out' forever
-- because WF06 only picks 'enriched'. Now WF07 surfaces it for manual
-- requeue (UPDATE ... SET status='enriched', locked_at=NULL) or root-cause.
EXPLAIN (VERBOSE OFF, COSTS OFF)
SELECT id, status, source, title, locked_at,
       extract(epoch FROM (now() - locked_at))::int AS stuck_seconds
FROM content.items
WHERE org_id = 'org_smoke'
  AND status IN ('fanning_out','batch_rewriting')
  AND locked_at IS NOT NULL
  AND locked_at < now() - interval '30 minutes'
ORDER BY locked_at ASC
LIMIT 50;

-- ── workflow 08: batch-rewrite (cost saver; shares enriched with wf06 but
--    uses a distinct transitional status so FOR UPDATE SKIP LOCKED keeps them
--    race-free; locked_at is set on claim and cleared on the terminal flip).
EXPLAIN (VERBOSE OFF, COSTS OFF)
WITH ready AS (
  SELECT id FROM content.items
  WHERE org_id = 'org_smoke'
    AND status = 'enriched'
    AND (enrich_result->>'keep')::boolean = true
  ORDER BY created_at ASC
  LIMIT 5 FOR UPDATE SKIP LOCKED
)
UPDATE content.items i SET status='batch_rewriting', locked_at=now(), updated_at=now()
FROM ready WHERE i.id = ready.id
RETURNING i.id, i.title, i.body, i.raw_payload->>'topic' AS topic;

-- WF08 does NOT push to Google Sheet, so queued_at=now() is set inline so
-- the WF06/WF08 gate semantics match (queued_at IS NOT NULL = editor visible).
-- Round X (X1): DO NOTHING → DO UPDATE SET updated_at=now() RETURNING.
-- Rationale: same class bug as WF06 W1. Full-conflict retry with DO NOTHING
-- emits zero items → Mark items drafted never triggers → items stuck in
-- batch_rewriting forever. DO UPDATE guarantees output on every conflict.
-- Synthetic test [X-e] below exercises the all-conflict retry path.
EXPLAIN (VERBOSE OFF, COSTS OFF)
INSERT INTO content.drafts
  (item_id, org_id, platform, variant_key, body, hashtags, status, scheduled_at, queued_at)
VALUES ('00000000-0000-0000-0000-000000000000','org_smoke','facebook','batch-v1','body',
        '[]'::jsonb,'pending_review', now() + interval '2 hours', now())
ON CONFLICT (item_id, platform, variant_key) DO UPDATE
  SET updated_at = now()
RETURNING id, item_id, queued_at;

-- Round W: WF08 Mark items drafted now gates on BOTH status='batch_rewriting'
-- (idempotency) AND EXISTS a batch-v1 draft with queued_at IS NOT NULL.
-- Previously this unconditionally marked every claimed id, so if the LLM
-- returned fewer results than the batch input (cardinality mismatch), items
-- without a corresponding draft flipped to 'drafted' anyway. Now those items
-- stay 'batch_rewriting' with locked_at set → WF07 Branch B catches them.
EXPLAIN (VERBOSE OFF, COSTS OFF)
UPDATE content.items i
SET status='drafted', locked_at=NULL, updated_at=now()
WHERE i.id = ANY(string_to_array('00000000-0000-0000-0000-000000000000,11111111-1111-1111-1111-111111111111', ',')::uuid[])
  AND i.status = 'batch_rewriting'
  AND EXISTS (
    SELECT 1 FROM content.drafts d
    WHERE d.item_id = i.id
      AND d.variant_key = 'batch-v1'
      AND d.queued_at IS NOT NULL
  )
RETURNING i.id;

-- ── workflow 09: monthly-cost-review (three report queries)
EXPLAIN (VERBOSE OFF, COSTS OFF)
SELECT platform,
       COUNT(*) FILTER (WHERE status IN ('success','failed','retrying')) AS automated_attempts,
       COUNT(*) FILTER (WHERE status = 'success')                         AS successes,
       COUNT(*) FILTER (WHERE status = 'failed')                          AS failures,
       COUNT(*) FILTER (WHERE status = 'manual_required')                 AS manual_required,
       COUNT(*)                                                           AS total_rows
FROM content.publish_log
WHERE attempted_at >= date_trunc('month', now() - interval '1 month')
  AND attempted_at <  date_trunc('month', now())
GROUP BY platform
ORDER BY total_rows DESC;

EXPLAIN (VERBOSE OFF, COSTS OFF)
SELECT intent,
       COUNT(*) AS messages,
       COUNT(*) FILTER (WHERE intent = 'lead_qualified')        AS leads,
       COUNT(*) FILTER (WHERE action_taken = 'handoff')         AS handoffs,
       COUNT(*) FILTER (WHERE action_taken = 'auto_reply')      AS auto_replies,
       COUNT(*) FILTER (WHERE staff_verdict = 'approved')       AS staff_approved,
       COUNT(*) FILTER (WHERE staff_verdict = 'rejected')       AS staff_rejected
FROM omni.intent_log
WHERE created_at >= date_trunc('month', now() - interval '1 month')
  AND created_at <  date_trunc('month', now())
GROUP BY intent
ORDER BY messages DESC;
-- NOTE: the LiteLLM spend-by-model query in workflow 09 targets a separate
-- database ("LiteLLM_SpendLogs" in the litellm DB) and cannot be validated
-- from this script. Run it separately via:
--   docker exec -i zalo-crm-db psql -U crmuser -d litellm -c '\d "LiteLLM_SpendLogs"'
-- then EXPLAIN the SELECT from workflow 09 node `spend-by-model`.

-- ---------------------------------------------------------------------------
-- 6. Monitoring queries that postgres_exporter runs every 15s.
-- ---------------------------------------------------------------------------
EXPLAIN (VERBOSE OFF, COSTS OFF)
SELECT
  CASE WHEN COUNT(*) = 0 THEN 1.0
       ELSE (COUNT(*) FILTER (WHERE status = 'success'))::float / COUNT(*)
  END
FROM content.publish_log
WHERE attempted_at > now() - interval '24 hours'
  AND status IN ('success','failed','retrying');

EXPLAIN (VERBOSE OFF, COSTS OFF)
SELECT
  COUNT(*) FILTER (WHERE intent = 'lead_qualified')     AS intent_lead_qualified,
  COUNT(*) FILTER (WHERE action_taken = 'handoff')      AS action_handoff,
  COUNT(*)                                              AS total_messages
FROM omni.intent_log
WHERE created_at > now() - interval '24 hours';

-- ---------------------------------------------------------------------------
-- 7. Synthetic state tests — exercise the retry invariants EXPLAIN cannot
--    cover. These do actual INSERT/UPDATE against the current transaction
--    (rolled back at the end) so we can assert that the new SQL shapes
--    correctly recover from half-written state:
--
--    (a) WF06 retry after Google Sheet fail (draft exists, queued_at NULL)
--        must still be recoverable via DO UPDATE upsert + Mark draft queued.
--
--    (b) WF06 Mark item drafted gate must count ONLY drafts whose queued_at
--        is NOT NULL — a fan-out with one platform whose sheet push failed
--        must NOT flip the parent item to 'drafted'.
--
--    (c) WF08 Mark items drafted must SKIP items that have no batch-v1
--        draft (LLM cardinality mismatch scenario) and KEEP them in
--        'batch_rewriting' so WF07 Branch B can alert.
--
--    (d) WF07 Branch B must surface items whose locked_at is older than the
--        configured threshold.
--
--    (e) (round X) WF08 all-conflict retry — when a previous run inserted
--        every batch-v1 draft but died before Mark items drafted, the retry
--        upsert must emit rows so the downstream mark query fires. The prior
--        DO NOTHING version silently returned zero rows → items stuck in
--        batch_rewriting forever. Also asserts body is NOT overwritten on
--        conflict so editor edits survive retries.
--
--    Every assertion uses DO $$ RAISE EXCEPTION $$ so a regression aborts
--    the whole transaction with a diagnostic message, not a silent 0-row
--    EXPLAIN pass. All writes are in the outer BEGIN/ROLLBACK, so nothing
--    leaks to live data even if someone runs this against a prod replica.
-- ---------------------------------------------------------------------------

-- (a) + (b) — WF06 retry + gate behaviour.
DO $$
DECLARE
  _org          TEXT := 'org_smoke_w_wf06';
  _item_id      UUID;
  _draft_ok     UUID;    -- platform whose Sheet push succeeded
  _draft_partial UUID;   -- platform whose Sheet push failed (queued_at stays NULL)
  _gate_count   INT;
  _item_status  TEXT;
  _returned_id  UUID;
BEGIN
  INSERT INTO content.items (org_id, source, canonical_url, title, body,
                             dedupe_hash, raw_payload, status, locked_at)
  VALUES (_org, 'rss:test', 'https://ex/w', 't', 'b',
          'hash_w', '{"topic":"x","keep":true}'::jsonb, 'fanning_out', now())
  RETURNING id INTO _item_id;

  -- Platform 1: happy path — queued_at set by Mark draft queued.
  INSERT INTO content.drafts (item_id, org_id, platform, variant_key, body,
                              media_urls, hashtags, status, qa_result,
                              scheduled_at, queued_at)
  VALUES (_item_id, _org, 'facebook', 'v1', 'body',
          '[]'::jsonb, '[]'::jsonb, 'pending_review', '{}'::jsonb,
          now() + interval '2 hours', now())
  RETURNING id INTO _draft_ok;

  -- Platform 2: Google Sheet push failed — queued_at stays NULL.
  INSERT INTO content.drafts (item_id, org_id, platform, variant_key, body,
                              media_urls, hashtags, status, qa_result,
                              scheduled_at, queued_at)
  VALUES (_item_id, _org, 'tiktok', 'v1', 'body',
          '[]'::jsonb, '[]'::jsonb, 'pending_review', '{}'::jsonb,
          now() + interval '2 hours', NULL)
  RETURNING id INTO _draft_partial;

  -- (b) gate must count only 1 draft (queued_at IS NOT NULL) and therefore
  -- refuse to flip the item when plannedCount = 2.
  UPDATE content.items i
  SET status = 'drafted', locked_at = NULL, updated_at = now()
  WHERE i.id = _item_id
    AND i.status = 'fanning_out'
    AND (
      SELECT COUNT(*) FROM content.drafts d
      WHERE d.item_id = i.id
        AND d.variant_key = 'v1'
        AND d.queued_at IS NOT NULL
    ) >= 2;

  SELECT status INTO _item_status FROM content.items WHERE id = _item_id;
  IF _item_status <> 'fanning_out' THEN
    RAISE EXCEPTION
      '[W-b] WF06 gate regression: item flipped to % with a draft missing queued_at (expected fanning_out)',
      _item_status;
  END IF;

  -- (a) retry WF06 Save draft on the partial platform using the NEW DO UPDATE
  -- shape. Must return the existing row so the downstream IF can re-route it
  -- to Push to Review Queue.
  INSERT INTO content.drafts
    (item_id, org_id, platform, variant_key, body, media_urls, hashtags,
     status, qa_result, scheduled_at, queued_at)
  VALUES (_item_id, _org, 'tiktok', 'v1', 'body',
          '[]'::jsonb, '[]'::jsonb, 'pending_review', '{}'::jsonb,
          now() + interval '2 hours', NULL)
  ON CONFLICT (item_id, platform, variant_key) DO UPDATE
    SET updated_at = now()
  RETURNING id INTO _returned_id;

  IF _returned_id IS DISTINCT FROM _draft_partial THEN
    RAISE EXCEPTION
      '[W-a] WF06 upsert did not return the conflicted row (got %, expected %) — Sheet retry cannot recover',
      _returned_id, _draft_partial;
  END IF;

  -- Simulate Mark draft queued succeeding on the retry.
  UPDATE content.drafts
  SET queued_at = COALESCE(queued_at, now()),
      updated_at = now()
  WHERE id = _draft_partial;

  -- Gate must now flip the item.
  UPDATE content.items i
  SET status = 'drafted', locked_at = NULL, updated_at = now()
  WHERE i.id = _item_id
    AND i.status = 'fanning_out'
    AND (
      SELECT COUNT(*) FROM content.drafts d
      WHERE d.item_id = i.id
        AND d.variant_key = 'v1'
        AND d.queued_at IS NOT NULL
    ) >= 2;

  SELECT status INTO _item_status FROM content.items WHERE id = _item_id;
  IF _item_status <> 'drafted' THEN
    RAISE EXCEPTION
      '[W-a] WF06 recovery regression: item still % after all drafts queued (expected drafted)',
      _item_status;
  END IF;

  RAISE NOTICE '[W-a,b] WF06 retry + gate invariants OK (item_id=%)', _item_id;
END $$;

-- (c) WF08 cardinality mismatch — partial batch.
DO $$
DECLARE
  _org        TEXT := 'org_smoke_w_wf08';
  _item_ok    UUID;
  _item_miss  UUID;
  _flipped    INT;
BEGIN
  INSERT INTO content.items (org_id, source, canonical_url, title, body,
                             dedupe_hash, raw_payload, status, locked_at)
  VALUES (_org, 'rss:test', 'https://ex/w/ok', 't', 'b',
          'hash_w_ok', '{"topic":"x","keep":true}'::jsonb, 'batch_rewriting', now())
  RETURNING id INTO _item_ok;

  INSERT INTO content.items (org_id, source, canonical_url, title, body,
                             dedupe_hash, raw_payload, status, locked_at)
  VALUES (_org, 'rss:test', 'https://ex/w/miss', 't', 'b',
          'hash_w_miss', '{"topic":"x","keep":true}'::jsonb, 'batch_rewriting', now())
  RETURNING id INTO _item_miss;

  -- Only _item_ok got a draft — the model skipped _item_miss.
  INSERT INTO content.drafts (item_id, org_id, platform, variant_key, body,
                              hashtags, status, scheduled_at, queued_at)
  VALUES (_item_ok, _org, 'facebook', 'batch-v1', 'body',
          '[]'::jsonb, 'pending_review', now() + interval '2 hours', now());

  WITH upd AS (
    UPDATE content.items i
    SET status = 'drafted', locked_at = NULL, updated_at = now()
    WHERE i.id = ANY(ARRAY[_item_ok, _item_miss])
      AND i.status = 'batch_rewriting'
      AND EXISTS (
        SELECT 1 FROM content.drafts d
        WHERE d.item_id = i.id
          AND d.variant_key = 'batch-v1'
          AND d.queued_at IS NOT NULL
      )
    RETURNING i.id
  )
  SELECT COUNT(*) INTO _flipped FROM upd;

  IF _flipped <> 1 THEN
    RAISE EXCEPTION
      '[W-c] WF08 regression: gate flipped % items (expected exactly 1 — only the one with a draft)',
      _flipped;
  END IF;

  -- The item without a draft must still be batch_rewriting with locked_at set
  -- so WF07 Branch B alerts on it after 30m.
  PERFORM 1 FROM content.items
  WHERE id = _item_miss AND status = 'batch_rewriting' AND locked_at IS NOT NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION
      '[W-c] WF08 regression: item without draft lost its stuck-state — WF07 cannot surface it';
  END IF;

  RAISE NOTICE '[W-c] WF08 cardinality gate OK (ok=%, miss=%)', _item_ok, _item_miss;
END $$;

-- (d) WF07 Branch B — manually age locked_at past the threshold and verify
-- the exact query the workflow runs surfaces the item.
DO $$
DECLARE
  _org      TEXT := 'org_smoke_w_wf07';
  _item_id  UUID;
  _hit      INT;
BEGIN
  INSERT INTO content.items (org_id, source, canonical_url, title, body,
                             dedupe_hash, raw_payload, status, locked_at)
  VALUES (_org, 'rss:test', 'https://ex/w/stuck', 't', 'b',
          'hash_w_stuck', '{"topic":"x","keep":true}'::jsonb,
          'fanning_out', now() - interval '45 minutes')
  RETURNING id INTO _item_id;

  SELECT COUNT(*) INTO _hit
  FROM content.items
  WHERE org_id = _org
    AND status IN ('fanning_out','batch_rewriting')
    AND locked_at IS NOT NULL
    AND locked_at < now() - interval '30 minutes';

  IF _hit = 0 THEN
    RAISE EXCEPTION '[W-d] WF07 Branch B regression: stuck item not surfaced (locked_at=45m)';
  END IF;

  RAISE NOTICE '[W-d] WF07 Branch B OK (stuck_hits=%)', _hit;
END $$;

-- (e) WF08 all-conflict retry — simulate a previous run that inserted every
-- batch-v1 draft but died before Mark items drafted. On retry, Save drafts
-- must still emit rows (DO UPDATE RETURNING, not DO NOTHING) so the
-- downstream mark query actually fires. This test covers Codex round #8 P1:
-- the prior DO NOTHING version would silently conflict on all N rows →
-- Postgres node returns zero items → pipeline halts → items stay stuck in
-- batch_rewriting forever despite drafts existing.
DO $$
DECLARE
  _org      TEXT := 'org_smoke_x_wf08_retry';
  _item_a   UUID;
  _item_b   UUID;
  _returned INT;
  _flipped  INT;
BEGIN
  -- Seed: two items in batch_rewriting with locked_at (prior run claimed them).
  INSERT INTO content.items (org_id, source, canonical_url, title, body,
                             dedupe_hash, raw_payload, status, locked_at)
  VALUES (_org, 'rss:test', 'https://ex/x/retry_a', 't', 'b',
          'hash_x_retry_a', '{"topic":"x","keep":true}'::jsonb,
          'batch_rewriting', now())
  RETURNING id INTO _item_a;

  INSERT INTO content.items (org_id, source, canonical_url, title, body,
                             dedupe_hash, raw_payload, status, locked_at)
  VALUES (_org, 'rss:test', 'https://ex/x/retry_b', 't', 'b',
          'hash_x_retry_b', '{"topic":"x","keep":true}'::jsonb,
          'batch_rewriting', now())
  RETURNING id INTO _item_b;

  -- Seed: BOTH drafts already exist from the previous (partially failed) run.
  INSERT INTO content.drafts (item_id, org_id, platform, variant_key, body,
                              hashtags, status, scheduled_at, queued_at)
  VALUES
    (_item_a, _org, 'facebook', 'batch-v1', 'body_a',
     '[]'::jsonb, 'pending_review', now() + interval '2 hours', now()),
    (_item_b, _org, 'facebook', 'batch-v1', 'body_b',
     '[]'::jsonb, 'pending_review', now() + interval '2 hours', now());

  -- Retry: Save drafts replays the same two INSERTs. With DO UPDATE RETURNING,
  -- the upsert MUST return both rows even though both conflict.
  WITH upsert AS (
    INSERT INTO content.drafts (item_id, org_id, platform, variant_key, body,
                                hashtags, status, scheduled_at, queued_at)
    VALUES
      (_item_a, _org, 'facebook', 'batch-v1', 'body_a_retry',
       '[]'::jsonb, 'pending_review', now() + interval '2 hours', now()),
      (_item_b, _org, 'facebook', 'batch-v1', 'body_b_retry',
       '[]'::jsonb, 'pending_review', now() + interval '2 hours', now())
    ON CONFLICT (item_id, platform, variant_key) DO UPDATE
      SET updated_at = now()
    RETURNING id, item_id, queued_at
  )
  SELECT COUNT(*) INTO _returned FROM upsert;

  IF _returned <> 2 THEN
    RAISE EXCEPTION
      '[X-e] WF08 all-conflict retry regression: DO UPDATE RETURNING emitted % rows (expected 2). Pipeline would halt — items stay stuck in batch_rewriting.',
      _returned;
  END IF;

  -- Invariant: upsert MUST NOT overwrite body (editors may have touched it
  -- via admin UI between retries; only updated_at is bumped).
  PERFORM 1 FROM content.drafts
  WHERE item_id = _item_a AND variant_key = 'batch-v1' AND body = 'body_a';
  IF NOT FOUND THEN
    RAISE EXCEPTION
      '[X-e] WF08 upsert regression: body was overwritten by retry — editor edits would be lost';
  END IF;

  -- Mark items drafted runs next and must flip both (both have queued_at IS NOT NULL).
  WITH upd AS (
    UPDATE content.items i
    SET status = 'drafted', locked_at = NULL, updated_at = now()
    WHERE i.id = ANY(ARRAY[_item_a, _item_b])
      AND i.status = 'batch_rewriting'
      AND EXISTS (
        SELECT 1 FROM content.drafts d
        WHERE d.item_id = i.id
          AND d.variant_key = 'batch-v1'
          AND d.queued_at IS NOT NULL
      )
    RETURNING i.id
  )
  SELECT COUNT(*) INTO _flipped FROM upd;

  IF _flipped <> 2 THEN
    RAISE EXCEPTION
      '[X-e] WF08 all-conflict retry regression: Mark items drafted flipped % items (expected 2). Retry failed to complete.',
      _flipped;
  END IF;

  RAISE NOTICE '[X-e] WF08 all-conflict retry OK (upserted=%, flipped=%)', _returned, _flipped;
END $$;

ROLLBACK;

\echo '--- smoke-test-schema.sql: OK (workflows 01-09 + monitoring parsed + planned + state invariants) ---'
