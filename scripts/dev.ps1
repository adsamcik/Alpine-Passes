#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Starts the Itinera local dev server.

.DESCRIPTION
    Thin wrapper around tools/dev_server.py. Forwards all arguments
    (e.g. --port 9000, --no-open) to the Python script.

.EXAMPLE
    ./scripts/dev.ps1
    ./scripts/dev.ps1 --port 9000
    ./scripts/dev.ps1 --no-open
#>
[CmdletBinding()]
param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$Args
)

$ErrorActionPreference = "Stop"
$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$script   = Join-Path $repoRoot "tools/dev_server.py"

$python = $null
foreach ($candidate in @("python", "python3", "py")) {
    if (Get-Command $candidate -ErrorAction SilentlyContinue) {
        $python = $candidate
        break
    }
}
if (-not $python) {
    Write-Error "Python 3 is required but was not found on PATH."
    exit 1
}

Push-Location $repoRoot
try {
    & $python $script @Args
}
finally {
    Pop-Location
}
