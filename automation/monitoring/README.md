# Phase 3.1 — Observability (Grafana + Prometheus)

## Launch

```bash
# From the automation/ directory
docker compose \
  -f docker-compose.yml \
  -f docker-compose.monitoring.yml \
  up -d
```

Grafana on <http://localhost:3000>, Prometheus on <http://localhost:9090>.

## What's wired

| Component           | Source                                      | Purpose                              |
| ------------------- | ------------------------------------------- | ------------------------------------ |
| `prometheus`        | Scrapes LiteLLM, n8n, postgres-exporter     | Time-series store                    |
| `postgres-exporter` | Custom SQL in `postgres-exporter-queries.yaml` | Exposes content/omni business metrics |
| `grafana`           | Provisioned dashboard + datasources         | Visualization                        |
| Alert rules         | `alerts.yml`                                | Budget, error rate, auto-reply band  |

## KPIs on the default dashboard

1. **Publish success 24h** — `content_publish_success_ratio` (≥0.9 target).
2. **Auto-reply ratio** — `cskh_auto_reply_ratio` (band 0.5–0.9).
3. **LiteLLM spend 24h** — sum of `litellm_spend_metric` increase.
4. **LiteLLM error rate 10m** — 5xx over total requests.
5. **Publish attempts by platform** — stacked time series.
6. **CSKH intents by type** — stacked time series.
7. **Lead conversion table** — direct Postgres query on `omni.intent_log`.
8. **Inbound messages by channel** — Zalo/FB/TikTok volume.

## Budget alerts → Telegram

1. Add Telegram contact point in Grafana → Alerting → Contact points, using
   `TELEGRAM_BOT_TOKEN` + `TELEGRAM_ALERT_CHAT_ID`.
2. Attach the `automation-budget` rules group as a notification policy.
3. LiteLLM itself also emits slack-compatible alerts via `litellm_settings.alerting`;
   point the webhook to the Telegram bridge if you prefer a second channel.

## Extending

- New Postgres metric? Add it to `postgres-exporter-queries.yaml`, rerun
  `docker compose restart postgres-exporter prometheus`.
- New n8n workflow metric? n8n exposes `/metrics` natively; no change needed
  since Prometheus is already scraping.
