# Compatibility entry point for unified multi-agent subagent dispatcher.
$delegationScript = Join-Path $PSScriptRoot 'skills\agent-delegation-tools\scripts\delegate.ps1'
if (-not (Test-Path -LiteralPath $delegationScript -PathType Leaf)) {
    throw "Unified delegation dispatcher script is missing: $delegationScript"
}

& $delegationScript @args
exit $LASTEXITCODE
