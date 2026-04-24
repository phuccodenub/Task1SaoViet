import { createHmac, randomUUID } from 'node:crypto';
import { logger } from '../../../shared/utils/logger.js';

export interface CallWebhookActionParams {
  orgId: string;
  url: string;
  secret?: string | null;
  headers?: Record<string, string> | null;
  timeoutMs?: number;
  payload: Record<string, unknown>;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_PAYLOAD_BYTES = 64 * 1024;

/**
 * Deliver an automation-triggered webhook to an external endpoint (typically
 * an n8n workflow). Signs the payload with HMAC-SHA256 using the rule's
 * secret so the receiver can verify authenticity, identical to the scheme
 * used by webhook-service.ts (X-Webhook-Signature).
 *
 * Fire-and-forget: validation/payload shaping happens synchronously, then the
 * HTTP delivery is scheduled in the background. Failures are logged but do not
 * raise, which matches the semantics of the other automation actions.
 */
export function callWebhookAction(params: CallWebhookActionParams): void {
  const { orgId, url, secret, headers, timeoutMs, payload } = params;

  if (!url || !/^https?:\/\//i.test(url)) {
    logger.warn('[automation:call_webhook] Invalid URL, skipping', { orgId, url });
    return;
  }

  let body: string;
  try {
    body = JSON.stringify({
      event: 'automation.rule_fired',
      deliveryId: randomUUID(),
      timestamp: new Date().toISOString(),
      orgId,
      data: payload,
    });
  } catch (error) {
    logger.warn('[automation:call_webhook] Payload is not JSON-serializable, skipping', {
      orgId,
      url,
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  if (Buffer.byteLength(body, 'utf8') > MAX_PAYLOAD_BYTES) {
    logger.warn('[automation:call_webhook] Payload exceeds 64KB limit, skipping', { orgId, url });
    return;
  }

  const outgoingHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Automation-Event': 'rule_fired',
    ...(headers ?? {}),
  };
  if (secret) {
    outgoingHeaders['X-Webhook-Signature'] = createHmac('sha256', secret).update(body).digest('hex');
  }

  void deliverWebhook({
    orgId,
    url,
    headers: outgoingHeaders,
    body,
    timeoutMs: timeoutMs ?? DEFAULT_TIMEOUT_MS,
  });
}

async function deliverWebhook(input: {
  orgId: string;
  url: string;
  headers: Record<string, string>;
  body: string;
  timeoutMs: number;
}): Promise<void> {
  const { orgId, url, headers, body, timeoutMs } = input;
  const startedAt = Date.now();

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const durationMs = Date.now() - startedAt;
    if (!response.ok) {
      logger.warn('[automation:call_webhook] Non-2xx response', {
        orgId,
        url,
        status: response.status,
        durationMs,
      });
    } else {
      logger.info('[automation:call_webhook] Delivery ok', {
        orgId,
        url,
        status: response.status,
        durationMs,
      });
    }
  } catch (error) {
    logger.warn('[automation:call_webhook] Delivery failed', {
      orgId,
      url,
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
