# Compatibility entry point. The installable Codex skill owns the implementation.
$delegationScript = Join-Path $PSScriptRoot 'skills\agent-delegation-tools\scripts\codex.ps1'
if (-not (Test-Path -LiteralPath $delegationScript -PathType Leaf)) {
    throw "Agent delegation script is missing: $delegationScript"
}

& $delegationScript @args
exit $LASTEXITCODE
