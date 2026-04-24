#!/usr/bin/env bash
# =============================================================================
# smoke-test-webhooks.sh
#
# Contract smoke test for the three external boundaries where silent drift
# bit us once already:
#
#   1. ZaloCRM "message.received" webhook    → workflow 04 consumer
#   2. ZaloCRM POST /api/public/messages/send → reply path
#   3. Facebook Messenger X-Hub-Signature-256 verification → workflow 05
#
# The script does NOT talk to live n8n. It validates payload shape with jq,
# recomputes HMAC signatures locally, and fails loudly on any missing field
# the workflow code expects. Keep dependencies minimal: bash, jq, openssl.
#
# NOTE (round V): This bash script is now the Linux/macOS fallback only. The
# primary runner on every dev machine is `smoke-test-webhooks.ps1` (pure
# PowerShell + .NET HMACSHA256, no bash/openssl/jq). The two scripts MUST
# produce identical HMAC output for identical input — see the contract test
# in automation/docs/09-smoke-test.md.
#
# Usage:
#   bash automation/scripts/smoke-test-webhooks.sh
#
# Env overrides:
#   ZALOCRM_WEBHOOK_SECRET   (default: test-secret)
#   FB_APP_SECRET            (default: test-secret)
# =============================================================================
set -euo pipefail

WEBHOOK_SECRET="${ZALOCRM_WEBHOOK_SECRET:-test-secret}"
FB_SECRET="${FB_APP_SECRET:-test-secret}"
fail=0

need_field() {
  local json="$1" field="$2" label="$3"
  if [[ "$(echo "$json" | jq -r "$field // \"__missing__\"")" == "__missing__" ]]; then
    echo "  FAIL: $label — field $field missing"
    fail=$((fail + 1))
  else
    echo "  ok : $label — $field present"
  fi
}

echo "==> 1) ZaloCRM message.received webhook payload"
# Mirrors what message-handler.ts emits after the senderType/threadId/threadType fix.
MSG_RECEIVED=$(cat <<'JSON'
{
  "event": "message.received",
  "timestamp": 1716000000000,
  "data": {
    "messageId": "msg_01",
    "conversationId": "conv_01",
    "zaloAccountId": "acc_01",
    "threadId": "user_uid_01",
    "threadType": "user",
    "senderType": "contact",
    "senderUid": "user_uid_01",
    "senderName": "Khách A",
    "contactId": "contact_01",
    "content": "Shop ơi còn hàng không",
    "contentType": "text",
    "sentAt": "2026-04-22T10:00:00.000Z"
  }
}
JSON
)
for f in \
  '.data.zaloAccountId' '.data.threadId' '.data.threadType' \
  '.data.senderType'   '.data.conversationId' '.data.contactId' \
  '.data.content'      '.data.senderName'; do
  need_field "$MSG_RECEIVED" "$f" "message.received"
done

echo ""
echo "==> 2) ZaloCRM POST /api/public/messages/send body (workflow 04 reply)"
SEND_BODY=$(cat <<'JSON'
{
  "zaloAccountId": "acc_01",
  "threadId": "user_uid_01",
  "threadType": "user",
  "content": "Dạ shop vẫn còn hàng ạ"
}
JSON
)
# public-api-routes.ts requires zaloAccountId + threadId + content; threadType optional.
for f in '.zaloAccountId' '.threadId' '.content'; do
  need_field "$SEND_BODY" "$f" "messages/send body"
done
# Forbidden legacy fields — fail if anyone re-adds them.
for legacy in '.conversationId' '.message'; do
  val=$(echo "$SEND_BODY" | jq -r "$legacy // \"__absent__\"")
  if [[ "$val" != "__absent__" ]]; then
    echo "  FAIL: messages/send body carries legacy field $legacy"
    fail=$((fail + 1))
  else
    echo "  ok : messages/send body has no legacy $legacy"
  fi
done

echo ""
echo "==> 3) HMAC signature parity (workflow 04)"
RAW_BODY='{"event":"message.received","data":{"test":1}}'
EXPECTED_ZALO=$(printf '%s' "$RAW_BODY" | openssl dgst -sha256 -hmac "$WEBHOOK_SECRET" | awk '{print $2}')
echo "  X-Webhook-Signature (hex sha256) = $EXPECTED_ZALO"
[[ ${#EXPECTED_ZALO} -eq 64 ]] || { echo "  FAIL: signature length != 64"; fail=$((fail + 1)); }

echo ""
echo "==> 4) Facebook X-Hub-Signature-256 (workflow 05)"
FB_BODY='{"entry":[{"id":"PAGE_ID","messaging":[{"sender":{"id":"PSID"},"recipient":{"id":"PAGE_ID"},"timestamp":1,"message":{"mid":"mid1","text":"hi"}}]}]}'
EXPECTED_FB="sha256=$(printf '%s' "$FB_BODY" | openssl dgst -sha256 -hmac "$FB_SECRET" | awk '{print $2}')"
echo "  X-Hub-Signature-256 = $EXPECTED_FB"
[[ "$EXPECTED_FB" =~ ^sha256=[0-9a-f]{64}$ ]] || { echo "  FAIL: FB signature shape"; fail=$((fail + 1)); }

echo ""
if (( fail > 0 )); then
  echo "smoke-test-webhooks: ${fail} failure(s)"
  exit 1
fi
echo "smoke-test-webhooks: OK"
