<#
.SYNOPSIS
  One-shot bootstrap for the automation stack (Phase 1.1 → 1.3).
  Windows PowerShell. Assumes ZaloCRM stack is already running.

.DESCRIPTION
  1. Creates `n8n` and `litellm` databases in the shared Postgres.
  2. Creates `content` + `omni` schemas inside the `zalocrm` DB.
  3. Generates API key + webhook secret and writes them into `app_settings`.
  4. Prints the values so you can paste them into automation/.env.

.EXAMPLE
  cd h:\Task1SaoViet\automation
  ./scripts/bootstrap.ps1 -PostgresContainer zalo-crm-db -N8nBaseUrl "https://n8n.yourdomain.com"
#>
[CmdletBinding()]
param(
  [string]$PostgresContainer = "zalo-crm-db",
  [string]$DbUser = "crmuser",
  [string]$DbName = "zalocrm",
  [string]$N8nBaseUrl = "http://localhost:5678",
  [string]$OrgId = ""
)

$ErrorActionPreference = "Stop"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition

function Invoke-Sql {
  param([string]$Database, [string]$File, [hashtable]$Vars = @{})
  $args = @("exec", "-i", $PostgresContainer, "psql", "-U", $DbUser, "-d", $Database, "-v", "ON_ERROR_STOP=1")
  foreach ($k in $Vars.Keys) { $args += @("-v", "$k=$($Vars[$k])") }
  Get-Content $File -Raw | docker @args
  if ($LASTEXITCODE -ne 0) { throw "psql failed for $File" }
}

Write-Host "[1/4] Creating n8n + litellm databases..." -ForegroundColor Cyan
Invoke-Sql -Database "postgres" -File "$scriptDir/01-create-databases.sql"

Write-Host "[2/4] Creating content + omni schemas..." -ForegroundColor Cyan
Invoke-Sql -Database $DbName -File "$scriptDir/02-content-schema.sql"

if (-not $OrgId) {
  Write-Host "[3a/4] Discovering default organization..." -ForegroundColor Cyan
  $OrgId = (docker exec $PostgresContainer psql -U $DbUser -d $DbName -tAc "SELECT id FROM organizations ORDER BY created_at ASC LIMIT 1").Trim()
  if (-not $OrgId) {
    throw "No organization found. Register the first ZaloCRM user via the UI first."
  }
  Write-Host "    → using orgId = $OrgId" -ForegroundColor Yellow
}

$apiKey        = "zcrm_" + (-join ((1..48) | ForEach-Object { "{0:x}" -f (Get-Random -Max 16) }))
$webhookSecret = -join ((1..64) | ForEach-Object { "{0:x}" -f (Get-Random -Max 16) })
$webhookUrl    = "$N8nBaseUrl/webhook/zalocrm/events"

Write-Host "[3b/4] Writing webhook + API key into app_settings..." -ForegroundColor Cyan
Invoke-Sql -Database $DbName -File "$scriptDir/03-bootstrap-zalocrm.sql" -Vars @{
  "org_id"         = "'$OrgId'"
  "api_key"        = "'$apiKey'"
  "webhook_url"    = "'$webhookUrl'"
  "webhook_secret" = "'$webhookSecret'"
}

Write-Host "`n[4/4] Done. Save these into automation/.env:" -ForegroundColor Green
Write-Host "ZALOCRM_ORG_ID=$OrgId"
Write-Host "ZALOCRM_API_KEY=$apiKey"
Write-Host "ZALOCRM_WEBHOOK_SECRET=$webhookSecret"
Write-Host ""
Write-Host "Then restart the automation stack:" -ForegroundColor Yellow
Write-Host "  docker compose --env-file .env up -d"
