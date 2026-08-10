# Compatibility entry point for Claude Code subagent worker.
$delegationScript = Join-Path $PSScriptRoot 'skills\agent-delegation-tools\scripts\claude.ps1'
if (-not (Test-Path -LiteralPath $delegationScript -PathType Leaf)) {
    throw "Claude delegation script is missing: $delegationScript"
}

& $delegationScript @args
exit $LASTEXITCODE
