# =============================================================================
# smoke-test.ps1
#
# Cross-platform pre-merge gate for the automation stack. Three stages, any
# of which will fail the gate non-zero:
#
#   [1/3] lint-workflows.ps1
#         Static integrity of every n8n workflow JSON (dangling connections,
#         unknown $('Node') references, duplicate node names). This is the
#         layer that used to silently pass when U3 renamed "Log + mark
#         published/failed" → "Log + mark outcome" without rewiring
#         "Route by platform" fallback.
#
#   [2/3] smoke-test-schema.sql (docker exec against zalo-crm-db)
#         EXPLAIN-based SQL smoke test covering every workflow's DB touch.
#
#   [3/3] smoke-test-webhooks.ps1
#         Webhook/API contract + HMAC parity checks. 100% PowerShell (.NET
#         HMACSHA256) so Windows dev does NOT need Git Bash / WSL / openssl.
#         The legacy bash version is kept only for Linux CI convenience.
#
# Usage:
#   pwsh -File automation/scripts/smoke-test.ps1
#   pwsh -File automation/scripts/smoke-test.ps1 -SkipWebhook    # schema-only
#   pwsh -File automation/scripts/smoke-test.ps1 -SkipLint       # last resort
#
# Prerequisites:
#   - Docker Desktop / Engine running, ZaloCRM compose stack up
#     (container zalo-crm-db reachable).
#   - No bash / WSL / openssl / jq required.
# =============================================================================

param(
  [string] $DbContainer = 'zalo-crm-db',
  [string] $DbUser      = 'crmuser',
  [string] $Database    = 'zalocrm',
  [switch] $SkipWebhook,
  [switch] $SkipLint
)

$ErrorActionPreference = 'Stop'

function Assert-Command($name) {
  if (-not (Get-Command $name -ErrorAction SilentlyContinue)) {
    throw "Missing required tool on PATH: $name"
  }
}

# ── [1/3] Static graph lint ──────────────────────────────────────────────────
if ($SkipLint) {
  Write-Warning "-SkipLint was passed; workflow graph integrity NOT verified."
} else {
  Write-Host '==> [1/3] Static graph lint on n8n workflow JSON ...'
  $lintScript = Join-Path $PSScriptRoot 'lint-workflows.ps1'
  & pwsh -NoProfile -File $lintScript
  if ($LASTEXITCODE -ne 0) {
    throw "lint-workflows.ps1 failed (exit $LASTEXITCODE). Fix graph integrity before running DB smoke."
  }
  Write-Host ''
}

# ── [2/3] SQL schema smoke test ──────────────────────────────────────────────
Assert-Command docker
Write-Host "==> [2/3] Running smoke-test-schema.sql against $DbContainer ..."
$schemaSql = Join-Path $PSScriptRoot 'smoke-test-schema.sql'
Get-Content $schemaSql -Raw | docker exec -i $DbContainer psql -U $DbUser -d $Database -v ON_ERROR_STOP=1
if ($LASTEXITCODE -ne 0) { throw "smoke-test-schema.sql failed (exit $LASTEXITCODE)" }
Write-Host ''

# ── [3/3] Webhook / API contract smoke test ─────────────────────────────────
if ($SkipWebhook) {
  Write-Warning '-SkipWebhook was passed; webhook/API contract tests WERE NOT RUN.'
  Write-Warning 'Treat this as a partial run, not a green gate.'
  Write-Host ''
  Write-Host 'smoke-test: lint + schema OK, webhook/API SKIPPED (explicit).' -ForegroundColor Yellow
  exit 0
}

Write-Host '==> [3/3] Running smoke-test-webhooks.ps1 (cross-platform, no bash/openssl) ...'
$psWebhook = Join-Path $PSScriptRoot 'smoke-test-webhooks.ps1'
& pwsh -NoProfile -File $psWebhook
if ($LASTEXITCODE -ne 0) { throw "smoke-test-webhooks.ps1 failed (exit $LASTEXITCODE)" }

Write-Host ''
Write-Host 'smoke-test: all checks passed.' -ForegroundColor Green
