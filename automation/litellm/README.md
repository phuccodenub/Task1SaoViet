# LiteLLM Gateway

Single OpenAI-compatible endpoint for n8n, ZaloCRM and OpenClaw. Lets us swap
model providers without touching any workflow.

## Model groups

| Group         | Primary               | Fallbacks                       | Use case                                     |
| ------------- | --------------------- | ------------------------------- | -------------------------------------------- |
| `cheap-vi`    | Kimi moonshot-v1-8k   | Gemini Flash → Qwen Plus        | Intent classify, short rewrite, summary      |
| `rewrite-vi`  | Kimi moonshot-v1-32k  | Gemini Flash → cheap-vi         | Fan-out rewrite per platform                 |
| `guardrail`   | Gemini 2.0 Flash      | —                               | Policy / sentiment / factuality checks       |
| `premium-vi`  | Claude 3.5 Sonnet     | GPT-4o mini → rewrite-vi        | VIP replies, complaint handling              |
| `embedding-vi`| Gemini text-embed-004 | —                               | Semantic dedup, intent cache keys            |

## Bootstrap

```bash
# Create per-workflow virtual keys (run after `docker compose up`)
curl -X POST http://localhost:4000/key/generate \
  -H "Authorization: Bearer $LITELLM_MASTER_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "key_alias": "n8n-content-rewrite",
    "models": ["cheap-vi", "rewrite-vi", "guardrail"],
    "max_budget": 30,
    "budget_duration": "30d",
    "rpm_limit": 120
  }'

curl -X POST http://localhost:4000/key/generate \
  -H "Authorization: Bearer $LITELLM_MASTER_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "key_alias": "n8n-cskh-intent",
    "models": ["cheap-vi", "guardrail"],
    "max_budget": 20,
    "budget_duration": "30d",
    "rpm_limit": 300
  }'

curl -X POST http://localhost:4000/key/generate \
  -H "Authorization: Bearer $LITELLM_MASTER_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "key_alias": "zalocrm-ai-service",
    "models": ["cheap-vi", "rewrite-vi", "premium-vi"],
    "max_budget": 40,
    "budget_duration": "30d",
    "rpm_limit": 200
  }'
```

Each returned `sk-...` key gets stored in the respective service's credential
store (n8n credential `LiteLLM`, ZaloCRM `AiConfig.apiKey`). Rotate keys by
calling `/key/update`.

## Swap a model

Edit `config.yaml` → change the `litellm_params.model` of a group → reload:

```bash
docker compose kill -s SIGHUP litellm
```

No workflow changes needed because workflows always reference the group name
(`cheap-vi`, `premium-vi`, …) not the underlying model.

## Cost observability

- `GET http://localhost:4000/spend/keys` shows per-key spend.
- Budget alerts fire at 80% / 100% to `LITELLM_ALERT_WEBHOOK` (Telegram bridge
  defined in `n8n/workflows/99-litellm-alerts.json`).
