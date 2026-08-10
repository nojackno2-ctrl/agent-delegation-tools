# Compatibility entry point for Antigravity subagent worker.
$delegationScript = Join-Path $PSScriptRoot 'skills\agent-delegation-tools\scripts\agy.ps1'
if (-not (Test-Path -LiteralPath $delegationScript -PathType Leaf)) {
    throw "Antigravity delegation script is missing: $delegationScript"
}

& $delegationScript @args
exit $LASTEXITCODE
