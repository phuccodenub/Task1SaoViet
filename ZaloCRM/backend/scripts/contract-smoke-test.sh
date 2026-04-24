#!/usr/bin/env bash
# contract-smoke-test.sh — manual contract verification for allowlist + ACL.
# Asserts both HTTP status AND response body where data leakage is the risk.
#
# Required env (always — for read-side ACL/visibility tests):
#   BASE              e.g. http://localhost:3000
#   ADMIN_TOKEN       JWT for an owner/admin user
#   MEMBER_TOKEN      JWT for a member user without ZaloAccountAccess to ACCOUNT_ID
#   API_KEY           public-api X-Api-Key
#   ACCOUNT_ID        a Zalo account in the org
#   HIDDEN_CONV_ID    conversation row id for a HIDDEN conversation (read-side tests)
#   INACCESSIBLE_ACCOUNT_ID an account in the same org the MEMBER_TOKEN user
#                     has no ZaloAccountAccess to (and is not ownerUserId of)
#
# Live-send guard (Fix #33 + Fix #34 — defaults safe, opt-in for end-to-end):
#   ALLOW_LIVE_SEND=1     unlock EVERY POST-send assertion (positive AND
#                         negative). Reason: the negative tests also hit
#                         the send endpoint. If the visibility guard
#                         regresses the request can deliver a Zalo message
#                         BEFORE the test reports failure, so positive and
#                         negative send tests share the same gate.
#                         ONLY set this with dedicated smoke threads you
#                         control (internal team chat, sandbox account).
#                         Never against real customer threads.
#   THREAD_ID_VISIBLE     externalThreadId of a VISIBLE conversation you
#                         are willing to receive a smoke message in.
#                         Required when ALLOW_LIVE_SEND=1.
#   THREAD_ID_HIDDEN      externalThreadId of a HIDDEN conversation. If
#                         the guard works, no message is sent. If it
#                         regresses and ALLOW_LIVE_SEND=1, a message CAN
#                         reach this thread → use a dedicated smoke
#                         thread, never a real one. Required when
#                         ALLOW_LIVE_SEND=1.
#   SMOKE_CONTENT         message body sent (default "[smoke test] please ignore").
#
# Live-mutation guard (Fix #35 — mirrors the send gate for ACL probes):
#   ALLOW_LIVE_MUTATION=1 unlock the member create/login/delete/sync
#                         403-deny probes. Expected behavior is 403, but
#                         if the ACL guard regresses these calls CAN:
#                         create a real ZaloAccount row, kick an active
#                         Zalo session (login), delete an account +
#                         cascade its conversations/messages, or call
#                         Zalo getAllFriends and write contacts.
#                         Since this script exists to catch exactly those
#                         regressions, the probes must be opt-in with
#                         disposable smoke resources (a member user that
#                         should never have access, plus a smoke Zalo
#                         account you are willing to lose).
#                         Without this flag they are SKIPPED — the other
#                         read-side ACL checks still run.
#
# Required env (always — read-side ACL + visibility + body-level checks):
#   BASE              e.g. http://localhost:3000
#   ADMIN_TOKEN       JWT for an owner/admin user
#   MEMBER_TOKEN      JWT for a member user without ZaloAccountAccess to ACCOUNT_ID
#   API_KEY           public-api X-Api-Key
#   ACCOUNT_ID        a Zalo account in the org
#   HIDDEN_CONV_ID    conversation row id for a HIDDEN conversation (read-side tests)
#   INACCESSIBLE_ACCOUNT_ID an account in the same org the MEMBER_TOKEN user
#                     has no ZaloAccountAccess to (and is not ownerUserId of)
#
# Optional:
#   JQ      path to jq (default 'jq')
#
# Usage (safe — read-side only, NO write or mutation side-effect possible):
#   BASE=... ADMIN_TOKEN=... MEMBER_TOKEN=... API_KEY=... ACCOUNT_ID=... \
#   HIDDEN_CONV_ID=... INACCESSIBLE_ACCOUNT_ID=... \
#   bash backend/scripts/contract-smoke-test.sh
#
# Usage (full — adds send-path AND mutation-probe assertions; use disposable resources):
#   ALLOW_LIVE_SEND=1 ALLOW_LIVE_MUTATION=1 \
#   THREAD_ID_VISIBLE=<smoke-thread> THREAD_ID_HIDDEN=<smoke-hidden-thread> \
#   <other vars> bash backend/scripts/contract-smoke-test.sh
#
# Exit code 0 only when every assertion passes. Any FAIL → exit 1.

