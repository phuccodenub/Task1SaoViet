# =============================================================================
# lint-workflows.ps1
#
# Static integrity lint for every n8n workflow JSON under automation/n8n/workflows.
# Catches the class of bug that the SQL smoke test can NEVER catch:
#
#   1. connections.<src>.main[*].*.node references a name that no node
#      declares (dangling edge — e.g. after renaming a node without updating
#      the connection map). This is how U3's rename to "Log + mark outcome"
#      leaked a stale "Log + mark published/failed" edge past smoke-test.
#
#   2. Expressions of the form $('Node Name') reference a node that is not
#      declared in the same workflow. These are cross-node data reads that
#      silently break at runtime if the target was renamed/removed.
#
#   3. Declared node names must be unique per workflow (n8n enforces this at
#      import time; good to fail pre-merge instead).
#
#   4. `onError` must be at the node top-level, NOT inside parameters. n8n
#      treats `onError` as a node-level schema field (same tier as `type`,
#      `credentials`, etc.). Nesting it inside parameters makes the engine
#      ignore it: the error output pin won't be wired, so an error output
#      edge becomes a dead branch and the node throws into the error
#      workflow instead of falling through to a fallback branch. This
#      rule catches the class of bug Codex #7 P2 flagged in WF06's
#      content_qa node.
#
#   5. Postgres queries using `ON CONFLICT ... DO NOTHING` must be explicitly
#      allowlisted. This pattern is correct for pure dedupe inserts (RSS items,
#      webhook retries), but it broke retry recovery twice when used on WF06/WF08
#      draft-save paths because n8n received zero output rows and downstream
#      mark/recovery nodes never fired.
#
# Exit code: 0 on clean, 1 on any violation. Writes a human-readable report
# to stdout. Designed to be called from smoke-test.ps1 as a pre-schema gate.
#
# Usage:
#   pwsh -File automation/scripts/lint-workflows.ps1
# =============================================================================

[CmdletBinding()]
param(
    [string]$WorkflowDir = (Join-Path $PSScriptRoot '..\n8n\workflows')
)

$ErrorActionPreference = 'Stop'
$violations = @()

function Add-Violation {
    param([string]$File, [string]$Kind, [string]$Message)
    $script:violations += [pscustomobject]@{
        File    = $File
        Kind    = $Kind
        Message = $Message
    }
}

$workflowFiles = Get-ChildItem -Path $WorkflowDir -Filter '*.json' -File |
    Sort-Object Name
if ($workflowFiles.Count -eq 0) {
    Write-Error "No workflow JSON files found in $WorkflowDir"
    exit 1
}

Write-Host "==> Linting $($workflowFiles.Count) n8n workflow(s) in $WorkflowDir"

# $('Node Name') — capture the quoted argument.
# Works for both ' and " quoting variants.
$nodeRefRegex = [regex]'\$\(\s*[''"]([^''"]+)[''"]\s*\)'
$doNothingAllowlist = @{
    '01-content-ingest-rewrite.json|Upsert content.items' = 'RSS item dedupe by (org_id, dedupe_hash); duplicate rows should stop this branch.'
    '05-cskh-fb-messenger.json|Store external_messages'  = 'Meta webhook retry dedupe by (channel, external_message_id); duplicate messages should stop this branch.'
}

