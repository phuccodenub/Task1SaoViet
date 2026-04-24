# Phase 3.3 — Cost optimization playbook

Concrete levers ordered by ROI. Apply top-down.

## 1. 24h intent cache in Redis (applied)

n8n workflow `04-cskh-zalo-intent` already caches normalized-message →
intent with `TTL = 86 400` (24h). Key format: `cskh:intent:<sha256(norm)>`.
Hit rate to target: **≥ 35%** within the first 30 days. Track via
`omni.intent_log.cached_hit` — add it in the next iteration if the column
isn't already present.

Tuning dials:

- TTL: start at 24h, increase to 48h if cache size stays below 100 MB.
- Normalization: lowercase, strip whitespace, strip trailing punctuation.
  Avoid over-normalization (collapsing "OK" vs "Ok" is fine; collapsing
  two different products is not).

## 2. Batch rewrite fan-in (workflow 08)

`08-batch-rewrite.json` packs up to 5 items into a single LLM call instead
of firing 5 independent requests. Expected savings vs workflow 06 (1 call
per platform per item):

| Metric            | Fan-out (06) | Batch (08) | Δ        |
| ----------------- | ------------ | ---------- | -------- |
| Calls per 5 items | 20 (5×4)     | 1          | −95%     |
| Total tokens      | ~8 000       | ~5 000     | −38%     |
| Wall time         | ~12 s        | ~4 s       | −66%     |

Trade-offs:

- Only Facebook is batched in v1. Extend the prompt to emit per-platform
  fields once QA approves the quality.
- Batch size 5 keeps the response under the 8K context limit of
  `cheap-vi`. Increase only after checking average prompt/completion length
  in LiteLLM `/v1/usage`.

Enable both 06 and 08 in shadow mode, compare `approval_pct` via the
prompt-experiment view (step 3) before turning off 06.

## 3. A/B prompt experiments

Schema: `scripts/04-prompt-experiments.sql`.

- Every LLM-producing workflow writes one row per sample: `experiment_key`
  (e.g. `rewrite_fb_v2025_04`), `variant` (e.g. `terse`, `verbose`),
  `cost_usd`, `latency_ms`, `reviewer_verdict`, optional `engagement_score`.
- View `content.prompt_experiment_summary` gives approval rate, avg cost,
  avg engagement per variant in one query.
- Minimum sample size per variant: 30 before declaring a winner.

Wiring:

- In workflow 06's `Shape draft + QA` node, add an extra INSERT into
  `content.prompt_experiments` once you start running the experiment.
- Reviewer verdict flows back from workflow 03 (`03-review-sync`).

## 4. Monthly cost review (workflow 09)

`09-monthly-cost-review.json` runs on the 1st at 09:00 Asia/Ho_Chi_Minh,
pulls from the LiteLLM `LiteLLM_SpendLogs` table + `content.publish_log`
+ `omni.intent_log`, and posts a Markdown digest to Telegram.

Manual actions triggered by the digest:

- If `cheap-vi` spend > 70% of total → consider downgrading more steps.
- If `premium-vi` spend exceeds 25% of total → audit which workflow
  escalated to Sonnet/GPT-4o and whether a cheaper tier suffices.
- If publish failures > 10% → pull publish_log for a platform-specific
  root cause before next month's run.

## 5. Secondary levers

- **Prompt compression**: strip boilerplate ("Bạn là copywriter...") from
  repeated system prompts by setting LiteLLM `litellm_settings.cache` to
  hit on the system-prompt hash.
- **Model distillation**: once 1–2 prompts stabilise, send 200 examples to
  Qwen fine-tune (cheapest of the tiered providers) and route stable flows
  to the fine-tuned model.
- **Off-peak scheduling**: route non-urgent batch work to 02:00–06:00
  when some providers offer discounted rates (check per-provider docs
  before relying on this).

## Go/no-go gates

| Decision             | Data needed                                             |
| -------------------- | ------------------------------------------------------- |
| Cut workflow 06      | Batch-08 approval_pct ≥ 06 approval_pct for 2 weeks     |
| Extend cache TTL     | Redis memory stable + hit rate plateau under 50%        |
| Drop a model tier    | Spend share < 5% and substitute latency within 1.3×     |
| Introduce fine-tune  | ≥ 1 000 approved samples for a single prompt variant    |