set -u
BASE="${BASE:?set BASE}"
ADMIN_TOKEN="${ADMIN_TOKEN:?set ADMIN_TOKEN}"
MEMBER_TOKEN="${MEMBER_TOKEN:?set MEMBER_TOKEN}"
API_KEY="${API_KEY:?set API_KEY}"
ACCOUNT_ID="${ACCOUNT_ID:?set ACCOUNT_ID}"
HIDDEN_CONV_ID="${HIDDEN_CONV_ID:?set HIDDEN_CONV_ID}"
INACCESSIBLE_ACCOUNT_ID="${INACCESSIBLE_ACCOUNT_ID:?set INACCESSIBLE_ACCOUNT_ID}"
ALLOW_LIVE_SEND="${ALLOW_LIVE_SEND:-0}"
ALLOW_LIVE_MUTATION="${ALLOW_LIVE_MUTATION:-0}"
THREAD_ID_VISIBLE="${THREAD_ID_VISIBLE:-}"
THREAD_ID_HIDDEN="${THREAD_ID_HIDDEN:-}"
SMOKE_CONTENT="${SMOKE_CONTENT:-[smoke test] please ignore}"
JQ="${JQ:-jq}"

if [[ "$ALLOW_LIVE_SEND" == "1" ]]; then
  if [[ -z "$THREAD_ID_VISIBLE" ]]; then
    echo "FATAL: ALLOW_LIVE_SEND=1 requires THREAD_ID_VISIBLE (dedicated smoke thread)" >&2
    exit 2
  fi
  if [[ -z "$THREAD_ID_HIDDEN" ]]; then
    echo "FATAL: ALLOW_LIVE_SEND=1 requires THREAD_ID_HIDDEN (dedicated smoke hidden thread — a regression could deliver to it)" >&2
    exit 2
  fi
fi

PASS=0
FAIL=0
RED=$'\033[0;31m'; GRN=$'\033[0;32m'; CLR=$'\033[0m'

ok()   { echo "${GRN}PASS${CLR} $*"; ((PASS++)); }
fail() { echo "${RED}FAIL${CLR} $*"; ((FAIL++)); }

check_status() {
  local name="$1" expected="$2" actual="$3"
  if [[ "$actual" == "$expected" ]]; then
    ok "$name (HTTP $actual)"
  else
    fail "$name expected $expected got $actual"
  fi
}

# Returns "<status>\n<body>" on stdout
http_call() {
  local method="$1" url="$2" auth_header="$3" body="${4:-}"
  local tmp; tmp="$(mktemp)"
  local args=(-s -o "$tmp" -w '%{http_code}' -X "$method" "$BASE$url")
  [[ -n "$auth_header" ]] && args+=(-H "$auth_header")
  [[ -n "$body" ]] && args+=(-H 'Content-Type: application/json' --data "$body")
  local status; status=$(curl "${args[@]}")
  local body_out; body_out=$(cat "$tmp")
  rm -f "$tmp"
  printf '%s\n%s' "$status" "$body_out"
}

bearer() { echo "Authorization: Bearer $1"; }
apikey() { echo "x-api-key: $API_KEY"; }

echo "── Visibility contract: WRITE ──────────────────────────────"

# Fix #34: ALL POST send tests (positive + negative) share the live-send
# gate. Negative tests probe the visibility guard — if the guard regresses
# the request can deliver a Zalo message before the test reports failure,
# so they are no safer than the positive test.
if [[ "$ALLOW_LIVE_SEND" != "1" ]]; then
  echo "SKIP write contract tests (set ALLOW_LIVE_SEND=1 + dedicated smoke threads to enable)"
  echo "  → positive (visible→200) AND negative (hidden→409) both require the gate"
else
  # 1. Internal send to hidden conv → 409
  out=$(http_call POST "/api/v1/conversations/$HIDDEN_CONV_ID/messages" "$(bearer "$ADMIN_TOKEN")" \
    "{\"content\":$(printf '%s' "$SMOKE_CONTENT" | "$JQ" -Rs '.')}")
  status="${out%%$'\n'*}"
  check_status "internal send hidden conv → 409 (LIVE-gated)" 409 "$status"

  # 2. Public send to HIDDEN thread → 409
  out=$(http_call POST "/api/public/messages/send" "$(apikey)" \
    "{\"zaloAccountId\":\"$ACCOUNT_ID\",\"threadId\":\"$THREAD_ID_HIDDEN\",\"content\":$(printf '%s' "$SMOKE_CONTENT" | "$JQ" -Rs '.')}")
  status="${out%%$'\n'*}"
  check_status "public send hidden thread → 409 (LIVE-gated)" 409 "$status"

  # 3. Public send to VISIBLE thread → 200
  out=$(http_call POST "/api/public/messages/send" "$(apikey)" \
    "{\"zaloAccountId\":\"$ACCOUNT_ID\",\"threadId\":\"$THREAD_ID_VISIBLE\",\"content\":$(printf '%s' "$SMOKE_CONTENT" | "$JQ" -Rs '.')}")
  status="${out%%$'\n'*}"
  check_status "public send visible thread → 200 (LIVE)" 200 "$status"
fi

echo
echo "── Visibility contract: READ ───────────────────────────────"

# 4. Public GET hidden messages without opt-in → 409
out=$(http_call GET "/api/public/conversations/$HIDDEN_CONV_ID/messages" "$(apikey)")
status="${out%%$'\n'*}"
check_status "public GET hidden messages → 409" 409 "$status"

