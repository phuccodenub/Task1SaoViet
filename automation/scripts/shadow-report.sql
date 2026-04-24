-- Shadow mode precision / recall report.
-- Run daily during the 7-day shadow window and before flipping CSKH_SHADOW_MODE=false.
--
-- Usage (last 7 days):
--   docker exec -i zalo-crm-db psql -U crmuser -d zalocrm \
--     < automation/scripts/shadow-report.sql

\pset border 2

-- ─── 1. Volume & coverage ───────────────────────────────────────────────────
SELECT
  channel,
  count(*)                                           AS total,
  count(*) FILTER (WHERE action_taken = 'shadow')    AS shadow_drafted,
  count(*) FILTER (WHERE action_taken = 'handoff')   AS handoff,
  count(*) FILTER (WHERE staff_verdict IS NOT NULL)  AS graded,
  round(100.0 * count(*) FILTER (WHERE staff_verdict IS NOT NULL) /
    nullif(count(*) FILTER (WHERE action_taken = 'shadow'), 0), 1) AS grading_coverage_pct
FROM omni.intent_log
WHERE created_at >= now() - interval '7 days'
GROUP BY channel
ORDER BY channel;

-- ─── 2. Intent classifier accuracy (among graded shadow rows) ───────────────
SELECT
  intent,
  count(*)                                                       AS sampled,
  count(*) FILTER (WHERE staff_verdict = 'approved')             AS ok,
  count(*) FILTER (WHERE staff_verdict = 'edited')               AS edited,
  count(*) FILTER (WHERE staff_verdict = 'rejected')             AS rejected,
  round(100.0 * count(*) FILTER (WHERE staff_verdict IN ('approved','edited')) /
    nullif(count(*) FILTER (WHERE staff_verdict IS NOT NULL), 0), 1) AS precision_pct
FROM omni.intent_log
WHERE created_at >= now() - interval '7 days'
  AND action_taken = 'shadow'
  AND staff_verdict IS NOT NULL
GROUP BY intent
ORDER BY sampled DESC;

-- ─── 3. Global gate for flipping shadow off ─────────────────────────────────
WITH graded AS (
  SELECT staff_verdict, confidence, intent
  FROM omni.intent_log
  WHERE created_at >= now() - interval '7 days'
    AND action_taken = 'shadow'
    AND staff_verdict IS NOT NULL
)
SELECT
  count(*)                                                          AS graded_total,
  round(100.0 * count(*) FILTER (WHERE staff_verdict IN ('approved','edited')) /
    nullif(count(*), 0), 1)                                          AS overall_precision_pct,
  round(100.0 * count(*) FILTER (WHERE staff_verdict = 'approved') /
    nullif(count(*), 0), 1)                                          AS exact_match_pct,
  round(avg(confidence)::numeric, 2)                                 AS avg_confidence,
  CASE
    WHEN count(*) < 200
      THEN 'NOT_READY: need ≥200 graded rows'
    WHEN 100.0 * count(*) FILTER (WHERE staff_verdict IN ('approved','edited')) / nullif(count(*),0) < 85
      THEN 'NOT_READY: precision < 85%'
    WHEN 100.0 * count(*) FILTER (WHERE staff_verdict = 'approved') / nullif(count(*),0) < 60
      THEN 'REVIEW: exact-match < 60% — tune prompts'
    ELSE 'READY: flip CSKH_SHADOW_MODE=false after sign-off'
  END AS readiness
FROM graded;

-- ─── 4. Top bot drafts that got edited (to refine prompt / FAQ) ─────────────
SELECT
  intent,
  left(bot_draft, 80)    AS bot_draft_preview,
  left(staff_note, 120)  AS staff_note,
  created_at
FROM omni.intent_log
WHERE action_taken = 'shadow'
  AND staff_verdict = 'edited'
  AND created_at >= now() - interval '7 days'
ORDER BY created_at DESC
LIMIT 20;