foreach ($file in $workflowFiles) {
    $rel = $file.Name
    try {
        $raw = Get-Content -Raw -LiteralPath $file.FullName
        $wf = $raw | ConvertFrom-Json -Depth 100
    } catch {
        Add-Violation $rel 'parse' "JSON parse failed: $($_.Exception.Message)"
        continue
    }

    if (-not $wf.nodes) {
        Add-Violation $rel 'schema' 'workflow has no .nodes[]'
        continue
    }

    # 1) Collect declared node names + flag duplicates.
    $declared = @{}
    foreach ($n in $wf.nodes) {
        if (-not $n.name) {
            Add-Violation $rel 'node-missing-name' "node id='$($n.id)' has no name"
            continue
        }
        if ($declared.ContainsKey($n.name)) {
            Add-Violation $rel 'duplicate-node-name' "node name '$($n.name)' declared more than once"
        } else {
            $declared[$n.name] = $n
        }
    }

    # 2) Validate connection targets exist.
    if ($wf.connections) {
        $connectionMap = $wf.connections
        # connections is a PSCustomObject keyed by source node name.
        foreach ($prop in $connectionMap.PSObject.Properties) {
            $srcName = $prop.Name
            if (-not $declared.ContainsKey($srcName)) {
                Add-Violation $rel 'connection-source-unknown' "connections['$srcName'] references a node that is not declared in nodes[]"
            }
            $groups = $prop.Value
            if (-not $groups) { continue }
            foreach ($typeProp in $groups.PSObject.Properties) {
                # typeProp.Name is 'main', 'error', etc.
                $outputs = $typeProp.Value
                if (-not $outputs) { continue }
                for ($i = 0; $i -lt $outputs.Count; $i++) {
                    $bucket = $outputs[$i]
                    if (-not $bucket) { continue }
                    foreach ($edge in $bucket) {
                        if (-not $edge -or -not $edge.node) { continue }
                        if (-not $declared.ContainsKey($edge.node)) {
                            Add-Violation $rel 'connection-target-unknown' `
                                "connections['$srcName'].$($typeProp.Name)[$i] → '$($edge.node)' is NOT a declared node"
                        }
                    }
                }
            }
        }
    }

    # 3) Validate $('Node Name') references inside every string field of every node.
    foreach ($n in $wf.nodes) {
        $blob = $n | ConvertTo-Json -Depth 100 -Compress
        $refMatches = $nodeRefRegex.Matches($blob)
        foreach ($m in $refMatches) {
            $target = $m.Groups[1].Value
            if (-not $declared.ContainsKey($target)) {
                Add-Violation $rel 'expression-ref-unknown' `
                    "node '$($n.name)' uses `$('$target') but that node is not declared"
            }
        }
    }

    # 4) onError must be at node top-level, never inside parameters.
    foreach ($n in $wf.nodes) {
        $params = $n.parameters
        if ($null -eq $params) { continue }
        # parameters is a PSCustomObject — check the property directly.
        $hasNestedOnError = $false
        if ($params.PSObject.Properties.Name -contains 'onError') {
            $hasNestedOnError = $true
        }
        if ($hasNestedOnError) {
            Add-Violation $rel 'onerror-nested-in-parameters' `
                "node '$($n.name)' has parameters.onError — move to node top-level or n8n ignores it (silent error-output regression)"
        }
    }

    # 5) Guard against DO NOTHING on retry/recovery paths unless allowlisted.
    foreach ($n in $wf.nodes) {
        if ($n.type -ne 'n8n-nodes-base.postgres') { continue }
        $query = $n.parameters.query
        if (-not $query) { continue }
        if ($query -notmatch '(?is)\bON\s+CONFLICT\b.*\bDO\s+NOTHING\b') { continue }

        $key = "$rel|$($n.name)"
        if (-not $doNothingAllowlist.ContainsKey($key)) {
            Add-Violation $rel 'postgres-do-nothing-unreviewed' `
                "node '$($n.name)' uses ON CONFLICT ... DO NOTHING but is not allowlisted. Use DO UPDATE ... RETURNING for retry paths, or add a documented allowlist entry for pure dedupe inserts."
        }
    }

    Write-Host "  ok : $rel  ($($wf.nodes.Count) nodes)"
}

if ($violations.Count -eq 0) {
    Write-Host ""
    Write-Host "lint-workflows: OK ($($workflowFiles.Count) workflow(s) clean)"
    exit 0
}

Write-Host ""
Write-Host "lint-workflows: $($violations.Count) violation(s)"
$violations |
    Group-Object File |
    Sort-Object Name |
    ForEach-Object {
        Write-Host ""
        Write-Host "  [$($_.Name)]"
        $_.Group | ForEach-Object {
            Write-Host ("    - {0,-28} {1}" -f $_.Kind, $_.Message)
        }
    }
exit 1