# 5. Same with opt-in → 200
out=$(http_call GET "/api/public/conversations/$HIDDEN_CONV_ID/messages?includeNonVisible=true" "$(apikey)")
status="${out%%$'\n'*}"
check_status "public GET hidden messages opt-in → 200" 200 "$status"

# 6. Public GET conversations default → 200 AND body must NOT contain hidden conv id (Fix #32)
out=$(http_call GET "/api/public/conversations" "$(apikey)")
status="${out%%$'\n'*}"; body="${out#*$'\n'}"
check_status "public GET conversations default → 200" 200 "$status"
if echo "$body" | "$JQ" -e ".conversations | map(.id) | index(\"$HIDDEN_CONV_ID\") == null" >/dev/null 2>&1; then
  ok "public GET conversations default body does NOT include hidden conv"
else
  fail "public GET conversations default body INCLUDES hidden conv $HIDDEN_CONV_ID"
fi

# 6b. Body verification with explicit visibility=hidden — hidden conv MUST appear
out=$(http_call GET "/api/public/conversations?visibility=hidden" "$(apikey)")
status="${out%%$'\n'*}"; body="${out#*$'\n'}"
check_status "public GET conversations ?visibility=hidden → 200" 200 "$status"
if echo "$body" | "$JQ" -e ".conversations | map(.id) | index(\"$HIDDEN_CONV_ID\") != null" >/dev/null 2>&1; then
  ok "public GET conversations ?visibility=hidden body includes hidden conv"
else
  fail "public GET conversations ?visibility=hidden missing hidden conv $HIDDEN_CONV_ID (filter broken?)"
fi

echo
echo "── Account ACL parity ─────────────────────────────────────"

# 7. Member list → 200 AND body must NOT contain INACCESSIBLE_ACCOUNT_ID (Fix #32)
out=$(http_call GET "/api/v1/zalo-accounts" "$(bearer "$MEMBER_TOKEN")")
status="${out%%$'\n'*}"; body="${out#*$'\n'}"
check_status "member GET zalo-accounts → 200" 200 "$status"
if echo "$body" | "$JQ" -e "map(.id) | index(\"$INACCESSIBLE_ACCOUNT_ID\") == null" >/dev/null 2>&1; then
  ok "member zalo-accounts list does NOT include inaccessible account"
else
  fail "member zalo-accounts list LEAKS inaccessible account $INACCESSIBLE_ACCOUNT_ID"
fi

# 8. Member mutation probes (Fix #35): expected 403, but a regression
# means they actually mutate. Gate same way as send tests.
if [[ "$ALLOW_LIVE_MUTATION" != "1" ]]; then
  echo "SKIP member mutation probes (set ALLOW_LIVE_MUTATION=1 + disposable resources to enable)"
  echo "  → probes: create / login / delete / sync-contacts all expected 403; regression would mutate"
else
  # 8a. Member create → 403 (regression: writes ZaloAccount row)
  out=$(http_call POST "/api/v1/zalo-accounts" "$(bearer "$MEMBER_TOKEN")" '{"displayName":"[smoke] member-create-probe"}')
  check_status "member POST create → 403 (LIVE-MUT)" 403 "${out%%$'\n'*}"

  # 8b. Member login on inaccessible account → 403 (regression: kicks Zalo session)
  out=$(http_call POST "/api/v1/zalo-accounts/$INACCESSIBLE_ACCOUNT_ID/login" "$(bearer "$MEMBER_TOKEN")" '{}')
  check_status "member POST login (no access) → 403 (LIVE-MUT)" 403 "${out%%$'\n'*}"

  # 8c. Member delete on inaccessible account → 403 (regression: deletes account + cascades)
  out=$(http_call DELETE "/api/v1/zalo-accounts/$INACCESSIBLE_ACCOUNT_ID" "$(bearer "$MEMBER_TOKEN")")
  check_status "member DELETE (no access) → 403 (LIVE-MUT)" 403 "${out%%$'\n'*}"

  # 8d. Member sync-contacts on inaccessible account → 403 (regression: calls Zalo + writes contacts)
  out=$(http_call POST "/api/v1/zalo-accounts/$INACCESSIBLE_ACCOUNT_ID/sync-contacts" "$(bearer "$MEMBER_TOKEN")" '{}')
  check_status "member POST sync-contacts (no access) → 403 (LIVE-MUT)" 403 "${out%%$'\n'*}"
fi

# 9. Admin → GET status → 200 (read-only, always safe)
out=$(http_call GET "/api/v1/zalo-accounts/$ACCOUNT_ID/status" "$(bearer "$ADMIN_TOKEN")")
check_status "admin GET status → 200" 200 "${out%%$'\n'*}"

echo
echo "──────────────────────────────────────────────────────────"
echo "Result: ${GRN}$PASS passed${CLR}, ${RED}$FAIL failed${CLR}"
exit $((FAIL > 0))
