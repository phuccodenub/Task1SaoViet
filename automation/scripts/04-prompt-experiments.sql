-- Phase 3.3 — Prompt A/B experiment tracking.
-- Apply against the zalocrm database:
--   docker exec -i zalo-crm-db psql -U crmuser -d zalocrm < scripts/04-prompt-experiments.sql

CREATE SCHEMA IF NOT EXISTS content;

CREATE TABLE IF NOT EXISTS content.prompt_experiments (
    id               BIGSERIAL PRIMARY KEY,
    experiment_key   TEXT        NOT NULL,
    variant          TEXT        NOT NULL,
    draft_id         UUID        NULL REFERENCES content.drafts(id) ON DELETE SET NULL,
    item_id          UUID        NULL REFERENCES content.items(id)  ON DELETE SET NULL,
    platform         TEXT        NOT NULL,
    org_id           TEXT        NOT NULL,
    prompt_hash      TEXT        NOT NULL,
    cost_usd         NUMERIC(10,6) DEFAULT 0,
    latency_ms       INT         DEFAULT 0,
    reviewer_verdict TEXT,
    engagement_score NUMERIC(6,3),
    created_at       TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ix_prompt_exp_key_variant
    ON content.prompt_experiments (experiment_key, variant, created_at DESC);

CREATE OR REPLACE VIEW content.prompt_experiment_summary AS
SELECT experiment_key,
       variant,
       platform,
       COUNT(*)                                                    AS samples,
       ROUND(AVG(cost_usd)::numeric, 6)                            AS avg_cost_usd,
       ROUND(AVG(latency_ms)::numeric, 0)                          AS avg_latency_ms,
       ROUND(100.0 * COUNT(*) FILTER (WHERE reviewer_verdict = 'approved')
             / GREATEST(COUNT(*), 1), 2)                           AS approval_pct,
       ROUND(AVG(engagement_score)::numeric, 3)                    AS avg_engagement
FROM content.prompt_experiments
GROUP BY experiment_key, variant, platform
ORDER BY experiment_key, variant;
