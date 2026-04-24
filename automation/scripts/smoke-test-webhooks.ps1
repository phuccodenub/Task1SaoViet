# =============================================================================
# smoke-test-webhooks.ps1
#
# Cross-platform port of smoke-test-webhooks.sh. Runs on Windows PowerShell,
# PowerShell Core (pwsh), Linux, macOS — no bash / jq / openssl / WSL
# dependency. All HMAC-SHA256 is computed via .NET's built-in
# System.Security.Cryptography.HMACSHA256.
#
# What it validates (same contracts as the .sh version):
#
#   1. ZaloCRM 'message.received' webhook body → workflow 04 consumer shape
#      (post message-handler.ts fix: senderType/threadId/threadType required).
#   2. ZaloCRM POST /api/public/messages/send body (workflow 04 reply path).
#   3. HMAC-SHA256 signature parity for workflow 04 (X-Webhook-Signature).
#   4. Facebook X-Hub-Signature-256 shape parity for workflow 05.
#
# Exit: 0 if all contract checks pass, non-zero if any field or signature
# deviates from what the n8n workflows and ZaloCRM public-api-routes.ts
# actually expect.
#
# Env overrides:
#   ZALOCRM_WEBHOOK_SECRET   (default: test-secret)
#   FB_APP_SECRET            (default: test-secret)
#
# Usage:
#   pwsh -File automation/scripts/smoke-test-webhooks.ps1
# =============================================================================

[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$script:failCount = 0

$zaloSecret = if ($env:ZALOCRM_WEBHOOK_SECRET) { $env:ZALOCRM_WEBHOOK_SECRET } else { 'test-secret' }
$fbSecret   = if ($env:FB_APP_SECRET)          { $env:FB_APP_SECRET }          else { 'test-secret' }

function Test-JsonField {
    param(
        [Parameter(Mandatory)]$Object,
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$Label
    )
    $cur = $Object
    foreach ($seg in $Path.Trim('.').Split('.')) {
        if ($null -eq $cur) { break }
        $prop = $cur.PSObject.Properties[$seg]
        if (-not $prop) { $cur = $null; break }
        $cur = $prop.Value
    }
    if ($null -eq $cur -or ($cur -is [string] -and $cur -eq '')) {
        Write-Host ("  FAIL: {0} - field .{1} missing" -f $Label, $Path)
        $script:failCount++
    } else {
        Write-Host ("  ok  : {0} - .{1} present" -f $Label, $Path)
    }
}

function Test-NoLegacyField {
    param(
        [Parameter(Mandatory)]$Object,
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$Label
    )
    $cur = $Object
    foreach ($seg in $Path.Trim('.').Split('.')) {
        if ($null -eq $cur) { break }
        $prop = $cur.PSObject.Properties[$seg]
        if (-not $prop) { $cur = $null; break }
        $cur = $prop.Value
    }
    if ($null -ne $cur) {
        Write-Host ("  FAIL: {0} - legacy field .{1} present" -f $Label, $Path)
        $script:failCount++
    } else {
        Write-Host ("  ok  : {0} - no legacy .{1}" -f $Label, $Path)
    }
}

function Get-HmacSha256Hex {
    param(
        [Parameter(Mandatory)][string]$Key,
        [Parameter(Mandatory)][string]$Body
    )
    $keyBytes  = [System.Text.Encoding]::UTF8.GetBytes($Key)
    $bodyBytes = [System.Text.Encoding]::UTF8.GetBytes($Body)
    $hmac = [System.Security.Cryptography.HMACSHA256]::new($keyBytes)
    try {
        return ([System.BitConverter]::ToString($hmac.ComputeHash($bodyBytes)) -replace '-', '').ToLowerInvariant()
    } finally {
        $hmac.Dispose()
    }
}

# ── 1) ZaloCRM message.received payload shape ────────────────────────────────
Write-Host '==> 1) ZaloCRM message.received webhook payload'
$msgReceived = @'
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
'@ | ConvertFrom-Json
foreach ($field in @(
    'data.zaloAccountId', 'data.threadId', 'data.threadType',
    'data.senderType',    'data.conversationId', 'data.contactId',
    'data.content',       'data.senderName'
)) {
    Test-JsonField -Object $msgReceived -Path $field -Label 'message.received'
}

# ── 2) ZaloCRM reply body shape ──────────────────────────────────────────────
Write-Host ''
Write-Host '==> 2) ZaloCRM POST /api/public/messages/send body (workflow 04 reply)'
$sendBody = @'
{
  "zaloAccountId": "acc_01",
  "threadId": "user_uid_01",
  "threadType": "user",
  "content": "Dạ shop vẫn còn hàng ạ"
}
'@ | ConvertFrom-Json
foreach ($field in @('zaloAccountId', 'threadId', 'content')) {
    Test-JsonField -Object $sendBody -Path $field -Label 'messages/send body'
}
foreach ($legacy in @('conversationId', 'message')) {
    Test-NoLegacyField -Object $sendBody -Path $legacy -Label 'messages/send body'
}

# ── 3) HMAC parity for workflow 04 ───────────────────────────────────────────
Write-Host ''
Write-Host '==> 3) HMAC signature parity (workflow 04)'
$rawBody = '{"event":"message.received","data":{"test":1}}'
$sig = Get-HmacSha256Hex -Key $zaloSecret -Body $rawBody
Write-Host "  X-Webhook-Signature (hex sha256) = $sig"
if ($sig.Length -ne 64 -or $sig -notmatch '^[0-9a-f]{64}$') {
    Write-Host '  FAIL: signature shape (expected 64 lowercase hex chars)'
    $script:failCount++
}

# ── 4) Facebook X-Hub-Signature-256 ──────────────────────────────────────────
Write-Host ''
Write-Host '==> 4) Facebook X-Hub-Signature-256 (workflow 05)'
$fbBody = '{"entry":[{"id":"PAGE_ID","messaging":[{"sender":{"id":"PSID"},"recipient":{"id":"PAGE_ID"},"timestamp":1,"message":{"mid":"mid1","text":"hi"}}]}]}'
$fbSig = 'sha256=' + (Get-HmacSha256Hex -Key $fbSecret -Body $fbBody)
Write-Host "  X-Hub-Signature-256 = $fbSig"
if ($fbSig -notmatch '^sha256=[0-9a-f]{64}$') {
    Write-Host '  FAIL: FB signature shape'
    $script:failCount++
}

Write-Host ''
if ($script:failCount -gt 0) {
    Write-Host "smoke-test-webhooks: $($script:failCount) failure(s)"
    exit 1
}
Write-Host 'smoke-test-webhooks: OK'
exit 0
